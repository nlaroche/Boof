<#
.SYNOPSIS
    Uses Vercel agent-browser to snapshot the Boof app and verify UI state.
    Returns a compact accessibility tree that AI agents can reason about.

.PARAMETER Url
    URL to check (default: http://localhost:3456)

.PARAMETER Navigate
    Optional path to navigate to after opening (e.g., click a button ref)

.PARAMETER Screenshot
    Optional path to save a screenshot
#>

param(
    [string]$Url = "http://localhost:3456",
    [string]$Navigate = "",
    [string]$Screenshot = ""
)

$ErrorActionPreference = "Stop"
$env:PLAYWRIGHT_BROWSERS_PATH = "$env:LOCALAPPDATA\ms-playwright"

# Open the page
$openResult = agent-browser open $Url 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
    Write-Host "[FAIL] Could not open $Url"
    Write-Host $openResult
    exit 1
}

# Wait for the app to load (WebSocket connects, content renders)
agent-browser wait 2000 2>&1 | Out-Null

# Navigate if requested (e.g., click a nav button)
if ($Navigate) {
    agent-browser click $Navigate 2>&1 | Out-Null
    agent-browser wait 1000 2>&1 | Out-Null
}

# Take snapshot
Write-Host "--- UI SNAPSHOT ---"
$snapshot = agent-browser snapshot 2>&1 | Out-String
Write-Host $snapshot.Trim()
Write-Host "--- END SNAPSHOT ---"

# Screenshot if requested
if ($Screenshot) {
    agent-browser screenshot $Screenshot 2>&1 | Out-Null
    Write-Host "[INFO] Screenshot saved to $Screenshot"
}

# Close browser
agent-browser close 2>&1 | Out-Null

exit 0
