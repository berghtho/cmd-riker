param(
  [Parameter(Mandatory = $true)][string]$Revision,
  [string]$NodePath = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
)
$ErrorActionPreference = "Stop"
$repository = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repository
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$commit = (git rev-parse HEAD).Trim()
npm run build:local-release -- `
  --revision $Revision `
  --node $NodePath `
  --lead-dist dist/lead-agent `
  --lead-node-modules node_modules `
  --tools vendor `
  --source-path "$repository" `
  --source-commit $commit `
  --output "release/$Revision"
exit $LASTEXITCODE
