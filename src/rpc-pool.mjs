import {EventEmitter} from 'node:events';
import {CodexRpc} from './rpc.mjs';

// Desktop turns use short-lived workers. Closing one releases its writer lock
// without interrupting unrelated T tasks in the primary server.
export class CodexRpcPool extends EventEmitter {
  constructor(options={},factory=opts=>new CodexRpc(opts)) {
    super();this.options=options;this.factory=factory;this.primary=factory(options);
    this.desktop=new Map();this.requests=new Map();this.sequence=0;
    for(const name of ['notification','request','disconnected','ready','protocolError'])this.primary.on(name,m=>this.emit(name,m));
  }
  get ready(){return this.primary.ready;}
  get authenticated(){return this.primary.authenticated;}
  get models(){return this.primary.models;}
  set models(value){this.primary.models=value;}
  start(){return this.primary.start();}
  call(method,params={}){return (this.desktop.get(params.threadId)??this.primary).call(method,params);}
  respond(id,result){const r=this.requests.get(id);if(r)r.rpc.respond(r.id,result);else this.primary.respond(id,result);}
  reject(id,message){const r=this.requests.get(id);if(r)r.rpc.reject(r.id,message);else this.primary.reject(id,message);}
  async openDesktop(threadId){
    if(this.desktop.has(threadId))return;
    const rpc=this.factory(this.options);this.desktop.set(threadId,rpc);
    rpc.on('notification',m=>{
      if(this.desktop.get(threadId)!==rpc)return;
      if(m.method==='serverRequest/resolved'){
        const r=[...this.requests].find(([,v])=>v.rpc===rpc&&v.id===m.params?.requestId);
        const requestId=r?.[0]??'desktop:unknown:'+threadId+':'+m.params?.requestId;
        if(r)this.requests.delete(r[0]);m={...m,params:{...m.params,requestId}};
      }
      this.emit('notification',m);
    });
    rpc.on('request',m=>{
      if(this.desktop.get(threadId)!==rpc)return;
      // Never forward another thread's request or share numeric request IDs.
      if(m.params?.threadId!==threadId){rpc.reject(m.id,'会话不匹配');return;}
      const id='desktop:'+ ++this.sequence;this.requests.set(id,{rpc,id:m.id});this.emit('request',{...m,id});
    });
    rpc.on('disconnected',()=>{
      if(this.desktop.get(threadId)!==rpc)return;
      this.releaseDesktop(threadId);this.emit('desktopDisconnected',threadId);
    });
    try{await rpc.start();if(!rpc.authenticated)throw new Error('Codex 尚未登录');}catch(e){this.releaseDesktop(threadId);throw e;}
  }
  releaseDesktop(threadId){
    const rpc=this.desktop.get(threadId);if(!rpc)return;
    this.desktop.delete(threadId);for(const [id,r] of this.requests)if(r.rpc===rpc)this.requests.delete(id);
    rpc.stop();
  }
  stop(){for(const id of [...this.desktop.keys()])this.releaseDesktop(id);this.primary.stop();}
}
