import fs from 'node:fs';
import path from 'node:path';

export function extractQuestions(event){
  const p=event?.payload;
  if(event?.type!=='response_item'||p?.type!=='function_call'||!/(?:^|[._])request_user_input(?:_async)?$/.test(p.name??''))return null;
  let args;try{args=typeof p.arguments==='string'?JSON.parse(p.arguments):p.arguments;}catch{return null;}
  const questions=args?.questions?.slice(0,10).map(q=>({
    secret:!!q.isSecret,text:String(q.question??q.title??'').slice(0,1500),
    options:(q.options??[]).slice(0,10).map(o=>typeof o==='string'?{label:o.slice(0,300)}:{label:String(o.label??'').slice(0,300),description:String(o.description??'').slice(0,500)})
  })).filter(q=>q.text);
  return questions?.length?{id:p.call_id,at:Date.parse(event.timestamp)||Date.now(),questions}:null;
}

// The desktop host's asynchronous question tool may bypass ordinary tool hooks.
// Observe only new session records and forward explicit user questions. The
// transcript schema is local/unstable; unknown records are ignored safely.
export class QuestionMonitor {
  constructor(sync,{sessionsRoot=path.join(process.env.CODEX_HOME||path.join(process.env.USERPROFILE,'.codex'),'sessions'),maxFilesPerPoll=128,discoveryDirectoryBudget=24}={}){
    this.sync=sync;this.store=sync.store;this.sessionsRoot=sessionsRoot;this.live=new Map();this.files=new Map();
    this.maxFilesPerPoll=maxFilesPerPoll;this.discoveryDirectoryBudget=discoveryDirectoryBudget;this.fileIndex=0;this.discovery=[];this.discoveryAt=0;this.initialized=false;
    this.store.data.questionMonitoringSince??=Date.now();this.store.data.questionCursors??={};
    this.store.save();
  }
  resetBaseline(){
    this.live.clear();this.files.clear();this.fileIndex=0;this.discovery=[];
    this.store.data.questionCursors={};this.store.data.questionMonitoringSince=Date.now();
    // Capture existing lengths while the user enables syncing. Previously
    // recorded questions stay local, including records made while paused.
    this.startDiscovery();while(this.discovery.length)this.discover(this.discoveryDirectoryBudget,true);
    this.store.data.questionMonitoringSince=Date.now();this.initialized=true;this.discoveryAt=Date.now();this.store.save();
  }
  startDiscovery(){this.discovery=[{dir:this.sessionsRoot,depth:0}];}
  discover(budget,baseline=false){
    let changed=false;
    for(let n=0;n<budget&&this.discovery.length;n++){
      const {dir,depth}=this.discovery.shift();let entries;
      try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch{continue;}
      for(const entry of entries){
        if(depth<3){
          const valid=depth===0?/^\d{4}$/:depth===1?/^(?:0[1-9]|1[0-2])$/:/^(?:0[1-9]|[12]\d|3[01])$/;
          if(entry.isDirectory()&&valid.test(entry.name))this.discovery.push({dir:path.join(dir,entry.name),depth:depth+1});
          continue;
        }
        const match=entry.name.match(/-([a-f0-9]{8}-[a-f0-9-]{27})\.jsonl$/i);if(!entry.isFile()||!match)continue;
        const id=match[1],file=path.join(dir,entry.name);if(this.files.get(id)===file)continue;
        let stat;try{stat=fs.statSync(file);}catch{continue;}
        this.files.set(id,file);
        if(baseline||this.store.data.questionCursors[id]===undefined){
          this.store.data.questionCursors[id]=baseline||stat.birthtimeMs<this.store.data.questionMonitoringSince?stat.size:0;changed=true;
        }
      }
    }
    return changed;
  }
  read(id,file){
    let stat;try{stat=fs.statSync(file);}catch{this.files.delete(id);this.live.delete(id);return false;}
    let cursor=this.store.data.questionCursors[id]??0;
    let live=this.live.get(id)??{position:cursor,tail:Buffer.alloc(0),discarding:false};
    if(stat.size<live.position){cursor=0;live={position:0,tail:Buffer.alloc(0),discarding:false};}
    if(stat.size===live.position)return false;
    this.live.set(id,live);
    const fd=fs.openSync(file,'r');try{
      const buf=Buffer.alloc(Math.min(stat.size-live.position,1048576));
      const read=fs.readSync(fd,buf,0,buf.length,live.position);live.position+=read;
      const data=Buffer.concat([live.tail,buf.subarray(0,read)]);let start=0,end;
      while((end=data.indexOf(10,start))!==-1){
        if(!live.discarding){
          const line=data.subarray(start,end).toString('utf8');
          if(line.includes('request_user_input')){
            try{const q=extractQuestions(JSON.parse(line));if(q&&q.at>=this.store.data.questionMonitoringSince)this.sync.question({sessionId:id,...q});}catch{}
          }
        }
        live.discarding=false;start=end+1;cursor=live.position-(data.length-start);
      }
      live.tail=data.subarray(start);
      if(live.tail.length>2000000||live.discarding){live.tail=Buffer.alloc(0);live.discarding=true;}
      // Persist only complete lines. A restart re-reads any partial JSON/UTF-8
      // record instead of starting in the middle and losing the question.
      if(this.store.data.questionCursors[id]!==cursor){this.store.data.questionCursors[id]=cursor;return true;}
      return false;
    }finally{fs.closeSync(fd);}
  }
  poll(now=Date.now()){
    let changed=false;
    if(!this.initialized){this.startDiscovery();while(this.discovery.length)changed=this.discover(this.discoveryDirectoryBudget)||changed;this.initialized=true;this.discoveryAt=now;}
    // A conversation's file remains in its creation-day directory even when
    // used much later. Register all dates, then keep reading known live files.
    if(!this.discovery.length&&now-this.discoveryAt>=30000){this.startDiscovery();this.discoveryAt=now;}
    changed=this.discover(this.discoveryDirectoryBudget)||changed;
    // Inspect today's directory every poll so a fresh question need not wait
    // behind years of date directories during background discovery.
    const today=path.join(this.sessionsRoot,String(new Date(now).getFullYear()),String(new Date(now).getMonth()+1).padStart(2,'0'),String(new Date(now).getDate()).padStart(2,'0'));
    this.discovery.unshift({dir:today,depth:3});changed=this.discover(1)||changed;
    const checked=new Set(),active=new Set((this.store.data.desktopTasks??[]).filter(t=>['starting','running','waiting'].includes(t.status)).map(t=>t.threadId));
    for(const [id,file] of this.files)if(active.has(id)){changed=this.read(id,file)||changed;checked.add(id);}
    const files=[...this.files];
    for(let n=0;n<Math.min(this.maxFilesPerPoll,files.length);n++){
      const [id,file]=files[this.fileIndex++%files.length];if(!checked.has(id))changed=this.read(id,file)||changed;
    }
    if(changed)this.store.save();
  }
}
