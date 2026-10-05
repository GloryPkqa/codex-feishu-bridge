import fs from 'node:fs';
import path from 'node:path';
import {within} from './store.mjs';
import {progress} from './cards.mjs';

export class DesktopSync {
  constructor(bridge){
    this.bridge=bridge;this.store=bridge.store;this.root=bridge.root;this.store.data.desktopTasks??=[];this.store.data.hookSeen??=[];this.inbox=path.join(this.root,'runtime','hook-inbox');
    // Older releases mistook a permission check for a pending human approval.
    // Remove only those obsolete unsent alerts; never discard real T-task requests.
    this.store.data.outbox=this.store.data.outbox.filter(x=>!['桌面任务需要审批','定时进度简报'].includes(x.payload?.card?.header?.title?.content));
    for(const t of this.store.data.desktopTasks)if(t.status==='waiting'&&t.activity==='等待在电脑上批准'){
      t.status='running';t.activity='最近发生权限检查；无法确认是否等待人工批准';
    }
    this.store.save();
  }
  question(e){
    if(this.bridge.config.desktopSyncEnabled===false)return;
    if(!this.store.data.ownerChat||!e.id||this.store.taskByThread(e.sessionId))return;
    const seen='question:'+e.sessionId+':'+e.id;if(this.store.data.hookSeen.includes(seen))return;
    const t=this.store.data.desktopTasks.find(t=>t.threadId===e.sessionId);
    if(t?.archived)return;
    const content=e.questions.map(q=>q.secret?'敏感问题：请在电脑端查看和填写。':`${q.text}\n${q.options.map((o,i)=>`${i+1}. ${o.label}${o.description?'：'+o.description:''}`).join('\n')}`).join('\n\n');
    this.bridge.show(this.store.data.ownerChat,'电脑上的 Codex 有个问题',`${t?t.id+' · '+t.title:'电脑上的 Codex 对话'}\n\n${content}\n\n这来自电脑启动的原轮次，仍需在电脑回答。本轮结束且桌面释放会话后，才可在飞书选择 D 编号接续；飞书接续的轮次可直接回答其问题卡片。`,[],'orange','questions');
    this.store.data.hookSeen.push(seen);this.store.save();
  }
  async consume(){
    if(this.bridge.config.desktopSyncEnabled===false)return;
    if(!this.store.data.ownerChat||!fs.existsSync(this.inbox))return;
    for(const name of fs.readdirSync(this.inbox).filter(n=>/^\d+-[-a-f0-9]+\.json$/.test(n)).sort().slice(0,200)){
      const file=path.join(this.inbox,name);
      try{
        const e=JSON.parse(fs.readFileSync(file,'utf8'));let task=this.store.data.desktopTasks.find(t=>t.threadId===e.sessionId);
        if(!task?.titleChecked&&this.bridge.rpc.ready&&!this.store.taskByThread(e.sessionId)){
          try{const r=await this.bridge.rpc.call('thread/read',{threadId:e.sessionId,includeTurns:false});const title=String(r.thread?.name||r.thread?.preview||'').replace(/\s+/g,' ').slice(0,80);if(title&&!title.startsWith('<'))e.conversationTitle=title;}catch{}
          if(task){task.titleChecked=true;if(e.conversationTitle)task.title=e.conversationTitle;}
        }
        this.event(e);task=this.store.data.desktopTasks.find(t=>t.threadId===e.sessionId);if(task)task.titleChecked=true;this.store.save();fs.unlinkSync(file);
      }catch{this.bridge.log('桌面同步事件处理失败，将稍后重试');}
    }
  }
  event(e){
    if(this.bridge.config.desktopSyncEnabled===false)return;
    if(!e.id||!e.sessionId||!e.turnId)return;
    if(this.store.data.hookSeen.includes(e.id))return;
    if(this.store.taskByThread(e.sessionId)||(e.cwd&&within(path.join(this.root,'tasks'),e.cwd)))return;
    let t=this.store.data.desktopTasks.find(t=>t.threadId===e.sessionId);
    if(!t){t={id:'D'+String(this.store.data.desktopTasks.length+1).padStart(3,'0'),source:'desktop',threadId:e.sessionId,title:e.conversationTitle||e.title||'桌面 Codex 对话',chatId:this.store.data.ownerChat,cwd:e.cwd,status:'idle',turns:{}};this.store.data.desktopTasks.push(t);}
    t.turns??={};const previous=t.turns[e.turnId];const r=previous??{startedAt:e.at,status:'running'};t.turns[e.turnId]=r;
    // Completed old turns cannot be resurrected by background events arriving late.
    const uuid=/^[a-f0-9]{8}-[a-f0-9-]{27}$/i;
    const older=uuid.test(e.turnId)&&uuid.test(t.turnId??'')&&e.turnId<t.turnId;
    if(!previous&&!older&&(!t.turnId||t.turns[t.turnId]?.finished||e.event==='UserPromptSubmit')){t.turnId=e.turnId;t.startedAt=e.at;t.lastNoticeAt=Date.now();}
    const active=t.turnId===e.turnId||!t.turnId;
    if(!t.turnId){t.turnId=e.turnId;t.startedAt=e.at;t.lastNoticeAt=Date.now();}
    if(e.conversationTitle)t.title=e.conversationTitle;
    else if(e.title&&active&&t.title==='桌面 Codex 对话'){t.title=e.title;t.lastComment='';}
    if(e.model&&active)t.model=e.model;
    if(!r.finished){
      if(e.event==='UserPromptSubmit'&&!r.announced){r.announced=true;if(active)t.status='running';this.bridge.show(t.chatId,'电脑上的 Codex 任务已开始',progress(t),[],undefined,'started');}
      if(['PreToolUse','PostToolUse'].includes(e.event)&&active){t.status='running';t.activity=e.tool?'最近工具：'+e.tool:'正在处理任务';}
      // PermissionRequest also precedes automatic review. These async hooks do
      // not expose a reliable human-wait state, so do not emit approval alerts.
      if(e.event==='PermissionRequest'&&active)t.activity='正在检查操作权限';
      if(['Stop','Interrupt'].includes(e.event)){
        r.finished=true;r.status=e.event==='Interrupt'?'interrupted':'completed';
        if(active){t.status=r.status;t.finishedAt=e.at;t.activity=e.event==='Interrupt'?'已停止':'本轮回复已输出';}
        const reply=e.reply||'本轮没有可同步的文字回复。';
        const dir=path.join(this.root,'tasks',t.id,'reports');fs.mkdirSync(dir,{recursive:true});
        const name=`${t.id}-${e.turnId.replace(/[^a-zA-Z0-9_-]/g,'')}.md`,file=path.join(dir,name);
        fs.writeFileSync(file,`# ${t.id} · ${t.title}\n\n来源：电脑上的 Codex 对话\n会话：${t.threadId}\n轮次：${e.turnId}\n状态：${r.status}\n\n${reply}\n`,'utf8');
        if(active){t.report=file;t.lastResult=reply;}
        this.bridge.show(t.chatId,e.event==='Interrupt'?'桌面任务已停止':'桌面对话本轮回复',`${t.id} · ${t.title}\n\n${reply.slice(0,14000)}\n\n点击“回复这段聊天”后直接发消息，或发送“继续 ${t.id} 你的要求”。完整回复保存在本机报告。Stop 表示本轮回复已输出；即使本轮结束，桌面仍持有会话时也会拒绝接续；当前不能实时接管。`,[{label:'回复这段聊天',value:{ui:'select',taskId:t.id,epoch:this.bridge.epoch}}],e.event==='Interrupt'?'orange':'green',e.event==='Interrupt'?'errors':'results');
        this.bridge.queue(t.chatId,{kind:'file',path:file,name},'files');
      }
    }
    this.store.data.hookSeen.push(e.id);this.store.data.hookSeen=this.store.data.hookSeen.slice(-10000);
    this.store.data.desktopSyncLastEvent=Date.now();this.store.save();
  }
}
