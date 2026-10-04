import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {CodexRpc} from '../src/rpc.mjs';

function fakeChildren(t){
  const children=[];
  t.after(()=>{for(const child of children){child.stdin.destroy();child.stdout.end();child.stderr.end();}});
  const spawnImpl=()=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.held=[];
    child.stdin=new Writable({write(chunk,encoding,done){
      for(const line of chunk.toString().trim().split('\n')){
        const request=JSON.parse(line);if(request.id===undefined)continue;
        if(request.method==='review/hold'){child.held.push(request);continue;}
        const result=request.method==='account/read'?{account:{type:'chatgpt'}}:request.method==='model/list'?{data:[]}:{};
        queueMicrotask(()=>child.stdout.write(JSON.stringify({id:request.id,result})+'\n'));
      }
      done();
    }});
    child.kill=()=>child.emit('exit',0,null);children.push(child);return child;
  };
  return {children,spawnImpl};
}

test('a delayed stdin error from an old child preserves a reconnected RPC and its pending request',async t=>{
  const {children,spawnImpl}=fakeChildren(t),rpc=new CodexRpc({bin:'fake-codex',spawnImpl});
  let disconnected=0;rpc.on('disconnected',()=>disconnected++);
  await rpc.start();const oldChild=children[0];oldChild.emit('exit',1,null);assert.equal(disconnected,1);
  await rpc.start();const newChild=children[1],pending=rpc.call('review/hold');
  assert.equal(rpc.pending.size,1);
  oldChild.stdin.emit('error',new Error('delayed old pipe error'));
  assert.equal(rpc.ready,true);assert.equal(rpc.pending.size,1);assert.equal(disconnected,1);
  newChild.stdout.write(JSON.stringify({id:newChild.held[0].id,result:{ok:true}})+'\n');
  assert.deepEqual(await pending,{ok:true});assert.equal(rpc.pending.size,0);
});

test('a stdin error from the current child still disconnects and rejects its pending request',async t=>{
  const {children,spawnImpl}=fakeChildren(t),rpc=new CodexRpc({bin:'fake-codex',spawnImpl});
  let disconnected=0;rpc.on('disconnected',()=>disconnected++);await rpc.start();
  const rejected=assert.rejects(rpc.call('review/hold'),/current pipe error/);
  children[0].stdin.emit('error',new Error('current pipe error'));await rejected;
  assert.equal(rpc.ready,false);assert.equal(rpc.pending.size,0);assert.equal(disconnected,1);
});
