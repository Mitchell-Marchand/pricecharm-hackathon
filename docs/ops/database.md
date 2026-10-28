# PriceCharm's database

PriceCharm keeps its data in a database server of its own.

## Production

The database runs on PriceCharm's own server, in Docker: MariaDB 11.4, the version CI tests against. [`bootstrap-ec2.sh`](../../apps/api/deploy/bootstrap-ec2.sh) sets it up. It listens only on `127.0.0.1:3306`, so nothing outside the server can reach it. Its files are in `/srv/mariadb`, and the root password is in `/root/pricecharm/mariadb.env`.

The app gets two database users, which the bootstrap creates on its first run:

| User | Used by | Can do |
| --- | --- | --- |
| `quotefolk_app` | The running API and worker | Read and write rows, at most 20 connections. |
| `quotefolk_migrate` | Deployments, to run migrations | Change the schema as well, at most 2 connections. |

The bootstrap writes the app user's settings at the top of `/srv/quotient-api/shared/.env` and the migration user's into `shared/migrate.env`. Both files are owned by `quotient` with mode 600. The deploy script refuses to run without `shared/migrate.env`, and migrations refuse to run as the app user. The full API test suite passes with a rows-only user, and the nightly backup works with it. The one exception is a test fixture that creates a trigger.

Traffic to the database never leaves the server, so it doesn't use TLS. If the database ever moves to its own host, set `DB_SSL=1`. The API refuses an unencrypted connection to any database that isn't on the same machine.

To open a database prompt on the server:

```sh
sudo docker exec -it pricecharm-db sh -c 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb -uroot quotient_production'
```

### Backups and restores

Daily snapshots of the server's disk cover the database along with everything else ([LAUNCH.md](../../apps/api/deploy/LAUNCH.md) section 2). On top of that, `apps/api/deploy/ops/backup.py` writes a nightly logical dump as the app user, and the server keeps a week of them. Set `BACKUP_BUCKET` to copy each one to S3 as well.

Practise a restore before launch by loading a dump into a separate `quotient_restore_…` database (LAUNCH.md section 7). Never restore over the live database.

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
