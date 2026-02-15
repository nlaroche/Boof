<#
.SYNOPSIS
    Autonomous build-fix loop: runs build, if errors launches Aider to fix,
    rebuilds, repeats until clean or max attempts reached.

.PARAMETER MaxAttempts
    Maximum number of fix attempts before giving up (default: 5).

.EXAMPLE
    .\aider-iterate.ps1
    .\aider-iterate.ps1 -MaxAttempts 10
#>

param(
    [int]$MaxAttempts = 5
)

$env:PYTHONUTF8 = "1"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

$attempt = 0

while ($attempt -lt $MaxAttempts) {
    $attempt++
    Write-Host ""
    Write-Host "=========================================="
    Write-Host "  ITERATION $attempt / $MaxAttempts"
    Write-Host "=========================================="
    Write-Host ""

    # Run build
    Write-Host "--- Building ---"
    $buildOutput = npm run build 2>&1 | Out-String

    if ($LASTEXITCODE -eq 0) {
        Write-Host ""
        Write-Host "[SUCCESS] Build passed on attempt $attempt!"
        Write-Host ""

        # Run full validation
        Write-Host "--- Running full validation ---"
        powershell -ExecutionPolicy Bypass -File "$ProjectRoot\test.ps1" -Quick
        if ($LASTEXITCODE -eq 0) {
            Write-Host ""
            Write-Host "=========================================="
            Write-Host "  ALL CHECKS PASSED"
            Write-Host "=========================================="
            exit 0
        }
    }

    Write-Host "[FAIL] Build failed on attempt $attempt"

    if ($attempt -ge $MaxAttempts) {
        Write-Host ""
        Write-Host "=========================================="
        Write-Host "  MAX ATTEMPTS REACHED - GIVING UP"
        Write-Host "=========================================="
        Write-Host ""
        Write-Host "Last build output:"
        Write-Host $buildOutput
        exit 1
    }

    # Clean ANSI codes
    $cleanOutput = $buildOutput -replace '\x1b\[[0-9;]*m', ''

    # Gather source files
    $sourceFiles = Get-ChildItem -Path "src" -Recurse -Include "*.ts","*.tsx","*.css" -ErrorAction SilentlyContinue | ForEach-Object {
        Resolve-Path -Path $_.FullName -Relative
    }

    $fixMessage = @"
BUILD FAILED (attempt $attempt of $MaxAttempts). Fix these errors:

$($cleanOutput.Trim())

Rules:
- Fix ONLY the build errors shown above
- Make minimal, targeted changes
- The build must pass after your fixes
"@

    Write-Host ""
    Write-Host "--- Launching Aider to fix (attempt $attempt) ---"
    Write-Host ""

    $aiderArgs = @("--no-gitignore")
    foreach ($f in $sourceFiles) {
        $aiderArgs += $f
    }
    $aiderArgs += "--message"
    $aiderArgs += $fixMessage

    aider @aiderArgs

    Write-Host ""
    Write-Host "--- Aider finished, rebuilding ---"
}
