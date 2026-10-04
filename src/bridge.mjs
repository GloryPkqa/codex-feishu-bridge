import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,randomInt} from 'node:crypto';
import {card,progress,modelLabel,formCard,selectField,statusNames} from './cards.mjs';
import {within} from './store.mjs';
import {notificationAllowed,featureAllowed} from './preferences.mjs';

export const ASK_TOOL={type:'function',name:'feishu_ask_user',description:'当任务必须由用户决定时，在飞书发送问题与可选按钮，等待用户作答。不要用于普通进度或索取密码。',inputSchema:{type:'object',additionalProperties:false,properties:{question:{type:'string'},options:{type:'array',items:{type:'string'},maxItems:6}},required:['question','options']}};
export class Bridge {
  constructor({store,rpc,feishu,root,config,log=()=>{}}) {
    Object.assign(this,{store,rpc,feishu,root,config,log});
    this.epoch=randomUUID();this.pairCode=String(randomInt(10000000,100000000));this.chain=Promise.resolve();this.loaded=new Set();this.forms=new Map();
    rpc.on('notification',m=>this.enqueue(()=>this.notification(m)));
    rpc.on('request',m=>this.enqueue(()=>this.request(m)));
    rpc.on('disconnected',()=>this.enqueue(()=>this.disconnected()));
    feishu.on('message',m=>{this.enqueue(()=>this.message(m)).catch(e=>{if(this.authorize(m.senderId))this.say(m.chatId,e.message);});});
    feishu.on('action',e=>{this.enqueue(()=>this.action(e)).catch(err=>{if(this.authorize(e.operator?.openId))this.say(e.chatId,`操作未完成：${String(err.message).slice(0,250)}。请重新打开面板或最新问题卡片。`);});});
  }
  enqueue(fn) {const p=this.chain.then(fn);this.chain=p.catch(e=>this.log(e.message));return p;}
  recover() {
    for(const r of this.store.data.requests)if(r.status==='pending')r.status='expired';
    for(const t of this.store.data.tasks)if(['running','waiting','starting'].includes(t.status)) {
      t.status='disconnected';this.say(t.chatId,`${t.id}：服务重新启动。历史已保留，旧审批已失效。发送“继续 ${t.id}”可恢复会话。`,'errors');
    }
    this.store.save();
  }
  queue(chat,payload,category) {
    if(!notificationAllowed(this.config,category))return;
    const item=this.store.queue(chat,payload);
    if(item&&category){item.category=category;this.store.save();}
    return item;
  }
  say(chat,text,category) {return this.queue(chat,{kind:'text',text},category);}
  show(chat,title,content,buttons=[],color,category) {return this.queue(chat,{kind:'card',card:card(title,content,buttons,color)},category);}
  feature(feature){return featureAllowed(this.config,feature);}
  requireFeature(feature){if(!this.feature(feature))throw new Error({newTasks:'新建任务功能已关闭，请在网页管理页勾选后再试',continuation:'继续对话功能已关闭，请在网页管理页勾选后再试',remoteApprovals:'远程审批功能已关闭'}[feature]);}
  pendingSummary(t){const rs=this.store.data.requests.filter(r=>r.taskId===t.id&&r.status==='pending');return rs.length?'\n待处理：'+rs.map(r=>`${r.code}（${r.kind==='approval'?'审批':'问题'}）`).join('、')+'\n发送“问题 '+t.id+'”重新获取内容。':'';}
  pendingRequests(chat,id){
    const rs=this.store.data.requests.filter(r=>r.status==='pending'&&r.chatId===chat&&r.epoch===this.epoch&&(!id||r.taskId===id.toUpperCase()||r.code.toLowerCase()===id.toLowerCase()));
    if(!rs.length)return this.say(chat,'当前没有可在飞书处理的待回答问题或审批。桌面 D 编号任务请在电脑原对话处理。');
    for(const r of rs)this.renderRequest(r,{manual:true});
  }
  selected(chat) {return this.store.taskById(this.store.data.selected[chat]);}
  select(chat,t) {this.store.data.selected[chat]=t.id;this.store.save();}
  authorize(sender) {return Boolean(sender && sender===this.store.data.ownerId);}
  async message(m) {
    if(m.chatType!=='p2p')return; // First version deliberately uses private chats only.
    const text=m.content?.trim()??'';if(!text)return;
    if(!this.store.data.ownerId) {
      if(text!==`绑定 ${this.pairCode}`)return;
      this.store.data.ownerId=m.senderId;this.store.data.ownerChat=m.chatId;this.store.save();
      this.pairCode='';this.say(m.chatId,'绑定成功。只有你的账号可以操作。发送“帮助”查看用法。');return;
    }
    if(!this.authorize(m.senderId))return;
    if(this.store.seen(m.messageId))return;
    this.store.data.ownerChat=m.chatId;this.store.save();
    const normalized=text.replace(/^\//,'');
    if(['帮助','help','面板','菜单'].includes(normalized))return this.panel(m.chatId);
    if(normalized==='命令')return this.say(m.chatId,HELP);
    const pendingQuery=normalized.match(/^问题(?:\s+(T\d+|R[a-f0-9]+))?$/i);
    if(pendingQuery)return this.pendingRequests(m.chatId,pendingQuery[1]);
    if(/^(?:全部进度|当前进度|状态|项目状态|运行状态|总览|有几个项目正在运行|现在有几个项目正在运行|有哪些项目在运行|正在运行的项目|项目|进度)(?:以及状态|和状态)?[？?。！!]*$/.test(normalized)||/^(?:请问|帮我看看|查一下)?(?:现在|目前)?(?:有|总共有|一共有)?(?:几个|多少个?)(?:项目|任务)(?:正在|在)?(?:运行|执行|跑)(?:以及状态|和状态)?[呢吗呀？?。！!]*$/.test(normalized))return this.overview(m.chatId);
    if(normalized==='模型')return this.modelMenu(m.chatId);
    if(normalized==='强度')return this.effortMenu(m.chatId);
    if(normalized==='设置')return this.say(m.chatId,`新任务默认：${this.config.model??'Codex 默认模型'} · ${this.config.effort??'默认强度'}\n当前任务：${this.selected(m.chatId)?.model??'默认模型'} · ${this.selected(m.chatId)?.effort??'默认强度'}\n自动通知按网页勾选发送，进度可随时查询。发送“模型”或“强度”点选。设置在下轮生效。`);
    const modelSetting=normalized.match(/^模型\s+(\S+)$/);
    if(modelSetting)return this.setModel(m.chatId,modelSetting[1]);
    const effortSetting=normalized.match(/^强度\s+(\S+)$/);
    if(effortSetting)return this.setEffort(m.chatId,effortSetting[1]);
    if(['任务','列表'].includes(normalized)) {
      if(this.config.nativeForms)return this.taskMenu(m.chatId);
      return this.say(m.chatId,[...this.store.data.tasks.filter(t=>!t.archived),...(this.store.data.desktopTasks??[]).filter(t=>!t.archived)].map(t=>`${t.id} · ${t.title} · ${t.status}`).join('\n')||'还没有任务。发送“新建 你的任务要求”。');
    }
    const switched=normalized.match(/^切换\s+(T\d+)$/i);
    if(switched){const t=this.requireTask(switched[1]);this.select(m.chatId,t);return this.show(m.chatId,'已切换任务',progress(t));}
    const status=normalized.match(/^进度(?:\s+([TD]\d+))?$/i);
    if(status){const t=status[1]?(this.store.taskById(status[1].toUpperCase())??this.store.data.desktopTasks?.find(t=>t.id===status[1].toUpperCase())):this.selected(m.chatId);if(!t)return this.say(m.chatId,'找不到任务，请发送“任务”查看编号。');return this.show(m.chatId,'任务进度',progress(t)+this.pendingSummary(t));}
    const frequency=normalized.match(/^通知\s+(\d+)$/);
    if(frequency)return this.say(m.chatId,'定时进度报告已取消。发送“全部进度”或“状态”随时查看；自动通知按网页勾选发送。');
    const stop=normalized.match(/^停止(?:\s+(T\d+))?$/i);
    if(stop){const t=stop[1]?this.requireTask(stop[1]):this.selected(m.chatId);if(!t?.turnId||!['starting','running','waiting'].includes(t.status))return this.say(m.chatId,'该任务当前没有执行中的轮次。');await this.rpc.call('turn/interrupt',{threadId:t.threadId,turnId:t.turnId});return this.say(m.chatId,`${t.id} 已请求停止。`);}
    const answer=normalized.match(/^回答\s+(R[a-f0-9]+)\s+([\s\S]+)$/i);
    if(answer){await this.answer(answer[1],answer[2],m.senderId,m.chatId);return;}
    const approval=normalized.match(/^(同意|拒绝)\s+(R[a-f0-9]+)$/i);
    if(approval){await this.answer(approval[2],approval[1]==='同意'?'accept':'decline',m.senderId,m.chatId);return;}
    const again=normalized.match(/^继续\s+(T\d+)(?:\s+([\s\S]+))?$/i);
    if(again){const t=this.requireTask(again[1]);this.select(m.chatId,t);return this.run(t,again[2]||'请继续完成原任务。',m.messageId);}
    const newTask=normalized.match(/^新建(?:\s+([\s\S]+))?$/);
    if(newTask){this.requireFeature('newTasks');if(!newTask[1])return this.config.nativeForms?this.newTaskForm(m.chatId):this.say(m.chatId,'用法：新建 任务要求');return this.newTask(m.chatId,newTask[1],m.messageId);}
    const t=this.selected(m.chatId);
    if(!t)return this.newTask(m.chatId,text,m.messageId);
    const pending=this.store.data.requests.filter(r=>r.taskId===t.id&&r.status==='pending');
    if(pending.length)return this.say(m.chatId,`任务正在等你回答，请点击卡片选项，或发送“回答 ${pending[0].code} 你的答案”。`);
    if(t.status==='running'&&t.turnId){this.requireFeature('continuation');await this.rpc.call('turn/steer',{threadId:t.threadId,expectedTurnId:t.turnId,input:[{type:'text',text}]});return this.say(m.chatId,`${t.id} 已收到补充要求。`);}
    return this.run(t,text,m.messageId);
  }
  requireTask(id) {const t=this.store.taskById(id.toUpperCase());if(!t||t.archived)throw new Error('找不到这个任务编号，或任务已归档');return t;}
  models(){return (this.rpc.models??[]).filter(m=>!m.hidden);}
  overview(chat){
    const all=[...this.store.data.tasks,...(this.store.data.desktopTasks??[])].filter(t=>!t.archived&&t.chatId===chat);
    const active=all.filter(t=>['starting','running','waiting'].includes(t.status)),waiting=active.filter(t=>t.status==='waiting');
    const parts=active.map(t=>`**${t.id} · ${t.title}**\n${statusNames[t.status]} · ${t.activity||'处理中'}${this.pendingSummary(t)}${t.lastComment?'\n'+t.lastComment.slice(-400):''}`);
    return this.show(chat,'所有项目状态',`进行中：${active.length} 个（执行／启动：${active.length-waiting.length}，等待回答：${waiting.length}）\n\n${parts.join('\n\n')||'当前没有正在运行的项目。'}\n\n最近结束：\n${all.filter(t=>!active.includes(t)).slice(-5).map(t=>`${t.id} · ${t.title} · ${statusNames[t.status]??t.status}`).join('\n')||'暂无'}\n\n定时报告已关闭，可随时询问。桌面任务显示最近同步到的状态。`);
  }
  panel(chat){
    const t=this.selected(chat),m=this.currentModel(chat);
    this.show(chat,'Codex 控制面板',`当前任务：${t?t.id+' · '+t.title:'还未选择'}\n模型：${m?modelLabel(m):'默认'} · 强度：${t?.effort??this.config.effort??m?.defaultReasoningEffort??'默认'}\n自动通知按网页勾选发送，进度可随时查询\n\n选好任务后，开启继续对话功能即可直接发消息接着聊。`,[{label:'新建任务',value:{ui:'new',epoch:this.epoch}},{label:'我的任务',value:{ui:'tasks',epoch:this.epoch}},{label:'模型和强度',value:{ui:'model',epoch:this.epoch}},{label:'全部进度',value:{ui:'progress',epoch:this.epoch}},{label:'停止当前轮次',value:{ui:'stop',epoch:this.epoch,taskId:t?.id??null}}]);
  }
  form(chat,title,description,fields,label,kind,extra={}){
    const token=randomUUID();this.forms.set(token,{kind,chat,taskId:this.selected(chat)?.id??null,at:Date.now(),...extra});
    for(const [key,f] of this.forms)if(Date.now()-f.at>3600000)this.forms.delete(key);
    return this.store.queue(chat,{kind:'card',card:formCard(title,description,fields,label,{form:token,epoch:this.epoch})});
  }
  newTaskForm(chat){this.requireFeature('newTasks');return this.form(chat,'新建任务','写下任务要求，点击开始。使用你上次选择的模型和强度。输入框最多 1000 字，更长的要求可以直接发消息。',[{tag:'input',name:'prompt',placeholder:{tag:'plain_text',content:'希望 Codex 帮你做什么？'},max_length:1000,required:true,width:'fill'}],'开始任务','new');}
  taskMenu(chat){
    const ts=this.store.data.tasks.filter(t=>!t.archived);
    if(ts.length)this.form(chat,'我的任务','选择要继续聊天的任务，再点切换。',[selectField('task','选择任务',ts.slice(-100).map(t=>({label:t.id+' · '+t.title.slice(0,28),value:t.id})),this.selected(chat)?.id)],'切换任务','task');
    else this.say(chat,'还没有飞书任务，点击面板里的“新建任务”。');
    const ds=(this.store.data.desktopTasks??[]).filter(t=>!t.archived);if(ds.length)this.show(chat,'电脑任务',ds.slice(-15).map(t=>`${t.id} · ${t.title} · ${t.status}`).join('\n'));
  }
  frequencyForm(chat){return this.show(chat,'通知方式','定时报告已取消。发送“全部进度”随时查询，自动通知按网页勾选发送。');}
  currentModel(chat){const name=this.selected(chat)?.model??this.config.model;return this.models().find(m=>m.model===name)??this.models().find(m=>m.isDefault)??this.models()[0];}
  async modelMenu(chat){
    if(!this.rpc.ready)throw new Error('Codex 尚未连接');
    const r=await this.rpc.call('model/list',{includeHidden:false,limit:100});this.rpc.models=r.data??[];
    const selected=this.currentModel(chat);
    if(this.config.nativeForms)return this.form(chat,'选择模型',`当前：${selected?modelLabel(selected):'默认'}\n下一轮生效，并保存为新任务默认。`,[selectField('model','选择模型',this.models().map(m=>({label:modelLabel(m),value:m.model})),selected?.model)],'保存并选强度','model');
    this.show(chat,'选择模型',`当前：${selected?modelLabel(selected):'默认'}\n下一轮生效，并保存为新任务默认。`,this.models().map(m=>({label:modelLabel(m),primary:m.model===selected?.model,value:{setting:'model',model:m.model,taskId:this.selected(chat)?.id??null,epoch:this.epoch}})));
  }
  effortMenu(chat){
    const m=this.currentModel(chat);if(!m)throw new Error('模型列表尚未加载，请先发送“模型”');
    const efforts=m.supportedReasoningEfforts??[];
    if(this.config.nativeForms)return this.form(chat,'选择思考强度',`${modelLabel(m)}\n下一轮生效。`,[selectField('effort','选择强度',efforts.map(e=>({label:EFFORT_NAMES[e.reasoningEffort]??e.reasoningEffort,value:e.reasoningEffort})),this.selected(chat)?.effort??this.config.effort??m.defaultReasoningEffort)],'保存强度','effort',{model:m.model});
    this.show(chat,'选择思考强度',`${m.displayName??m.model}\n当前：${this.selected(chat)?.effort??this.config.effort??m.defaultReasoningEffort}\n${efforts.map(e=>e.reasoningEffort+'：'+e.description).join('\n')}\n在下一轮生效。`,efforts.map(e=>({label:EFFORT_NAMES[e.reasoningEffort]??e.reasoningEffort,value:{setting:'effort',effort:e.reasoningEffort,model:m.model,taskId:this.selected(chat)?.id??null,epoch:this.epoch}})));
  }
  setModel(chat,name){
    const m=this.models().find(m=>m.model===name||m.id===name);if(!m)throw new Error('模型不可用，请发送“模型”查看可选列表');
    this.config.model=m.model;this.config.effort=m.defaultReasoningEffort;
    const t=this.selected(chat);if(t){t.model=m.model;t.effort=m.defaultReasoningEffort;}
    this.persistConfig?.();this.store.save();this.say(chat,`已选择 ${m.displayName??m.model}，强度 ${m.defaultReasoningEffort}。下一轮生效。`);return this.effortMenu(chat);
  }
  setEffort(chat,name){
    const effort=Object.keys(EFFORT_NAMES).find(e=>e===name||EFFORT_NAMES[e]===name)??name;
    const m=this.currentModel(chat);if(!m?.supportedReasoningEfforts?.some(e=>e.reasoningEffort===effort))throw new Error('该模型不支持这个强度，请发送“强度”查看选项');
    this.config.model=m.model;this.config.effort=effort;const t=this.selected(chat);if(t){t.model=m.model;t.effort=effort;}
    this.persistConfig?.();this.store.save();this.say(chat,`已设为 ${m.displayName??m.model} · ${EFFORT_NAMES[effort]??effort}（${effort}）。下一轮生效。`);
  }
  async newTask(chat,text,messageId) {
    this.requireFeature('newTasks');
    const id='T'+String(this.store.data.tasks.length+1).padStart(3,'0');
    const cwd=path.join(this.root,'tasks',id,'project');fs.mkdirSync(cwd,{recursive:true});
    const t={id,title:text.replace(/\s+/g,' ').slice(0,42),chatId:chat,cwd,status:'idle',createdAt:Date.now(),plan:[],messages:{},model:this.config.model,effort:this.config.effort};
    this.store.data.tasks.push(t);this.select(chat,t);await this.run(t,text,messageId);
  }
  async run(t,text,messageId) {
    this.requireFeature(t.threadId?'continuation':'newTasks');
    if(!this.rpc.ready)throw new Error('Codex 尚未连接，请在电脑上查看连接页面');
    if(!this.rpc.authenticated)throw new Error('Codex 尚未登录，请先在电脑上完成登录');
    if(['running','waiting','starting'].includes(t.status))throw new Error('任务仍在执行，先停止或直接补充要求');
    t.status='starting';t.startedAt=Date.now();t.messages={};t.lastComment='';t.plan=[];t.activity='启动任务';this.store.save();
    try {
      if(!t.threadId) {
        const r=await this.rpc.call('thread/start',{cwd:t.cwd,sandbox:'workspace-write',approvalPolicy:'on-request',approvalsReviewer:'user',dynamicTools:[ASK_TOOL],developerInstructions:INSTRUCTIONS});
        t.threadId=r.thread.id;this.loaded.add(t.threadId);this.store.save();
      } else if(!this.loaded.has(t.threadId)) {
        await this.rpc.call('thread/resume',{threadId:t.threadId});this.loaded.add(t.threadId);
      }
      const selectedModel=this.models().find(m=>m.model===(t.model??this.config.model));
      if(t.model&&!selectedModel)throw new Error('所选模型已不可用，请发送“模型”重新选择');
      if(t.effort&&selectedModel&&!selectedModel.supportedReasoningEfforts?.some(e=>e.reasoningEffort===t.effort))throw new Error('所选强度已不可用，请发送“强度”重新选择');
      const r=await this.rpc.call('turn/start',{threadId:t.threadId,input:[{type:'text',text}],clientUserMessageId:messageId,...(t.model?{model:t.model}:{}),...(t.effort?{effort:t.effort}:{})});
      t.turnId=r.turn.id;t.status='running';t.lastNoticeAt=Date.now();this.store.save();
      this.show(t.chatId,'任务已开始',progress(t),[],undefined,'started');
    }catch(e){t.status='failed';t.activity=e.message;this.store.save();this.say(t.chatId,`${t.id} 启动失败：${e.message}`,'errors');throw e;}
  }
  async notification(m) {
    const p=m.params??{}, t=this.store.taskByThread(p.threadId);
    if(m.method==='serverRequest/resolved'){
      for(const r of this.store.data.requests)if(r.rpcId===p.requestId&&r.status==='pending')r.status='expired';
      if(t?.status==='waiting'&&!this.store.data.requests.some(r=>r.taskId===t.id&&r.status==='pending'))t.status='running';
      this.store.save();return;
    }
    if(!t)return;
    switch(m.method) {
      case 'turn/started':t.turnId=p.turn.id;t.status='running';break;
      case 'turn/plan/updated': {
        const before=(t.plan??[]).filter(x=>x.status==='completed').map(x=>x.step);
        t.plan=p.plan;
        if(p.plan.some(x=>x.status==='completed'&&!before.includes(x.step)))this.show(t.chatId,'阶段完成',progress(t),[],undefined,'stages');
        break;
      }
      case 'item/started': {
        const names={commandExecution:'正在运行命令',fileChange:'正在修改文件',mcpToolCall:'正在调用工具',webSearch:'正在搜索资料',agentMessage:'正在整理回复'};
        t.activity=names[p.item?.type]??'正在处理任务';break;
      }
      case 'item/agentMessage/delta': {
        const msg=t.messages[p.itemId]??={text:'',phase:null};msg.text=(msg.text+p.delta).slice(-200000);break;
      }
      case 'item/completed': {
        if(p.item?.type==='agentMessage') {
          const item=p.item;t.messages[item.id]={text:item.text??t.messages[item.id]?.text??'',phase:item.phase};
          if(item.phase==='commentary')t.lastComment=item.text;
        }
        break;
      }
      case 'turn/completed': {
        // Only the event's explicit status is used to classify the result.
        t.status=p.turn.status==='completed'?'completed':p.turn.status==='interrupted'?'interrupted':'failed';
        t.finishedAt=Date.now();t.error=p.turn.error?.message;
        for(const r of this.store.data.requests)if(r.taskId===t.id&&r.status==='pending')r.status='expired';
        const msgs=Object.values(t.messages);const finals=msgs.filter(x=>x.phase==='final_answer'||x.phase==='finalAnswer');
        const reply=(finals.length?finals:msgs.filter(x=>x.phase!=='commentary')).map(x=>x.text).join('\n\n')||t.error||'本轮没有文字回复。';
        t.lastResult=reply;
        const reportDir=path.join(this.root,'tasks',t.id,'reports');fs.mkdirSync(reportDir,{recursive:true});
        const filename=`${t.id}-${String(t.turnId).replace(/[^a-zA-Z0-9_-]/g,'')}.md`;
        const reportPath=path.join(reportDir,filename);
        fs.writeFileSync(reportPath,`# ${t.id} · ${t.title}\n\n状态：${t.status}\n完成时间：${new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}\n\n${reply}\n`,'utf8');
        t.report=reportPath;
        this.show(t.chatId,t.status==='completed'?'本轮完成':t.status==='interrupted'?'任务已停止':'任务执行失败',`${t.id} · ${t.title}\n\n${reply.slice(0,14000)}\n\n完整回复保存在本机报告。`,[],t.status==='failed'?'red':'green',t.status==='completed'?'results':'errors');
        this.queue(t.chatId,{kind:'file',path:reportPath,name:filename},'files');break;
      }
      case 'error':t.activity='Codex 正在处理执行错误';break;
    }
    this.store.save();
  }
  async request(m) {
    const p=m.params??{},t=this.store.taskByThread(p.threadId);
    if(!t){this.rpc.reject(m.id,'该任务不属于飞书桥接服务');return;}
    const r={code:'R'+randomUUID().replaceAll('-','').slice(0,8),rpcId:m.id,method:m.method,params:p,taskId:t.id,chatId:t.chatId,epoch:this.epoch,status:'pending',createdAt:Date.now(),answers:{}};
    if(m.method==='item/tool/call' && p.tool==='feishu_ask_user') {
      const a=p.arguments;
      if(typeof a?.question!=='string'||!Array.isArray(a.options)||a.options.length>6||a.options.some(x=>typeof x!=='string')) {this.rpc.respond(m.id,{success:false,contentItems:[{type:'inputText',text:'问题格式无效'}]});return;}
      r.questions=[{id:'answer',question:a.question,options:a.options.map(label=>({label}))}];r.kind='dynamic';
    }else if(['item/tool/requestUserInput','tool/requestUserInput'].includes(m.method)) {
      if(p.questions?.some(q=>q.isSecret)){this.rpc.reject(m.id,'敏感信息请在电脑端填写');this.say(t.chatId,'Codex 请求了敏感信息，请回到电脑端处理。','questions');return;}
      r.questions=p.questions;r.kind='questions';
    }else if(['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval'].includes(m.method))r.kind='approval';
    else if(m.method==='mcpServer/elicitation/request')r.kind='elicitation';
    else {this.rpc.reject(m.id,'该交互尚不支持飞书处理');this.say(t.chatId,`${t.id} 出现暂不支持的交互：${m.method}`,'errors');return;}
    if(r.kind==='approval'&&!this.feature('remoteApprovals')){
      this.rpc.respond(m.id,pendingApprovalResult(r,'decline'));r.status='denied';r.answeredAt=Date.now();
      this.store.data.requests.push(r);this.store.data.requests=this.store.data.requests.slice(-500);
      t.activity='远程审批已关闭，已拒绝本次权限请求';this.store.save();
      this.say(t.chatId,`${t.id}：远程审批功能已关闭，已拒绝本次权限请求；没有授予任何权限。需要时请在网页管理页开启远程审批，再让任务重试。`,'approvals');return;
    }
    this.store.data.requests.push(r);this.store.data.requests=this.store.data.requests.slice(-500);t.status='waiting';this.store.save();this.renderRequest(r);
  }
  renderRequest(r,{manual=false}={}) {
    const category=manual?undefined:r.kind==='approval'?'approvals':'questions';
    const value=(answer,qid)=>({request:r.code,epoch:r.epoch,answer,...(qid?{question:qid}:{})});
    if(r.questions)for(const q of r.questions) {
      const opts=q.options??[];
      const details=opts.map((o,i)=>`${i+1}. ${o.label}${o.description?'：'+o.description:''}`).join('\n');
      this.show(r.chatId,`${r.taskId} · 需要你的选择`,`${q.question}\n\n${details}\n\n也可发送：回答 ${r.code} 你的答案`,opts.map((o,i)=>({label:o.label,primary:i===0,value:value(o.label,q.id)})),'orange',category);
    } else if(r.kind==='approval') {
      const p=r.params;
      const details=p.networkApprovalContext?`访问网络：${p.networkApprovalContext.protocol}://${p.networkApprovalContext.host}`:p.command?`命令：\n\n${p.command}\n\n工作目录：${p.cwd??''}`:p.permissions?`申请权限：\n${JSON.stringify(p.permissions,null,2)}`:`文件变更：${p.reason??''}\n授权范围：${p.grantRoot??'当前请求'}`;
      this.show(r.chatId,`${r.taskId} · 需要你的批准`,`${p.reason??''}\n\n${details}\n\n仅批准本次。也可发送“同意 ${r.code}”或“拒绝 ${r.code}”。`,[{label:'允许本次',value:value('accept')},{label:'拒绝',value:value('decline')}],'orange',category);
    }else {
      const p=r.params;
      this.show(r.chatId,`${r.taskId} · 工具需要你的回答`,`${p.message}\n${p.url??''}\n${p.requestedSchema?'需要填写的内容：\n'+JSON.stringify(p.requestedSchema,null,2):''}\n\n用“回答 ${r.code} JSON内容”提交表单；完成网页操作后回复“回答 ${r.code} 完成”。`,[{label:'拒绝',value:value('decline')}],'orange',category);
    }
  }
  async action(e) {
    if(!this.authorize(e.operator?.openId))return;
    const v=e.action?.value;
    if(v?.ui||v?.form){
      if(v.epoch!==this.epoch||e.chatId!==this.store.data.ownerChat)return this.say(e.chatId,'面板已过期，请发送“面板”打开新版。');
      if(v.form)return this.submitForm(e,v.form);
      switch(v.ui){
        case 'new':this.requireFeature('newTasks');return this.config.nativeForms?this.newTaskForm(e.chatId):this.say(e.chatId,'发送“新建 任务要求”开始。');
        case 'tasks':return this.config.nativeForms?this.taskMenu(e.chatId):this.say(e.chatId,this.store.data.tasks.map(t=>`${t.id} · ${t.title}`).join('\n'));
        case 'model':return this.modelMenu(e.chatId);
        case 'frequency':return this.frequencyForm(e.chatId);
        case 'progress':return this.overview(e.chatId);
        case 'stop':{
          const t=this.selected(e.chatId);if(!t||t.id!==v.taskId||!t.turnId||!['running','waiting'].includes(t.status))return this.say(e.chatId,'该轮次已结束或当前任务已切换，请重新打开面板。');
          await this.rpc.call('turn/interrupt',{threadId:t.threadId,turnId:t.turnId});return this.say(e.chatId,'已请求停止当前轮次。');
        }
      }
      return;
    }
    if(v?.setting){
      if(v.epoch!==this.epoch||e.chatId!==this.store.data.ownerChat)return this.say(e.chatId,'设置卡片已过期，请重新发送“模型”或“强度”。');
      const current=this.selected(e.chatId)?.id??null;
      if(v.taskId!==current)return this.say(e.chatId,'当前任务已切换，请重新打开设置卡片。');
      if(v.setting==='model')return this.setModel(e.chatId,v.model);
      if(v.setting==='effort'){
        if(v.model!==this.currentModel(e.chatId)?.model)return this.say(e.chatId,'模型已改变，请重新发送“强度”。');
        return this.setEffort(e.chatId,v.effort);
      }
      return;
    }
    if(!v?.request||v.epoch!==this.epoch){this.say(e.chatId,'这个按钮已过期，请查看最新的问题卡片。');return;}
    await this.answer(v.request,v.answer,e.operator.openId,e.chatId,v.question);
  }
  async answer(code,answer,sender,chat,qid) {
    if(!this.authorize(sender))throw new Error('账号未授权');
    const r=this.store.data.requests.find(x=>x.code.toLowerCase()===code.toLowerCase());
    if(!r||r.status!=='pending'||r.epoch!==this.epoch||r.chatId!==chat){this.say(chat,'这个问题已过期或已处理。');return;}
    let result;
    if(r.questions) {
      const q=qid?r.questions.find(x=>x.id===qid):r.questions.find(x=>!r.answers[x.id]);
      if(!q){this.say(chat,'该问题已回答。');return;}
      r.answers[q.id]={answers:[String(answer)]};
      if(r.questions.some(x=>!r.answers[x.id])){this.store.save();this.say(chat,'已记录，请继续回答剩余问题。');return;}
      result=r.kind==='dynamic'?{success:true,contentItems:[{type:'inputText',text:JSON.stringify(r.answers)}]}:{answers:r.answers};
    }else if(r.kind==='approval') {
      if(!['accept','decline'].includes(answer))throw new Error('请使用同意或拒绝按钮');
      if(answer==='accept'&&!this.feature('remoteApprovals'))answer='decline';
      result=pendingApprovalResult(r,answer);
    }else {
      if(answer==='decline')result={action:'decline',content:null};
      else if(r.params.mode==='url') {if(answer!=='完成')throw new Error('网页操作完成后，请回复“完成”');result={action:'accept',content:null};}
      else {const content=JSON.parse(answer);validateForm(r.params.requestedSchema,content);result={action:'accept',content};}
    }
    this.rpc.respond(r.rpcId,result);r.status='answered';r.answeredAt=Date.now();
    const t=this.store.taskById(r.taskId);if(t)t.status=this.store.data.requests.some(x=>x.taskId===t.id&&x.status==='pending')?'waiting':'running';
    this.store.save();this.say(chat,r.kind==='approval'&&!this.feature('remoteApprovals')?`${r.taskId} 远程审批已关闭，已拒绝本次请求，没有授予任何权限。`:`${r.taskId} 已收到你的回答。`);
  }
  async submitForm(e,token){
    const f=this.forms.get(token);if(!f||f.chat!==e.chatId||Date.now()-f.at>3600000)return this.say(e.chatId,'表单已提交或过期，请重新打开面板。');
    if(['model','effort'].includes(f.kind)&&f.taskId!==(this.selected(e.chatId)?.id??null))return this.say(e.chatId,'任务已切换，请重新打开设置。');
    const values=e.action.formValue;if(!values||typeof values!=='object')throw new Error('未收到表单内容，请重新打开面板');
    if(f.kind==='new'){
      const text=typeof values.prompt==='string'?values.prompt.trim():'';if(!text||text.length>1000)throw new Error('请填写 1 到 1000 字的任务要求');
      this.forms.delete(token);return this.newTask(e.chatId,text,e.messageId+'-'+token);
    }
    if(f.kind==='task'){const t=this.requireTask(String(values.task));this.select(e.chatId,t);this.forms.delete(token);return this.panel(e.chatId);}
    if(f.kind==='model'){
      const model=String(values.model);if(!this.models().some(m=>m.model===model))throw new Error('模型已不可用，请重新打开设置');
      this.forms.delete(token);return this.setModel(e.chatId,model);
    }
    if(f.kind==='effort'){
      if(f.model!==this.currentModel(e.chatId)?.model)throw new Error('模型已更改，请重新选择强度');
      this.setEffort(e.chatId,String(values.effort));this.forms.delete(token);return this.panel(e.chatId);
    }
    if(f.kind==='frequency'){
      this.forms.delete(token);return this.say(e.chatId,'定时报告已取消，发送“全部进度”随时查询。');
    }
  }
  disconnected() {
    this.loaded.clear();for(const r of this.store.data.requests)if(r.status==='pending')r.status='expired';
    for(const t of this.store.data.tasks)if(['starting','running','waiting'].includes(t.status)) {t.status='disconnected';this.say(t.chatId,`${t.id}：Codex 连接中断。旧审批已失效，重连后发送“继续 ${t.id}”恢复会话。`,'errors');}
    this.store.save();
  }
  tick(now=Date.now()) {
    // Progress is queried on demand. Keep this entry point for compatibility.
    return;
  }
  async drain() {
    if(this.draining||!this.feishu.connected)return;
    this.draining=true;
    try {
      // One destination's failure does not block another destination.
      for(const x of [...this.store.data.outbox]) {
        if(!notificationAllowed(this.config,x.category)){
          this.store.data.outbox=this.store.data.outbox.filter(i=>i.id!==x.id);this.store.save();continue;
        }
        if(x.nextAt>Date.now())continue;
        if(x.payload.kind==='file'&&(!within(path.join(this.root,'tasks'),x.payload.path)||!fs.existsSync(x.payload.path))){x.nextAt=Date.now()+3600000;this.log('报告文件不可用');continue;}
        try {await this.feishu.deliver(x);this.store.data.outbox=this.store.data.outbox.filter(i=>i.id!==x.id);}
        catch(e) {x.attempts++;x.nextAt=Date.now()+Math.min(300000,2000*2**Math.min(x.attempts,8));this.log(/^飞书(上传|发送)失败/.test(e.message)?e.message+'，稍后重试':'飞书发送失败，稍后重试');}
        this.store.save();
      }
    }finally{this.draining=false;}
  }
}

function pendingApprovalResult(r,answer){
  return r.method==='item/permissions/requestApproval'?{permissions:answer==='accept'?r.params.permissions:{},scope:'turn'}:{decision:answer};
}

export function validateForm(schema,value) {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('需要 JSON 对象');
  for(const key of schema?.required??[])if(!(key in value))throw new Error(`缺少字段：${key}`);
  for(const [key,v] of Object.entries(value)) {
    const p=schema?.properties?.[key];if(!p)throw new Error(`未知字段：${key}`);
    if(p.type==='array'){if(!Array.isArray(v))throw new Error(`字段类型不正确：${key}`);}
    else if(p.type==='integer'){if(!Number.isInteger(v))throw new Error(`字段类型不正确：${key}`);}
    else if(p.type && typeof v!==p.type)throw new Error(`字段类型不正确：${key}`);
    if(p.enum&&!p.enum.includes(v))throw new Error(`选项不正确：${key}`);
    if(typeof v==='number'&&((p.minimum!==undefined&&v<p.minimum)||(p.maximum!==undefined&&v>p.maximum)))throw new Error(`数值超出范围：${key}`);
  }
}

const INSTRUCTIONS=`用户通过飞书远程控制此任务。请用中文汇报。长任务先列出步骤，通过计划更新与简短 commentary 报告真实进展。必须由用户决定的问题请调用 feishu_ask_user，给出具体选项，等待真实回复；不要把沉默当作批准。不在飞书索取密码、密钥或其他秘密。任务完成后给出包含完成内容、验证结果、成果位置和遗留问题的报告。遵守已有沙箱与审批限制。`;
const EFFORT_NAMES={none:'无',minimal:'极低',low:'低',medium:'中',high:'高',xhigh:'很高',max:'最大',ultra:'Ultra'};
const HELP=`Codex 飞书助手\n\n新建 任务要求 — 建立独立任务\n任务 — 查看所有任务\n切换 T001 — 切换飞书任务\n进度 [T001/D001] — 查看进度\n继续 T001 [补充要求] — 恢复或继续\n停止 [T001] — 停止当前轮次\n模型 — 点击选择可用模型\n强度 — 点击选择支持的思考强度\n设置 — 查看当前设置\n全部进度 / 状态 — 查看所有项目\n问题 [T编号/R编号] — 重新获取待回答问题或审批\n回答 R编号 内容 — 回答问题\n同意 R编号 / 拒绝 R编号 — 批准本次操作\n\n普通消息会接着当前飞书任务聊；执行中发送消息可以补充要求。模型设置下轮生效。T编号支持对话和远程答题；D编号为桌面任务通知，须在电脑上回答和审批。通知类别与功能可在网页管理页勾选；关闭问题通知时，任务仍可能等待你的回答。`;
