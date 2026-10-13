# LeadGen AI — Production Startup
# Builds the React frontend, then serves everything from FastAPI on port 8000.
# Usage: .\start.ps1

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

Write-Host ""
Write-Host "=== LeadGen AI — Production Build ===" -ForegroundColor Cyan

# 1. Build React frontend
Write-Host "`n[1/3] Building React frontend..." -ForegroundColor Yellow
Set-Location "$root\frontend"
npm run build
if ($LASTEXITCODE -ne 0) { Write-Host "Frontend build failed." -ForegroundColor Red; exit 1 }
Write-Host "Frontend built successfully." -ForegroundColor Green

# 2. Start the WhatsApp (Baileys) microservice in the background
# (not part of the React build — it's a separate Node runtime process)
Write-Host "`n[2/3] Starting WhatsApp service on http://localhost:3001 ..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\frontend\whatsapp-service'; npm start"

# 3. Start FastAPI (serves API + built frontend)
Write-Host "`n[3/3] Starting FastAPI on http://localhost:8000 ..." -ForegroundColor Yellow
Set-Location "$root\backend"
& ".\.venv\Scripts\uvicorn.exe" main:app --host 0.0.0.0 --port 8000
