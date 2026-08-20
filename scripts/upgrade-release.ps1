param([Parameter(Mandatory = $true)][string]$Revision)
$ErrorActionPreference = "Stop"
& "$env:LOCALAPPDATA\CMD Riker\launcher\riker.cmd" upgrade `
  --lead-bundle "C:\repos\cmd-riker\release\$Revision\lead-agent" `
  --state-revision "before-$Revision" `
  --compatibility-evidence "typecheck, tests, build green; lossless state, no schema change" `
  --review-evidence "reviewed and merged to main"
exit $LASTEXITCODE
