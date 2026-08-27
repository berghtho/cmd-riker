param([Parameter(Mandatory = $true)][string]$Revision)
$ErrorActionPreference = "Stop"
$repository = Resolve-Path (Join-Path $PSScriptRoot "..")
$leadBundle = Join-Path $repository "release\$Revision\lead-agent"
& "$env:LOCALAPPDATA\CMD Riker\launcher\riker.cmd" upgrade `
  --lead-bundle $leadBundle `
  --state-revision "before-$Revision"
exit $LASTEXITCODE
