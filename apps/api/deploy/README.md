# EC2 deployment

GitHub Actions builds a release, uploads it with SSH/rsync, switches a `current` symlink, and restarts separate PM2 processes. The web app deploys independently to the same EC2 instance from the same repository (`Deploy web`). Quotefolk has its own RDS database; see [the database guide](../../../docs/ops/database.md).

## Provision the server

Use an Amazon Linux 2023 or Ubuntu LTS EC2 instance with Node 24 LTS, npm, PM2, rsync, curl and Nginx. Install the latest patched Node 24 release; pin production versions deliberately. Create application directories owned by the deployment user:

```text
/srv/quotient-api/
  releases/
  shared/.env
  shared/migrate.env   # migration user, read only by deploy-remote.sh
  shared/uploads/      # local fallback when S3_BUCKET is unset
  current -> releases/<commit>-<workflow-run>-<attempt>
/srv/quotient-web/
  releases/
  current -> releases/<commit>-<workflow-run>-<attempt>
```

Place API settings and secrets in `/srv/quotient-api/shared/.env` with mode `600`. Copy the names from `.env.example`; do not put this file in GitHub or a release archive. Set `NODE_ENV=production`, the HTTPS `APP_ORIGIN`, and the dedicated database connection. Keep MySQL private and allow connections only from approved application hosts. Limit the app user to the Quotefolk database. Configure an EC2 role for S3 rather than storing AWS credentials in the repository.

Set `S3_BUCKET` (with `AWS_REGION` and optional `S3_PREFIX`) to use private S3 for production photos. If `S3_BUCKET` is unset, PM2 explicitly sets the absolute `UPLOAD_DIR` to the application's `shared/uploads` directory. Include it in the backup/retention plan; photos do not belong beneath a release directory.

Restrict network ingress to HTTPS, HTTP for certificate issuance/redirect, and SSH from your administration/CI mechanism. Application ports 3100 and 4100 bind only to localhost. Install TLS and adapt `nginx.conf.example` into the product domain's server block. The API trusts exactly its local reverse proxy; Nginx overwrites forwarding headers with the actual remote client address. Keep proxy timeouts compatible with the AI timeout.

Configure PM2 startup under the application user and save the process list after the first successful deployment. The process names are `quotient-api`, `quotient-worker`, and `quotient-web`.

## GitHub configuration

Configure these **production environment secrets** in the repository:

| Name | Value |
| --- | --- |
| `EC2_HOST` | EC2 hostname or IPv4 address |
| `EC2_USER` | Deployment username |
| `EC2_SSH_KEY` | Dedicated private SSH deployment key |
| `EC2_KNOWN_HOSTS` | Pinned SSH host-key entry obtained through a trusted channel |

Configure the repository variable `ENABLE_DEPLOY` and optionally the deploy roots. The job's deployment condition is evaluated before production environment variables are loaded, so `ENABLE_DEPLOY` must be a repository variable:

| Name | Value |
| --- | --- |
| `EC2_API_DEPLOY_ROOT` | `/srv/quotient-api` (default) |
| `EC2_WEB_DEPLOY_ROOT` | `/srv/quotient-web` (default) |
| `ENABLE_DEPLOY` | `true` when server provisioning is complete |

The API workflow provisions a disposable MariaDB 11.4 service with a dedicated `quoting_ci` database/user and test-only credentials. It migrates that database before running tests with `RUN_DB_TESTS=1` and `AI_PROVIDER=demo`, so tenant isolation and end-to-end persistence checks run in CI without contacting live providers. These credentials never connect to a real database.

The workflow runs checks for pull requests. A successful build on `main` deploys only when `ENABLE_DEPLOY=true`. Use GitHub's production environment rules for the approval policy you want. Do not use host-key verification bypasses. The workflow never transfers `.env` or prints secret values.

Deploy the API first, then the web application. The browser uses same-origin `/api/v1`; Nginx forwards it to port 4100. The web build's Next rewrite is also set to `http://127.0.0.1:4100` for standalone operation.

## Migrations, rollback and compatibility

Every API deploy installs production dependencies from the root lockfile (`npm ci --omit=dev --workspace @quotefolk/api`) and runs the compiled migration program, as the migration user from `shared/migrate.env`, before switching traffic. Normal release migrations must be additive and compatible with the prior application. MySQL DDL can commit independently; restoring a symlink cannot undo a destructive migration. Take tested backups and schedule destructive schema changes separately after old code is retired.

The API and web have independent pipelines. Maintain compatibility with the preceding release's API contract and coordinate changes that require both. Deployment serialization prevents two API releases from migrating concurrently. An immutable release directory includes the commit, run ID and retry attempt; retrying a workflow does not overwrite a prior release.

PM2 derives `APP_RELEASE` from the immutable release directory name. The deployment checks both database readiness and that `/health` reports this exact release, so a response from an old process cannot mark a new release healthy. PM2 also enables `TRUST_PROXY=1`; the provided Nginx configuration overwrites forwarded client-address headers and application ports remain bound to localhost.

If startup/readiness or release identity verification fails, the script restores the prior symlink and PM2 configuration. This is an application rollback, not a database rollback. Releases remain on disk for inspection; remove old ones only after verifying that neither `current` nor PM2 points to them. A single EC2 instance remains a single point of failure, and PM2 fork restarts may cause a brief interruption.

For a deliberate rollback, select a known compatible release and restore its symlink and PM2 configuration under the deployment user. Do not run down-migrations automatically. Recheck API `/ready` and the web homepage, then save PM2 state.

## Product operation and launch

Read [LAUNCH.md](LAUNCH.md) for the complete EC2/CloudFormation/bootstrap, DNS/TLS, environment, backup/restore and acceptance runbook. Read [COMMERCE.md](COMMERCE.md) for SES, verified contacts, Stripe meter/price/webhook setup, fees, spending caps and reconciliation.

The production API rejects local email and payments and demo AI. Quotes go out on their own only when the owner allows it, the customer confirmed their email, and the server's checks pass: priced from the owner's own jobs, under their limit, for a listed service, in their area, and close to similar past jobs. Everything else waits for the owner. Practice and the owner's own test chats are never billed.

Use `node dist/ops.js --http` for read-only application/schema/queue readiness checks. Investigate failed jobs, uncertain email outcomes and delayed usage dispatch before invoice finalization. Keep customer content/provider payloads out of logs and use the query-free access log example in `nginx-site.conf.example`.

Primary references: [Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting), [Node release support](https://nodejs.org/en/about/previous-releases), [Amazon Linux Node24 packages](https://docs.aws.amazon.com/linux/al2023/ug/nodejs.html), [SES identity permissions](https://docs.aws.amazon.com/ses/latest/dg/control-user-access.html), [Stripe usage ingestion](https://docs.stripe.com/billing/subscriptions/usage-based/recording-usage-api), [Stripe webhook handling](https://docs.stripe.com/webhooks).
