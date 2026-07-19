param(
  [Parameter(Mandatory = $true)]
  [string]$EnvPath
)

$ErrorActionPreference = "Stop"

function Set-DotEnvValue([string]$content, [string]$key, [string]$value) {
  $line = if ($value -match '[\s#"]') {
    ('{0}="{1}"' -f $key, ($value -replace '\\', '\\' -replace '"', '\"'))
  } else {
    ('{0}={1}' -f $key, $value)
  }
  $pattern = '(?m)^' + [regex]::Escape($key) + '=.*$'
  if ($content -match $pattern) {
    return [regex]::Replace($content, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $line })
  }
  $trimmed = $content.TrimEnd()
  if ($trimmed.Length -eq 0) { return $line + "`r`n" }
  return $trimmed + "`r`n" + $line + "`r`n"
}

Write-Host ""
$key = Read-Host "  AGENT_API_KEY (Cursor Integrations dashboard)"
$acs = Read-Host "  ACCESS_TOKEN (password for web UI; empty = generate)"

if ([string]::IsNullOrWhiteSpace($acs)) {
  $bytes = New-Object byte[] 18
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $acs = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', 'x').Replace('/', 'y')
  Write-Host "  ACCESS_TOKEN generated: $acs"
}

$content = Get-Content -Raw -Path $EnvPath
if ($null -eq $content) { $content = "" }

if (-not [string]::IsNullOrWhiteSpace($key)) {
  $content = Set-DotEnvValue $content "AGENT_API_KEY" $key.Trim()
}
$content = Set-DotEnvValue $content "ACCESS_TOKEN" $acs.Trim()

# UTF-8 without BOM (Node dotenv-friendly)
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText((Resolve-Path $EnvPath), $content, $utf8)
Write-Host "  Wrote keys to $EnvPath"
