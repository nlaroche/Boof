<#
.SYNOPSIS
    Primary Claude-to-Aider orchestration interface for Boof.
    Sends a task to Aider, captures structured output, logs results.

.PARAMETER Message
    The task instruction for Aider (required).

.PARAMETER Files
    Specific files to include (optional). If omitted, includes all src/ files.

.PARAMETER ReadOnly
    Files to include as read-only context (optional).

.PARAMETER NoTest
    Skip auto-test after changes (optional).

.PARAMETER DryRun
    Show the command that would be run without executing (optional).

.EXAMPLE
    .\aider-task.ps1 -Message "Add the WebSocket hook"
    .\aider-task.ps1 -Message "Fix the build" -Files @("src/client/App.tsx") -NoTest
#>

param(
    [Parameter(Mandatory=$true)]
    [string]$Message,
    [string[]]$Files = @(),
    [string[]]$ReadOnly = @(),
    [switch]$NoTest,
    [switch]$DryRun
)

$env:PYTHONUTF8 = "1"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

$startTime = Get-Date
$historyFile = Join-Path $ProjectRoot ".claude\aider-history.jsonl"
$conventionsFile = Join-Path $ProjectRoot "aider-conventions.md"

# -- Ensure .claude dir exists --
$claudeDir = Join-Path $ProjectRoot ".claude"
if (-not (Test-Path $claudeDir)) { New-Item -ItemType Directory -Path $claudeDir -Force | Out-Null }

# -- Prepend conventions to message --
$fullMessage = $Message
if (Test-Path $conventionsFile) {
    $conventions = Get-Content $conventionsFile -Raw
    $fullMessage = @"
$conventions

---
TASK:
$Message
"@
}

# -- Resolve files --
if ($Files.Count -eq 0) {
    $Files = Get-ChildItem -Path "src" -Recurse -Include "*.ts","*.tsx","*.css" -ErrorAction SilentlyContinue | ForEach-Object {
        Resolve-Path -Path $_.FullName -Relative
    }
}

# -- Build aider args --
$aiderArgs = @("--no-gitignore", "--yes-always", "--no-stream", "--no-pretty", "--no-fancy-input")

# Add editable files
foreach ($f in $Files) {
    $aiderArgs += $f
}

# Add read-only files
foreach ($f in $ReadOnly) {
    $aiderArgs += "--read"
    $aiderArgs += $f
}

# Test control
if ($NoTest) {
    $aiderArgs += "--no-auto-test"
}

# Add message
$aiderArgs += "--message"
$aiderArgs += $fullMessage

# -- DryRun --
if ($DryRun) {
    Write-Host "AIDER_DRY_RUN:"
    Write-Host "  aider $($aiderArgs -join ' ')"
    exit 0
}

# -- Run Aider --
Write-Host "AIDER_START: $(Get-Date -Format 'HH:mm:ss')"
Write-Host "AIDER_TASK: $Message"
Write-Host "AIDER_FILES: $($Files.Count) editable, $($ReadOnly.Count) read-only"

$output = ""
try {
    $output = aider @aiderArgs 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
} catch {
    $output = $_.Exception.Message
    $exitCode = 1
}

$endTime = Get-Date
$duration = ($endTime - $startTime).TotalSeconds

# -- Parse results --
$committed = ($output -match "Commit [a-f0-9]") -or ($output -match "Applied edit")
$testPassed = -not ($output -match "test-cmd.*failed" -or $output -match "FAIL")
$filesChanged = @()
if ($output -match "(?m)^[+\-]{3}\s+[ab]/(.+)$") {
    $filesChanged = [regex]::Matches($output, "(?m)^[+\-]{3}\s+[ab]/(.+)$") | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
}

# -- Extract commit hashes --
$commits = [regex]::Matches($output, "Commit ([a-f0-9]{7,})") | ForEach-Object { $_.Groups[1].Value }

# -- Summary output --
Write-Host ""
Write-Host "AIDER_DONE: $([math]::Round($duration, 1))s"
Write-Host "AIDER_EXIT: $exitCode"
Write-Host "AIDER_COMMITTED: $committed"
Write-Host "AIDER_TEST: $(if ($NoTest) { 'skipped' } elseif ($testPassed) { 'passed' } else { 'failed' })"
if ($commits.Count -gt 0) {
    Write-Host "AIDER_COMMITS: $($commits -join ', ')"
}
if ($filesChanged.Count -gt 0) {
    Write-Host "AIDER_CHANGED: $($filesChanged -join ', ')"
}

# -- Log to history --
$logEntry = @{
    timestamp = $startTime.ToString("o")
    duration_s = [math]::Round($duration, 1)
    task = $Message
    exit_code = $exitCode
    committed = $committed
    test_passed = $testPassed
    commits = $commits
    files_changed = $filesChanged
    files_count = $Files.Count
} | ConvertTo-Json -Compress

Add-Content -Path $historyFile -Value $logEntry -Encoding UTF8

# -- Exit with Aider's code --
exit $exitCode
