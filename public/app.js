const $=id=>document.getElementById(id);
let csrf=document.querySelector('meta[name="csrf-token"]').content;
let state,noticeTimer,preferencesDirty=false;
const preferenceInputs=[...document.querySelectorAll('#preferences input[data-key]')];
function renderPreferences(value){for(const input of preferenceInputs)input.checked=value?.[input.dataset.group]?.[input.dataset.key]!==false;}
function preferenceValue(){const value={notifications:{},features:{}};for(const input of preferenceInputs)value[input.dataset.group][input.dataset.key]=input.checked;return value;}
function dirtyPreferences(){preferencesDirty=true;$('preferencesStatus').textContent='有更改尚未保存';}
function notice(text){$('notice').textContent=text;$('notice').style.display='block';clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$('notice').style.display='none',7000);}
async function post(route,body={}){
  const send=()=>fetch('/api/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body)});
  let r=await send();
  if(r.status===403){const html=await (await fetch('/')).text();const token=html.match(/name="csrf-token" content="([^"]+)"/);if(token){csrf=token[1];r=await send();}}
  const j=await r.json();if(!r.ok)throw new Error(j.error);return j;
}
function badge(id,ok,text){$(id).className='badge'+(ok?' ok':'');$(id).textContent=text;}
async function refresh(){try{
  const r=await fetch('/api/state');state=await r.json();
  badge('codex',state.codex.connected&&state.codex.loggedIn,state.codex.connected?(state.codex.loggedIn?'Codex 已登录':'Codex 等待登录'):'Codex 连接中');
  badge('feishu',state.feishu.connected,state.feishu.connected?'飞书已连接':state.feishu.connecting?'飞书连接中':state.feishu.configured?'飞书等待连接':'等待创建飞书应用');
  $('login').hidden=!state.codex.connected||state.codex.loggedIn;
  $('connectionText').textContent=state.feishu.connected?'机器人已连接。接下来在飞书打开私聊并发送“帮助”。':'创建或授权应用后，继续完成下面的对话设置。';
  $('register').disabled=state.feishu.configured||['waiting','starting'].includes(state.registration.status);
  $('register').textContent=state.feishu.configured?'此安装已连接应用':'扫码创建飞书应用';
  const reg=state.registration;
  if(reg.status==='waiting'&&reg.url){
    if($('qr').dataset.url!==reg.url){$('qr').replaceChildren();$('qr').dataset.url=reg.url;}
    if(reg.image&&!$('qr').querySelector('img')){const img=document.createElement('img');img.src=reg.image;img.alt='使用飞书扫描二维码';$('qr').append(img);}
    if(!$('qr').querySelector('a')){const a=document.createElement('a');a.href=reg.url;a.target='_blank';a.rel='noreferrer';a.className='button';a.textContent='在飞书授权页面确认';$('qr').append(a);}
    $('regText').textContent='用手机飞书扫码，检查应用权限后确认创建。二维码有效期约 10 分钟。';
  }else{$('qr').replaceChildren();$('qr').dataset.url='';$('regText').textContent=reg.status==='done'?'飞书应用授权完成。':reg.message??(reg.status==='starting'?'正在生成授权二维码…':'');}
  $('pair').hidden=state.ownerBound||!state.feishu.configured;$('pairCode').textContent=state.pairCode?'绑定 '+state.pairCode:'';
  $('owner').textContent=state.conversationReady?'已收到你的私聊消息，飞书对话已启用。':state.ownerBound?'已绑定你的飞书账号。请在机器人私聊发送“帮助”。':'完成绑定后，只有你的账号能操作任务。';
  $('mode').textContent=state.paused?'飞书收发已暂停。本机任务继续运行。':'自动通知按你的勾选发送，进度可随时查询。';$('pause').disabled=state.paused;$('resume').disabled=!state.paused;
  $('desktopSync').checked=!!state.desktopSync.enabled;
  if(!preferencesDirty)renderPreferences(state.preferences);
  $('tasks').replaceChildren();
  const names={idle:'待开始',starting:'正在启动',running:'执行中',waiting:'等你回答',completed:'本轮完成',failed:'执行失败',interrupted:'已停止',disconnected:'连接中断'};
  for(const t of state.tasks){const div=document.createElement('div');div.className='task';const title=document.createElement('b');title.textContent=t.id+' · '+t.title;div.append(title);const p=document.createElement('p');p.textContent=(names[t.status]??t.status)+(t.activity?' · '+t.activity:'');div.append(p);$('tasks').append(div);}
  if(!state.tasks.length){const p=document.createElement('p');p.textContent='还没有任务。连接后可以在飞书直接发要求。';$('tasks').append(p);}
  $('logs').replaceChildren();for(const x of state.logs.slice(-8).reverse()){const div=document.createElement('div');div.className='log';div.textContent=new Date(x.time).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai'})+' · '+x.message;$('logs').append(div);}
  $('outbox').textContent=state.outbox?'还有 '+state.outbox+' 条通知等待发送。':'通知队列已清空。';
}catch{badge('codex',false,'本地服务未连接');}}
$('register').onclick=()=>post('register').then(refresh).catch(e=>notice(e.message));
$('reconnect').onclick=()=>post('reconnect').then(()=>notice('正在重新连接')).catch(e=>notice(e.message));
$('test').onclick=()=>post('test').then(()=>notice('测试消息已进入发送队列')).catch(e=>notice(e.message));
$('demo').onclick=()=>post('demo').then(()=>notice('已启动完整测试，请到飞书回答问题并查看报告')).catch(e=>notice(e.message));
$('login').onclick=async()=>{try{const r=await post('login');if(r.url)window.open(r.url,'_blank','noopener');}catch(e){notice(e.message);}};
$('manual').onsubmit=async e=>{e.preventDefault();try{await post('connect',{appId:$('appId').value.trim(),appSecret:$('appSecret').value.trim()});$('appSecret').value='';notice('已加密保存，正在连接');}catch(e){notice(e.message);}};
$('pause').onclick=()=>post('pause',{paused:true}).then(()=>{notice('已暂停飞书收发');return refresh();}).catch(e=>notice(e.message));
$('resume').onclick=()=>post('pause',{paused:false}).then(()=>{notice('正在恢复飞书收发');return refresh();}).catch(e=>notice(e.message));
$('panel').onclick=()=>post('panel').then(()=>notice('面板已发送到飞书')).catch(e=>notice(e.message));
$('overview').onclick=()=>post('overview').then(()=>notice('项目状态已发送到飞书')).catch(e=>notice(e.message));
$('desktopSync').onchange=()=>post('desktop-sync',{enabled:$('desktopSync').checked}).then(refresh).catch(e=>{notice(e.message);void refresh();});
for(const input of preferenceInputs)input.onchange=dirtyPreferences;
$('preferences').onsubmit=async e=>{e.preventDefault();try{await post('preferences',preferenceValue());preferencesDirty=false;$('preferencesStatus').textContent='已保存';notice('通知和功能设置已保存');await refresh();}catch(err){notice(err.message);}};
$('important').onclick=()=>{for(const input of preferenceInputs)if(input.dataset.group==='notifications')input.checked=['questions','approvals','results','errors'].includes(input.dataset.key);dirtyPreferences();};
$('quiet').onclick=()=>{for(const input of preferenceInputs)if(input.dataset.group==='notifications')input.checked=false;dirtyPreferences();};
$('defaults').onclick=()=>{for(const input of preferenceInputs)input.checked=true;dirtyPreferences();};
void refresh();setInterval(refresh,2000);
