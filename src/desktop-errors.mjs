// Return fixed explanations, never forward raw backend errors, paths or tokens.
export function desktopError(error,stage='resume'){
 const text=String(error?.message??'');
 if(/already has an active writer/i.test(text))return {kind:'writer_busy',message:'桌面仍持有这段会话，Codex 拒绝另一个服务接续。任务完成或停止不一定释放会话。当前机器人不能实时接管桌面持有的聊天；需等桌面释放后再手动接续。'};
 if(error?.kind==='desktop_running')return {kind:'desktop_running',message:'电脑原轮次仍在执行或等待处理，当前机器人不能接管该轮次。请先在电脑处理；本轮结束后仍可能需要等待桌面释放会话。'};
 if(/所选模型已不可用/.test(text))return {kind:'model_unavailable',message:'所选模型已不可用，请发送“模型”重新选择。'};
 if(/所选强度已不可用/.test(text))return {kind:'effort_unavailable',message:'所选模型不支持当前强度，请发送“强度”重新选择。'};
 if(/Codex 尚未登录/.test(text))return {kind:'not_authenticated',message:'Codex 尚未登录，请在电脑登录后重试。'};
 if(error?.code===-32601)return {kind:'unsupported_protocol',message:'本机 Codex 不支持当前接续接口，需要检查 Codex 版本和连接方式。'};
 if(/接口超时/.test(text))return {kind:'timeout',message:'Codex 接续接口超时，无法确认启动结果；请先查询原对话状态，避免重复提交。'};
 const names={read:'读取原会话',connect:'连接执行服务',resume:'恢复原会话',validate:'检查模型设置',start:'启动接续轮次'};
 return {kind:'unknown',message:`在${names[stage]??names.resume}时失败，尚未确认具体原因；不能据此判断为模型或插件问题。`};
}
