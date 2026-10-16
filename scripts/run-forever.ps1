# Keeps the engine running 24/7: restarts it whenever it exits, with a short
# back-off so a crash loop cannot hammer the exchange.
#   powershell -ExecutionPolicy Bypass -File scripts\run-forever.ps1
Set-Location (Split-Path $PSScriptRoot -Parent)
if (-not (Test-Path 'web\dist\index.html')) { npm run build }
$delay = 2
while ($true) {
  $started = Get-Date
  node server/index.js
  $ran = ((Get-Date) - $started).TotalSeconds
  if ($ran -gt 300) { $delay = 2 } else { $delay = [Math]::Min($delay * 2, 120) }
  Write-Host "Engine exited after $([int]$ran)s; restarting in $delay s" -ForegroundColor Yellow
  Start-Sleep -Seconds $delay
}
