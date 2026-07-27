param(
  [string]$OutputPath
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

if (-not $OutputPath) {
  $ReleaseDir = Join-Path $ProjectRoot "release"
  New-Item -ItemType Directory -Path $ReleaseDir -Force | Out-Null
  $OutputPath = Join-Path $ReleaseDir "physics-practice-ubuntu24.tar.gz"
}

if (Test-Path -LiteralPath $OutputPath) {
  Remove-Item -LiteralPath $OutputPath -Force
}

tar.exe -czf $OutputPath `
  --exclude=.git `
  --exclude=xqj `
  --exclude=node_modules `
  --exclude=logs `
  --exclude=release `
  --exclude=.env `
  --exclude="database/*.db" `
  --exclude="database/*.db-shm" `
  --exclude="database/*.db-wal" `
  --exclude=database/backups `
  --exclude=database/exercise-content `
  -C $ProjectRoot .

if ($LASTEXITCODE -ne 0) {
  throw "发布包生成失败。"
}

Write-Host "发布包已生成：$OutputPath"
