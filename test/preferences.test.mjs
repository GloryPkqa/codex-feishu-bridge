import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store,within} from '../src/store.mjs';
import {Bridge} from '../src/bridge.mjs';
import {DesktopSync} from '../src/desktop-sync.mjs';
import {NOTIFICATION_KEYS,normalizePreferences,validatePreferences} from '../src/preferences.mjs';

function fixture(t,preferences={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'feishu-preferences-'));
  t.after(()=>{assert.ok(within(os.tmpdir(),root));fs.rmSync(root,{recursive:true,force:true});});
  const store=new Store(path.join(root,'state.json'));store.data.ownerId='owner';store.data.ownerChat='chat';
  const rpc=new EventEmitter();rpc.ready=true;rpc.authenticated=true;rpc.calls=[];rpc.answers=[];
  rpc.models=[];
  rpc.call=async(method,params)=>{rpc.calls.push({method,params});if(method==='thread/start')return {thread:{id:'thread-'+rpc.calls.length}};if(method==='turn/start')return {turn:{id:'turn-'+rpc.calls.length}};return {};};
  rpc.respond=(id,result)=>rpc.answers.push({id,result});rpc.reject=(id,error)=>rpc.answers.push({id,error});
  const feishu=new EventEmitter();feishu.connected=true;feishu.delivered=[];feishu.deliver=async item=>feishu.delivered.push(item);
  const config={nativeForms:true,preferences:normalizePreferences(preferences)};
  const bridge=new Bridge({root,store,rpc,feishu,config});
  return {root,store,rpc,feishu,bridge,config};
}
const message=(content,messageId='message')=>({content,messageId,chatId:'chat',senderId:'owner',chatType:'p2p'});
const allNotificationsOff={notifications:Object.fromEntries(NOTIFICATION_KEYS.map(key=>[key,false]))};
const dynamicQuestion=task=>({id:55,method:'item/tool/call',params:{threadId:task.threadId,tool:'feishu_ask_user',arguments:{question:'选哪种颜色？',options:['蓝色','绿色']}}});

test('settings validate only known boolean keys and normalize partial or missing defaults',()=>{
  const preferences=validatePreferences({notifications:{files:false},features:{remoteApprovals:false}});
  assert.equal(preferences.notifications.files,false);assert.equal(preferences.notifications.questions,true);
  assert.equal(preferences.features.remoteApprovals,false);assert.equal(preferences.features.continuation,true);
  for(const invalid of [null,[],{notifications:[]},{features:null},{unknown:true},{notifications:{other:false}},{features:{newTasks:'false'}},{notifications:{files:0}}])assert.throws(()=>validatePreferences(invalid));
  assert.deepEqual(normalizePreferences(undefined),validatePreferences({}));
  assert.equal('unknown' in normalizePreferences({unknown:true}),false);
});

test('queued automatic notifications are filtered again after settings change; manual replies remain',async t=>{
  const {bridge,store,feishu,config}=fixture(t);
  await bridge.message(message('新建 测试报告'));
  assert.equal(store.data.outbox[0].category,'started');
  config.preferences.notifications.started=false;
  bridge.panel('chat');await bridge.message(message('状态','query'));
  await bridge.drain();
  assert.equal(store.data.outbox.length,0);assert.equal(feishu.delivered.length,2);
  assert.ok(feishu.delivered.every(item=>!item.category));
  assert.equal(feishu.delivered.some(item=>item.payload.card.header.title.content==='任务已开始'),false);
});

test('hidden questions still wait, appear by request number in status, and can be fetched and answered manually',async t=>{
  const {bridge,store,rpc}=fixture(t,allNotificationsOff);
  await bridge.message(message('新建 测试问题'));
  const task=store.data.tasks[0];await bridge.request(dynamicQuestion(task));
  const request=store.data.requests[0];assert.equal(task.status,'waiting');assert.equal(store.data.outbox.length,0);assert.equal(rpc.answers.length,0);
  await bridge.message(message('状态','overview'));
  assert.match(JSON.stringify(store.data.outbox.at(-1)),new RegExp(request.code));
  await bridge.message(message('进度 T001','detail'));
  assert.match(JSON.stringify(store.data.outbox.at(-1)),new RegExp(request.code));
  await bridge.message(message('问题 T001','show'));
  assert.match(JSON.stringify(store.data.outbox.at(-1)),/选哪种颜色/);assert.equal(store.data.outbox.at(-1).category,undefined);
  await bridge.message(message(`回答 ${request.code} 蓝色`,'answer'));
  assert.equal(rpc.answers.length,1);assert.equal(rpc.answers[0].result.success,true);assert.equal(task.status,'running');
  assert.match(store.data.outbox.at(-1).payload.text,/已收到/);
});

test('all notifications can be disabled without losing T or desktop reports or enabling periodic sends',async t=>{
  const {bridge,store}=fixture(t,allNotificationsOff);
  await bridge.message(message('新建 保存报告'));
  const task=store.data.tasks[0];
  await bridge.notification({method:'turn/plan/updated',params:{threadId:task.threadId,plan:[{step:'验证',status:'completed'}]}});
  await bridge.notification({method:'item/completed',params:{threadId:task.threadId,item:{id:'reply',type:'agentMessage',phase:'final_answer',text:'报告内容保留'}}});
  await bridge.notification({method:'turn/completed',params:{threadId:task.threadId,turn:{status:'completed'}}});
  assert.match(fs.readFileSync(task.report,'utf8'),/报告内容保留/);assert.equal(store.data.outbox.length,0);
  const desktop=new DesktopSync(bridge),event=(id,event,extra={})=>({id,event,sessionId:'desktop-thread',turnId:'desktop-turn',at:Date.now(),...extra});
  desktop.event(event('start','UserPromptSubmit',{title:'桌面报告'}));
  desktop.question({id:'question',sessionId:'desktop-thread',questions:[{text:'桌面选择？',options:[]}]});
  desktop.event(event('stop','Stop',{reply:'桌面报告内容保留'}));
  const dt=store.data.desktopTasks[0];assert.match(fs.readFileSync(dt.report,'utf8'),/桌面报告内容保留/);assert.equal(store.data.outbox.length,0);
  bridge.tick(Date.now()+86400000);assert.equal(store.data.outbox.length,0);
});

test('disabling only files leaves completion summaries with honest local-report wording',async t=>{
  const {bridge,store}=fixture(t,{notifications:{files:false}});
  await bridge.message(message('新建 保存附件'));const task=store.data.tasks[0];
  await bridge.notification({method:'turn/completed',params:{threadId:task.threadId,turn:{status:'completed'}}});
  assert.ok(fs.existsSync(task.report));assert.equal(store.data.outbox.some(item=>item.payload.kind==='file'),false);
  const result=store.data.outbox.find(item=>item.category==='results');
  assert.match(JSON.stringify(result),/完整回复保存在本机报告/);assert.doesNotMatch(JSON.stringify(result),/随附件发送/);
});

test('new-task switch guards plain messages, direct calls and forms opened before disabling',async t=>{
  const {bridge,store,rpc,config,root}=fixture(t);
  bridge.newTaskForm('chat');const token=[...bridge.forms.keys()][0];
  config.preferences.features.newTasks=false;
  await assert.rejects(bridge.message(message('新建 任意要求')),/新建任务功能已关闭/);
  await assert.rejects(bridge.message(message('普通消息','plain')),/新建任务功能已关闭/);
  await assert.rejects(bridge.newTask('chat','直接调用','direct'),/新建任务功能已关闭/);
  assert.throws(()=>bridge.newTaskForm('chat'),/新建任务功能已关闭/);
  await assert.rejects(bridge.submitForm({chatId:'chat',messageId:'form',action:{formValue:{prompt:'旧表单'}}},token),/新建任务功能已关闭/);
  await assert.rejects(bridge.run({id:'T999',cwd:path.join(root,'tasks','T999','project'),status:'idle'},'绕过入口','run'),/新建任务功能已关闭/);
  assert.equal(store.data.tasks.length,0);assert.equal(rpc.calls.length,0);assert.equal(fs.existsSync(path.join(root,'tasks')),false);
});

test('continuation switch guards resume and steering while allowing initial tasks, stop, query and answers',async t=>{
  const {bridge,store,rpc,config}=fixture(t,{features:{continuation:false}});
  await bridge.message(message('新建 初始任务'));const task=store.data.tasks[0];const count=rpc.calls.length;
  await assert.rejects(bridge.message(message('补充要求','steer')),/继续对话功能已关闭/);
  task.status='completed';await assert.rejects(bridge.message(message('继续 T001','continue')),/继续对话功能已关闭/);
  await assert.rejects(bridge.run(task,'绕过入口','run'),/继续对话功能已关闭/);assert.equal(rpc.calls.length,count);
  task.status='running';await bridge.request(dynamicQuestion(task));
  const request=store.data.requests[0];await bridge.answer(request.code,'蓝色','owner','chat');assert.equal(rpc.answers.length,1);
  await bridge.message(message('停止 T001','stop'));assert.equal(rpc.calls.at(-1).method,'turn/interrupt');
  await bridge.message(message('状态','status'));assert.equal(store.data.outbox.at(-1).payload.card.header.title.content,'所有项目状态');
  config.preferences.features.continuation=true;task.status='completed';await bridge.message(message('继续 T001','enabled'));assert.equal(rpc.calls.at(-1).method,'turn/start');
});

test('disabled remote approvals decline command, file and permission requests using each protocol',async t=>{
  const {bridge,store,rpc}=fixture(t,{features:{remoteApprovals:false}});
  await bridge.message(message('新建 审批检查'));const task=store.data.tasks[0];
  for(const [index,method] of ['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval'].entries()){
    await bridge.request({id:index,method,params:{threadId:task.threadId,command:'test',permissions:{network:{enabled:true}}}});
    assert.deepEqual(rpc.answers.at(-1).result,method==='item/permissions/requestApproval'?{permissions:{},scope:'turn'}:{decision:'decline'});
  }
  assert.equal(store.data.requests.some(request=>request.status==='pending'),false);assert.equal(task.status,'running');
  assert.match(store.data.outbox.at(-1).payload.text,/已拒绝本次权限请求/);assert.match(task.activity,/远程审批已关闭/);
});

test('old allow buttons cannot approve after remote-approval switch closes; decline still works',async t=>{
  const {bridge,store,rpc,config}=fixture(t);
  await bridge.message(message('新建 旧按钮检查'));const task=store.data.tasks[0];
  await bridge.request({id:88,method:'item/permissions/requestApproval',params:{threadId:task.threadId,permissions:{network:{enabled:true}}}});
  const old=store.data.requests[0];config.preferences.features.remoteApprovals=false;
  await bridge.action({operator:{openId:'owner'},chatId:'chat',action:{value:{request:old.code,epoch:bridge.epoch,answer:'accept'}}});
  assert.deepEqual(rpc.answers.at(-1).result,{permissions:{},scope:'turn'});assert.equal(old.status,'answered');
  assert.match(store.data.outbox.at(-1).payload.text,/已拒绝本次请求/);
  config.preferences.features.remoteApprovals=true;
  await bridge.request({id:89,method:'item/commandExecution/requestApproval',params:{threadId:task.threadId,command:'test'}});
  const pending=store.data.requests.at(-1);config.preferences.features.remoteApprovals=false;
  await bridge.answer(pending.code,'decline','owner','chat');assert.deepEqual(rpc.answers.at(-1).result,{decision:'decline'});
});

test('error preference covers failure, interruption, disconnection and restart, without deleting task state',async t=>{
  const {bridge,store,config}=fixture(t,{notifications:{errors:false,files:false}});
  await bridge.message(message('新建 中断测试'));const task=store.data.tasks[0];store.data.outbox=[];
  await bridge.notification({method:'turn/completed',params:{threadId:task.threadId,turn:{status:'interrupted'}}});
  assert.equal(task.status,'interrupted');assert.ok(fs.existsSync(task.report));assert.equal(store.data.outbox.length,0);
  task.status='running';bridge.disconnected();assert.equal(task.status,'disconnected');assert.equal(store.data.outbox.length,0);
  task.status='waiting';bridge.recover();assert.equal(task.status,'disconnected');assert.equal(store.data.outbox.length,0);
  config.preferences.notifications.errors=true;task.status='running';bridge.disconnected();assert.equal(store.data.outbox[0].category,'errors');
});
