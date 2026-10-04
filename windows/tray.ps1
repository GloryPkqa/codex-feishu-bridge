param([switch]$OpenWeb)
$ErrorActionPreference='Stop'
$bridgeRoot=Split-Path -Parent $PSScriptRoot
$runtimeDir=Join-Path $bridgeRoot 'runtime'
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
$hash=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($bridgeRoot))).Replace('-','').Substring(0,16)
$created=$false
$trayMutex=New-Object Threading.Mutex($true,('Local\CodexFeishuTray_'+$hash),[ref]$created)
if(-not $created){$trayMutex.Dispose();if($OpenWeb){Start-Process 'http://127.0.0.1:17861'};exit}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$baseUrl='http://127.0.0.1:17861'
function Read-State { Invoke-RestMethod ($baseUrl+'/api/state') -TimeoutSec 2 }
function Call-Api($route,$body) {
  $html=(Invoke-WebRequest $baseUrl -UseBasicParsing -TimeoutSec 3).Content
  $token=[regex]::Match($html,'name="csrf-token" content="([^"]+)"').Groups[1].Value
  if(-not $token){throw '本地管理页面未响应'}
  Invoke-RestMethod ($baseUrl+'/api/'+$route) -Method Post -ContentType 'application/json' -Headers @{'Origin'=$baseUrl;'X-CSRF-Token'=$token} -Body ($body|ConvertTo-Json -Compress) -TimeoutSec 5
}
function Open-Web {Start-Process $baseUrl}
function Start-Bridge {
  $flag=Join-Path $runtimeDir 'stop-service.flag'
  if(Test-Path -LiteralPath $flag){Remove-Item -LiteralPath $flag}
  try {Call-Api 'pause' @{paused=$false}|Out-Null} catch {
    $existing=Get-ScheduledTask -TaskName 'Codex-Feishu-Bridge' -ErrorAction SilentlyContinue
    $scriptPath=Join-Path $PSScriptRoot 'start.ps1'
    if($existing -and $existing.Actions.Arguments.Contains($scriptPath)) {Start-ScheduledTask -TaskName 'Codex-Feishu-Bridge'}
    else {Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+$scriptPath+'"'),'-Watch','-NoTray')}
    $script:resumeWhenReady=$true
  }
}
$icon=New-Object Windows.Forms.NotifyIcon
$icon.Icon=[Drawing.SystemIcons]::Information
$icon.Text='Codex 飞书助手'
$menu=New-Object Windows.Forms.ContextMenuStrip
$statusItem=$menu.Items.Add('正在检查状态');$statusItem.Enabled=$false
[void]$menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
$openItem=$menu.Items.Add('打开管理页面')
$startItem=$menu.Items.Add('启动／恢复机器人')
$pauseItem=$menu.Items.Add('暂停飞书收发（本机任务继续）')
[void]$menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
$exitTray=$menu.Items.Add('退出托盘（后台继续运行）')
$exitAll=$menu.Items.Add('关闭机器人并退出')
$icon.ContextMenuStrip=$menu;$icon.Visible=$true
$openItem.add_Click({Open-Web});$icon.add_DoubleClick({Open-Web})
$startItem.add_Click({try{Start-Bridge}catch{$icon.ShowBalloonTip(4000,'Codex 飞书助手','启动未完成，请打开管理页面检查。',[Windows.Forms.ToolTipIcon]::Warning)}})
$pauseItem.add_Click({try{Call-Api 'pause' @{paused=$true}|Out-Null}catch{$icon.ShowBalloonTip(4000,'Codex 飞书助手','暂停未完成，请在管理页面操作。',[Windows.Forms.ToolTipIcon]::Warning)}})
$exitTray.add_Click({[Windows.Forms.Application]::Exit()})
$exitAll.add_Click({
  try{
    $state=Read-State
    $active=@($state.tasks|Where-Object {$_.id -like 'T*' -and $_.status -in @('starting','running','waiting')})
    if($active.Count){
      $choice=[Windows.Forms.MessageBox]::Show('机器人创建的任务仍在执行。关闭会中断这些任务，电脑其他对话不受影响。确定关闭吗？','关闭机器人',[Windows.Forms.MessageBoxButtons]::YesNo,[Windows.Forms.MessageBoxIcon]::Warning)
      if($choice -ne [Windows.Forms.DialogResult]::Yes){return}
    }
    Call-Api 'shutdown' @{confirmed=$true}|Out-Null
    [Windows.Forms.Application]::Exit()
  }catch{$icon.ShowBalloonTip(4000,'Codex 飞书助手','关闭未完成，请打开管理页面检查。',[Windows.Forms.ToolTipIcon]::Warning)}
})
$timer=New-Object Windows.Forms.Timer;$timer.Interval=5000
$script:resumeWhenReady=$false
function Update-Tray {
  try{
    $state=Read-State
    if($script:resumeWhenReady){Call-Api 'pause' @{paused=$false}|Out-Null;$script:resumeWhenReady=$false}
    $text=if($state.paused){'已暂停收发'}elseif($state.feishu.connected){'运行中'}else{'连接中'}
    $statusItem.Text='Codex 飞书助手 · '+$text;$icon.Text=$statusItem.Text;$pauseItem.Enabled=-not $state.paused
    @{pid=$PID;visible=$icon.Visible;status=$text;menu=@($menu.Items|ForEach-Object {$_.Text})}|ConvertTo-Json -Depth 3|Set-Content (Join-Path $runtimeDir 'tray-state.json') -Encoding UTF8
  }catch{$statusItem.Text='Codex 飞书助手 · 后台未启动';$pauseItem.Enabled=$false}
}
$timer.add_Tick({Update-Tray});$timer.Start();Update-Tray
if($OpenWeb){Open-Web}
try{[Windows.Forms.Application]::Run()}finally{
  $timer.Stop();$timer.Dispose();$icon.Visible=$false;$icon.Dispose();$menu.Dispose();$trayMutex.ReleaseMutex();$trayMutex.Dispose()
  $stateFile=Join-Path $runtimeDir 'tray-state.json';if(Test-Path -LiteralPath $stateFile){Remove-Item -LiteralPath $stateFile}
}
