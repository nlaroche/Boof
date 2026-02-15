param(
    [Parameter(Mandatory=$true)]
    [string]$MessageFile,
    [string[]]$ReadOnly = @(),
    [switch]$NoTest
)

$message = Get-Content $MessageFile -Raw
$splatArgs = @{
    Message = $message
}
if ($ReadOnly.Count -gt 0) { $splatArgs.ReadOnly = $ReadOnly }
if ($NoTest) { $splatArgs.NoTest = $true }

& "$PSScriptRoot\aider-task.ps1" @splatArgs
