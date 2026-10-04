import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

const allowed=new Set(['UserPromptSubmit','PreToolUse','PostToolUse','PermissionRequest','Stop','Interrupt']);
export function sanitizeEvent(raw,now=Date.now()) {
  if(!allowed.has(raw.hook_event_name)||!/^[-a-zA-Z0-9_]{1,100}$/.test(raw.session_id??'')||!/^[-a-zA-Z0-9_]{1,100}$/.test(raw.turn_id??''))return null;
  return {id:randomUUID(),at:now,event:raw.hook_event_name,sessionId:raw.session_id,turnId:raw.turn_id,cwd:String(raw.cwd??'').slice(0,4096),model:String(raw.model??'').slice(0,100),
    title:raw.hook_event_name==='UserPromptSubmit'&&!/^\s*</.test(String(raw.prompt??''))?String(raw.prompt??'').replace(/\s+/g,' ').slice(0,80):undefined,
    tool:raw.tool_name?String(raw.tool_name).slice(0,120):undefined,
    reply:raw.hook_event_name==='Stop'?String(raw.last_assistant_message??'').slice(0,200000):undefined};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>2000000)throw new Error('large');}
    const raw=JSON.parse(input);const e=sanitizeEvent(raw);
    if(!e){const diagnostic=fileURLToPath(new URL('../runtime/hook-diagnostic.json',import.meta.url));fs.writeFileSync(diagnostic,JSON.stringify({at:Date.now(),keys:Object.keys(raw),event:raw.hook_event_name,sessionType:typeof raw.session_id,turnType:typeof raw.turn_id,sessionValid:/^[-a-zA-Z0-9_]{1,100}$/.test(raw.session_id??''),turnValid:/^[-a-zA-Z0-9_]{1,100}$/.test(raw.turn_id??'')}));}
    if(e){const inbox=fileURLToPath(new URL('../runtime/hook-inbox/',import.meta.url));fs.mkdirSync(inbox,{recursive:true});const file=path.join(inbox,e.at+'-'+e.id+'.json');fs.writeFileSync(file+'.tmp',JSON.stringify(e),{mode:0o600});fs.renameSync(file+'.tmp',file);}
  }catch{} // Notification delivery must never block or redirect Codex work.
  process.stdout.write('{}\n');
}
