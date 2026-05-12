# Tenure Windows Uninstaller
# Run with: powershell -ExecutionPolicy Bypass -File uninstall.ps1

$ErrorActionPreference = "Stop"

$InstallDir = "$env:USERPROFILE\.tenure"
$ComposeFile = "$InstallDir\docker-compose.yml"

function Write-Info { param($msg) Write-Host $msg -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "Warning: $msg" -ForegroundColor Yellow }
function Write-Err  { param($msg) Write-Host "Error: $msg" -ForegroundColor Red }

if (-not (Test-Path $ComposeFile)) {
  Write-Err "No Tenure installation found at $InstallDir"
  exit 1
}

Write-Host ""
Write-Warn "This will permanently delete Tenure and all of your belief data."
Write-Host ""
Write-Host "  This includes:"
Write-Host "    - All beliefs, sessions, and compaction history"
Write-Host "    - Your provider credentials"
Write-Host "    - All configuration"
Write-Host ""
Write-Host "  If you have not exported a backup, your world model cannot be recovered."
Write-Host "  Export first at: http://localhost:5757/admin/backup"
Write-Host ""
$reply = Read-Host "  Type 'yes' to confirm uninstall"

if ($reply -ne "yes") {
  Write-Host "Aborted."
  exit 0
}

Write-Host ""
Write-Info "Stopping containers and removing volumes..."
docker compose -f "$ComposeFile" down -v 2>$null

Write-Info "Removing $InstallDir..."
Remove-Item -Recurse -Force $InstallDir

Write-Host ""
Write-Info "Tenure has been uninstalled."
Write-Host ""