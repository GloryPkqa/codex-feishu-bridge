param([switch]$OpenWeb)
$ErrorActionPreference='Stop'
$bridgeRoot=Split-Path -Parent $PSScriptRoot
$flag=Join-Path $bridgeRoot 'runtime/stop-service.flag'
if(Test-Path -LiteralPath $flag){Remove-Item -LiteralPath $flag}
$startScript=Join-Path $PSScriptRoot 'start.ps1'
$task=Get-ScheduledTask -TaskName 'Codex-Feishu-Bridge' -ErrorAction SilentlyContinue
if($task -and $task.Actions.Arguments.Contains($startScript)){if($task.State -ne 'Running'){Start-ScheduledTask -TaskName 'Codex-Feishu-Bridge'}}
else{Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+$startScript+'"'),'-Watch','-NoTray')}
if ($OpenWeb) {
  $readyDeadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    try {
      $readyHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:17861/health' -TimeoutSec 1
      if ($readyHealth.service -eq 'codex-feishu-bridge') { break }
    } catch { }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $readyDeadline)
}
$trayScript=Join-Path $PSScriptRoot 'tray.ps1'
$argsList=@('-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',('"'+$trayScript+'"'))
if($OpenWeb){$argsList+='-OpenWeb'}
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList $argsList
