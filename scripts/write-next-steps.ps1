param(
  [Parameter(Mandatory = $true)]
  [string]$RepoDir,
  [Parameter(Mandatory = $true)]
  [string]$OutPath
)

$ErrorActionPreference = "Stop"

$templatePath = Join-Path $PSScriptRoot "next-steps.template.txt"
if (-not (Test-Path -LiteralPath $templatePath)) {
  throw "Missing template: $templatePath"
}

# Template is UTF-8. Output is Windows-1251 so classic Russian Notepad (ANSI) shows Cyrillic.
$utf8 = New-Object System.Text.UTF8Encoding $false
$raw = [System.IO.File]::ReadAllText($templatePath, $utf8)
$text = $raw.Replace("__REPO_DIR__", $RepoDir).TrimStart() + "`r`n"

$cp1251 = [System.Text.Encoding]::GetEncoding(1251)
[System.IO.File]::WriteAllText($OutPath, $text, $cp1251)
Write-Host "Wrote $OutPath (Windows-1251)"
