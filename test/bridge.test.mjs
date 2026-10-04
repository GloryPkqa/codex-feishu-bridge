import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store,within} from '../src/store.mjs';
import {Bridge} from '../src/bridge.mjs';
import {CodexRpc} from '../src/rpc.mjs';
import {Feishu,cardAction} from '../src/feishu.mjs';
import {card,modelLabel,fitCard} from '../src/cards.mjs';
import {DesktopSync} from '../src/desktop-sync.mjs';
import {sanitizeEvent} from '../src/hook-relay.mjs';
import {QuestionMonitor,extractQuestions} from '../src/question-monitor.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'feishu-test-'));t.after(()=>{assert.ok(within(os.tmpdir(),root));fs.rmSync(root,{recursive:true,force:true});});
  const store=new Store(path.join(root,'state.json'));store.data.ownerId='owner';store.data.ownerChat='chat';
  const rpc=new EventEmitter();rpc.ready=true;rpc.authenticated=true;rpc.calls=[];rpc.answers=[];
  rpc.models=[{id:'model-a',model:'model-a',displayName:'A',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'中'},{reasoningEffort:'high',description:'高'}]},{id:'model-b',model:'model-b',displayName:'B',defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low',description:'低'}]}];
  rpc.call=async(method,params)=>{rpc.calls.push({method,params});if(method==='thread/start')return {thread:{id:'thr'}};if(method==='turn/start')return {turn:{id:'turn'}};return {};};
  rpc.respond=(id,result)=>rpc.answers.push({id,result});rpc.reject=(id,error)=>rpc.answers.push({id,error});
  const feishu=new EventEmitter();feishu.connected=true;feishu.delivered=[];feishu.deliver=async x=>{feishu.delivered.push(x);};
  const bridge=new Bridge({root,store,rpc,feishu,config:{progressMinutes:10}});
  return {root,store,rpc,feishu,bridge};
}
const msg=(text,id='m1',senderId='owner',chatId='chat')=>({content:text,messageId:id,senderId,chatId,chatType:'p2p'});

test('unauthorized sender cannot start tasks or answer requests',async t=>{
  const {bridge,store,rpc}=fixture(t);await bridge.message(msg('新建 任务','m','stranger'));assert.equal(store.data.tasks.length,0);assert.equal(rpc.calls.length,0);
  await assert.rejects(bridge.answer('R123','accept','stranger','chat'),/未授权/);
});

test('model and effort controls validate account capabilities and pass settings to next turn',async t=>{
  const {bridge,rpc,store}=fixture(t);await bridge.message(msg('新建 测试'));
  await bridge.message(msg('模型 model-b','model1'));await bridge.message(msg('强度 low','effort1'));
  await assert.rejects(bridge.message(msg('强度 high','effort2')),/不支持/);
  assert.equal(rpc.calls.filter(c=>c.method==='turn/start').length,1);
  store.data.tasks[0].status='completed';await bridge.message(msg('继续 T001','next'));
  const params=rpc.calls.filter(c=>c.method==='turn/start').at(-1).params;assert.equal(params.model,'model-b');assert.equal(params.effort,'low');
  await bridge.action({operator:{openId:'stranger'},chatId:'chat',action:{value:{setting:'model',model:'model-a',epoch:bridge.epoch,taskId:'T001'}}});assert.equal(bridge.config.model,'model-b');
  await bridge.action({operator:{openId:'owner'},chatId:'chat',action:{value:{setting:'model',model:'model-a',epoch:bridge.epoch,taskId:'T999'}}});assert.equal(bridge.config.model,'model-b');
});

test('global relay excludes transcript, raw tool arguments, outputs and unrelated fields',()=>{
  const e=sanitizeEvent({hook_event_name:'PostToolUse',session_id:'session',turn_id:'turn',tool_name:'Bash',tool_input:{command:'secret'},tool_response:'secret',transcript_path:'secret',prompt:'secret'});
  assert.ok(e);assert.doesNotMatch(JSON.stringify(e),/secret/);assert.equal(e.tool,'Bash');
  assert.equal(sanitizeEvent({hook_event_name:'Stop',session_id:'../bad',turn_id:'turn'}),null);
});

test('desktop question monitor forwards new explicit questions once and omits raw calls and secret options',async t=>{
  const {bridge,store,root}=fixture(t),sync=new DesktopSync(bridge),sessionsRoot=path.join(root,'sessions');
  store.data.desktopTasks.push({id:'D001',threadId:'11111111-1111-7111-8111-111111111111',title:'电脑项目'});
  const monitor=new QuestionMonitor(sync,{sessionsRoot});
  const d=new Date(),dir=path.join(sessionsRoot,String(d.getFullYear()),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0'));
  fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'rollout-11111111-1111-7111-8111-111111111111.jsonl');fs.writeFileSync(file,'');monitor.poll();
  const event={timestamp:new Date(Date.now()+10).toISOString(),type:'response_item',payload:{type:'function_call',call_id:'question1',name:'request_user_input_async',arguments:JSON.stringify({questions:[{title:'选择颜色',options:['蓝色','绿色']},{question:'密码？',isSecret:true,options:['never-send-secret']}],rawSecret:'never-send-secret'})}};
  fs.appendFileSync(file,JSON.stringify(event)+'\n');monitor.poll();monitor.poll();
  assert.equal(store.data.outbox.length,1);const text=JSON.stringify(store.data.outbox[0]);assert.match(text,/选择颜色/);assert.match(text,/蓝色/);assert.doesNotMatch(text,/never-send-secret/);
  assert.equal(extractQuestions({type:'response_item',payload:{type:'function_call',name:'exec_command',arguments:'{}'}}),null);
});

test('authenticated forms create a task once and preserve callback fields without raw event',async t=>{
  const {bridge,store,rpc}=fixture(t);bridge.config.nativeForms=true;
  bridge.newTaskForm('chat');const item=store.data.outbox.at(-1);const button=item.payload.card.body.elements[1].elements.at(-1);
  const raw={action:{form_value:{prompt:'表单任务'}},secret:'not retained'};
  const evt=cardAction({operator:{openId:'owner'},chatId:'chat',messageId:'card',action:{value:button.value},raw});
  assert.equal(evt.raw,undefined);assert.equal(evt.action.formValue.prompt,'表单任务');
  await bridge.action({...evt,operator:{openId:'stranger'}});assert.equal(rpc.calls.length,0);
  await bridge.action(evt);await bridge.action(evt);assert.equal(store.data.tasks.length,1);assert.equal(rpc.calls.filter(x=>x.method==='turn/start').length,1);
});

test('stale settings forms cannot modify a newly selected task',async t=>{
  const {bridge,store}=fixture(t);bridge.config.nativeForms=true;await bridge.message(msg('新建 首个任务'));
  bridge.effortMenu('chat');const button=store.data.outbox.at(-1).payload.card.body.elements[1].elements.at(-1);
  store.data.tasks.push({id:'T002',model:'model-b',effort:'low'});bridge.select('chat',store.data.tasks.at(-1));
  await bridge.action({operator:{openId:'owner'},chatId:'chat',action:{value:button.value,formValue:{effort:'high'}}});assert.equal(store.data.tasks.at(-1).effort,'low');
});

test('mobile model labels omit repeated GPT prefix and long buttons occupy one row',()=>{
  assert.equal(modelLabel({displayName:'GPT-6.1-Sol'}),'6.1 Sol');
  const short=card('title','body',[{label:'6.1 Sol',value:{}},{label:'6 Astra',value:{}},{label:'6 Luna',value:{}}]);assert.equal(short.body.elements[1].columns.length,2);
  const long=card('title','body',[{label:'这个问题的选项文字非常长需要完整显示在一行按钮里',value:{}}]);assert.equal(long.body.elements[1].columns.length,1);
});

test('Chinese and escaped long reply cards respect the Feishu byte limit, including old queued cards',()=>{
  for(const text of ['中'.repeat(14000),('"\\\n😀').repeat(6000)]){
    const result=card('本轮回复',text);
    assert.ok(Buffer.byteLength(JSON.stringify(result),'utf8')<30000);
    const old=card('旧卡片','');old.body.elements[0].content=text;
    assert.ok(Buffer.byteLength(JSON.stringify(fitCard(old)),'utf8')<30000);
  }
});

test('desktop Markdown images never become invalid Feishu image keys',()=>{
  const result=card('回复','![截图](C:/Users/User/output.png)\n![网页图](https://example.com/img.png)\n![飞书图](img_valid-key)');
  const text=result.body.elements[0].content;
  assert.doesNotMatch(text,/!\[截图\]|!\[网页图\]/);assert.match(text,/!\[飞书图\]\(img_valid-key\)/);
});

test('desktop migration removes false alerts but preserves genuine remote approvals',async t=>{
  const {bridge,store}=fixture(t);
  store.data.desktopTasks=[{id:'D001',status:'waiting',activity:'等待在电脑上批准'}];
  bridge.show('chat','桌面任务需要审批','obsolete');
  bridge.show('chat','T001 · 需要你的批准','真实命令',[],'orange');
  store.data.requests.push({code:'R123',taskId:'T001',status:'pending'});
  new DesktopSync(bridge);
  assert.equal(store.data.outbox.length,1);assert.equal(store.data.outbox[0].payload.card.header.title.content,'T001 · 需要你的批准');
  assert.equal(store.data.requests[0].status,'pending');assert.equal(store.data.desktopTasks[0].status,'running');
});

test('desktop events produce reports, deduplicate stops and never duplicate bridge tasks',async t=>{
  const {bridge,store,root}=fixture(t);const sync=new DesktopSync(bridge);
  const event=(id,event,turnId='first',extra={})=>({id,event,turnId,sessionId:'desktop',at:Date.now(),...extra});
  sync.event(event('1','UserPromptSubmit','first',{title:'桌面任务'}));const notices=store.data.outbox.length;
  sync.event(event('2','PermissionRequest'));sync.event(event('2b','PermissionRequest'));sync.event(event('2c','PermissionRequest'));
  assert.equal(store.data.desktopTasks[0].status,'running');assert.equal(store.data.outbox.length,notices);
  sync.event(event('3','PostToolUse'));assert.equal(store.data.desktopTasks[0].status,'running');
  sync.event(event('4','Stop','first',{reply:'完成的回复'}));const count=store.data.outbox.length;
  sync.event(event('4','Stop','first',{reply:'完成的回复'}));sync.event(event('5','Stop','first',{reply:'完成的回复'}));assert.equal(store.data.outbox.length,count);
  const task=store.data.desktopTasks[0];assert.equal(task.status,'completed');assert.match(fs.readFileSync(task.report,'utf8'),/完成的回复/);
  sync.event(event('6','PostToolUse'));assert.equal(task.status,'completed');
  sync.event(event('7','UserPromptSubmit','second'));sync.event(event('8','Stop','first'));assert.equal(task.status,'running');assert.equal(task.turnId,'second');
  sync.event({...event('9','UserPromptSubmit'),sessionId:'bridge',cwd:path.join(root,'tasks','T001','project')});assert.equal(store.data.desktopTasks.length,1);
  const beforeTick=store.data.outbox.length;bridge.tick(task.lastNoticeAt+600001);assert.equal(store.data.outbox.length,beforeTick);
});
test('new task preserves cwd boundary and deduplicates incoming messages',async t=>{
  const {bridge,store,rpc,root}=fixture(t);await bridge.message(msg('新建 请完成报告'));await bridge.message(msg('新建 请完成报告'));
  assert.equal(store.data.tasks.length,1);assert.ok(within(path.join(root,'tasks'),store.data.tasks[0].cwd));
  const start=rpc.calls.find(x=>x.method==='thread/start');assert.equal(start.params.approvalPolicy,'on-request');assert.equal(start.params.sandbox,'workspace-write');assert.equal(start.params.dynamicTools[0].name,'feishu_ask_user');
});
test('dynamic question blocks until authorized reply and rejects duplicate click',async t=>{
  const {bridge,store,rpc}=fixture(t);await bridge.message(msg('新建 测试'));
  await bridge.request({id:100,method:'item/tool/call',params:{threadId:'thr',turnId:'turn',tool:'feishu_ask_user',arguments:{question:'颜色？',options:['蓝','绿']}}});
  const r=store.data.requests[0];assert.equal(store.data.tasks[0].status,'waiting');assert.equal(rpc.answers.length,0);
  const e={operator:{openId:'owner'},chatId:'chat',action:{value:{request:r.code,epoch:bridge.epoch,question:'answer',answer:'蓝'}}};
  await bridge.action(e);await bridge.action(e);assert.equal(rpc.answers.length,1);assert.equal(rpc.answers[0].result.success,true);assert.equal(store.data.tasks[0].status,'running');
});
test('multi-question input waits for every question',async t=>{
  const {bridge,store,rpc}=fixture(t);await bridge.message(msg('新建 测试'));
  await bridge.request({id:101,method:'item/tool/requestUserInput',params:{threadId:'thr',questions:[{id:'a',question:'A?',options:[{label:'a1'}]},{id:'b',question:'B?',options:[{label:'b1'}]}]}});
  const r=store.data.requests[0];await bridge.answer(r.code,'a1','owner','chat','a');assert.equal(rpc.answers.length,0);
  await bridge.answer(r.code,'b1','owner','chat','b');assert.deepEqual(rpc.answers[0].result,{answers:{a:{answers:['a1']},b:{answers:['b1']}}});
});
test('permissions approval grants only the presented turn-scoped permission',async t=>{
  const {bridge,store,rpc}=fixture(t);await bridge.message(msg('新建 测试'));
  const permissions={network:{enabled:true}};
  await bridge.request({id:102,method:'item/permissions/requestApproval',params:{threadId:'thr',permissions}});
  await bridge.answer(store.data.requests[0].code,'accept','owner','chat');assert.deepEqual(rpc.answers[0].result,{permissions,scope:'turn'});
});
test('restart invalidates old approval and preserves conversation id',async t=>{
  const f=fixture(t);await f.bridge.message(msg('新建 测试'));await f.bridge.request({id:103,method:'item/commandExecution/requestApproval',params:{threadId:'thr',command:'test',reason:'test'}});
  const code=f.store.data.requests[0].code;f.bridge.recover();await f.bridge.answer(code,'accept','owner','chat');assert.equal(f.rpc.answers.length,0);assert.equal(f.store.data.requests[0].status,'expired');
  f.bridge.loaded.clear();await f.bridge.message(msg('继续 T001','m2'));assert.ok(f.rpc.calls.some(x=>x.method==='thread/resume'&&x.params.threadId==='thr'));
});
test('completion writes final reply report and expires pending approvals',async t=>{
  const {bridge,store,rpc,root}=fixture(t);await bridge.message(msg('新建 测试'));await bridge.request({id:104,method:'item/commandExecution/requestApproval',params:{threadId:'thr',command:'test'}});
  await bridge.notification({method:'item/completed',params:{threadId:'thr',item:{id:'a',type:'agentMessage',phase:'commentary',text:'处理中'}}});
  await bridge.notification({method:'item/completed',params:{threadId:'thr',item:{id:'b',type:'agentMessage',phase:'final_answer',text:'结果完成'}}});
  await bridge.notification({method:'turn/completed',params:{threadId:'thr',turn:{id:'turn',status:'completed'}}});
  const task=store.data.tasks[0];assert.equal(task.status,'completed');assert.equal(task.lastResult,'结果完成');assert.ok(within(root,task.report));assert.match(fs.readFileSync(task.report,'utf8'),/结果完成/);
  await bridge.answer(store.data.requests[0].code,'accept','owner','chat');assert.equal(rpc.answers.length,0);assert.ok(store.data.outbox.some(x=>x.payload.kind==='file'));
});
test('notification retries retain a stable message uuid across restart',async t=>{
  const {bridge,store,feishu}=fixture(t);bridge.say('chat','报告');const id=store.data.outbox[0].id;
  feishu.deliver=async()=>{throw new Error('offline');};await bridge.drain();assert.equal(store.data.outbox[0].id,id);assert.equal(store.data.outbox[0].attempts,1);
  const reloaded=new Store(store.file);assert.equal(reloaded.data.outbox[0].id,id);store.data.outbox[0].nextAt=0;feishu.deliver=async()=>{};await bridge.drain();assert.equal(store.data.outbox.length,0);
});
test('periodic reports stay disabled and on-demand overview covers desktop and bot tasks',async t=>{
  const {bridge,store}=fixture(t);await bridge.message(msg('新建 测试'));const task=store.data.tasks[0];const count=store.data.outbox.length;
  bridge.tick(task.lastNoticeAt+599999);bridge.tick(task.lastNoticeAt+600001);bridge.tick(task.lastNoticeAt+86400000);assert.equal(store.data.outbox.length,count);
  store.data.desktopTasks=[{id:'D001',chatId:'chat',title:'电脑项目',status:'running',activity:'检查文件'},{id:'D002',chatId:'chat',title:'旧项目',status:'completed',archived:true}];
  await bridge.message(msg('有几个项目正在运行','overview'));
  const text=store.data.outbox.at(-1).payload.card.body.elements[0].content;assert.match(text,/进行中：2 个/);assert.match(text,/电脑项目/);assert.doesNotMatch(text,/旧项目/);
  assert.doesNotMatch(JSON.stringify(store.data.outbox.at(-1).payload),/\d+%/);
});
test('RPC separates server requests from request-response messages using same id',async()=>{
  const rpc=new CodexRpc();let incoming;rpc.on('request',m=>incoming=m);let resolved=false;
  rpc.pending.set(1,{resolve:()=>{resolved=true;},reject:()=>{},timer:setTimeout(()=>{},1000)});
  rpc.receive({id:1,method:'item/tool/call',params:{}});assert.equal(incoming.id,1);assert.equal(resolved,false);
  rpc.receive({id:1,result:{ok:true}});assert.equal(resolved,true);
});

test('report delivery handles the official SDK unwrapped upload response and reuses file key',async t=>{
  const {root}=fixture(t);const file=path.join(root,'report.md');fs.writeFileSync(file,'测试报告');
  const f=new Feishu();f.connected=true;let uploads=0;const sends=[];
  f.client={im:{file:{create:async()=>{uploads++;return {file_key:'test-key'};}},message:{create:async args=>{sends.push(args.data);return {code:0,data:{message_id:'test-id'}};}}}};
  const item={id:'stable-id',chatId:'chat',payload:{kind:'file',path:file,name:'report.md'}};
  await f.deliver(item);await f.deliver(item);assert.equal(uploads,1);assert.equal(sends[0].uuid,'stable-id');assert.deepEqual(JSON.parse(sends[0].content),{file_key:'test-key'});
});
test('report delivery rejects failed upload instead of announcing a missing attachment',async t=>{
  const {root}=fixture(t);const file=path.join(root,'report.md');fs.writeFileSync(file,'测试报告');
  const f=new Feishu();f.connected=true;let sends=0;
  f.client={im:{file:{create:async()=>({code:99991400,msg:'permission denied'})},message:{create:async()=>{sends++;}}}};
  await assert.rejects(f.deliver({id:'id',chatId:'chat',payload:{kind:'file',path:file,name:'report.md'}}),/99991400/);assert.equal(sends,0);
});
