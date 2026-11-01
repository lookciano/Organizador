#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p node_modules/.cache
validation_dir=$(mktemp -d "$PWD/node_modules/.cache/tidb-validation.XXXXXX")
validation_container=''
cleanup() {
  if [ -n "$validation_container" ]; then docker rm -f "$validation_container" >/dev/null; fi
  rm -rf "$validation_dir"
}
trap cleanup EXIT
cat > "$validation_dir/openssl.cnf" <<'EOF'
[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=localhost
[ext]
subjectAltName=DNS:localhost,IP:127.0.0.1
basicConstraints=critical,CA:TRUE
keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign
EOF
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -config "$validation_dir/openssl.cnf" -keyout "$validation_dir/server-key.pem" -out "$validation_dir/server.pem" >/dev/null 2>&1
cat > "$validation_dir/tidb.toml" <<'EOF'
host = "0.0.0.0"
store = "unistore"
path = "/tmp/pr1-validation"
enable-telemetry = false
[security]
ssl-cert = "/validation/server.pem"
ssl-key = "/validation/server-key.pem"
tls-version = "TLSv1.2"
[log]
level = "warn"
[performance]
max-procs = 2
EOF
validation_container=$(docker run -d --publish 127.0.0.1::4000 --mount "type=bind,src=$validation_dir,dst=/validation,readonly" pingcap/tidb:v8.5.3@sha256:00f015520ce91734c3fbec720f23448e790e691655c7e181544a620872a00c61 --config=/validation/tidb.toml)
validation_port=$(docker port "$validation_container" 4000/tcp | sed 's/.*://')
export NODE_EXTRA_CA_CERTS="$validation_dir/server.pem"
export TEST_DATABASE_URL="mysql://root@127.0.0.1:$validation_port/pr1_validation_disposable"
node --input-type=module <<'JS'
import mysql from 'mysql2/promise';
const url = new URL(process.env.TEST_DATABASE_URL);
for (let attempt = 0; attempt < 120; attempt++) {
  try {
    const connection = await mysql.createConnection({host:url.hostname,port:Number(url.port),user:'root',ssl:{rejectUnauthorized:true},connectTimeout:1000});
    await connection.end(); process.exit(0);
  } catch { await new Promise(resolve => setTimeout(resolve, 500)); }
}
throw new Error('The disposable TiDB instance did not become ready');
JS
npm run test:integration
