import {setTimeout as sleep} from 'node:timers/promises';

// Reserve slots synchronously, including concurrent direct form previews.
export class SendLimiter {
  constructor({interval=300,now=Date.now,wait=sleep}={}){this.interval=interval;this.now=now;this.wait=wait;this.next=0;}
  async take(){const time=this.now(),at=Math.max(time,this.next);this.next=at+this.interval;if(at>time)await this.wait(at-time);}
}
