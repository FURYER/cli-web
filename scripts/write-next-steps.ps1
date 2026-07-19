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

# Read template as UTF-8 (BOM). Write UTF-16 LE so notepad.exe always shows Cyrillic.
$utf8 = New-Object System.Text.UTF8Encoding $false
$raw = [System.IO.File]::ReadAllText($templatePath, $utf8)
$text = $raw.Replace("__REPO_DIR__", $RepoDir).TrimStart() + "`r`n"

[System.IO.File]::WriteAllText($OutPath, $text, [System.Text.Encoding]::Unicode)
Write-Host "Wrote $OutPath (UTF-16)"
