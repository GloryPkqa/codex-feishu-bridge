export const NOTIFICATION_KEYS=Object.freeze(['started','stages','questions','approvals','results','files','errors']);
export const FEATURE_KEYS=Object.freeze(['newTasks','continuation','remoteApprovals']);

// Missing settings retain the existing behavior. Normalization also strips
// unrelated fields from old local configuration files.
export function normalizePreferences(value){
  return {
    notifications:Object.fromEntries(NOTIFICATION_KEYS.map(key=>[key,typeof value?.notifications?.[key]==='boolean'?value.notifications[key]:true])),
    features:Object.fromEntries(FEATURE_KEYS.map(key=>[key,typeof value?.features?.[key]==='boolean'?value.features[key]:true]))
  };
}

export function validatePreferences(value){
  const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
  if(!object(value))throw new Error('通知与功能设置必须是对象');
  for(const key of Object.keys(value))if(!['notifications','features'].includes(key))throw new Error(`未知设置：${key}`);
  for(const [group,keys] of [['notifications',NOTIFICATION_KEYS],['features',FEATURE_KEYS]]){
    if(!(group in value))continue;
    if(!object(value[group]))throw new Error(`${group==='notifications'?'通知':'功能'}设置必须是对象`);
    for(const [key,enabled] of Object.entries(value[group])){
      if(!keys.includes(key))throw new Error(`未知设置：${key}`);
      if(typeof enabled!=='boolean')throw new Error(`设置 ${key} 必须为勾选或未勾选`);
    }
  }
  return normalizePreferences(value);
}

export function notificationAllowed(config,category){
  return !NOTIFICATION_KEYS.includes(category)||config?.preferences?.notifications?.[category]!==false;
}

export function featureAllowed(config,feature){
  return !FEATURE_KEYS.includes(feature)||config?.preferences?.features?.[feature]!==false;
}
