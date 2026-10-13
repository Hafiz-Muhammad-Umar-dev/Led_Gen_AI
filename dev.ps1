# LeadGen AI — Dev Startup
# Starts the backend (0.0.0.0:8000, auto-reload) and frontend (0.0.0.0:3000)
# each in their own window, so the app is reachable from other devices on
# the network without having to remember the --host flag every day.
# `npm run dev` in frontend/ also launches the WhatsApp (Baileys) microservice
# (localhost:3001) alongside react-scripts via `concurrently` — see
# frontend/whatsapp-service/.
# Usage: .\dev.ps1

$root = $PSScriptRoot

Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\backend'; .\.venv\Scripts\python.exe main.py"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\frontend'; npm run dev"

Write-Host "Backend starting on http://0.0.0.0:8000 (reachable via this PC's LAN IP)" -ForegroundColor Green
Write-Host "Frontend + WhatsApp service starting on http://0.0.0.0:3000 and http://localhost:3001" -ForegroundColor Green
