<#
  DiscFlow background launcher for Windows.

  Usage:
    .\windows\start-discflow.ps1 -Install     Register a logon scheduled task (runs hidden)
    .\windows\start-discflow.ps1 -Uninstall   Remove the scheduled task
    .\windows\start-discflow.ps1              Start the server in the background now

  The task runs "node dist/main.js" with the project root as the working directory,
  so run "pnpm build" before installing.
#>
[CmdletBinding()]
param(
  [switch]$Install,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$TaskName = 'DiscFlow'
$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$entry = Join-Path $root 'dist\main.js'
$logFile = Join-Path $root 'data\discflow.log'
$logDir = Split-Path -Parent $logFile

function Install-DiscFlowTask {
  $action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`"" `
    -WorkingDirectory $root
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Start DiscFlow in the background at user logon.' `
    -Force | Out-Null

  Write-Host "Scheduled task '$TaskName' registered. DiscFlow will start at the next logon."
}

function Uninstall-DiscFlowTask {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Scheduled task '$TaskName' removed."
  } else {
    Write-Host "Scheduled task '$TaskName' is not registered."
  }
}

function Start-DiscFlow {
  Set-Location $root

  $running = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*dist\main.js*' }
  if ($running) {
    Write-Host 'DiscFlow is already running.'
    return
  }

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'Node.js was not found in PATH.'
    return
  }

  if (-not (Test-Path $entry)) {
    Write-Host "Entry point not found: $entry. Run 'pnpm build' first."
    return
  }

  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Starting DiscFlow from $root" |
    Out-File -FilePath $logFile -Append -Encoding utf8

  & node $entry *>> $logFile
}

if ($Install) {
  Install-DiscFlowTask
  return
}

if ($Uninstall) {
  Uninstall-DiscFlowTask
  return
}

Start-DiscFlow
