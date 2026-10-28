# Deploy and launch PriceCharm

PriceCharm runs on one EC2 instance. Nginx sits in front. PM2 runs the API, the worker and the web app, and MariaDB 11.4 runs in Docker on the same machine. When code changes on `main`, GitHub Actions builds each app, copies it to the server over SSH and restarts it. Certbot renews the HTTPS certificate on a timer. PriceCharm has its own AI keys with provider spending caps ([AI keys guide](../../../docs/ops/ai-keys.md)).

If the AWS account also runs other products, PriceCharm still gets its own instance, security group, key pair and Elastic IP. Don't reuse theirs, and don't put PriceCharm on their server or database.

## 1. Email (start this first)

PriceCharm sends email: customers' verification codes and quotes, owner alerts, signup verification and password resets. It sends through Amazon SES.

1. In the SES console, in the region you'll use for everything (`us-east-1` unless you have a reason), choose **Create identity**, pick **Domain**, enter `pricecharm.com` and keep Easy DKIM. Add the three CNAME records it shows to the domain's DNS, plus a DMARC record: TXT at `_dmarc` with `v=DMARC1; p=none; rua=mailto:hello@pricecharm.com`.
2. Once the identity shows **Verified**, request production access from the SES **Account dashboard**. AWS usually answers within a day. Until then SES only delivers to addresses you've verified yourself: enough for testing, not for customers. If another product in the account already sends through SES in that region, the dashboard may already show production access. That access and the sending reputation are shared across the account in each region.
3. Copy the identity's ARN from its page. The server's role needs it.

`SUPPORT_EMAIL` needs a real inbox, such as `hello@pricecharm.com`. SES only sends.

## 2. The server

1. **A role that can send email.** In IAM, choose **Roles → Create role → AWS service → EC2**, skip the managed policies and name it `pricecharm-server`. Then add an inline policy, with the ARN from section 1:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": "ses:SendEmail",
         "Resource": "arn:aws:ses:us-east-1:ACCOUNT:identity/pricecharm.com"
       }
     ]
   }
   ```

2. **Launch the instance** from the EC2 console:
   - Name it `pricecharm`. The snapshot policy in step 5 finds it by this name.
   - Amazon Linux 2023 (x86_64), `t3.medium`.
   - A new key pair, `pricecharm-admin`. The `.pem` file stays on your machine and never goes into GitHub.
   - The default VPC is fine. Keep **Auto-assign public IP** on: the bootstrap downloads software before the Elastic IP is attached.
   - A new security group, `pricecharm-web`, allowing SSH (22), HTTP (80) and HTTPS (443) from anywhere. SSH only accepts keys.
   - 30 GiB gp3. Under **Advanced**, set **Encrypted** to Yes and **Delete on termination** to No.
   - Under **Advanced details**, choose the `pricecharm-server` instance profile and paste the whole of [`bootstrap-ec2.sh`](bootstrap-ec2.sh) into **User data**.
3. **Elastic IP.** Under **Elastic IPs**, allocate one and associate it with the instance.
4. **Check the bootstrap.** Connect with **Connect → EC2 Instance Connect**, or `ssh -i pricecharm-admin.pem ec2-user@<elastic IP>`. `sudo tail -n 5 /var/log/cloud-init-output.log` should end with "Bootstrap complete". `sudo docker ps` should list `pricecharm-db`, and `systemctl list-timers` should list `quotient-backup` and `certbot-renew`. If you skipped User data, copy the script up and run `sudo bash bootstrap-ec2.sh` instead. It's safe to run again.
5. **Daily snapshots.** In **EC2 → Lifecycle Manager**, create an EBS snapshot policy for instances tagged `Name` = `pricecharm`: daily, keeping 14. With the database on the server, these are the backups that survive losing the instance. Keep retention at 30 days or less, because the privacy policy says deleted data leaves backups within 30 days.

The bootstrap installs Node 24, PM2, Nginx, certbot and its renewal timer, the nightly backup timer and MariaDB 11.4, listening only on `127.0.0.1:3306`. It creates:

- `quotient`, the user deploys log in as. It has no sudo.
- The `quotient_production` database, with a rows-only `quotefolk_app` user for the API and worker and a `quotefolk_migrate` user that only deploys use.
- `/srv/quotient-api/shared/.env`, holding the app user's settings, and `shared/migrate.env`, holding the migration user's. Both are owned by `quotient` with mode 600.

The MariaDB root password is in `/root/pricecharm/mariadb.env`.

## 3. Settings

Open the settings file: `sudo -u quotient nano /srv/quotient-api/shared/.env`. The database lines are already at the top. Paste everything from [`env.production.example`](env.production.example) below them, then fill it in. Start with `APP_ENV=staging` and Stripe test-mode values; section 6 switches to production.

The API refuses to start a deployed configuration that's only safe on a laptop. That covers demo AI, local email or payments, missing providers or `TRUST_PROXY`, `EXPOSE_DEV_TOKENS`, and a test Stripe key in production or a live one in staging. Set:

- `APP_ORIGIN=https://pricecharm.com`. Keep `HOST=127.0.0.1` and port 4100.
- `AI_PROVIDER=openai` or `anthropic`, its chat model and PriceCharm's own production API key from the [AI keys guide](../../../docs/ops/ai-keys.md). Practice photos also need `OPENAI_API_KEY` on an image-capable account, with `OPENAI_IMAGE_MODEL=gpt-image-2.5-flare` by default. Set provider spending limits and the daily call budgets.
- `MAIL_PROVIDER=ses`, the SES region as `AWS_REGION`, `SES_EMAIL_FROM` on the verified domain, and a `MAIL_ENCRYPTION_KEY` from `openssl rand -base64 32`. Save that key in your password manager: queued emails can't be decrypted without it. The same key makes the daily fingerprints that stand in for visitors' addresses in the setup and chat limits, and signs the links in customer emails, so changing it retires links already sent.
- `BILLING_PROVIDER=stripe` and the six Stripe values, using the exact setup in [COMMERCE.md](COMMERCE.md): the secret key, the webhook signing secret, the meter event name, the usage price and the monthly and yearly plan prices.
- `OPERATOR_NAME` (the legal entity), `OPERATOR_ADDRESS` (its postal address), `GOVERNING_LAW` (the US state whose laws govern the terms, such as `Texas`) and `SUPPORT_EMAIL`. All four appear in the privacy policy and terms of service, and production refuses to start without them. Replies to PriceCharm's emails go to `SUPPORT_EMAIL`, except that a customer replying to a business's email reaches that business's owner once the owner has confirmed their address.
- `TURNSTILE_SECRET_KEY` from a Cloudflare Turnstile widget. It's free, and the domain doesn't need to be on Cloudflare. Add `pricecharm.com` and `www.pricecharm.com` to the widget's hostnames and choose Managed mode. Starting setup, signup, demo chats and new customer chats need a passing check. The widget's site key goes in a GitHub variable (section 5). Staging can use Cloudflare's published test keys; production refuses them. Use the real keys from the start, because the site key is built into the web app.
- `SENTRY_DSN` from a Sentry project for the API and worker. Production refuses to start without it. Reports carry the error, its stack and the request ID, never request bodies, headers, emails or AI prompts. Add an alert rule in Sentry so a new error emails you.
- Optional: `METRICS_EMAIL`, who gets the weekly numbers on Monday mornings (section 8), and `BACKUP_BUCKET` (section 7).
- The customer chat budgets (`AI_DAILY_CUSTOMER_APP_LIMIT`, `AI_DAILY_BUSINESS_CUSTOMER_LIMIT`, `AI_DAILY_CUSTOMER_IP_LIMIT`) and the budgets for setups that haven't signed up (`AI_DAILY_DRAFT_APP_LIMIT`, `AI_DRAFT_LIFETIME_LIMIT`). The defaults are in the template and the [AI keys guide](../../../docs/ops/ai-keys.md). Never set `LOCAL_SETUPS_PER_ADDRESS` on a server. It's for local browser tests, and deployed servers ignore it.

`.env` stays on the server. It never goes into GitHub or a release. The web app calls the API at `/api/v1` on the same domain, so the browser needs no keys and the API needs no hostname of its own.

## 4. Domain and HTTPS

In the domain's DNS, turn off any forwarding or parking page. Point an A record for `pricecharm.com` at the Elastic IP, and point `www` at it too (a CNAME to `pricecharm.com` works). Wait until `dig +short pricecharm.com` returns only the Elastic IP. Then, on the server:

1. Copy only the port 80 server (and the `log_format` line) from `nginx-site.conf.example` to `/etc/nginx/conf.d/quotient.conf`, then `sudo nginx -t && sudo systemctl reload nginx`.
2. Issue one certificate for both names: `sudo certbot certonly --webroot -w /var/www/acme -d pricecharm.com -d www.pricecharm.com --email hello@pricecharm.com --agree-tos --no-eff-email`.
3. Replace the file with the whole of `nginx-site.conf.example`, run `sudo nginx -t`, and reload Nginx. `http://` and `www.` now redirect to `https://pricecharm.com`.

`certbot-renew.timer` renews the certificate, and a hook reloads Nginx when it changes. `sudo certbot renew --dry-run` checks that renewal works.

The example config logs `$uri`, leaving out query strings that carry password-reset or inquiry link tokens. Keep debug and body logging off. The API logs request IDs and error codes, never customer transcripts or provider payloads. PM2 logs rotate daily and are kept 14 days. Keep Nginx logs no longer than 30 days, which is what the privacy policy promises; they include IP addresses.

## 5. GitHub

The repository is `Mitchell-Marchand/pricecharm-hackathon`. In its settings, create a `production` environment and limit its deployment branches to `main`. Add yourself as a required reviewer if you want to approve each deploy.

Make a key just for deploys, on your own machine: `ssh-keygen -t ed25519 -N '' -C pricecharm-deploy -f pricecharm-deploy`. On the server, add the public half for the `quotient` user: `sudo -u quotient tee -a /home/quotient/.ssh/authorized_keys`, paste the contents of `pricecharm-deploy.pub`, then press Ctrl-D. In the same session, `cat /etc/ssh/ssh_host_ed25519_key.pub` prints the server's host key. Read it there rather than with `ssh-keyscan`, so a spoofed answer can't be pinned.

Production environment **secrets**:

| Name | Value |
| --- | --- |
| `EC2_HOST` | The Elastic IP |
| `EC2_USER` | `quotient` |
| `EC2_SSH_KEY` | The whole private `pricecharm-deploy` file. Delete your local copy afterwards. |
| `EC2_KNOWN_HOSTS` | The Elastic IP, a space, then the host key line, for example `203.0.113.10 ssh-ed25519 AAAA…` |

**Repository** variables:

| Name | Value |
| --- | --- |
| `TURNSTILE_SITE_KEY` | The Turnstile widget's site key. The web deploy fails without it. |
| `SENTRY_WEB_DSN` | The web app's Sentry DSN. A separate Sentry project from the API's works best. |
| `POSTHOG_KEY` | Optional, for session recordings (section 8) |
| `PUBLIC_APP_URL` | Optional. Defaults to `https://pricecharm.com`; used in link previews and the sitemap. |
| `ENABLE_DEPLOY` | `true`, once the server, settings and HTTPS are ready. It has to be a repository variable, not an environment one. |

`CI` runs on every pull request. `Deploy API` and `Deploy web` run on pushes to `main` that change their app. Run the first deploy of each by hand from the Actions tab: **Deploy API** first, then **Deploy web**.

Each API deploy checks, tests and builds the code, copies an immutable release to the server, installs its production dependencies, runs migrations as the migration user, switches `current`, restarts PM2 and checks that `/health` reports the new release. If that check fails, it restores the previous release. Migrations aren't rolled back, so they have to stay additive. [README.md](README.md) has the details.

## 6. Check it, then go live

```sh
cd /srv/quotient-api/current/apps/api
node dist/ops.js --http
sudo -u quotient pm2 status
```

Walk through it yourself in staging mode before inviting anyone. Use email addresses you've verified in SES until production access comes through.

1. In a fresh browser, start setup from the home page. Pick a trade, add two or three past jobs with photos, upload an old invoice, and finish the three practice customers. Their photos are generated by the AI and labelled as practice.
2. Create the account. Confirm the verification email arrives and its link works, then add a payment method from the "You're live" page. Sign out, reset the password from the sign-in page and sign back in.
3. On Share, save your website and copy the widget code. Paste it into a page on that site and check the button opens the chat. On any other site it should offer the quote page instead.
4. From another browser or a phone, open the quote link. Describe a job, add a photo, enter a real email you control and the code it receives. With automatic quotes off, the quote waits: check the owner email, open it signed out, sign in and land on that quote. Edit it, send it, and confirm the customer's page and email both show it.
5. Accept it from the customer's emailed link, ask for a site visit on another quote, and decline a third. Check the owner emails for each.
6. Turn automatic quotes on in Settings and request one more quote that matches your past jobs. It should go out on its own, and the owner should get the "sent" email.
7. In Settings, check this month's fees match the quotes customers received, and that your own test chats didn't count.

Then check billing with Stripe's test card `4242 4242 4242 4242`. Check out on every plan. Watch the yearly plan most closely: it puts a yearly price and the monthly usage price on one subscription. Confirm a billable quote shows up on the Stripe meter, and that resending a webhook from the Stripe dashboard doesn't count anything twice. Confirm the fees shown match the invoice.

To go live:

1. Wait for SES production access.
2. While Stripe is still in test mode, delete your test business from Settings. Otherwise its test-mode Stripe IDs stay in the live database.
3. Set up Stripe again in live mode: the meter, the three prices, the customer portal and the webhook, which has its own signing secret.
4. In `.env`, set `APP_ENV=production`, switch all six Stripe values to the live ones together, and check `OPERATOR_*`, `SUPPORT_EMAIL` and `SENTRY_DSN` are filled in. Restart with `sudo -u quotient pm2 restart quotient-api quotient-worker`, then run `node dist/ops.js --http` again. If the API refuses a setting, `sudo -u quotient pm2 logs quotient-api` says which.
5. Send one real quote to an address of yours that isn't verified in SES. Confirm the email arrives and the fee shows up in live Stripe.
6. Add an external HTTPS uptime monitor for `https://pricecharm.com`.

Automated tests use local providers and mocks. They never send real email or charge cards.

## 7. Backups and daily operations

There are two layers of backup:

- **Disk snapshots** (section 2, step 5) capture the whole server once a day: the database, photos and settings.
- **A nightly database dump.** The `quotient-backup.timer` runs `deploy/ops/nightly-backup.sh` as `quotient`. `backup.py` writes a compressed, mode 600 dump to `/srv/quotient-api/shared/backups`, and the server keeps a week of them. If `BACKUP_BUCKET` is set, each dump is also copied there. For that, create a private bucket, give it a lifecycle rule that deletes objects after 28 days, and add `s3:PutObject` on `arn:aws:s3:::BUCKET/database/*` to the `pricecharm-server` role.

Check the timer with `systemctl list-timers quotient-backup.timer` and `journalctl -u quotient-backup`. Run it now with `sudo systemctl start quotient-backup`. Nothing alerts on a failed backup yet, so look now and then. Keep `MAIL_ENCRYPTION_KEY` and the MariaDB root password (`/root/pricecharm/mariadb.env`) in your password manager too.

Practise a restore before launch, into a **separate** database, never over the live one:

```sh
sudo docker exec pricecharm-db sh -c 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb -uroot -e "CREATE DATABASE quotient_restore_test"'
gunzip -c /srv/quotient-api/shared/backups/<dump>.sql.gz \
  | sudo docker exec -i pricecharm-db sh -c 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb -uroot quotient_restore_test'
```

Check the table counts, then drop `quotient_restore_test`. A backup can still hold data that was deleted since it was taken. Don't bring deleted accounts back when restoring.

Run `node dist/ops.js --http` regularly. It reports schema status, failed or late jobs, uncertain mail and delayed usage dispatch, without customer content. Investigate failures before retrying. Email whose delivery outcome is unknown is held for checking against SES, so a retry can't send a private link twice. Meter events have stable identifiers and fees fixed when they're recorded. COMMERCE.md covers reconciliation, refunds and cancellation.

One server is a single point of failure, and a PM2 restart can interrupt requests briefly. Keep dependencies patched and watch disk space, provider spend and failed jobs.

## 8. Metrics and session recordings

PriceCharm records how it's used in its own database, in `product_events`:

- **From the server**, with the facts at that moment: setup started, every business-details save (trade, services, area, radius), every step, each past job added, edited or deleted (service, price, which fields were filled, how many photos), invoice uploads and whether the AI could read them, every practice answer and practice quote (the owner's price, the Charm's own guess and the gap between them), settings changes, sign-ins, checkout, going live, share settings, owners approving quotes (from the app or the email link, whether they changed the price and by how much, how long the customer waited), customer requests and their steps, and every AI call (operation, model, seconds, tokens) or failure.
- **From the browser**, outside quote links and the website widget: each visit's start (referrer, campaign, device, screen size), every screen with the time someone actually worked on it and how far they scrolled, every click (the button's words and where it was), every field (how long it took and whether it was filled, never what's in it), error messages shown, failed and slow requests, rage clicks, clicks on things that do nothing, page crashes and the tab going to the background.

A random id per browser tab joins what someone did before they had a setup to what they did after, and server events carry the same id. Records hold no names, contact details or messages; email addresses and phone numbers are scrubbed from any text. Each business's records are filed under a random tag that's deleted with the business. Browser events are deleted after 400 days. Visits to the public pages are also counted without cookies, using a daily keyed hash of the visitor's address and browser.

```sh
cd /srv/quotient-api/current/apps/api
node dist/metrics-report.js            # the last 7 days, compared with the 7 before
node dist/metrics-report.js --days 30  # or --json
```

The report covers setups by trade and how far each got, past jobs given, real time spent working in setup, the last screen, click and error for everyone who left before making an account, practice guesses within 10% of the owner's price, time per screen, error messages, failed and slow requests, rage and dead clicks, owner approvals and edits, the customer funnel and AI speed and tokens. Set `METRICS_EMAIL` to get it every Monday.

**Session recordings (PostHog).** Create a PostHog account in its US cloud and a project called PriceCharm. In the project settings:

- Turn on session replay, autocapture, heatmaps and dead-click capture.
- Set recording retention to 30 days. The privacy policy says recordings are kept 30 days.
- Turn on discarding client IP addresses.

Put the project API key in the `POSTHOG_KEY` repository variable; the web build reads it. Recordings run only on the owner side and the marketing pages, never on quote links, the website widget or pages opened from a one-time link. Typing is masked everywhere, and so are customers' names, messages and photos in the owner app. Browsers that send Do Not Track or Global Privacy Control aren't recorded. Visitors whose clock is set to Europe or the UK are asked first, and nothing in the browser is tracked until they agree. Requests go through `pricecharm.com/ingest`, so ad blockers don't drop them. Each recording is filed under the same random tag as the setup, so a setup in the report can be found in PostHog.
