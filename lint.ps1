$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

# Build server project references first (generates .d.ts files)
& node node_modules/typescript/lib/tsc.js -p tsconfig.server.json 2>&1 | Out-Null

# Type-check client (uses project references)
$output = & node node_modules/typescript/lib/tsc.js --noEmit 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
    Write-Host $output.Trim()
    exit 1
}
exit 0
