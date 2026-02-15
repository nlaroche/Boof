<#
.SYNOPSIS
    Emergency build fixer. Captures build errors and sends them to Aider.

.PARAMETER MaxAttempts
    Maximum fix attempts before giving up (default: 3).

.EXAMPLE
    .\aider-fix.ps1
    .\aider-fix.ps1 -MaxAttempts 5
#>

param(
    [int]$MaxAttempts = 3
)

$env:PYTHONUTF8 = "1"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

$historyFile = Join-Path $ProjectRoot ".claude\aider-history.jsonl"
$conventionsFile = Join-Path $ProjectRoot "aider-conventions.md"
$claudeDir = Join-Path $ProjectRoot ".claude"
if (-not (Test-Path $claudeDir)) { New-Item -ItemType Directory -Path $claudeDir -Force | Out-Null }

$startTime = Get-Date

for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    Write-Host "AIDER_FIX_ATTEMPT: $attempt/$MaxAttempts"

    # Run build
    $vitePath = Join-Path $ProjectRoot "node_modules\vite\bin\vite.js"
    $buildOutput = node $vitePath build 2>&1 | Out-String

    if ($LASTEXITCODE -eq 0) {
        Write-Host "AIDER_FIX_RESULT: PASS (attempt $attempt)"

        $logEntry = @{
            timestamp = $startTime.ToString("o")
            duration_s = [math]::Round(((Get-Date) - $startTime).TotalSeconds, 1)
            task = "BUILD_FIX"
            exit_code = 0
            committed = $true
            test_passed = $true
            attempts = $attempt
        } | ConvertTo-Json -Compress
        Add-Content -Path $historyFile -Value $logEntry -Encoding UTF8

        exit 0
    }

    # Clean ANSI codes
    $cleanOutput = $buildOutput -replace '\x1b\[[0-9;]*m', ''

    # Build fix message
    $fixMessage = "The build is failing with these errors:`n`n$($cleanOutput.Trim())`n`nFix ALL build errors. Make minimal changes - only fix what's broken."

    # Prepend conventions
    if (Test-Path $conventionsFile) {
        $conventions = Get-Content $conventionsFile -Raw
        $fixMessage = "$conventions`n---`nTASK:`n$fixMessage"
    }

    # Gather source files
    $sourceFiles = Get-ChildItem -Path "src" -Recurse -Include "*.ts","*.tsx","*.css" -ErrorAction SilentlyContinue | ForEach-Object {
        Resolve-Path -Path $_.FullName -Relative
    }

    $aiderArgs = @("--no-gitignore", "--yes-always", "--no-stream", "--no-pretty", "--no-fancy-input")
    foreach ($f in $sourceFiles) { $aiderArgs += $f }
    $aiderArgs += "--message"
    $aiderArgs += $fixMessage

    aider @aiderArgs 2>&1 | Out-Null
}

Write-Host "AIDER_FIX_RESULT: FAIL (exhausted $MaxAttempts attempts)"

$logEntry = @{
    timestamp = $startTime.ToString("o")
    duration_s = [math]::Round(((Get-Date) - $startTime).TotalSeconds, 1)
    task = "BUILD_FIX"
    exit_code = 1
    committed = $false
    test_passed = $false
    attempts = $MaxAttempts
} | ConvertTo-Json -Compress
Add-Content -Path $historyFile -Value $logEntry -Encoding UTF8

exit 1
