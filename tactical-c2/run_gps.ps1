# Start the backend on HTTPS :8443 so a phone can open https://<laptop-ip>:8443/gps
# (browsers block Geolocation on plain http except localhost). Run setup_and_run.ps1 once first.
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Join-Path $root "backend")
$py = ".\.venv\Scripts\python.exe"
& $py -m pip install -q "cryptography>=42"
if (-not (Test-Path ".\certs\cert.pem")) { & $py tools\make_cert.py }
Write-Host "COP  -> https://localhost:8443        Phone -> https://<this-laptop-ip>:8443/gps" -ForegroundColor Cyan
Write-Host "Windows may ask to allow Python through the firewall: allow on Private networks." -ForegroundColor Yellow
& $py -m uvicorn app.main:app --host 0.0.0.0 --port 8443 --ssl-keyfile certs\key.pem --ssl-certfile certs\cert.pem
