import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {QuestionMonitor,extractQuestions} from '../src/question-monitor.mjs';

const firstId='11111111-1111-4111-8111-111111111111';
function fixture(t){
  const sessionsRoot=fs.mkdtempSync(path.join(os.tmpdir(),'feishu-question-review-'));
  t.after(()=>{
    const real=fs.realpathSync(sessionsRoot),temp=fs.realpathSync(os.tmpdir()),rel=path.relative(temp,real);
    assert.ok(rel&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));
    fs.rmSync(real,{recursive:true,force:true});
  });
  const store={data:{},saves:0,save(){this.saves++;}},questions=[];
  const sync={store,question:q=>questions.push(q)};
  function file(id=firstId,ago=0){
    const d=new Date(Date.now()-ago*86400000),dir=path.join(sessionsRoot,String(d.getFullYear()),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0'));
    fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'rollout-'+id+'.jsonl');if(!fs.existsSync(file))fs.writeFileSync(file,'');return file;
  }
  const event=(call='question',time=Date.now()+1000)=>JSON.stringify({timestamp:new Date(time).toISOString(),type:'response_item',payload:{type:'function_call',call_id:call,name:'request_user_input_async',arguments:JSON.stringify({questions:[{title:'短标题',question:'完整问题正文：请选择颜色？',options:['蓝色','绿色']}]})}})+'\n';
  return {sessionsRoot,store,questions,sync,file,event};
}

test('old creation-day sessions keep forwarding new questions, including after restart',t=>{
  const f=fixture(t),file=f.file(firstId,15);
  fs.appendFileSync(file,f.event('historical',Date.now()-86400000));
  let monitor=new QuestionMonitor(f.sync,{sessionsRoot:f.sessionsRoot});monitor.resetBaseline();
  fs.appendFileSync(file,f.event('new-question'));monitor.poll();
  assert.deepEqual(f.questions.map(q=>q.id),['new-question']);
  const saved=structuredClone(f.store.data);f.store.data=saved;
  monitor=new QuestionMonitor(f.sync,{sessionsRoot:f.sessionsRoot});
  fs.appendFileSync(file,f.event('after-restart'));monitor.poll();
  assert.deepEqual(f.questions.map(q=>q.id),['new-question','after-restart']);
});

test('partial JSON and UTF-8 records survive a monitor restart and deliver once',t=>{
  const f=fixture(t),file=f.file();let monitor=new QuestionMonitor(f.sync,{sessionsRoot:f.sessionsRoot});monitor.resetBaseline();
  const bytes=Buffer.from(f.event('split-question')),split=bytes.indexOf(Buffer.from('完整'))+1;
  fs.appendFileSync(file,bytes.subarray(0,split));monitor.poll();
  assert.equal(f.store.data.questionCursors[firstId],0);assert.equal(f.questions.length,0);
  f.store.data=structuredClone(f.store.data);monitor=new QuestionMonitor(f.sync,{sessionsRoot:f.sessionsRoot});
  fs.appendFileSync(file,bytes.subarray(split));monitor.poll();monitor.poll();
  assert.equal(f.questions.length,1);assert.equal(f.questions[0].questions[0].text,'完整问题正文：请选择颜色？');
  assert.equal(f.store.data.questionCursors[firstId],bytes.length);
});

test('enabling again baselines out questions written while syncing was disabled',t=>{
  const f=fixture(t),file=f.file(firstId,9),monitor=new QuestionMonitor(f.sync,{sessionsRoot:f.sessionsRoot});
  monitor.resetBaseline();fs.appendFileSync(file,f.event('while-disabled'));monitor.resetBaseline();monitor.poll();
  assert.equal(f.questions.length,0);
  fs.appendFileSync(file,f.event('after-enabled'));monitor.poll();
  assert.deepEqual(f.questions.map(q=>q.id),['after-enabled']);
});

test('the full question takes precedence over a short title and secret flags stay intact',()=>{
  const result=extractQuestions({type:'response_item',payload:{type:'function_call',call_id:'input',name:'functions.request_user_input',arguments:{questions:[{title:'标题',question:'需要用户回答的完整问题',isSecret:true,options:['不能上传的选项']}]}}});
  assert.equal(result.questions[0].text,'需要用户回答的完整问题');assert.equal(result.questions[0].secret,true);
});

test('active old sessions bypass the bounded background file rotation',t=>{
  const f=fixture(t),a=f.file(firstId,10),secondId='22222222-2222-4222-8222-222222222222',b=f.file(secondId,30);
  const monitor=new QuestionMonitor(f.sync,{sessionsRoot:f.sessionsRoot,maxFilesPerPoll:1});monitor.resetBaseline();
  f.store.data.desktopTasks=[{threadId:secondId,status:'running'}];
  fs.appendFileSync(a,f.event('background'));fs.appendFileSync(b,f.event('active'));monitor.poll();
  assert.ok(f.questions.some(q=>q.id==='active'));monitor.poll();
  assert.ok(f.questions.some(q=>q.id==='background'));assert.equal(f.questions.length,2);
});

test('unchanged polling does not rewrite the persisted store',t=>{
  const f=fixture(t);f.file(firstId,10);const monitor=new QuestionMonitor(f.sync,{sessionsRoot:f.sessionsRoot});monitor.resetBaseline();
  const saves=f.store.saves;monitor.poll();monitor.poll();assert.equal(f.store.saves,saves);
});
