$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

# Build server project references first (generates .d.ts files)
& node node_modules/typescript/lib/tsc.js -p tsconfig.server.json 2>&1 | Out-Null

# Type-check client (uses project references)
$output = & node node_modules/typescript/lib/tsc.js --noEmit 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
    Write-Host "TSC_ERROR_START"
    Write-Host $output.Trim()
    exit 1
}

# ESLint — catch React hooks bugs, closure issues, etc.
$eslintOutput = & node node_modules/eslint/bin/eslint.js "src/**/*.ts" "src/**/*.tsx" --no-warn-ignored 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
    Write-Host "ESLINT_ERROR_START"
    Write-Host $eslintOutput.Trim()
    exit 1
}
exit 0
