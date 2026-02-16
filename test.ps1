<#
.SYNOPSIS
    Validation script for Boof project.
    Runs build, optional lint, and optional dev server smoke test.

.PARAMETER Quick
    Only run the build step (skip lint and dev server checks).

.EXAMPLE
    .\test.ps1           # Full validation
    .\test.ps1 -Quick    # Build only
#>

param(
    [switch]$Quick
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

$exitCode = 0
$results = @()

function Write-Step($step, $status, $detail) {
    $icon = if ($status -eq "PASS") { "[PASS]" } elseif ($status -eq "FAIL") { "[FAIL]" } elseif ($status -eq "SKIP") { "[SKIP]" } else { "[INFO]" }
    $msg = "$icon $step"
    if ($detail) { $msg += " - $detail" }
    Write-Host $msg
    $script:results += @{ Step = $step; Status = $status; Detail = $detail }
}

# --------------------------------------------------
# Step 1: Check dependencies
# --------------------------------------------------
if (-not (Test-Path "node_modules")) {
    Write-Step "Dependencies" "INFO" "node_modules missing, running npm install..."
    $installOutput = npm install 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        Write-Step "Dependencies" "FAIL" "npm install failed"
        Write-Host $installOutput
        exit 1
    }
    Write-Step "Dependencies" "PASS" "npm install succeeded"
} else {
    Write-Step "Dependencies" "PASS" "node_modules present"
}

# --------------------------------------------------
# Step 2: Build
# --------------------------------------------------
Write-Host ""
Write-Host "--- BUILD ---"
$vitePath = Join-Path $ProjectRoot "node_modules\vite\bin\vite.js"
$buildOutput = node $vitePath build 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
    Write-Step "Build" "FAIL" "vite build failed"
    Write-Host "BUILD_ERROR_START"
    Write-Host $buildOutput.Trim()
    Write-Host "BUILD_ERROR_END"
    $exitCode = 1
} else {
    Write-Step "Build" "PASS" "Build succeeded"
}

# --------------------------------------------------
# Step 2b: TypeScript check
# --------------------------------------------------
Write-Host ""
Write-Host "--- TYPE CHECK ---"
$tscPath = Join-Path $ProjectRoot "node_modules\.bin\tsc.cmd"
if (Test-Path $tscPath) {
    # Build server project first (generates .d.ts files needed by client via project references)
    & $tscPath -p tsconfig.server.json 2>&1 | Out-Null
    $tscOutput = & $tscPath --noEmit 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        Write-Step "TypeCheck" "FAIL" "TypeScript errors found"
        Write-Host "TSC_ERROR_START"
        Write-Host $tscOutput.Trim()
        Write-Host "TSC_ERROR_END"
        $exitCode = 1
    } else {
        Write-Step "TypeCheck" "PASS" "No type errors"
    }
} else {
    Write-Step "TypeCheck" "SKIP" "tsc not found"
}

if ($Quick) {
    Write-Host ""
    Write-Host "--- SUMMARY (quick mode) ---"
    foreach ($r in $results) {
        Write-Step $r.Step $r.Status $r.Detail
    }
    exit $exitCode
}

# --------------------------------------------------
# Step 3: E2E Smoke Tests (Playwright)
# --------------------------------------------------
Write-Host ""
Write-Host "--- E2E SMOKE TESTS ---"
$playwrightCli = Join-Path $ProjectRoot "node_modules\@playwright\test\cli.js"
if (Test-Path $playwrightCli) {
    $e2eOutput = node $playwrightCli test 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        Write-Step "E2ESmoke" "FAIL" "Playwright smoke tests failed"
        Write-Host "E2E_ERROR_START"
        Write-Host $e2eOutput.Trim()
        Write-Host "E2E_ERROR_END"
        $exitCode = 1
    } else {
        Write-Step "E2ESmoke" "PASS" "All smoke tests passed"
    }
} else {
    Write-Step "E2ESmoke" "SKIP" "Playwright not installed"
}

# --------------------------------------------------
# Summary
# --------------------------------------------------
Write-Host ""
Write-Host "--- SUMMARY ---"
foreach ($r in $results) {
    Write-Step $r.Step $r.Status $r.Detail
}

Write-Host ""
if ($exitCode -eq 0) {
    Write-Host "RESULT: ALL CHECKS PASSED"
} else {
    Write-Host "RESULT: CHECKS FAILED"
}

exit $exitCode
