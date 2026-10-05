import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';

export function findCodex() {
  if(process.env.FEISHU_CODEX_BIN) return process.env.FEISHU_CODEX_BIN;
  const local=path.join(process.env.LOCALAPPDATA || '', 'OpenAI','Codex','bin');
  if(fs.existsSync(local)) {
    const versions=fs.readdirSync(local).map(v=>path.join(local,v,'codex.exe')).filter(p=>fs.existsSync(p));
    versions.sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
    if(versions[0]) return versions[0];
  }
  return 'codex';
}

export class CodexRpc extends EventEmitter {
  constructor({bin=findCodex(),cwd,spawnImpl=spawn}={}) {super();this.bin=bin;this.cwd=cwd;this.spawnImpl=spawnImpl;this.seq=0;this.pending=new Map();this.ready=false;}
  async start() {
    this.process=this.spawnImpl(this.bin,['app-server','--listen','stdio://'],{cwd:this.cwd,windowsHide:true,stdio:['pipe','pipe','pipe']});
    const current=this.process;
    this.process.on('error',e=>{if(this.process===current)this.fail(e);});
    this.process.on('exit',(code,signal)=>{if(this.process===current)this.fail(new Error(`Codex 进程退出 (${code??signal})`));});
    this.process.stdin.on('error',e=>{if(this.process===current)this.fail(e);});
    this.process.stderr.on('data',()=>{}); // Never copy authentication or raw tool output into logs.
    readline.createInterface({input:this.process.stdout}).on('line',line=>{if(this.process!==current)return;try{this.receive(JSON.parse(line));}catch(e){this.emit('protocolError',e);}});
    await this.call('initialize',{clientInfo:{name:'codex_feishu_bridge',title:'Codex 飞书助手',version:'0.1.0'},capabilities:{experimentalApi:true,mcpServerOpenaiFormElicitation:true}});
    this.notify('initialized',{});this.ready=true;
    const account=await this.call('account/read',{refreshToken:false});
    this.authenticated=Boolean(account.account);
    const models=await this.call('model/list',{});
    this.models=models.data??[];
    this.emit('ready'); return account;
  }
  receive(m) {
    if(m.method) {this.emit(m.id!==undefined?'request':'notification',m);return;}
    const p=this.pending.get(m.id);if(!p)return;
    this.pending.delete(m.id);clearTimeout(p.timer);
    if(m.error){const error=new Error(m.error.message);error.code=m.error.code;p.reject(error);}else p.resolve(m.result);
  }
  send(m) {if(!this.process || this.process.stdin.destroyed)throw new Error('Codex 尚未连接');this.process.stdin.write(JSON.stringify(m)+'\n');}
  call(method,params={}) {
    const id=++this.seq;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Codex 接口超时：${method}`));},60000);
      this.pending.set(id,{resolve,reject,timer});
      try{this.send({id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}
    });
  }
  notify(method,params) {this.send({method,params});}
  respond(id,result) {this.send({id,result});}
  reject(id,message='该交互暂不支持') {this.send({id,error:{code:-32601,message}});}
  fail(e) {this.ready=false;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(e);}this.pending.clear();this.emit('disconnected',e);}
  stop() {this.ready=false;this.process?.stdin.end();this.process?.kill();}
}
