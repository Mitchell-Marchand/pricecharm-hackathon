# Deploy and launch Quotefolk

One repository ships the product: the Next.js web app (`apps/web`) and the Node/Express API (`apps/api`). Quotefolk shares nothing with other applications. It has its own RDS database ([database guide](../../../docs/ops/database.md)) and its own AI keys with provider spending caps ([AI keys guide](../../../docs/ops/ai-keys.md)).

## 1. Provision the new application host

`infra/cloudformation.json` creates an Amazon Linux 2023 EC2 host, EIP, encrypted disk, HTTPS/HTTP security group, restricted SSH source, private encrypted photo bucket, runtime S3/SES role, SSM access and CPU/status alarms. With `DatabaseMode=dedicated` (the default) it also creates Quotefolk's private RDS MariaDB database, reachable only from the app host, with TLS required, encrypted storage, automated backups, deletion protection and database alarms. It uses an existing VPC and subnets, and contains no secrets: RDS keeps the admin password in Secrets Manager. Photos are not versioned so account deletion can remove them; the bucket and instance disk are retained if the stack is deleted. Remove retained resources deliberately when decommissioning.

Set parameters in the AWS console or a local, ignored parameter file: VPC, public subnet for the app host, two or more private subnets for the database (`DbSubnetIds`), existing SSH key pair, trusted SSH CIDR, verified SES domain ARN and an optional SNS alarm topic. Use a CI runner with a stable permitted source address. The default SSH source is intentionally unreachable from the internet. Do not make application ports public.

```sh
aws cloudformation validate-template --template-body file://deploy/infra/cloudformation.json
aws cloudformation deploy --stack-name quotient \
  --template-file deploy/infra/cloudformation.json \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides file://quotient-parameters.json
aws cloudformation describe-stacks --stack-name quotient --query 'Stacks[0].Outputs'
```

`quotient-parameters.json` uses a JSON string array such as `["VpcId=vpc-…", "SubnetId=subnet-…", "DbSubnetIds=subnet-aaa,subnet-bbb", "KeyName=…", "SshCidr=203.0.113.5/32", "SesIdentityArn=arn:aws:ses:us-east-1:123456789012:identity/example.com"]`; replace every example. Keep deployment parameters outside source control. CloudFormation invokes `bootstrap-ec2.sh` as user data. Inspect `/var/log/cloud-init-output.log` on the new host; confirm Node24, PM2 and Nginx are installed. The deployment user is `quotient`, with no sudo privileges. A separate administrator handles TLS/system changes.

You may instead provision a new EC2 instance yourself and run `sudo bash deploy/bootstrap-ec2.sh`. This script is specific to Amazon Linux2023. The host needs outbound HTTPS for package installation, AI, Stripe, SES and S3, plus private access to MySQL. Enable AWS host monitoring/SSM and configure an external HTTPS uptime monitor for the product domain.

## 2. Create isolated production storage

Create the two database users with `sql/create-database-users.sql`, following the [database guide](../../../docs/ops/database.md): a rows-only `quotefolk_app` user for the running API and worker, and a `quotefolk_migrate` user that only deployments use. Both require TLS. The API refuses database names outside the `quotient…` / `quoting…` namespace.

Copy `env.production.example` to `/srv/quotient-api/shared/.env` and `migrate.env.example` to `/srv/quotient-api/shared/migrate.env`, both owned by `quotient` with mode 600. The API refuses to start if a deployed configuration is unsafe: it requires `APP_ENV=staging` or `production`, `NODE_ENV=production`, explicit providers and `TRUST_PROXY`, `DB_SSL=1` for a remote database, no `EXPOSE_DEV_TOKENS`, and a live Stripe key in production or a test key in staging. Set:

- `NODE_ENV=production`, `APP_ORIGIN=https://YOUR_PRODUCT_DOMAIN`, `HOST=127.0.0.1`, port4100.
- The `quotefolk_app` credentials, the `DatabaseEndpoint` stack output as `DB_HOST`, `DB_CONNECTION_LIMIT=5`, `DB_SSL=1` and `DB_SSL_CA_FILE=/etc/pki/rds/global-bundle.pem`. Certificates are verified.
- Selected `AI_PROVIDER=openai` or `anthropic`, its chat model and Quotefolk's own production API key from the [AI keys guide](../../../docs/ops/ai-keys.md). Practice photos also require `OPENAI_API_KEY` and an image-capable account, with `OPENAI_IMAGE_MODEL=gpt-image-2.5-flare` by default. Chat uses the selected provider; generated practice images use OpenAI. Set provider spending limits and the app/tenant daily call budgets.
- `MAIL_PROVIDER=ses`, AWS region, verified `SES_EMAIL_FROM`, stable random32-byte/base64 `MAIL_ENCRYPTION_KEY`. Back up this encryption key with secrets; pending emails cannot be decrypted if it is lost.
- Guest previews use a domain-separated HMAC with that stable key for private IP allowance buckets. Optional `GUEST_PREVIEW_DAILY_APP_LIMIT=50` and `GUEST_PREVIEW_DAILY_IP_LIMIT=3` bound anonymous preview attempts per UTC day within the existing application AI allowance. Failed attempts count; preview reloads and account claims make no provider call. Local development can use its stable `DB_PASS` as the fallback hashing secret; previews fail visibly if neither secret is available.
- `BILLING_PROVIDER=stripe`, Stripe secret, webhook signing secret, meter event name and metered price ID, using the exact setup in [COMMERCE.md](COMMERCE.md).
- `S3_BUCKET` from the stack output, `S3_PREFIX=quotient/`, AWS region. AWS credentials come from the EC2 role.
- Real `OPERATOR_NAME` and `SUPPORT_EMAIL`; these appear on the public support/privacy/terms pages.

Production rejects demo AI, local email/payments, missing required provider configuration and HTTP app origins. `.env` stays on the server and never goes into CI artifacts or Git. The web uses same-origin `/api/v1`, so no browser API keys or separate API public hostname are required.

## 3. Domain, HTTPS and logs

Point the product domain's DNS A record at the EIP. Use your existing certificate process or ACME/Certbot with the HTTP challenge directory `/var/www/acme`. First enable the HTTP server from `nginx-site.conf.example`; issue a certificate, then enable the TLS server with the actual domain/certificate paths. Install it under `/etc/nginx/conf.d/quotient.conf`, run `sudo nginx -t`, reload Nginx, and enable certificate auto-renewal. The application proxy locations are also available in `nginx.conf.example` if you use an existing TLS server configuration.

The complete example logs `$uri`, excluding query strings containing password-reset or inquiry link tokens. Keep debug/body logging off. The API logs request IDs and error codes without customer transcripts or provider payloads. Rotate PM2/Nginx logs and forward operational errors to your normal monitoring destination.

## 4. Configure the GitHub repository

Create one private repository for the monorepo, add it as the remote and push `main`. Configure production environment secrets: `EC2_HOST`, `EC2_USER=quotient`, `EC2_SSH_KEY`, and trusted/pinned `EC2_KNOWN_HOSTS`. Optionally set `EC2_API_DEPLOY_ROOT` (default `/srv/quotient-api`) and `EC2_WEB_DEPLOY_ROOT` (default `/srv/quotient-web`). Set repository variable `ENABLE_DEPLOY=true` after server secrets/TLS are ready. `CI` runs on every pull request; `Deploy API` and `Deploy web` run on pushes to `main` that change their app. Keep the SSH host key pinned; do not use an unverified runtime key scan.

Deploy **API first**, then web. CI runs typechecks/tests/build, packages immutable releases, installs API production dependencies on EC2, runs additive migrations, switches `current`, starts PM2 and checks readiness plus exact release identity. On failed readiness it restores the prior application release. Database DDL is not rolled back automatically. See [README.md](README.md) for details and workflow inputs.

## 5. Verify the deployed application

```sh
cd /srv/quotient-api/current/apps/api
node dist/ops.js --http
sudo -u quotient pm2 status
```

Use a real controlled test account: sign up, receive/verify email, reset its password, configure a service, import a historical case, finish teaching, review/apply a playbook proposal, add separate test cases, run evaluation (including the active inquiry model on representative independent cases), test the private customer chat, and explicitly approve automatic publishing. Request a quote at the hosted link from another browser; verify its contact, confirm the amount, open its emailed link, accept/decline, and check the owner dashboard and usage ledger. Confirm a missing or excluded detail goes to owner review and that replying works in both directions. Open an actual owner request-alert email after signing out; sign back in and confirm the exact request opens, survives reload and returns to the inbox without selecting a different customer. Use a controlled account with more than25 requests to confirm global filter counts, Older/Newer navigation, and the same inbox page after request opening, expired sign-in, price saving and separate approval. If that page becomes empty after a status change, verify explicit Newest recovery. Deploy the API containing `GET /quotes/page` before this frontend; the legacy latest200 array remains available to older clients. Try both iframe and script embeds on another origin, including a browser with third-party storage blocked.

In a practice conversation, ask for sample photos. Confirm visible generation progress becomes actual viewable images, then refresh and check they remain attached to the same messages. Confirm a failed request has an explicit retry instead of an unfulfilled promise. The API and `quotient-worker` must both run: photo jobs are durable and generated images use the same private S3/local photo storage as uploads. The worker gets up to ten minutes to finish its current photo job during a graceful release restart. Generated practice images are labelled and are not evidence of a real customer's property.

Use Stripe test mode first with a separate test-mode meter/price/webhook. Exercise checkout, customer portal, one trial delivery and one billable delivery after the trial, signed webhook processing and duplicate delivery retry. Confirm the displayed tariff, fee cap and invoice amount. Switch all Stripe settings together to live mode only after that check. Enable SES production sending and confirm actual delivery to an unverified controlled address; SES sandbox cannot serve arbitrary customer emails. These are deployment acceptance checks; automated QA uses isolated local providers/mocks and never sends real emails or charges cards.

## 6. Backups and daily operations

Run `python3 /srv/quotient-api/current/apps/api/deploy/ops/backup.py` as `quotient` nightly. RDS also keeps automated backups. it writes a compressed, mode600 snapshot of the dedicated DB using a temporary private client option file. For another layout pass `--env` and `--output`. Copy snapshots to your encrypted off-host backup destination, retain according to your published data policy, and monitor failures. Back up the stable mail encryption key securely. S3 holds photos separately; local storage deployments also need a backup of `shared/uploads`.

Test restoration into a **different, isolated** `quotient_restore_…` database, or restore an RDS snapshot to a new instance. Never restore over the live database. Verify migrations, table counts and private file access before using a restored database. Backups may temporarily retain deleted data; do not silently reintroduce deleted accounts when restoring.

Run `node dist/ops.js --http` periodically. It reports schema status, failed/late jobs, uncertain mail and delayed usage dispatch without customer content. Investigate failures before retrying. Unknown email delivery outcomes are held for provider reconciliation so retries cannot blindly send duplicate private links. Customer-link notifications may finish as skipped with a specific reason when their private grant expired, was superseded or became unavailable before dispatch. They have no sent timestamp or provider message ID; do not treat them as delivered. Original browser links expire independently of new, explicit owner email grants. Meter events have stable identifiers and immutable fee snapshots. See COMMERCE.md for provider reconciliation, refunds and cancellation.

The single-host deployment can have a short PM2 restart interruption and remains a single point of failure. The database, encrypted mail queue and private object storage persist across releases. Changing the configured inquiry model invalidates its previous automatic evaluation at delivery/publish time; re-evaluate and approve services with the new model. Keep dependencies patched, test backups, monitor disk/DB connections/provider spend and watch for failed jobs. Before a release, keep a tested database snapshot and preserve the preceding compatible release for rollback.
