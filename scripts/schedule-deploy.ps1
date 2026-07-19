param(
  [int]$Port = 8787,
  # Kept for CLI compat; server ignores delay and restarts on idle.
  [int]$DelayMinutes = 0
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root ".env"))) {
  $root = $PSScriptRoot
  if (-not (Test-Path (Join-Path $root ".env"))) {
    Write-Error "Cannot find .env"
    exit 1
  }
}

$token = $null
Get-Content (Join-Path $root ".env") | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith("#")) { return }
  if ($line -match '^\s*ACCESS_TOKEN\s*=\s*(.*)$') {
    $token = $Matches[1].Trim()
    if (
      ($token.StartsWith('"') -and $token.EndsWith('"')) -or
      ($token.StartsWith("'") -and $token.EndsWith("'"))
    ) {
      $token = $token.Substring(1, $token.Length - 2)
    }
  }
}

if (-not $token) {
  Write-Error "ACCESS_TOKEN missing in .env"
  exit 1
}

$url = "http://127.0.0.1:$Port/api/admin/deploy"
$body = @{ delayMinutes = $DelayMinutes } | ConvertTo-Json
try {
  $res = Invoke-RestMethod -Method Post -Uri $url -Headers @{
    Authorization = "Bearer $token"
  } -ContentType "application/json" -Body $body -TimeoutSec 10
} catch {
  $msg = $_.Exception.Message
  if ($_.ErrorDetails.Message) { $msg = $_.ErrorDetails.Message }
  if ($msg -match '404|Not Found|Cannot POST|ECONNREFUSED') {
    Write-Host ""
    Write-Host "Release on :$Port does not support deploy API yet (or is down)."
    Write-Host "One-time step: stop the release window and run start-prod.bat again."
    Write-Host "After that, promote-to-release.bat will schedule restarts safely."
    Write-Host ""
  }
  Write-Error $msg
  exit 1
}

if ($res.waitingForIdle) {
  Write-Host "Scheduled. Waiting for active run(s) to finish, then restarting."
} elseif ($res.scheduled) {
  Write-Host "Scheduled. Restarting release now…"
} else {
  Write-Host ($res | ConvertTo-Json -Compress)
}
if ($res.message) { Write-Host $res.message }
exit 0
