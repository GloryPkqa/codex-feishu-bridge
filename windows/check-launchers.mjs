import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildHookCommand,installHooks} from './install-hooks.mjs';

// Uses only synthetic data in an isolated temporary folder. No real settings,
// desktop shortcut, scheduled task, network connection or Codex session changes.
const windowsRoot=fileURLToPath(new URL('./',import.meta.url));
const launchSource=fs.readFileSync(path.join(windowsRoot,'launch.ps1'),'utf8');
assert.match(launchSource,/if\s*\(\$OpenWeb\)\s*\{/);
assert.match(launchSource,/\$readyDeadline\s*=\s*\[DateTime\]::UtcNow\.AddSeconds\(15\)/);
assert.match(launchSource,/-TimeoutSec 1/);
assert.ok(launchSource.indexOf('$readyDeadline')<launchSource.indexOf("$trayScript="),'wait for local health before asking the tray to open a page');
for(const name of fs.readdirSync(windowsRoot).filter(n=>n.endsWith('.ps1'))){
  const data=fs.readFileSync(path.join(windowsRoot,name));
  assert.deepEqual([...data.subarray(0,3)],[0xef,0xbb,0xbf],name+' must be UTF-8 with BOM for Windows PowerShell 5.1');
}
const fake=buildHookCommand("C:\\Program Files\\node's\\node.exe","C:\\项目 $cash %PATH% & (test)\\relay.mjs");
assert.equal(Buffer.from(fake.command.split(' ').at(-1),'base64').toString('utf16le'),fake.script);
assert.match(fake.script,/node''s/);
assert.match(fake.script,/\$cash %PATH% & \(test\)/);
if(process.platform!=='win32'){console.log('Static launcher checks passed; Windows execution checks skipped.');process.exit(0);}
const parent=path.resolve(os.tmpdir());
const temporary=fs.mkdtempSync(path.join(parent,'codex-feishu-launcher-check-'));
try{
  const folder=path.join(temporary,"space 中文 $cash %PATH% & ' folder");fs.mkdirSync(folder);
  const nodePath=path.join(folder,'node with spaces.exe');fs.copyFileSync(process.execPath,nodePath);
  const relay=path.join(folder,"relay with ' spaces.mjs");
  fs.writeFileSync(relay,"let input='';for await(const c of process.stdin)input+=c;process.stdout.write(JSON.stringify({received:JSON.parse(input),argument:process.argv[2]??null}));");
  const {command}=buildHookCommand(nodePath,relay);
  for(const [shell,args] of [['cmd.exe',['/d','/s','/c',command]],['powershell.exe',['-NoProfile','-NonInteractive','-Command',command]]]){
    const r=spawnSync(shell,args,{input:JSON.stringify({test:'中文 stdin',flag:true}),encoding:'utf8',windowsHide:true,timeout:20000});
    assert.ifError(r.error);assert.equal(r.status,0,shell+' failed: '+r.stderr);
    assert.deepEqual(JSON.parse(r.stdout),{received:{test:'中文 stdin',flag:true},argument:null},shell+' must forward standard input intact');
  }
  const project=path.join(temporary,'project with spaces'),codexHome=path.join(temporary,'synthetic-codex');
  fs.mkdirSync(codexHome);fs.mkdirSync(path.join(project,'src'),{recursive:true});
  const configPath=path.join(codexHome,'hooks.json');
  fs.writeFileSync(configPath,JSON.stringify({extra:'preserve',hooks:{Stop:[{matcher:'keep',hooks:[{type:'command',command:'unrelated-handler',trusted_hash:'synthetic-trust'}]}]}}));
  installHooks({root:project,nodePath,codexHome});installHooks({root:project,nodePath,codexHome});
  let config=JSON.parse(fs.readFileSync(configPath,'utf8'));
  assert.equal(config.extra,'preserve');assert.equal(config.hooks.Stop.length,2);
  assert.equal(config.hooks.Stop[0].hooks[0].trusted_hash,'synthetic-trust');
  assert.equal(config.hooks.Stop[1].hooks[0].trusted_hash,undefined);
  installHooks({root:project,nodePath,codexHome,remove:true});
  config=JSON.parse(fs.readFileSync(configPath,'utf8'));
  assert.deepEqual(config.hooks.Stop,[{matcher:'keep',hooks:[{type:'command',command:'unrelated-handler',trusted_hash:'synthetic-trust'}]}]);
  const installRoot=path.join(project,'windows');fs.mkdirSync(installRoot);
  fs.copyFileSync(path.join(windowsRoot,'install.ps1'),path.join(installRoot,'install.ps1'));
  const dependency=path.join(project,'node_modules','@larksuiteoapi','node-sdk');fs.mkdirSync(dependency,{recursive:true});fs.writeFileSync(path.join(dependency,'package.json'),'{}');
  const dryRun=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(installRoot,'install.ps1'),'-CheckOnly','-Startup','-Hooks'],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.ifError(dryRun.error);assert.equal(dryRun.status,0,dryRun.stderr);
  const plan=JSON.parse(dryRun.stdout);assert.equal(plan.Project,project);assert.equal(plan.Startup,true);assert.equal(plan.Hooks,true);
  assert.match(plan.ShortcutArguments,/".*project with spaces.*launch\.ps1" -OpenWeb$/);
  assert.equal(fs.existsSync(path.join(project,'runtime')),true); // Only synthetic hook backup exists.
  assert.equal(fs.existsSync(path.join(project,'runtime','stop-service.flag')),false);
  for(const name of fs.readdirSync(windowsRoot).filter(n=>n.endsWith('.ps1'))){
    const file=path.join(windowsRoot,name),encoded=Buffer.from("$parseErrors=$null;[void][Management.Automation.Language.Parser]::ParseFile('"+file.replaceAll("'","''")+"',[ref]$null,[ref]$parseErrors);if($parseErrors.Count){$parseErrors|ForEach-Object {$_.Message};exit 1}",'utf16le').toString('base64');
    const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',encoded],{encoding:'utf8',windowsHide:true,timeout:10000});
    assert.ifError(r.error);assert.equal(r.status,0,name+' parse failed: '+r.stdout+r.stderr);
  }
  console.log('Launcher checks passed: both hook shells, spaces/Unicode/literal path characters, stdin, hook merge/remove, installer dry-run and PowerShell syntax/BOM.');
}finally{
  const resolved=path.resolve(temporary),relative=path.relative(parent,resolved);
  if(relative.startsWith('codex-feishu-launcher-check-')&&!relative.includes(path.sep))fs.rmSync(resolved,{recursive:true,force:true});
}
