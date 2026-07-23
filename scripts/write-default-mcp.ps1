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

$board = (Join-Path $RepoDir "packages\workspace-board-mcp\dist\index.js") -replace '\\', '/'
$profileDir = (Join-Path $env:USERPROFILE ".webcli\browser-profiles\default") -replace '\\', '/'
$playwrightArgs = @("-y", "@playwright/mcp@latest", "--user-data-dir=$profileDir")

function Get-DefaultServers {
  return [ordered]@{
    context7 = [ordered]@{
      type = "http"
      url = "https://mcp.context7.com/mcp"
      headers = [ordered]@{
        CONTEXT7_API_KEY = '${CONTEXT7_API_KEY}'
      }
    }
    "workspace-board" = [ordered]@{
      command = "node"
      args = @($board)
    }
    playwright = [ordered]@{
      command = "npx"
      args = $playwrightArgs
    }
  }
}

function ConvertTo-McpJson($servers) {
  $root = [ordered]@{ mcpServers = $servers }
  return ($root | ConvertTo-Json -Depth 8)
}

function Update-PlaywrightArgs([object]$argsObj) {
  $list = @()
  if ($argsObj -is [System.Array]) {
    $list = @($argsObj)
  } elseif ($null -ne $argsObj) {
    $list = @($argsObj)
  }
  $next = @()
  foreach ($a in $list) {
    if ($a -eq "--headless" -or $a -eq "--headed") { continue }
    if ($a -is [string] -and $a.StartsWith("--user-data-dir=")) { continue }
    $next += $a
  }
  $next += "--user-data-dir=$profileDir"
  return ,$next
}

if (Test-Path -LiteralPath $OutPath) {
  try {
    $existing = Get-Content -Raw -LiteralPath $OutPath | ConvertFrom-Json
    $map = $existing.mcpServers
    if (-not $map) { $map = [pscustomobject]@{} }

    $defaults = Get-DefaultServers
    $added = @()
    foreach ($name in $defaults.Keys) {
      if (-not ($map.PSObject.Properties.Name -contains $name)) {
        $map | Add-Member -NotePropertyName $name -NotePropertyValue $defaults[$name] -Force
        $added += $name
      }
    }

    $pwMigrated = $false
    if ($map.playwright -and $map.playwright.args) {
      $newArgs = Update-PlaywrightArgs $map.playwright.args
      $oldJoined = (@($map.playwright.args) -join "`0")
      $newJoined = ($newArgs -join "`0")
      if ($oldJoined -ne $newJoined) {
        $map.playwright.args = $newArgs
        $pwMigrated = $true
      }
    }

    if ($added.Count -eq 0 -and -not $pwMigrated) {
      $count = @($map.PSObject.Properties).Count
      Write-Host "MCP config already exists ($count servers): $OutPath"
      exit 0
    }

    $existing.mcpServers = $map
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($OutPath, (($existing | ConvertTo-Json -Depth 8).Trim() + "`r`n"), $utf8)
    if ($added.Count -gt 0) {
      Write-Host "Merged MCP servers ($($added -join ', ')) into: $OutPath"
    }
    if ($pwMigrated) {
      Write-Host "Migrated playwright to headed + user-data-dir: $OutPath"
    }
    exit 0
  } catch {
    # rewrite broken/empty file below
  }
}

$json = ConvertTo-McpJson (Get-DefaultServers)
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($OutPath, $json.Trim() + "`r`n", $utf8)
Write-Host "Wrote default MCP config: $OutPath"
Write-Host "  Set CONTEXT7_API_KEY in .env for Context7 docs."
Write-Host "  Playwright MCP: headed window + ~/.webcli/browser-profiles/default"
