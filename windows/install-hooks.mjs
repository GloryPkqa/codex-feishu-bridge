import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// A single encoded argument passes through either Windows hook shell without
// expanding path characters. The decoded script uses literal PowerShell paths.
export function buildHookCommand(nodePath,relayPath) {
  const literal=value=>"'"+String(value).replaceAll("'","''")+"'";
  const script=`& ${literal(nodePath)} ${literal(relayPath)}; exit $LASTEXITCODE`;
  return {command:'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand '+Buffer.from(script,'utf16le').toString('base64'),script};
}

export function installHooks({root=fileURLToPath(new URL('../',import.meta.url)),nodePath=process.execPath,codexHome=process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),remove=false}={}) {
if(process.platform!=='win32')throw new Error('同步 Hooks 安装器目前仅支持 Windows。');
const target=path.join(codexHome,'hooks.json');
const relay=path.join(root,'src','hook-relay.mjs');
const {command}=buildHookCommand(nodePath,relay);
const oldCommands=new Set([command,`${nodePath} ${relay}`,`"${nodePath}" "${relay}"`]);
const events=['UserPromptSubmit','PreToolUse','PostToolUse','PermissionRequest','Stop','Interrupt'];
const existing=fs.existsSync(target)?fs.readFileSync(target,'utf8'):null;
const config=existing?JSON.parse(existing.replace(/^\uFEFF/,'')):{hooks:{}};config.hooks??={};
for(const event of events){
  const groups=config.hooks[event]??=[];
  // Touch only this installation's handler; preserve other handlers and metadata.
  for(const group of groups)group.hooks=(group.hooks??[]).filter(h=>!oldCommands.has(h.command));
  config.hooks[event]=groups.filter(g=>g.hooks.length);
  if(!remove)config.hooks[event].push({hooks:[{type:'command',command,async:true,timeout:10,statusMessage:'同步到飞书'}]});
}
fs.mkdirSync(path.dirname(target),{recursive:true});
if(existing){const backup=path.join(root,'runtime','hook-backups');fs.mkdirSync(backup,{recursive:true});fs.writeFileSync(path.join(backup,Date.now()+'.json'),existing,{mode:0o600});}
fs.writeFileSync(target+'.feishu.tmp',JSON.stringify(config,null,2),'utf8');fs.renameSync(target+'.feishu.tmp',target);
return remove?'已移除本项目的同步 Hooks，其他配置保留。':'已安装全局同步 Hooks。请在 Codex 的 Hooks 设置中审查并信任，再开启新一轮对话验证。';
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.includes('--print-command'))console.log(JSON.stringify(buildHookCommand(process.execPath,fileURLToPath(new URL('../src/hook-relay.mjs',import.meta.url))),null,2));
  else console.log(installHooks({remove:process.argv.includes('--remove')}));
}
