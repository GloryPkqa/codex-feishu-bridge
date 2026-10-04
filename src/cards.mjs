export function cardText(text){
  let result='',bytes=0;
  // Feishu interprets Markdown images as uploaded image keys. Desktop paths
  // and web image URLs cannot be used there; retain their source in the report.
  const display=String(text).replace(/!\[([^\]]*)\]\(([^)]*)\)/g,(all,label,source)=>/^img_[a-zA-Z0-9_-]+$/.test(source)?all:`图片：${label||'任务图片'}（图片地址见完整报告）`);
  for(const ch of display){
    const size=Buffer.byteLength(JSON.stringify(ch),'utf8')-2;
    if(bytes+size>20000)return result+'\n\n（内容较长，此处仅显示前部分。）';
    bytes+=size;result+=ch;
  }
  return result;
}
export function fitCard(value){
  const result=structuredClone(value);
  for(const element of result.body?.elements??[])if(element.tag==='markdown')element.content=cardText(element.content);
  return result;
}
export function card(title,content,buttons=[],color='blue') {
  const elements=[{tag:'markdown',content:cardText(content)}];
  const columns=buttons.some(b=>b.label.length>16)?1:2;
  for(let i=0;i<buttons.length;i+=columns) elements.push({
    tag:'column_set',flex_mode:'none',horizontal_spacing:'8px',columns:buttons.slice(i,i+columns).map(b=>({
      tag:'column',width:'weighted',weight:1,elements:[{tag:'button',text:{tag:'plain_text',content:b.label.slice(0,60)},type:b.primary?'primary':'default',value:b.value}]
    }))
  });
  return {schema:'2.0',config:{wide_screen_mode:true},header:{title:{tag:'plain_text',content:title.slice(0,120)},template:color},body:{elements}};
}
export function modelLabel(model){return String(model.displayName??model.model).replace(/^GPT[-\s]*/i,'').replace(/-/g,' ');}
export function formCard(title,description,fields,submitLabel,value){
  return {schema:'2.0',config:{wide_screen_mode:true},header:{title:{tag:'plain_text',content:title},template:'blue'},body:{elements:[{tag:'markdown',content:description},{tag:'form',name:'control_form',elements:[...fields,{tag:'button',name:'submit',action_type:'form_submit',text:{tag:'plain_text',content:submitLabel},type:'primary',value}]}]}};
}
export function selectField(name,label,options,selected){
  return {tag:'select_static',name,placeholder:{tag:'plain_text',content:label},width:'fill',required:true,options:options.map(o=>({text:{tag:'plain_text',content:o.label},value:o.value})),...(selected?{initial_option:selected}:{})};
}
export const statusNames={idle:'待开始',starting:'正在启动',running:'执行中',waiting:'等你回答',completed:'本轮完成',failed:'执行失败',interrupted:'已停止',disconnected:'连接中断'};
export function progress(t,now=Date.now()) {
  const elapsed=t.startedAt?Math.floor((now-t.startedAt)/60000):0;
  const steps=(t.plan??[]).map(x=>`${x.status==='completed'?'✅':x.status==='inProgress'?'▶️':'▫️'} ${x.step}`).join('\n');
  return `**${t.id} · ${t.title}**\n状态：${statusNames[t.status]??t.status}\n运行：${elapsed} 分钟\n${steps||'当前阶段：'+(t.activity||'等待执行')}\n${t.lastComment?'\n最近进展：'+t.lastComment.slice(-1000):''}`;
}
