import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export class Store {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), {recursive:true});
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {
      version:1, tasks:[], selected:{}, requests:[], seen:[], outbox:[], ownerId:null, ownerChat:null
    };
  }
  save() {
    const temp = this.file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.data,null,2), {mode:0o600});
    fs.renameSync(temp,this.file);
  }
  seen(id) {
    if (!id) throw new Error('消息缺少唯一编号');
    if (this.data.seen.includes(id)) return true;
    this.data.seen.push(id);
    this.data.seen = this.data.seen.slice(-3000);
    this.save();
    return false;
  }
  controlledTasks() {return [...this.data.tasks,...(this.data.desktopTasks??[]).filter(t=>t.bridgeActive)];}
  taskByThread(id) { return this.controlledTasks().find(t=>t.threadId === id); }
  taskById(id) { return [...this.data.tasks,...(this.data.desktopTasks??[])].find(t=>t.id === id); }
  queue(chatId, payload) {
    if (!chatId) return;
    const item={id:randomUUID(),chatId,payload,attempts:0,nextAt:0,createdAt:Date.now()};
    this.data.outbox.push(item); this.save(); return item;
  }
}

export function within(root, file) {
  const rel=path.relative(path.resolve(root),path.resolve(file));
  return rel==='' || (rel!=='..' && !rel.startsWith('..'+path.sep) && !path.isAbsolute(rel));
}
