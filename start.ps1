[CmdletBinding()]
param(
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Find-Node {
  $candidates = @()
  $fromPath = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($fromPath) { $candidates += $fromPath.Source }
  if ($env:LOCALAPPDATA) {
    $candidates += Join-Path $env:LOCALAPPDATA 'nodejs\node-v24.22.2-win-x64\node.exe'
  }
  if ($env:ProgramFiles) {
    $candidates += Join-Path $env:ProgramFiles 'nodejs\node.exe'
  }
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  return $null
}

$node = Find-Node
if (-not $node) {
  throw 'Node.js 24 or newer was not found. Install it from https://nodejs.org/ and run this script again.'
}

$nodeVersion = (& $node -p "process.versions.node").Trim()
$major = [int]($nodeVersion.Split('.')[0])
if ($major -lt 24) {
  throw "Node.js $nodeVersion is too old. Seven Stones needs Node.js 24 or newer."
}

Write-Host "Using Node.js $nodeVersion"

$nodeDir = Split-Path -Parent $node
$env:Path = "$nodeDir;$env:Path"

if (-not (Test-Path -LiteralPath '.env')) {
  Copy-Item -LiteralPath '.env.example' -Destination '.env'
  Write-Host 'Created .env from .env.example.'
}

if (-not (Test-Path -LiteralPath 'node_modules')) {
  Write-Host 'Installing dependencies with pnpm 11.25.0...'
  $corepack = Get-Command corepack.cmd -ErrorAction SilentlyContinue
  if ($corepack) {
    & $corepack.Source pnpm@11.25.0 install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'pnpm install failed.' }
  } else {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { throw 'pnpm/corepack and npm were not found.' }
    & $npm.Source install
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
  }
}

$port = 8787
$envLines = Get-Content -LiteralPath '.env' -ErrorAction SilentlyContinue
foreach ($line in $envLines) {
  if ($line -match '^\s*PORT\s*=\s*(\d+)\s*$') { $port = [int]$Matches[1] }
}
$url = "http://localhost:$port"

if (-not $NoBrowser) {
  Start-Job -ScriptBlock {
    param($target)
    Start-Sleep -Seconds 2
    Start-Process $target
  } -ArgumentList $url | Out-Null
}

Write-Host ''
Write-Host "Seven Stones will be available at $url"
Write-Host 'Press Ctrl+C to stop the server.'
Write-Host ''

& $node --env-file-if-exists=.env server.cjs
exit $LASTEXITCODE
