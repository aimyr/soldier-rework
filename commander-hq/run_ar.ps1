# Phone AR + GPS on Windows. Usage: .\run_ar.ps1 [laptop-ip]
param([string]$LaptopIp = "", [int]$Port = 8443)
$ErrorActionPreference = "Stop"
$taskRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Join-Path $taskRoot "backend")
$taskPython = Join-Path (Get-Location) ".venv\Scripts\python.exe"
if (-not (Test-Path $taskPython)) {
    & py -3 -m venv .venv
    if ($LASTEXITCODE) { throw "Python 3.11+ is required." }
}
& $taskPython -m pip install -q -r requirements.txt
if ($LASTEXITCODE) { throw "Could not install backend packages." }
if (-not $LaptopIp) {
    $LaptopIp = & $taskPython -c "from tools.make_cert import primary_ipv4; print(primary_ipv4() or '127.0.0.1')"
}
& $taskPython tools\make_cert.py $LaptopIp
if ($LASTEXITCODE) { throw "Could not create the HTTPS certificate." }
Write-Host "Phone AR: https://${LaptopIp}:$Port/ar" -ForegroundColor Cyan
Write-Host "GPS only: https://${LaptopIp}:$Port/gps"
Write-Host "Laptop monitor: https://localhost:$Port/gps/pc"
Write-Host "Use the same Wi-Fi. Install and trust backend\certs\root-ca.cer on the phones; see README for iPhone steps."
Write-Host "Allow inbound TCP $Port from the local subnet in Windows Firewall if phones cannot connect."
& $taskPython -m uvicorn app.main:app --host 0.0.0.0 --port $Port --ssl-keyfile certs\key.pem --ssl-certfile certs\cert.pem
if ($LASTEXITCODE) { throw "AR server exited with an error." }
