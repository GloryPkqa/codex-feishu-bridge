import * as lark from '@larksuiteoapi/node-sdk';
import fs from 'node:fs';
import {EventEmitter} from 'node:events';
import {fitCard} from './cards.mjs';
import {SendLimiter} from './send-limiter.mjs';

// SDK errors can contain full HTTP request configuration, including secrets.
// Deliberately log only a constant message and never raw SDK objects.
const logger={trace(){},debug(){},info(){},warn(){},error(){}};
export class Feishu extends EventEmitter {
  constructor({createChannel=lark.createLarkChannel,createClient=opts=>new lark.Client(opts)}={}){
    super();this.sendLimiter=new SendLimiter();this.createChannel=createChannel;this.createClient=createClient;this.generation=0;this.subscriptions=new WeakMap();
  }
  async connect(secrets) {
    const clearing=this.disconnect(),generation=this.generation;await clearing;
    if(generation!==this.generation)throw new Error('飞书连接已取消');
    const opts={appId:secrets.appId,appSecret:secrets.appSecret,domain:lark.Domain.Feishu,logger,loggerLevel:lark.LoggerLevel.error};
    this.client=this.createClient(opts);
    const channel=this.createChannel({...opts,
      policy:{requireMention:true,dmMode:'open',respondToMentionAll:false},
      safety:{perChatQueue:true},includeRawEvent:true
    });
    this.channel=channel;const unsubscribers=[];this.subscriptions.set(channel,unsubscribers);
    const current=()=>this.channel===channel&&generation===this.generation;
    const on=(name,handler)=>{const unsubscribe=channel.on(name,(...args)=>{if(current())handler(...args);});if(typeof unsubscribe==='function')unsubscribers.push(unsubscribe);};
    on('message',m=>{const {raw,...message}=m;this.emit('message',message);});
    on('cardAction',e=>{this.emit('action',cardAction(e));});
    on('error',()=>this.emit('warning','飞书事件接收失败，请检查应用权限与事件订阅'));
    on('reconnecting',()=>{this.connected=false;this.emit('state');});
    on('reconnected',()=>{this.connected=true;this.emit('state');});
    try{
      await channel.connect();if(!current())throw new Error('飞书连接已取消');
      this.connected=true;this.botName=channel.botIdentity?.name;this.emit('state');
    }catch(error){
      if(current()){this.channel=null;this.client=null;this.connected=false;this.emit('state');}
      await this.closeChannel(channel);throw error;
    }
  }
  async closeChannel(channel){
    if(!channel)return;
    for(const unsubscribe of this.subscriptions.get(channel)??[])try{unsubscribe();}catch{}
    this.subscriptions.delete(channel);
    // SDK 1.74 disconnect() skips channels whose initial handshake failed.
    // Its public raw WS client must still stop every pending reconnect loop.
    try{channel.rawWsClient?.close({force:true});}catch{}
    try{await channel.disconnect();}catch{}
  }
  async disconnect() {
    ++this.generation;const channel=this.channel;this.channel=null;this.client=null;this.connected=false;
    await this.closeChannel(channel);this.emit('state');
  }
  async deliver(item) {
    if(!this.connected) throw new Error('飞书未连接');
    const p=item.payload;let msgType,content;
    if(p.kind==='file') {
      if(!p.fileKey) {
        const u=await this.client.im.file.create({data:{file_type:'stream',file_name:p.name,file:fs.readFileSync(p.path)}});
        // The SDK unwraps multipart upload responses to {file_key}; ordinary
        // API responses retain {code,data}. Accept both official response forms.
        const fileKey=u.file_key??u.data?.file_key;
        if((u.code!==undefined&&u.code!==0)||!fileKey)throw new Error(`飞书上传失败 (${u.code??'缺少文件编号'})`);
        p.fileKey=fileKey;
      }
      msgType='file';content={file_key:p.fileKey};
    } else if(p.kind==='card') {msgType='interactive';content=fitCard(p.card);}
    else {msgType='text';content={text:p.text};}
    await this.sendLimiter.take();
    if(!this.connected)throw new Error('飞书未连接');
    const r=await this.client.im.message.create({params:{receive_id_type:'chat_id'},data:{receive_id:item.chatId,msg_type:msgType,content:JSON.stringify(content),uuid:item.id}});
    if(r.code!==0) throw new Error(`飞书发送失败 (${r.code})`);
    return r.data?.message_id;
  }
}
export function cardAction(e){
  const {raw,...event}=e;
  // The official channel normalizer omits form_value. Preserve only this
  // needed field from the authenticated callback, then drop the raw event.
  return {...event,action:{...event.action,formValue:raw?.action?.form_value??event.action?.formValue}};
}

export async function registerNewApp({onQR,signal}) {
  return lark.registerApp({
    createOnly:true,source:'codex-feishu-bridge',signal,
    appPreset:{name:'Codex 远程助手',desc:'在飞书查看 Codex 进度、回答问题并接收任务报告'},
    addons:{preset:false,
      scopes:{tenant:['im:message:send_as_bot','im:message.p2p_msg:readonly','im:message.group_at_msg:readonly','im:resource']},
      events:{items:{tenant:['im.message.receive_v1']}},callbacks:{items:['card.action.trigger']}
    },onQRCodeReady:onQR
  });
}
