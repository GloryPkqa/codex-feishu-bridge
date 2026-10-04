import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import QRCode from 'qrcode';
import {Store} from './store.mjs';
import {CodexRpc} from './rpc.mjs';
import {Feishu,registerNewApp} from './feishu.mjs';
import {loadSecrets,saveSecrets} from './vault.mjs';
import {Bridge} from './bridge.mjs';
import {DesktopSync} from './desktop-sync.mjs';
import {QuestionMonitor} from './question-monitor.mjs';
import {normalizePreferences,validatePreferences} from './preferences.mjs';

export const root=fileURLToPath(new URL('../',import.meta.url));
const runtime=path.join(root,'runtime');fs.mkdirSync(runtime,{recursive:true});
const configFile=path.join(runtime,'settings.json');
const config=fs.existsSync(configFile)?JSON.parse(fs.readFileSync(configFile,'utf8')):{port:17861};
// Windows launchers use this loopback address. Reject silently incompatible ports.
config.port=17861;
config.progressEnabled=false;
config.nativeForms??=true;
config.desktopSyncEnabled??=false;
config.preferences=normalizePreferences(config.preferences);
const persistConfig=()=>{fs.writeFileSync(configFile+'.tmp',JSON.stringify(config,null,2));fs.renameSync(configFile+'.tmp',configFile);};persistConfig();
const csrf=randomBytes(32).toString('hex');
const logs=[];
function log(message) {
  const entry={time:new Date().toISOString(),message:String(message).replace(/(Bearer|app_secret|client_secret|access_token)[^\n]{0,200}/gi,'[已隐藏]').slice(0,400)};
  logs.push(entry);if(logs.length>60)logs.shift();
  // No raw request, message, or credential content is written to disk.
}
const store=new Store(path.join(runtime,'state.json'));
const rpc=new CodexRpc({cwd:root});const feishu=new Feishu();
const bridge=new Bridge({store,rpc,feishu,root,config,log});bridge.persistConfig=persistConfig;bridge.recover();
const desktopSync=new DesktopSync(bridge);
const questionMonitor=new QuestionMonitor(desktopSync);
let secrets=null,registration={status:'idle'},registrationAbort,connecting=false,closing=false,configuring=false;
let rpcRetryAt=0,rpcStarting=false,feishuRetryAt=0;
async function startCodex() {
  if(rpcStarting||rpc.ready||closing)return;
  rpcStarting=true;
  try {await rpc.start();log(rpc.authenticated?'Codex 已连接并登录':'Codex 已连接，等待登录');}
  catch {rpcRetryAt=Date.now()+30000;log('Codex 连接失败，30 秒后重试');rpc.stop();}
  finally {rpcStarting=false;}
}
rpc.on('disconnected',()=>{rpcRetryAt=Date.now()+30000;log('Codex 连接已断开');});
rpc.on('notification',m=>{if(m.method==='account/login/completed'&&m.params?.success){rpc.call('account/read',{refreshToken:false}).then(r=>{rpc.authenticated=Boolean(r.account);log('Codex 登录完成');}).catch(()=>log('登录状态检查失败'));}});
feishu.on('warning',log);
async function connectFeishu() {
  if(connecting||!secrets||config.paused||closing)return;
  connecting=true;
  try{await feishu.connect(secrets);if(config.paused){await feishu.disconnect();return;}log('飞书已连接。请在飞书打开机器人私聊并发送“帮助”。');}
  catch{feishuRetryAt=Date.now()+30000;log('飞书连接失败，30 秒后重试。请检查机器人能力、权限及长连接事件订阅。');}
  finally{connecting=false;}
}
async function registrationStart() {
  if(['waiting','starting'].includes(registration.status))return;
  registrationAbort=new AbortController();registration={status:'starting'};
  try {
    const result=await registerNewApp({signal:registrationAbort.signal,onQR:info=>{
      registration={status:'waiting',url:info.url,expiresAt:Date.now()+info.expireIn*1000};
      QRCode.toDataURL(info.url,{width:300,margin:2}).then(img=>{registration.image=img;}).catch(()=>{});
    }});
    secrets={appId:result.client_id,appSecret:result.client_secret};
    await saveSecrets(path.join(runtime,'credentials.dpapi'),secrets);
    if(result.user_info?.open_id){store.data.ownerId=result.user_info.open_id;store.save();}
    registration={status:'done'};log('飞书应用已授权，密钥已加密保存。');await connectFeishu();
  }catch(e){registration={status:'failed',message:e.code==='expired_token'?'二维码已过期，请重新生成':e.code==='access_denied'?'你取消了授权': '创建未完成，请重新尝试或使用手动连接'};log(registration.message);}
}

function publicState() {
  return {codex:{connected:rpc.ready,loggedIn:rpc.authenticated??false},feishu:{connected:!!feishu.connected,configured:!!secrets,connecting,appId:secrets?.appId,botName:feishu.botName},
    registration,progressMinutes:config.progressMinutes,ownerBound:!!store.data.ownerId,
    progressEnabled:false,paused:!!config.paused,preferences:config.preferences,pairCode:store.data.ownerId?null:bridge.pairCode,
    conversationReady:!!store.data.ownerChat,
    desktopSync:{enabled:config.desktopSyncEnabled,lastEvent:store.data.desktopSyncLastEvent??null},
    tasks:[...store.data.tasks.filter(t=>!t.archived),...store.data.desktopTasks.filter(t=>!t.archived)].map(t=>({id:t.id,title:t.title,status:t.status,activity:t.activity,plan:t.plan,startedAt:t.startedAt,report:t.report})),
    outbox:store.data.outbox.length,logs};
}
async function readBody(req) {
  let body='';for await(const chunk of req){body+=chunk;if(body.length>20000)throw new Error('请求过大');}
  return JSON.parse(body||'{}');
}
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
const origin=`http://127.0.0.1:${config.port}`;
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if(req.headers.host!==`127.0.0.1:${config.port}`){json(res,403,{error:'无效访问来源'});return;}
  const url=new URL(req.url,origin);
  try{
    if(req.method==='GET'&&url.pathname==='/'){
      let html=fs.readFileSync(path.join(root,'public','index.html'),'utf8').replace('__CSRF__',csrf);
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(html);return;
    }
    if(req.method==='GET'&&url.pathname==='/app.js'){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});res.end(fs.readFileSync(path.join(root,'public','app.js')));return;}
    if(req.method==='GET'&&url.pathname==='/api/state'){json(res,200,publicState());return;}
    if(req.method==='GET'&&url.pathname==='/health'){json(res,200,{service:'codex-feishu-bridge',pid:process.pid,codex:rpc.ready,feishu:!!feishu.connected});return;}
    if(req.method!=='POST'||!url.pathname.startsWith('/api/')){json(res,404,{error:'找不到此页面'});return;}
    if(req.headers.origin!==origin||req.headers['x-csrf-token']!==csrf||!req.headers['content-type']?.startsWith('application/json')){json(res,403,{error:'请从本机连接页面操作'});return;}
    const body=await readBody(req);
    if(url.pathname==='/api/register'){
      if(configuring)throw new Error('正在保存应用配置，请等待完成。');
      if(secrets||store.data.ownerId||store.data.ownerChat)throw new Error('本安装已连接应用。更换应用请使用新的安装目录，避免旧任务和账号绑定混用。');
      void registrationStart();json(res,200,{ok:true});return;
    }
    if(url.pathname==='/api/connect'){
      if(configuring)throw new Error('正在保存应用配置，请等待完成。');
      if(['waiting','starting'].includes(registration.status))throw new Error('正在扫码创建应用，请等待完成后再连接。');
      if(!/^cli_[a-zA-Z0-9]+$/.test(body.appId)||typeof body.appSecret!=='string'||body.appSecret.length<10)throw new Error('请填写正确的 App ID 和 App Secret');
      if((secrets&&body.appId!==secrets.appId)||(!secrets&&(store.data.ownerId||store.data.ownerChat)))throw new Error('更换应用请使用新的安装目录，避免旧任务和账号绑定混用。');
      configuring=true;
      try{const nextSecrets={appId:body.appId,appSecret:body.appSecret};await saveSecrets(path.join(runtime,'credentials.dpapi'),nextSecrets);secrets=nextSecrets;}
      finally{configuring=false;}
      void connectFeishu();json(res,200,{ok:true});return;
    }
    if(url.pathname==='/api/desktop-sync'){
      if(typeof body.enabled!=='boolean')throw new Error('缺少同步状态');
      if(body.enabled&&!config.desktopSyncEnabled)questionMonitor.resetBaseline();
      config.desktopSyncEnabled=body.enabled;persistConfig();
      // Remove unprocessed local events when disabling; they must not replay later.
      const inbox=path.join(runtime,'hook-inbox');
      if(fs.existsSync(inbox))for(const name of fs.readdirSync(inbox))if(/^\d+-[-a-f0-9]+\.json$/.test(name))fs.unlinkSync(path.join(inbox,name));
      log(body.enabled?'已启用桌面对话同步':'已关闭桌面对话同步');json(res,200,{ok:true});return;
    }
    if(url.pathname==='/api/preferences'){
      const preferences=validatePreferences(body);
      config.preferences=preferences;persistConfig();
      json(res,200,{ok:true,preferences});return;
    }
    if(url.pathname==='/api/reconnect'){void connectFeishu();json(res,200,{ok:true});return;}
    if(url.pathname==='/api/pause'){
      if(typeof body.paused!=='boolean')throw new Error('缺少暂停状态');
      config.paused=body.paused;persistConfig();
      if(config.paused)await feishu.disconnect();else void connectFeishu();
      json(res,200,{ok:true,paused:config.paused});return;
    }
    if(url.pathname==='/api/overview'){
      if(!store.data.ownerChat)throw new Error('请先在飞书打开机器人私聊');
      await bridge.enqueue(()=>bridge.overview(store.data.ownerChat));json(res,200,{ok:true});return;
    }
    if(url.pathname==='/api/shutdown'){
      if(body.confirmed!==true)throw new Error('请先确认关闭机器人');
      fs.writeFileSync(path.join(runtime,'stop-service.flag'),'stopped');
      json(res,200,{ok:true});setTimeout(()=>{void close();},100);return;
    }
    if(url.pathname==='/api/login'){const r=await rpc.call('account/login/start',{type:'chatgpt'});json(res,200,{url:r.authUrl});return;}
    if(url.pathname==='/api/notify'){
      throw new Error('定时报告已关闭，请改用全部进度查询');
    }
    if(url.pathname==='/api/test'){
      if(!store.data.ownerChat)throw new Error('请先在飞书打开机器人私聊并发送“帮助”');
      bridge.say(store.data.ownerChat,'连接测试成功。你现在可以在飞书查看任务进度、继续对话和接收报告。');json(res,200,{ok:true});return;
    }
    if(url.pathname==='/api/models'){
      if(!store.data.ownerChat)throw new Error('请先在飞书打开机器人私聊');
      await bridge.enqueue(()=>bridge.modelMenu(store.data.ownerChat));json(res,200,{ok:true});return;
    }
    if(url.pathname==='/api/panel'){
      if(!store.data.ownerChat)throw new Error('请先在飞书打开机器人私聊');
      await bridge.enqueue(()=>bridge.panel(store.data.ownerChat));json(res,200,{ok:true});return;
    }
    if(url.pathname==='/api/formpreview'){
      if(!store.data.ownerChat)throw new Error('请先在飞书打开机器人私聊');
      await bridge.enqueue(async()=>{
        const item=body.kind==='new'?bridge.newTaskForm(store.data.ownerChat):body.kind==='effort'?bridge.effortMenu(store.data.ownerChat):bridge.frequencyForm(store.data.ownerChat);
        try{await feishu.deliver(item);config.nativeForms=true;persistConfig();}
        finally{store.data.outbox=store.data.outbox.filter(x=>x.id!==item.id);store.save();}
      });json(res,200,{ok:true});return;
    }
    if(url.pathname==='/api/demo'){
      if(!store.data.ownerChat)throw new Error('请先在飞书打开机器人私聊并发送“帮助”');
      if(store.data.tasks.some(t=>['starting','running','waiting'].includes(t.status)))throw new Error('已有任务正在执行，请先完成当前任务');
      void bridge.enqueue(async()=>{
        await bridge.newTask(store.data.ownerChat,'这是飞书连接测试，不执行命令、不修改文件。请必须调用 feishu_ask_user，提问“飞书选择按钮测试：你是否收到了这条问题？”，选项为“收到了，可以继续”和“稍后再测”。等待真实用户回答后，输出简短的连接测试报告，写明收到的选择。不要自行模拟答案。',randomBytes(12).toString('hex'));
        const t=bridge.selected(store.data.ownerChat);if(t){t.title='飞书连接测试';store.save();}
      }).catch(()=>log('连接测试启动失败'));
      json(res,200,{ok:true});return;
    }
    json(res,404,{error:'接口不存在'});
  }catch(e){json(res,400,{error:e.message?.startsWith('Codex')?e.message:e.message||'操作失败'});}
});
server.on('error',()=>{console.error('连接页面未能启动，端口可能已被占用。');process.exit(1);});
server.listen(config.port,'127.0.0.1',()=>console.log(`连接页面：${origin}`));
try{secrets=await loadSecrets(path.join(runtime,'credentials.dpapi'));}catch{log('密钥无法读取，请使用原 Windows 用户或重新授权');}
void startCodex();if(secrets)void connectFeishu();
const timers=[setInterval(()=>{void bridge.drain();},2000),setInterval(()=>{if(config.desktopSyncEnabled&&store.data.ownerChat)bridge.enqueue(()=>{if(config.desktopSyncEnabled&&store.data.ownerChat)return desktopSync.consume();}).catch(()=>{});},2000),setInterval(()=>{if(config.desktopSyncEnabled&&store.data.ownerChat)bridge.enqueue(()=>{if(config.desktopSyncEnabled&&store.data.ownerChat)return questionMonitor.poll();}).catch(()=>log('桌面问题检查失败，将稍后重试'));},3000),setInterval(()=>{if(!rpc.ready&&Date.now()>=rpcRetryAt)void startCodex();if(!feishu.connected&&Date.now()>=feishuRetryAt)void connectFeishu();},5000)];
async function close(){if(closing)return;closing=true;for(const t of timers)clearInterval(t);registrationAbort?.abort();rpc.stop();await feishu.disconnect();server.close();process.exit(0);}
process.on('SIGINT',close);process.on('SIGTERM',close);
process.on('unhandledRejection',()=>log('操作异常，已保留任务状态，请检查连接页面'));
