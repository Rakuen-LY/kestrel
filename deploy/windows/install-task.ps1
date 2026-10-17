#Requires -Version 5.1
<#
.SYNOPSIS
  Registers Kestrel as a Windows scheduled task that starts at logon and restarts on failure.

.DESCRIPTION
  Scheduled tasks avoid the service-wrapper dependency that plain `sc.exe create` requires.
  Edit the variables below, then run this script from an elevated PowerShell prompt.

.EXAMPLE
  .\install-task.ps1 -Workspace 'C:\src\my-app'
#>
param(
  [string]$InstallDir = 'C:\kestrel',
  [string]$Workspace = 'C:\kestrel-workspace',
  [string]$DataDir = 'C:\ProgramData\kestrel',
  [string]$NodePath = (Get-Command node).Source,
  [string]$Token = $env:KESTREL_TOKEN
)

$ErrorActionPreference = 'Stop'

if (-not $Token) {
  throw 'Set KESTREL_TOKEN or pass -Token. Generate one with: [Convert]::ToHexString((1..24 | ForEach-Object { Get-Random -Max 256 }))'
}

if (-not (Test-Path $NodePath)) {
  throw "node.exe not found at $NodePath"
}

$entry = Join-Path $InstallDir 'apps\server\dist\main.js'
if (-not (Test-Path $entry)) {
  throw "Kestrel build not found at $entry. Copy the repository there and run pnpm build first."
}

New-Item -ItemType Directory -Force -Path $DataDir, $Workspace | Out-Null

$envFile = Join-Path $DataDir 'kestrel.env'
@(
  "KESTREL_HOST=127.0.0.1",
  "KESTREL_PORT=7331",
  "KESTREL_WORKSPACE=$Workspace",
  "KESTREL_DATA_DIR=$DataDir",
  "KESTREL_LOG_LEVEL=info",
  "KESTREL_TOKEN=$Token"
) | Set-Content -Path $envFile -Encoding UTF8

$launcher = Join-Path $DataDir 'start-kestrel.cmd'
@(
  '@echo off',
  "set NODE_ENV=production",
  "for /f `"usebackq tokens=1,* delims==`" %%A in (`"$envFile`") do set `"%%A=%%B`"",
  "cd /d `"$InstallDir`"",
  "`"$NodePath`" `"$entry`""
) | Set-Content -Path $launcher -Encoding ASCII

$action = New-ScheduledTaskAction -Execute $launcher -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RestartCount 5 `
  -RestartInterval (New-TimeSpan -Seconds 10) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
  -TaskName 'Kestrel Agent' `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description 'Kestrel plugin-first agent platform' `
  -Force | Out-Null

Start-ScheduledTask -TaskName 'Kestrel Agent'
Write-Host "Kestrel registered. Console: http://127.0.0.1:7331"
Write-Host "Environment file: $envFile (contains KESTREL_TOKEN; restrict ACLs)"
