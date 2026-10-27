# PriceCharm's database

PriceCharm keeps its data in a database server of its own.

## Production

The CloudFormation template at `apps/api/deploy/infra/cloudformation.json` creates the database when `DatabaseMode` is `dedicated` (the default):

- A private RDS MariaDB 11.4 instance that only the PriceCharm app server's security group can reach.
- TLS required for every connection (`require_secure_transport=ON`), encrypted storage, and 14 days of automated backups with point-in-time restore.
- Deletion protection, plus a final snapshot if the stack ever deletes or replaces the instance.
- An admin password that RDS keeps in Secrets Manager. It never appears in the template or in GitHub.
- Alarms for CPU, free storage and connection count. They notify `AlarmTopicArn` if you set it.

Set `DbSubnetIds` to two or more private subnets in different Availability Zones. The defaults for size (`db.t4g.small`), storage (20 GiB, autoscaling to 100) and single-AZ are fine for launch. Set `DbMultiAz=true` when downtime costs more than the doubled bill. If CloudFormation rejects `DbEngineVersion=11.4`, use the full version RDS lists for MariaDB 11.4.

### Create the two users

The app gets two database users:

| User | Used by | Can do |
| --- | --- | --- |
| `quotefolk_app` | The running API and worker | Read and write rows. TLS only, at most 20 connections. |
| `quotefolk_migrate` | Deployments, to run migrations | Change the schema as well. TLS only, at most 2 connections. |

The full API test suite passes with a rows-only user, and the nightly backup works with it. The one exception is a test fixture that creates a trigger.

1. Read the admin password from the secret in the stack's `DatabaseAdminSecretArn` output (Secrets Manager console, or `aws secretsmanager get-secret-value --secret-id <arn>`).
2. Open a session on the app server with SSM Session Manager. The bootstrap script installed the `mariadb` client and the RDS certificate bundle at `/etc/pki/rds/global-bundle.pem`.
3. Make a private copy of `apps/api/deploy/sql/create-database-users.sql` and replace both passwords (`openssl rand -base64 32` works). Run it:

   ```sh
   mariadb --ssl-ca=/etc/pki/rds/global-bundle.pem --ssl-verify-server-cert \
     -h <DatabaseEndpoint> -u quotefolk_admin -p < create-database-users.sql
   ```

   Then delete the copy.
4. Put the app user in `/srv/quotient-api/shared/.env`, starting from `apps/api/deploy/env.production.example`. Keep `DB_SSL=1` and `DB_SSL_CA_FILE=/etc/pki/rds/global-bundle.pem`.
5. Put the migration user in `/srv/quotient-api/shared/migrate.env`, starting from `apps/api/deploy/migrate.env.example`. Both files are owned by `quotient` with mode 600.

The API refuses to start on a deployed server when `DB_SSL` is off for a remote database. The deploy script refuses to run without `shared/migrate.env`, and migrations refuse to run as the app user.

### Backups and restores

RDS takes automated backups. `apps/api/deploy/ops/backup.py` adds a nightly logical dump using the app user. Copy those dumps off the host.

Practice a restore before launch: restore a snapshot to a new instance, or load a dump into a separate `quotient_restore_…` database. Never restore over the live database.

## Local development

`npm run db:start` runs PriceCharm's own MariaDB 11.4 in Docker on `127.0.0.1:3307`, separate from any other app's local database. It has two databases:

- `quoting_engine` for development.
- `quoting_test`, a throwaway database for tests.

The credentials in `docker-compose.yml` are local-only and published on this machine only.

To use it for development, set these in `apps/api/.env` and run `npm run migrate --workspace @pricecharm/api`:

```sh
DB_HOST=127.0.0.1
DB_PORT=3307
DB_NAME=quoting_engine
DB_USER=quoting_engine
DB_PASS=local-dev-only
```

To bring existing local data across from the shared MariaDB server, dump it and load it into the container:

```sh
mariadb-dump --single-transaction quoting_engine \
  | docker exec -i quotefolk-db mariadb -uquoting_engine -plocal-dev-only quoting_engine
```

Uploaded photos stay in `apps/api/var/uploads`.

Tests never use your development data:

- `npm run test:db` runs every API test, including the database tests, against `quoting_test`.
- `bash scripts/e2e.sh` runs the browser tests against it, on ports 3300 and 4200.
