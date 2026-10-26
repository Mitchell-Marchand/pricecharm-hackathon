#!/usr/bin/env python3
"""Back up only the isolated Quotient DB using an env file. Secrets never enter argv or logs."""
import argparse, datetime, gzip, os, pathlib, re, subprocess, tempfile
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--env',type=pathlib.Path,default=pathlib.Path('/srv/quotient-api/shared/.env'))
p.add_argument('--output',type=pathlib.Path,default=pathlib.Path('/srv/quotient-api/shared/backups'))
a=p.parse_args()
v={}
for line in a.env.read_text().splitlines():
 if '=' in line and not line.lstrip().startswith('#'):
  k,value=line.split('=',1);v[k.strip()]=value.strip().strip('\"\'')
name=v.get('DB_NAME','')
if not re.fullmatch(r'quot(?:ient|ing)[a-zA-Z0-9_-]*',name) or 'golf' in name.lower():raise SystemExit('Refusing backup outside the dedicated Quotient namespace.')
a.output.mkdir(parents=True,exist_ok=True,mode=0o700)
def escaped(value):
 if '\n' in value or '\r' in value:raise SystemExit('Database options cannot contain newlines.')
 return '"'+value.replace('\\','\\\\').replace('"','\\"')+'"'
with tempfile.TemporaryDirectory(prefix='quotient-backup-') as directory:
 config=pathlib.Path(directory)/'client.cnf'
 options={'host':v.get('DB_HOST','127.0.0.1'),'port':v.get('DB_PORT','3306'),'user':v.get('DB_USER',''),'password':v.get('DB_PASS','')}
 config.write_text('[client]\n'+''.join(k+'='+escaped(value)+'\n' for k,value in options.items()))
 config.chmod(0o600)
 stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
 target=a.output/(name+'-'+stamp+'.sql.gz');partial=target.with_suffix('.partial')
 command=['mariadb-dump','--defaults-extra-file='+str(config),'--single-transaction','--quick','--skip-lock-tables','--no-tablespaces','--hex-blob',name]
 if v.get('DB_SSL')=='1':
  command.insert(2,'--ssl-verify-server-cert')
  if v.get('DB_SSL_CA_FILE'):command.insert(2,'--ssl-ca='+v['DB_SSL_CA_FILE'])
 try:
  with partial.open('xb') as raw:
   os.chmod(partial,0o600)
   # Stream compression instead of buffering an entire customer database in RAM.
   process=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
   with gzip.GzipFile(fileobj=raw,mode='wb') as compressed:
    while chunk:=process.stdout.read(1024*1024):compressed.write(chunk)
   errors=process.stderr.read();result=process.wait()
   if result:raise RuntimeError('Database dump failed. Check connectivity and the dedicated DB user permissions.')
  partial.replace(target)
 except Exception:
  partial.unlink(missing_ok=True);raise
 print(str(target))
