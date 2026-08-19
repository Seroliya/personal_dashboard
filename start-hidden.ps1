$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$listener = Get-NetTCPConnection -LocalPort 3456 -State Listen -ErrorAction SilentlyContinue

if ($listener) {
    exit 0
}

$env:SILENT = "true"
$logPath = Join-Path $projectDir "server.log"
$errorPath = Join-Path $projectDir "server-error.log"

& node (Join-Path $projectDir "server.js") 1>> $logPath 2>> $errorPath
