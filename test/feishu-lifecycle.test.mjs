import test from 'node:test';
import assert from 'node:assert/strict';
import {Feishu} from '../src/feishu.mjs';

function fakeChannel({connect=async()=>{},name='fake-bot'}={}){
  const handlers=new Map(),channel={botIdentity:{name},closeCalls:[],disconnectCalls:0};
  channel.rawWsClient={close:opts=>channel.closeCalls.push(opts)};
  channel.on=(name,handler)=>{
    const listeners=handlers.get(name)??new Set();listeners.add(handler);handlers.set(name,listeners);
    return ()=>listeners.delete(handler);
  };
  channel.emit=(name,value)=>{for(const handler of handlers.get(name)??[])handler(value);};
  channel.snapshot=name=>[...(handlers.get(name)??[])];
  channel.listenerCount=()=>[...handlers.values()].reduce((n,set)=>n+set.size,0);
  channel.connect=connect;channel.disconnect=async()=>{channel.disconnectCalls++;};
  return channel;
}
function fakeFeishu(channels){
  let next=0;return new Feishu({createClient:()=>({fake:true}),createChannel:()=>channels[next++]});
}
const secrets={appId:'test-app',appSecret:'synthetic-secret'};

test('an initial handshake timeout force-closes the raw WS retry loop and clears callbacks',async()=>{
  const channel=fakeChannel({connect:async()=>{throw new Error('synthetic handshake timeout');}}),feishu=fakeFeishu([channel]);
  await assert.rejects(feishu.connect(secrets),/handshake timeout/);
  assert.deepEqual(channel.closeCalls,[{force:true}]);assert.equal(channel.disconnectCalls,1);
  assert.equal(channel.listenerCount(),0);assert.equal(feishu.channel,null);assert.equal(feishu.client,null);assert.equal(feishu.connected,false);
});

test('stale messages, actions and connection events from a replaced channel stay isolated',async()=>{
  const old=fakeChannel(),current=fakeChannel({name:'current-bot'}),feishu=fakeFeishu([old,current]),messages=[],actions=[],warnings=[];
  feishu.on('message',m=>messages.push(m));feishu.on('action',a=>actions.push(a));feishu.on('warning',w=>warnings.push(w));
  await feishu.connect(secrets);
  // Keep callbacks already queued before unsubscribe, as a transport can do.
  const stale=Object.fromEntries(['message','cardAction','error','reconnecting','reconnected'].map(name=>[name,old.snapshot(name)[0]]));
  await feishu.connect(secrets);
  stale.message({content:'old'});stale.cardAction({action:{value:{old:true}}});stale.error(new Error('old error'));stale.reconnecting();
  assert.equal(feishu.connected,true);stale.reconnected();
  assert.equal(feishu.botName,'current-bot');assert.equal(messages.length,0);assert.equal(actions.length,0);assert.equal(warnings.length,0);
  assert.equal(old.listenerCount(),0);assert.deepEqual(old.closeCalls,[{force:true}]);
  current.emit('message',{content:'current',raw:{notRetained:true}});assert.deepEqual(messages,[{content:'current'}]);
  current.emit('reconnecting');assert.equal(feishu.connected,false);current.emit('reconnected');assert.equal(feishu.connected,true);
  await feishu.disconnect();
});

test('normal disconnect closes the socket, clears active state and detaches events',async()=>{
  const channel=fakeChannel(),feishu=fakeFeishu([channel]);await feishu.connect(secrets);assert.equal(feishu.connected,true);
  await feishu.disconnect();assert.deepEqual(channel.closeCalls,[{force:true}]);assert.equal(channel.disconnectCalls,1);
  assert.equal(channel.listenerCount(),0);assert.equal(feishu.channel,null);assert.equal(feishu.client,null);assert.equal(feishu.connected,false);
});

test('a superseded pending handshake cannot restore or clear the newer connection',async()=>{
  let resolve;const old=fakeChannel({connect:()=>new Promise(r=>resolve=r)}),current=fakeChannel({name:'newer-bot'}),feishu=fakeFeishu([old,current]);
  const oldConnection=feishu.connect(secrets),cancelled=assert.rejects(oldConnection,/连接已取消/);
  await new Promise(setImmediate);assert.equal(typeof resolve,'function');await feishu.connect(secrets);
  resolve();await cancelled;assert.equal(feishu.channel,current);assert.equal(feishu.connected,true);assert.equal(feishu.botName,'newer-bot');
  assert.ok(old.closeCalls.every(x=>x.force===true));assert.equal(old.listenerCount(),0);await feishu.disconnect();
});
