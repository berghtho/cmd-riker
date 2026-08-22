param([Parameter(Mandatory = $true)][string]$Revision)
$ErrorActionPreference = "Stop"
$repository = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repository
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$commit = (git rev-parse HEAD).Trim()
npm run build:local-release -- `
  --revision $Revision `
  --node "C:\Tools\nodejs\node.exe" `
  --lead-dist dist/lead-agent `
  --lead-node-modules node_modules `
  --tools vendor `
  --source-path "$repository" `
  --source-commit $commit `
  --output "release/$Revision"
exit $LASTEXITCODE
