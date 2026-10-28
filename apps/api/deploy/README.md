# EC2 deployment

GitHub Actions builds a release, uploads it with SSH/rsync, switches a `current` symlink, and restarts separate PM2 processes. The web app deploys independently to the same EC2 instance from the same repository (`Deploy web`). The database is MariaDB 11.4 in Docker on the same instance; see [the database guide](../../../docs/ops/database.md).

## Provision the server

[LAUNCH.md](LAUNCH.md) section 2 has the steps. [`bootstrap-ec2.sh`](bootstrap-ec2.sh) sets up an Amazon Linux 2023 instance with Node 24, PM2, rsync, Nginx, certbot and the database, and creates the application directories, owned by the deployment user `quotient`:

```text
/srv/quotient-api/
  releases/
  shared/.env          # starts with the database settings the bootstrap wrote
  shared/migrate.env   # migration user, read only by deploy-remote.sh
  shared/uploads/      # customer and practice photos
  shared/backups/      # nightly database dumps, a week of them
  current -> releases/<commit>-<workflow-run>-<attempt>
/srv/quotient-web/
  releases/
  current -> releases/<commit>-<workflow-run>-<attempt>
```

API settings and secrets live in `/srv/quotient-api/shared/.env` with mode `600`, starting from `env.production.example`. Never put this file in GitHub or a release archive. The server's IAM role lets it send email through SES, so no AWS credentials are stored anywhere. PM2 sets the absolute `UPLOAD_DIR` to `shared/uploads`, so photos never sit beneath a release directory. The daily disk snapshots cover them.

The security group allows HTTP, HTTPS and SSH. SSH accepts keys only: the deployment user's key from GitHub and the administrator's key on `ec2-user`. Application ports 3100 and 4100 and the database's 3306 bind only to localhost. Install TLS and adapt `nginx.conf.example` into the product domain's server block. The API trusts exactly its local reverse proxy; Nginx overwrites forwarding headers with the actual remote client address. Keep proxy timeouts compatible with the AI timeout.

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

Every API deploy installs production dependencies from the root lockfile (`npm ci --omit=dev --workspace @pricecharm/api`) and runs the compiled migration program, as the migration user from `shared/migrate.env`, before switching traffic. Normal release migrations must be additive and compatible with the prior application. MySQL DDL can commit independently; restoring a symlink cannot undo a destructive migration. Take tested backups and schedule destructive schema changes separately after old code is retired.

The API and web have independent pipelines. Maintain compatibility with the preceding release's API contract and coordinate changes that require both. Deployment serialization prevents two API releases from migrating concurrently. An immutable release directory includes the commit, run ID and retry attempt; retrying a workflow does not overwrite a prior release.

PM2 derives `APP_RELEASE` from the immutable release directory name. The deployment checks both database readiness and that `/health` reports this exact release, so a response from an old process cannot mark a new release healthy. PM2 also enables `TRUST_PROXY=1`; the provided Nginx configuration overwrites forwarded client-address headers and application ports remain bound to localhost.

If startup/readiness or release identity verification fails, the script restores the prior symlink and PM2 configuration. This is an application rollback, not a database rollback. Releases remain on disk for inspection; remove old ones only after verifying that neither `current` nor PM2 points to them. A single EC2 instance remains a single point of failure, and PM2 fork restarts may cause a brief interruption.

For a deliberate rollback, select a known compatible release and restore its symlink and PM2 configuration under the deployment user. Do not run down-migrations automatically. Recheck API `/ready` and the web homepage, then save PM2 state.

## Product operation and launch

Read [LAUNCH.md](LAUNCH.md) for the complete EC2/CloudFormation/bootstrap, DNS/TLS, environment, backup/restore and acceptance runbook. Read [COMMERCE.md](COMMERCE.md) for SES, verified contacts, Stripe meter/price/webhook setup, fees, spending caps and reconciliation.

The production API rejects local email and payments and demo AI. Quotes go out on their own only when the owner allows it, the customer confirmed their email, and the server's checks pass: priced from the owner's own jobs, under their limit, for a listed service, in their area, and close to similar past jobs. Everything else waits for the owner. Practice and the owner's own test chats are never billed.

Use `node dist/ops.js --http` for read-only application/schema/queue readiness checks. Investigate failed jobs, uncertain email outcomes and delayed usage dispatch before invoice finalization. Keep customer content/provider payloads out of logs and use the query-free access log example in `nginx-site.conf.example`.

Primary references: [Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting), [Node release support](https://nodejs.org/en/about/previous-releases), [Amazon Linux Node24 packages](https://docs.aws.amazon.com/linux/al2023/ug/nodejs.html), [SES identity permissions](https://docs.aws.amazon.com/ses/latest/dg/control-user-access.html), [Stripe usage ingestion](https://docs.stripe.com/billing/subscriptions/usage-based/recording-usage-api), [Stripe webhook handling](https://docs.stripe.com/webhooks).
