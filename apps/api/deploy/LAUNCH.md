# Deploy and launch PriceCharm

One repository ships the product: the Next.js web app (`apps/web`) and the Node/Express API (`apps/api`). PriceCharm shares nothing with other applications. It has its own RDS database ([database guide](../../../docs/ops/database.md)) and its own AI keys with provider spending caps ([AI keys guide](../../../docs/ops/ai-keys.md)).

## 1. Provision the new application host

`infra/cloudformation.json` creates an Amazon Linux 2023 EC2 host, EIP, encrypted disk, HTTPS/HTTP security group, private encrypted photo bucket, a backup bucket that deletes database dumps after 28 days, runtime S3/SES role, SSM access and CPU/status alarms. It also creates the role GitHub deploys sign in to and an empty firewall group for deploy SSH (section 4). With `DatabaseMode=dedicated` (the default) it also creates PriceCharm's private RDS MariaDB database, reachable only from the app host, with TLS required, encrypted storage, automated backups, deletion protection and database alarms. It uses an existing VPC and subnets, and contains no secrets: RDS keeps the admin password in Secrets Manager. Photos are not versioned so account deletion can remove them; the bucket and instance disk are retained if the stack is deleted. Remove retained resources deliberately when decommissioning.

Set parameters in the AWS console or a local, ignored parameter file: VPC, public subnet for the app host, two or more private subnets for the database (`DbSubnetIds`), existing SSH key pair, verified SES domain ARN and an optional SNS alarm topic. The default VPC only has public subnets, so create two private ones (no route to the internet gateway) in different Availability Zones first. Leave `SshCidr` at its default: SSH stays closed to everyone, administrators use Session Manager, and each deploy opens SSH to its own runner and closes it afterwards. `GitHubRepository` defaults to `Mitchell-Marchand/pricecharm-hackathon`. If the AWS account already has a GitHub sign-in provider (IAM > Identity providers > token.actions.githubusercontent.com), pass its ARN as `GitHubOidcProviderArn`; otherwise the stack creates one. Do not make application ports public.

```sh
aws cloudformation validate-template --template-body file://deploy/infra/cloudformation.json
aws cloudformation deploy --stack-name quotient \
  --template-file deploy/infra/cloudformation.json \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides file://quotient-parameters.json
aws cloudformation describe-stacks --stack-name quotient --query 'Stacks[0].Outputs'
```

`quotient-parameters.json` uses a JSON string array such as `["VpcId=vpc-…", "SubnetId=subnet-…", "DbSubnetIds=subnet-aaa,subnet-bbb", "KeyName=…", "SesIdentityArn=arn:aws:ses:us-east-1:123456789012:identity/pricecharm.com"]`; replace every example. Keep deployment parameters outside source control. CloudFormation invokes `bootstrap-ec2.sh` as user data. Inspect `/var/log/cloud-init-output.log` on the new host; confirm Node24, PM2, Nginx and certbot are installed and the `quotient-backup.timer` and `certbot-renew.timer` timers are enabled (`systemctl list-timers`). The deployment user is `quotient`, with no sudo privileges and no SSH key until you add the deploy key in section 4. A separate administrator handles TLS/system changes.

You may instead provision a new EC2 instance yourself and run `sudo bash deploy/bootstrap-ec2.sh`. This script is specific to Amazon Linux2023. The host needs outbound HTTPS for package installation, AI, Stripe, SES and S3, plus private access to MySQL. Enable AWS host monitoring/SSM and configure an external HTTPS uptime monitor for the product domain.

## 2. Create isolated production storage

Create the two database users with `sql/create-database-users.sql`, following the [database guide](../../../docs/ops/database.md): a rows-only `quotefolk_app` user for the running API and worker, and a `quotefolk_migrate` user that only deployments use. Both require TLS. The API refuses database names outside the `quotient…` / `quoting…` namespace.

Copy `env.production.example` to `/srv/quotient-api/shared/.env` and `migrate.env.example` to `/srv/quotient-api/shared/migrate.env`, both owned by `quotient` with mode 600. The API refuses to start if a deployed configuration is unsafe: it requires `APP_ENV=staging` or `production`, `NODE_ENV=production`, explicit providers and `TRUST_PROXY`, `DB_SSL=1` for a remote database, no `EXPOSE_DEV_TOKENS`, and a live Stripe key in production or a test key in staging. Set:

- `NODE_ENV=production`, `APP_ORIGIN=https://YOUR_PRODUCT_DOMAIN`, `HOST=127.0.0.1`, port4100.
- The `quotefolk_app` credentials, the `DatabaseEndpoint` stack output as `DB_HOST`, `DB_CONNECTION_LIMIT=5`, `DB_SSL=1` and `DB_SSL_CA_FILE=/etc/pki/rds/global-bundle.pem`. Certificates are verified.
- Selected `AI_PROVIDER=openai` or `anthropic`, its chat model and PriceCharm's own production API key from the [AI keys guide](../../../docs/ops/ai-keys.md). Practice photos also require `OPENAI_API_KEY` and an image-capable account, with `OPENAI_IMAGE_MODEL=gpt-image-2.5-flare` by default. Chat uses the selected provider; generated practice images use OpenAI. Set provider spending limits and the app/tenant daily call budgets.
- `MAIL_PROVIDER=ses`, AWS region, verified `SES_EMAIL_FROM`, stable random32-byte/base64 `MAIL_ENCRYPTION_KEY`. Back up this encryption key with secrets; pending emails cannot be decrypted if it is lost.
- The same key makes the daily fingerprints that stand in for visitors' addresses in the setup and customer chat limits, and the links in customer emails. Changing it retires links already sent.
- `BILLING_PROVIDER=stripe`, Stripe secret, webhook signing secret, meter event name and metered price ID, using the exact setup in [COMMERCE.md](COMMERCE.md).
- `S3_BUCKET` from the stack output, `S3_PREFIX=quotient/`, AWS region. AWS credentials come from the EC2 role.
- `BACKUP_BUCKET` from the stack's `BackupBucket` output. The nightly backup copies each database dump there.
- Optional `METRICS_EMAIL`: who gets the weekly numbers on Monday mornings (section 7).
- Real `OPERATOR_NAME` (the legal entity), `OPERATOR_ADDRESS` (its postal address), `GOVERNING_LAW` (the US state whose laws govern the terms, such as `Texas`) and `SUPPORT_EMAIL`, such as `hello@pricecharm.com`. All four appear in the privacy policy and terms of service, and production refuses to start without them. Replies to PriceCharm's emails go to `SUPPORT_EMAIL`, except that a customer replying to a business's email reaches that business's owner, once the owner has confirmed their address. `SUPPORT_EMAIL` needs a real inbox: SES only sends.
- `TURNSTILE_SECRET_KEY` from a Cloudflare Turnstile widget (free, and the domain doesn't need to be on Cloudflare). Add the product domain to the widget's hostnames and choose the Managed mode. Starting setup, signup, demo chats and new customer chats require a passing check. The widget's site key goes in a GitHub variable (section 4). Staging can use Cloudflare's published test keys; production refuses them.
- `SENTRY_DSN` from a Sentry project for the API and worker. Production refuses to start without it. Reports carry the error, its stack and the request ID, never request bodies, headers, emails or AI prompts. Set an alert rule in Sentry so a new error emails you.
- The customer chat budgets (`AI_DAILY_CUSTOMER_APP_LIMIT`, `AI_DAILY_BUSINESS_CUSTOMER_LIMIT`, `AI_DAILY_CUSTOMER_IP_LIMIT`) and the setup budgets for visitors who haven't signed up (`AI_DAILY_DRAFT_APP_LIMIT`, `AI_DRAFT_LIFETIME_LIMIT`). The defaults are in `.env.example` and the [AI keys guide](../../../docs/ops/ai-keys.md). Never set `LOCAL_SETUPS_PER_ADDRESS` on a server; it's for local browser tests, and deployed servers ignore it.

Production rejects demo AI, local email/payments, missing required provider configuration and HTTP app origins. `.env` stays on the server and never goes into CI artifacts or Git. The web uses same-origin `/api/v1`, so no browser API keys or separate API public hostname are required.

## 3. Domain, HTTPS and logs

Point DNS A records for `pricecharm.com` and `www.pricecharm.com` at the EIP. Then, as an administrator on the host:

1. Copy only the port 80 server (and the `log_format` line) from `nginx-site.conf.example` to `/etc/nginx/conf.d/quotient.conf`, then `sudo nginx -t && sudo systemctl reload nginx`.
2. Issue one certificate for both names: `sudo certbot certonly --webroot -w /var/www/acme -d pricecharm.com -d www.pricecharm.com --email hello@pricecharm.com --agree-tos --no-eff-email`.
3. Replace the file with the whole of `nginx-site.conf.example`, run `sudo nginx -t`, and reload Nginx. `http://` and `www.` now redirect to `https://pricecharm.com`.

`certbot-renew.timer` renews the certificate, and a hook reloads Nginx when it changes; `sudo certbot renew --dry-run` checks that renewal works. The application proxy locations are also available in `nginx.conf.example` if you use an existing TLS server configuration.

The complete example logs `$uri`, excluding query strings containing password-reset or inquiry link tokens. Keep debug/body logging off. The API logs request IDs and error codes without customer transcripts or provider payloads. Rotate PM2/Nginx logs and keep them no longer than 30 days, which is what the privacy policy promises; Nginx logs include IP addresses. Forward operational errors to your normal monitoring destination.

## 4. Configure the GitHub repository

The repository is `Mitchell-Marchand/pricecharm-hackathon`. Create a `production` environment in its settings and limit its deployment branches to `main`.

Make a key just for deploys, on your own machine: `ssh-keygen -t ed25519 -N '' -C pricecharm-deploy -f pricecharm-deploy`. Open a Session Manager session on the host and append the contents of `pricecharm-deploy.pub` to `/home/quotient/.ssh/authorized_keys` (as `quotient`, mode 600). In the same session, `cat /etc/ssh/ssh_host_ed25519_key.pub` gives the host key; `EC2_KNOWN_HOSTS` is the EIP, a space, then that line, for example `203.0.113.10 ssh-ed25519 AAAA…`. Reading it through Session Manager is what makes it trustworthy, so don't use `ssh-keyscan`.

Production environment **secrets**: `EC2_HOST` (the EIP), `EC2_USER=quotient`, `EC2_SSH_KEY` (the whole private `pricecharm-deploy` file; delete your local copy afterwards) and `EC2_KNOWN_HOSTS`.

Production environment **variables**: `AWS_DEPLOY_ROLE_ARN` (stack output `DeployRoleArn`), `AWS_REGION` (the stack's region) and `EC2_DEPLOY_SECURITY_GROUP_ID` (stack output `DeploySecurityGroupId`). Each deploy signs in to AWS as that role, which can do nothing except add and remove rules on that one group. It opens port 22 to the runner's own address, deploys, and removes the rule even when the deploy fails. If a runner dies mid-deploy, a rule described `GitHub deploy run …` can be left behind; delete it from the group in the EC2 console.

**Repository** variables: `ENABLE_DEPLOY=true` once the server, secrets and TLS are ready (it has to be a repository variable, not an environment one), `TURNSTILE_SITE_KEY` (the web deploy fails without it), `SENTRY_WEB_DSN`, the web app's Sentry DSN (a separate Sentry project from the API's works best), and optionally `PUBLIC_APP_URL` (default `https://pricecharm.com`, used in link previews and the sitemap). Optionally set `EC2_API_DEPLOY_ROOT` (default `/srv/quotient-api`) and `EC2_WEB_DEPLOY_ROOT` (default `/srv/quotient-web`). `CI` runs on every pull request; `Deploy API` and `Deploy web` run on pushes to `main` that change their app. The first deploy of each is manual: run `Deploy API`, then `Deploy web`, from the Actions tab.

Deploy **API first**, then web. CI runs typechecks/tests/build, packages immutable releases, installs API production dependencies on EC2, runs additive migrations, switches `current`, starts PM2 and checks readiness plus exact release identity. On failed readiness it restores the prior application release. Database DDL is not rolled back automatically. See [README.md](README.md) for details and workflow inputs.

## 5. Verify the deployed application

```sh
cd /srv/quotient-api/current/apps/api
node dist/ops.js --http
sudo -u quotient pm2 status
```

Walk through it yourself before inviting anyone:

1. In a fresh browser, start setup from the home page. Pick a trade, add two or three past jobs with photos, upload an old invoice, and finish the three practice customers. Their photos are generated by the AI and labelled as practice.
2. Create the account. Confirm the verification email arrives and its link works, then add a payment method from the "You're live" page. Sign out, reset the password from the sign-in page and sign back in.
3. On Share, save your website and copy the widget code. Paste it into a page on that site and check the button opens the chat. On any other site it should offer the quote page instead.
4. From another browser or a phone, open the quote link. Describe a job, add a photo, enter a real email you control and the code it receives. With automatic quotes off, the quote waits: check the owner email, open it signed out, sign in and land on that quote. Edit it, send it, and confirm the customer's page and email both show it.
5. Accept it from the customer's emailed link, ask for a site visit on another quote, and decline a third. Check the owner emails for each.
6. Turn automatic quotes on in Settings and request one more quote that matches your past jobs. It should go out on its own, and the owner should get the "sent" email.
7. In Settings, check this month's fees match the quotes customers received, and that your own test chats didn't count.

Use Stripe test mode first with a separate test-mode meter/price/webhook. Exercise checkout, customer portal, a billable quote, signed webhook processing and duplicate delivery retry. Confirm the displayed tariff, fee cap and invoice amount. Switch all Stripe settings together to live mode only after that check. Enable SES production sending and confirm actual delivery to an unverified controlled address; SES sandbox cannot serve arbitrary customer emails. These are deployment acceptance checks; automated QA uses isolated local providers/mocks and never sends real emails or charges cards.

## 6. Backups and daily operations

RDS keeps automated backups. On top of that, the `quotient-backup.timer` installed by the bootstrap runs `deploy/ops/nightly-backup.sh` as `quotient` every night: `backup.py` writes a compressed, mode600 dump of the dedicated DB using a temporary private client option file, the script copies it to `BACKUP_BUCKET`, and it keeps a week of local copies. The bucket deletes dumps after 28 days (the privacy policy says deleted data leaves backups within 30 days, so keep `DbBackupRetentionDays` at 30 or less too). Check it with `systemctl list-timers quotient-backup.timer` and `journalctl -u quotient-backup`; run it now with `sudo systemctl start quotient-backup`. Nothing alerts on a failed backup yet, so look at the bucket now and then. Back up the stable mail encryption key securely. S3 holds photos separately; local storage deployments also need a backup of `shared/uploads`.

Test restoration into a **different, isolated** `quotient_restore_…` database, or restore an RDS snapshot to a new instance. Never restore over the live database. Verify migrations, table counts and private file access before using a restored database. Backups may temporarily retain deleted data; do not silently reintroduce deleted accounts when restoring.

Run `node dist/ops.js --http` periodically. It reports schema status, failed/late jobs, uncertain mail and delayed usage dispatch without customer content. Investigate failures before retrying. Unknown email delivery outcomes are held for provider reconciliation so retries cannot blindly send duplicate private links. Meter events have stable identifiers and immutable fee snapshots. See COMMERCE.md for provider reconciliation, refunds and cancellation.

The single-host deployment can have a short PM2 restart interruption and remains a single point of failure. The database, encrypted mail queue and private object storage persist across releases. Keep dependencies patched, test backups, monitor disk/DB connections/provider spend and watch for failed jobs. Before a release, keep a tested database snapshot and preserve the preceding compatible release for rollback.

## 7. Metrics

PriceCharm records its own usage in its database: steps in setup and signup, customer requests, quotes drafted and sent, and how customers answered. The records say what happened and when, never names, contact details or messages. Visits to the public pages are counted without cookies, using a daily keyed hash of the visitor's address and browser, and not at all when the browser sends Do Not Track or Global Privacy Control. The privacy policy describes both.

```sh
cd /srv/quotient-api/current/apps/api
node dist/metrics-report.js            # the last 7 days, compared with the 7 before
node dist/metrics-report.js --days 30  # or --json
```

The report gives visitors and where they came from, setups started and how far they got, customer requests, quotes sent on their own or by the owner, how often owners changed the drafted price, and what customers did with their quotes. Set `METRICS_EMAIL` to get the same report by email every Monday.

