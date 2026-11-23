# Register the Codex skin host as a resident background service (scheduled task).
#   install.ps1              -> register + start
#   install.ps1 -Uninstall   -> unregister + kill running host
# ASCII only: PS 5.1 reads BOM-less UTF-8 as ANSI and mangles CJK.
[CmdletBinding()]
param([switch]$Uninstall)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSCommandPath
$hostScript = Join-Path $root "skin-host.ps1"
$vbsLauncher = Join-Path $root "skin-host.vbs"
$taskName = "Codex Skin Host"
$wscript = Join-Path $env:SystemRoot "System32\wscript.exe"

function Stop-SkinHost {
  $procs = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like "*skin-host.ps1*" -and $_.CommandLine -notlike "*Get-CimInstance*" }
  foreach ($p in $procs) {
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; Write-Host ("  killed host pid " + $p.ProcessId) } catch { }
  }
}

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Stop-SkinHost
  Write-Host "Uninstalled: scheduled task removed, host stopped."
  return
}

# Re-registering while an old host still runs is a silent no-op: the new process
# loses the mutex race and exits, leaving the old in-memory script in charge.
# Kill it first so "run install.ps1 again" really means "restart the host".
Stop-SkinHost

foreach ($f in @($hostScript, $vbsLauncher)) {
  if (-not (Test-Path -LiteralPath $f)) { throw ("missing " + $f) }
}
if (-not (Test-Path -LiteralPath $wscript)) { throw "wscript.exe not found" }

# The host only works if Codex exposes its CDP port; that comes from user env vars.
$flavor = [Environment]::GetEnvironmentVariable("BUILD_FLAVOR", "User")
$switches = [Environment]::GetEnvironmentVariable("CODEX_ELECTRON_CHROMIUM_SWITCHES", "User")
if ($flavor -ne "dev" -or -not $switches) {
  Write-Warning "BUILD_FLAVOR / CODEX_ELECTRON_CHROMIUM_SWITCHES not set for this user."
  Write-Warning "Run standalone\setup-env.ps1 from the codex task dashboard first, or the host cannot attach."
}

$action = New-ScheduledTaskAction -Execute $wscript -Argument ('//B "{0}"' -f $vbsLauncher)
$logon = New-ScheduledTaskTrigger -AtLogOn
$logon.Delay = "PT30S"
# Repetition keeps the host alive after it exits or crashes; the mutex makes repeats idempotent.
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($logon, $repeat) -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 2

Write-Host "Installed:"
Write-Host ("  Scheduled task: " + $taskName + " (at logon +30s, then every minute; single instance)")
Write-Host "  Old host stopped, new one started."
Write-Host "  Host is resident: it waits for Codex, injects on start, re-attaches on reload/crash."
Write-Host "  Start Codex any way you like - Start menu, taskbar, codex:// - no special launcher needed."
Write-Host ("  Log: " + (Join-Path $root "skin-host.log"))
