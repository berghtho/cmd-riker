param([Parameter(Mandatory = $true)][string]$Revision)
$ErrorActionPreference = "Stop"
& "$env:LOCALAPPDATA\CMD Riker\launcher\riker.cmd" upgrade `
  --lead-bundle "C:\repos\cmd-riker\release\$Revision\lead-agent" `
  --state-revision "before-$Revision"
exit $LASTEXITCODE
