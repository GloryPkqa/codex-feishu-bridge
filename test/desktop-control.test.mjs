import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store,within} from '../src/store.mjs';
import {Bridge} from '../src/bridge.mjs';
import {DesktopSync} from '../src/desktop-sync.mjs';
import {CodexRpcPool} from '../src/rpc-pool.mjs';

const message=(content,messageId='m')=>({content,messageId,chatId:'chat',senderId:'owner',chatType:'p2p'});
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-control-'));
 t.after(()=>{assert.ok(within(os.tmpdir(),root));fs.rmSync(root,{recursive:true,force:true});});
 const store=new Store(path.join(root,'state.json'));Object.assign(store.data,{ownerId:'owner',ownerChat:'chat',desktopTasks:[{id:'D001',source:'desktop',chatId:'chat',threadId:'original-thread',title:'原对话',cwd:root,status:'completed',turnId:'old-turn'}]});
 const rpc=new EventEmitter();Object.assign(rpc,{ready:true,authenticated:true,models:[],calls:[],opened:[],released:[],answers:[]});
 rpc.call=async(method,params)=>{
  rpc.calls.push({method,params});
  if(method==='thread/read'||method==='thread/resume')return {thread:{id:params.threadId,status:{type:'idle'},turns:[]}};
  if(method==='turn/start')return {turn:{id:'new-turn'}};
  return {};
 };
 rpc.openDesktop=async id=>rpc.opened.push(id);rpc.releaseDesktop=id=>rpc.released.push(id);
 rpc.respond=(id,result)=>rpc.answers.push({id,result});rpc.reject=(id,error)=>rpc.answers.push({id,error});
 const feishu=new EventEmitter(),bridge=new Bridge({store,rpc,feishu,root,config:{nativeForms:true}});
 return {store,rpc,bridge,dt:store.data.desktopTasks[0]};
}

test('desktop-only task selection and help explain which task receives replies',async t=>{
 const {store,bridge}=fixture(t);await bridge.message(message('帮助'));
 assert.match(JSON.stringify(store.data.outbox),/切换|选择任务/);assert.match(JSON.stringify(store.data.outbox),/继续 D001/);
 await bridge.message(message('任务','list'));
 const card=JSON.stringify(store.data.outbox.at(-1));assert.match(card,/D001/);assert.match(card,/原对话/);assert.doesNotMatch(card,/还没有飞书任务/);
 const token=[...bridge.forms.keys()][0];await bridge.submitForm({chatId:'chat',action:{formValue:{task:'D001'}}},token);
 assert.equal(bridge.selected('chat').id,'D001');assert.equal(store.data.tasks.length,0);
});
test('D continuation preserves thread ID, cwd and instructions, narrows permissions and releases on completion',async t=>{
 const {store,rpc,bridge,dt}=fixture(t);await bridge.message(message('继续 D001 补充原任务'));
 assert.equal(store.data.tasks.length,0);assert.equal(dt.threadId,'original-thread');assert.equal(dt.bridgeActive,true);
 assert.equal(rpc.calls.some(c=>['thread/start','thread/fork'].includes(c.method)),false);
 const resume=rpc.calls.find(c=>c.method==='thread/resume').params;
 assert.equal(resume.threadId,dt.threadId);assert.equal(resume.sandbox,'workspace-write');assert.equal(resume.approvalsReviewer,'user');
 assert.equal(resume.approvalPolicy,'on-request');assert.equal(resume.developerInstructions,undefined);assert.equal(resume.cwd,undefined);
 const start=rpc.calls.find(c=>c.method==='turn/start').params;assert.equal(start.input[0].text,'补充原任务');assert.equal(start.clientUserMessageId,'m');
 await bridge.message(message('再补充一点','steer'));
 assert.equal(rpc.calls.at(-1).method,'turn/steer');assert.equal(rpc.calls.at(-1).params.expectedTurnId,'new-turn');
 await bridge.request({id:'desktop:1',method:'item/tool/requestUserInput',params:{threadId:dt.threadId,questions:[{id:'q',question:'选择？',options:[{label:'甲'},{label:'乙'}]}]}});
 assert.equal(dt.status,'waiting');await bridge.answer(store.data.requests[0].code,'甲','owner','chat');assert.equal(rpc.answers[0].result.answers.q.answers[0],'甲');
 await bridge.notification({method:'item/completed',params:{threadId:dt.threadId,item:{id:'reply',type:'agentMessage',phase:'final_answer',text:'原会话结果'}}});
 await bridge.notification({method:'turn/completed',params:{threadId:dt.threadId,turn:{id:'new-turn',status:'completed'}}});
 assert.equal(dt.bridgeActive,false);assert.equal(dt.status,'completed');assert.deepEqual(rpc.released,[dt.threadId]);assert.match(fs.readFileSync(dt.report,'utf8'),/原会话结果/);
 const sync=new DesktopSync(bridge),before=store.data.outbox.length;
 sync.event({id:'hook-stop',sessionId:dt.threadId,turnId:'new-turn',event:'Stop',at:Date.now(),reply:'重复结果'});
 assert.equal(store.data.outbox.length,before);
 sync.event({id:'next-desktop',sessionId:dt.threadId,turnId:'future-turn',event:'UserPromptSubmit',at:Date.now()});assert.equal(dt.status,'running');
});
test('active desktop messages and stop never go to a different task or start a worker',async t=>{
 const {store,rpc,bridge,dt}=fixture(t);dt.status='running';
 await bridge.message(message('继续 D001 更改要求'));await bridge.message(message('停止 D001','stop'));await bridge.message(message('我再补充','plain'));
 assert.equal(rpc.calls.length,0);assert.equal(rpc.opened.length,0);assert.equal(store.data.tasks.length,0);
 assert.match(JSON.stringify(store.data.outbox),/没有发送/);
});
test('unknown and malformed D target commands cannot fall through into new T tasks',async t=>{
 const {bridge,store,rpc}=fixture(t);
 await assert.rejects(bridge.message(message('继续 D999 内容')),/找不到/);
 await bridge.message(message('继续 Dxxx 内容','bad'));
 assert.equal(store.data.tasks.length,0);assert.equal(rpc.calls.length,0);
});
test('persisted in-progress desktop turns are blocked even if hook status says completed',async t=>{
 const {bridge,rpc}=fixture(t);rpc.call=async()=>({thread:{id:'original-thread',status:{type:'notLoaded'},turns:[{status:'inProgress'}]}});
 await assert.rejects(bridge.message(message('继续 D001')),/执行中/);assert.equal(rpc.opened.length,0);
});
test('native writer-lock rejection restores desktop state without creating a copy',async t=>{
 const {bridge,rpc,dt,store}=fixture(t),call=rpc.call;
 rpc.call=async(method,params)=>{if(method==='thread/resume')throw new Error('thread original-thread already has an active writer');return call(method,params);};
 await assert.rejects(bridge.message(message('继续 D001')),/桌面仍持有/);
 assert.equal(dt.lastResumeError.kind,'writer_busy');assert.equal(dt.lastResumeError.stage,'resume');assert.match(dt.lastResumeError.message,/完成或停止不一定释放/);
 assert.equal(dt.status,'completed');assert.equal(dt.bridgeActive,false);assert.equal(store.data.tasks.length,0);assert.equal(rpc.calls.some(c=>c.method==='turn/start'),false);assert.deepEqual(rpc.released,[dt.threadId]);
});
test('backend errors remain specific when recognized and never expose raw secret or private path',async t=>{
 const {bridge,rpc,dt}=fixture(t),call=rpc.call;
 rpc.call=async(method,params)=>{if(method==='thread/resume')throw new Error('unknown failure: secret-token-123 /private/user');return call(method,params);};
 await assert.rejects(bridge.message(message('继续 D001')),e=>/恢复原会话/.test(e.message)&&!e.message.includes('secret-token-123')&&!e.message.includes('/private/user')&&!e.message.includes('插件暂不支持'));
 assert.equal(dt.lastResumeError.kind,'unknown');
});
test('desktop worker failure expires only that task requests and preserves primary T state',async t=>{
 const {bridge,store,dt}=fixture(t);dt.bridgeActive=true;dt.status='waiting';
 store.data.tasks.push({id:'T001',status:'running'});store.data.requests.push({taskId:'D001',status:'pending'},{taskId:'T001',status:'pending'});
 bridge.desktopDisconnected(dt.threadId);assert.equal(dt.status,'disconnected');assert.equal(dt.bridgeActive,false);assert.equal(store.data.tasks[0].status,'running');assert.equal(store.data.requests[1].status,'pending');
});
test('RPC pool isolates identical approval IDs and stops only the completed desktop worker',async()=>{
 const children=[],factory=()=>{
  const c=new EventEmitter();c.ready=true;c.authenticated=true;c.models=[];c.calls=[];c.answers=[];
  c.start=async()=>{};c.call=async(method,params)=>c.calls.push({method,params});c.respond=(id,result)=>c.answers.push({id,result});c.reject=(id,error)=>c.answers.push({id,error});c.stop=()=>{c.stopped=true;c.emit('disconnected');};children.push(c);return c;
 };
 const pool=new CodexRpcPool({},factory),received=[],resolved=[],disconnected=[];
 pool.on('request',m=>received.push(m));pool.on('notification',m=>resolved.push(m));pool.on('desktopDisconnected',id=>disconnected.push(id));
 await pool.openDesktop('d1');await pool.openDesktop('d2');
 children[0].emit('request',{id:7,method:'approval',params:{threadId:'t'}});
 children[1].emit('request',{id:7,method:'approval',params:{threadId:'d1'}});
 children[2].emit('request',{id:7,method:'approval',params:{threadId:'d2'}});
 assert.equal(new Set(received.map(m=>m.id)).size,3);
 pool.respond(received[1].id,{decision:'accept'});pool.respond(received[2].id,{decision:'decline'});
 assert.equal(children[1].answers[0].id,7);assert.equal(children[2].answers[0].result.decision,'decline');assert.equal(children[0].answers.length,0);
 children[1].emit('notification',{method:'serverRequest/resolved',params:{requestId:7}});assert.equal(resolved[0].params.requestId,received[1].id);
 children[1].emit('notification',{method:'serverRequest/resolved',params:{requestId:7}});assert.notEqual(resolved[1].params.requestId,7);
 await pool.call('turn/steer',{threadId:'d2'});assert.equal(children[2].calls[0].method,'turn/steer');
 pool.releaseDesktop('d1');assert.equal(children[0].stopped,undefined);assert.equal(children[2].stopped,undefined);assert.equal(children[1].stopped,true);assert.equal(disconnected.length,0);
 children[2].emit('disconnected');assert.deepEqual(disconnected,['d2']);pool.stop();
});
