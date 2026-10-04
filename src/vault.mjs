import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('../windows/vault.ps1', import.meta.url));
function crypt(mode,input) {
  if(process.platform !== 'win32') throw new Error('当前密钥保管功能仅支持 Windows');
  return new Promise((resolve,reject)=>{
    const p=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Mode',mode],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output=''; p.stdout.on('data',d=>output+=d);
    p.stderr.resume(); p.on('error',reject);
    p.on('exit',code=>code===0?resolve(output):reject(new Error('Windows 密钥保管失败，请使用原 Windows 用户运行')));
    p.stdin.end(input);
  });
}
export async function saveSecrets(file,secrets) {
  const sealed=await crypt('protect',JSON.stringify(secrets));
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file+'.tmp',sealed,{mode:0o600}); fs.renameSync(file+'.tmp',file);
}
export async function loadSecrets(file) {
  if(!fs.existsSync(file)) return null;
  return JSON.parse(await crypt('unprotect',fs.readFileSync(file,'utf8')));
}
