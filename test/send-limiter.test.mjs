import test from 'node:test';
import assert from 'node:assert/strict';
import {SendLimiter} from '../src/send-limiter.mjs';

test('concurrent outgoing messages reserve different rate-limit slots',async()=>{
  const waits=[];const limiter=new SendLimiter({interval:300,now:()=>1000,wait:async n=>waits.push(n)});
  await Promise.all(Array.from({length:6},()=>limiter.take()));
  assert.deepEqual(waits,[300,600,900,1200,1500]);
});
test('idle time clears backlog without losing the next spacing interval',async()=>{
  let now=1000;const waits=[];const limiter=new SendLimiter({interval:300,now:()=>now,wait:async n=>waits.push(n)});
  await limiter.take();now=5000;await limiter.take();await limiter.take();
  assert.deepEqual(waits,[300]);
});
