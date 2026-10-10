# Squad C2 - one-shot setup and run (Windows)
# Creates backend\.venv, installs Python libs, builds the Angular COP, starts the server.
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }

Step "Checking Python"
$py = $null
foreach ($c in @("py -3", "python")) {
  try { $v = & cmd /c "$c --version" 2>&1; if ($LASTEXITCODE -eq 0 -and $v -match "Python 3\.(\d+)") { if ([int]$Matches[1] -ge 11) { $py = $c; Write-Host "$c -> $v"; break } } } catch {}
}
if (-not $py) { Write-Host "Python 3.11+ not found. Install from https://www.python.org/downloads/ and re-run." -ForegroundColor Red; exit 1 }

Step "Creating virtual environment (backend\.venv)"
if (-not (Test-Path "backend\.venv\Scripts\python.exe")) { & cmd /c "$py -m venv backend\.venv"; if ($LASTEXITCODE) { exit 1 } }
$vpy = Join-Path $root "backend\.venv\Scripts\python.exe"

Step "Installing Python libraries"
& $vpy -m pip install --upgrade pip -q
& $vpy -m pip install -r backend\requirements.txt
if ($LASTEXITCODE) { exit 1 }

Step "Running backend tests"
Push-Location backend; & $vpy -m pytest -q tests; Pop-Location

if (Test-Path "frontend\dist\frontend\browser\index.html") {
  Step "Frontend already built (frontend\dist) - skipping npm"
} else {
  Step "Building Angular COP (needs Node.js 22)"
  Push-Location frontend
  & npm install; if ($LASTEXITCODE) { Pop-Location; exit 1 }
  & npx ng build; if ($LASTEXITCODE) { Pop-Location; exit 1 }
  Pop-Location
}

Step "Starting server -> http://localhost:8000  (Ctrl+C to stop)"
Push-Location backend
Start-Job -ScriptBlock { Start-Sleep 4; Start-Process "http://localhost:8000" } | Out-Null
& $vpy -m uvicorn app.main:app --host 127.0.0.1 --port 8000
Pop-Location
