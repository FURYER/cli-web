param(
  [Parameter(Mandatory = $true)]
  [string]$RepoDir,
  [Parameter(Mandatory = $false)]
  [string]$OutPath = ""
)

$ErrorActionPreference = "Stop"

if (-not $OutPath) {
  $OutPath = Join-Path $env:USERPROFILE ".webcli\mcp.json"
}

$dir = Split-Path -Parent $OutPath
if (-not (Test-Path -LiteralPath $dir)) {
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

if (Test-Path -LiteralPath $OutPath) {
  try {
    $existing = Get-Content -Raw -LiteralPath $OutPath | ConvertFrom-Json
    $count = 0
    if ($existing.mcpServers) {
      $count = @($existing.mcpServers.PSObject.Properties).Count
    }
    if ($count -gt 0) {
      Write-Host "MCP config already exists ($count servers): $OutPath"
      exit 0
    }
  } catch {
    # rewrite broken/empty file
  }
}

$board = (Join-Path $RepoDir "packages\workspace-board-mcp\dist\index.js") -replace '\\', '/'
$json = @"
{
  "mcpServers": {
    "context7": {
      "type": "http",
      "url": "https://mcp.context7.com/mcp",
      "headers": {
        "CONTEXT7_API_KEY": "`${CONTEXT7_API_KEY}"
      }
    },
    "workspace-board": {
      "command": "node",
      "args": [
        "$board"
      ]
    }
  }
}
"@

$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($OutPath, $json.Trim() + "`r`n", $utf8)
Write-Host "Wrote default MCP config: $OutPath"
Write-Host "  Set CONTEXT7_API_KEY in .env for Context7 docs."
