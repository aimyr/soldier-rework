#!/bin/sh
# Phone AR + GPS, same local backend; no Angular build is needed.
set -eu
task_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$task_root/backend"
if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
fi
.venv/bin/python -m pip install -q -r requirements.txt
task_ip=${1:-$(.venv/bin/python -c 'from tools.make_cert import primary_ipv4; print(primary_ipv4() or "127.0.0.1")')}
task_port=${AR_PORT:-8443}
.venv/bin/python tools/make_cert.py "$task_ip"
printf 'Phone AR: https://%s:%s/ar\nGPS only: https://%s:%s/gps\nLaptop monitor: https://localhost:%s/gps/pc\n' "$task_ip" "$task_port" "$task_ip" "$task_port" "$task_port"
printf 'Use the same Wi-Fi. Install and trust certs/root-ca.cer on each phone before enabling camera/GPS. See README for iPhone trust steps.\n'
exec .venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port "$task_port" --ssl-keyfile certs/key.pem --ssl-certfile certs/cert.pem
