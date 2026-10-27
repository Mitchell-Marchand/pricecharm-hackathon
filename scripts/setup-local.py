#!/usr/bin/env python3
"""Create local PriceCharm configuration without printing credentials.

By default the API uses PriceCharm's own MariaDB container (`npm run db:start`). Pass
--database local-server to provision a database on a MariaDB server already running on this
machine instead. Provider keys are never copied from another product: add PriceCharm's own dev
keys to apps/api/.env yourself (see docs/ops/ai-keys.md).
"""
from pathlib import Path
import argparse, os, re, secrets, shutil, subprocess

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument('--database', choices=('container', 'local-server'), default='container',
                    help='container: the docker compose MariaDB on port 3307 (default). '
                         'local-server: create ONLY the quoting_engine database and user on a MariaDB server on this machine.')
parser.add_argument('--port', default='3306', help='Port of the local MariaDB server when using --database local-server.')
args = parser.parse_args()
workspace = Path(__file__).resolve().parent.parent


def parse_env(path):
    result = {}
    if path.exists():
        for line in path.read_text().splitlines():
            if '=' in line and not line.lstrip().startswith('#'):
                key, value = line.split('=', 1)
                result[key.strip()] = value.strip().strip('"\'')
    return result


api_path = workspace / 'apps' / 'api' / '.env'
existing = parse_env(api_path)
if args.database == 'container':
    database = {'DB_HOST': '127.0.0.1', 'DB_PORT': '3307', 'DB_NAME': 'quoting_engine',
                'DB_USER': 'quoting_engine', 'DB_PASS': 'local-dev-only'}
else:
    db_password = existing.get('DB_PASS') if existing.get('DB_NAME') == 'quoting_engine' else secrets.token_urlsafe(32)
    if not db_password or not re.fullmatch(r'[A-Za-z0-9_\-]+', db_password):
        raise SystemExit('Local dedicated DB password must use URL-safe characters.')
    mysql = shutil.which('mysql')
    if not mysql:
        raise SystemExit('Install a MySQL/MariaDB client first.')
    # These identifiers are fixed to prevent accidental access to another app database.
    sql = "CREATE DATABASE IF NOT EXISTS quoting_engine CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n"
    for host in ('localhost', '127.0.0.1'):
        sql += f"CREATE USER IF NOT EXISTS 'quoting_engine'@'{host}' IDENTIFIED BY '{db_password}';\n"
        sql += f"GRANT ALL PRIVILEGES ON quoting_engine.* TO 'quoting_engine'@'{host}';\n"
    run = subprocess.run([mysql, '--user=root', '--connect-timeout=5', f'--port={args.port}', '--host=127.0.0.1'],
                         input=sql, text=True, capture_output=True, timeout=15)
    if run.returncode:
        raise SystemExit('Local database setup failed: ' + run.stderr.replace(db_password, '[redacted]'))
    database = {'DB_HOST': '127.0.0.1', 'DB_PORT': args.port, 'DB_NAME': 'quoting_engine',
                'DB_USER': 'quoting_engine', 'DB_PASS': db_password}

values = {
    'APP_ENV': 'local', 'NODE_ENV': 'development', 'PORT': '4100', 'APP_ORIGIN': 'http://localhost:3100',
    'PUBLIC_APP_URL': 'http://localhost:3100', 'EXPOSE_DEV_TOKENS': '1',
    'DB_CONNECTION_LIMIT': '5', 'AI_PROVIDER': 'openai', 'OPENAI_MODEL': 'gpt-4.1-mini',
    'ANTHROPIC_MODEL': 'claude-sonnet-4-5', 'AI_TIMEOUT_MS': '25000',
    'AI_MAX_OUTPUT_TOKENS': '1200', 'AI_MAX_TURNS': '40',
    'MAIL_PROVIDER': 'local', 'BILLING_PROVIDER': 'local',
    'SESSION_SECRET': secrets.token_urlsafe(48),
    'OPENAI_API_KEY': '', 'ANTHROPIC_API_KEY': '',
}
# Keep settings from earlier runs (including keys you added), then apply the chosen database.
values.update(existing)
values.update(database)
for key, value in values.items():
    if '\n' in value or '\r' in value:
        raise SystemExit('Multiline environment values are unsupported.')
api_path.parent.mkdir(parents=True, exist_ok=True)
fd = os.open(api_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as out:
    for key, value in values.items():
        out.write(f'{key}={value}\n')
os.chmod(api_path, 0o600)
web_path = workspace / 'apps' / 'web' / '.env.local'
if not web_path.exists():
    fd = os.open(web_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as out:
        out.write('API_BASE_URL=http://127.0.0.1:4100\nNEXT_PUBLIC_APP_URL=http://localhost:3100\n')
print('Local configuration ready in apps/api/.env. Values were not printed.')
print(f"Database: {database['DB_NAME']} on {database['DB_HOST']}:{database['DB_PORT']}.")
if not values.get('OPENAI_API_KEY') and not values.get('ANTHROPIC_API_KEY'):
    print("Add PriceCharm's own dev AI keys to apps/api/.env (docs/ops/ai-keys.md), or set AI_PROVIDER=demo.")
print('Next: npm run migrate --workspace @pricecharm/api, then npm run dev.')
