# Start the server only (after setup_and_run.ps1 has been run once)
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Join-Path $root "backend")
Write-Host "Squad C2 -> http://localhost:8000  (Ctrl+C to stop)" -ForegroundColor Cyan
& ".\.venv\Scripts\python.exe" -m uvicorn app.main:app --host 127.0.0.1 --port 8000
