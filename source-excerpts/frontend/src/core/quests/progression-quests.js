export function ensureProgressionQuestState(state){
  state.progressionQuest ||= {};
  state.progressionQuest.activeQuestId = state.progressionQuest.activeQuestId || null;
  state.progressionQuest.x = Math.max(0,Math.trunc(Number(state.progressionQuest.x||0)));
  state.progressionQuest.y = Math.max(0,Math.trunc(Number(state.progressionQuest.y||0)));
  state.progressionQuest.clearedGuards = Array.isArray(state.progressionQuest.clearedGuards)
    ? [...new Set(state.progressionQuest.clearedGuards.map(Number).filter(Number.isFinite))]
    : [];
  state.progressionQuest.completed = Array.isArray(state.progressionQuest.completed)
    ? [...new Set(state.progressionQuest.completed.map(String))]
    : [];
  state.progressionQuest.startedAt = Math.max(0,Number(state.progressionQuest.startedAt||0));
  state.progressionQuest.deadlineAt = Math.max(0,Number(state.progressionQuest.deadlineAt||0));
  return state.progressionQuest;
}

export function questMapSize(quest){
  const rows=Array.isArray(quest?.map)?quest.map:[];
  return {width:Math.max(0,...rows.map(row=>String(row).length)),height:rows.length};
}

export function questTile(quest,x,y){
  const rows=Array.isArray(quest?.map)?quest.map:[];
  if(y<0||y>=rows.length)return '#';
  const row=String(rows[y]||'');
  if(x<0||x>=row.length)return '#';
  return row[x]||'#';
}

export function findQuestTile(quest,symbol){
  const rows=Array.isArray(quest?.map)?quest.map:[];
  for(let y=0;y<rows.length;y+=1){
    const x=String(rows[y]).indexOf(symbol);
    if(x>=0)return {x,y};
  }
  return null;
}

export function questGuardAt(quest,x,y){
  return (quest?.guards||[]).find(g=>Number(g.x)===Number(x)&&Number(g.y)===Number(y))||null;
}

export function startProgressionQuest(state,quest,{now=Date.now()}={}){
  const q=ensureProgressionQuestState(state);
  if(!quest)return {ok:false,message:'Quest de progressão inválida.'};
  const level=Math.max(1,Number(state.profile?.level||1));
  if(level<Number(quest.level||1))return {ok:false,message:`Esta Quest requer level ${quest.level}.`};
  if(quest.vipOnly&&Number(state.profile?.vipUntil||0)<=now)return {ok:false,message:'Esta Quest é exclusiva para jogadores VIP.'};
  if(q.completed.includes(String(quest.id)))return {ok:false,message:'Esta Quest já foi concluída por este personagem.'};
  const start=findQuestTile(quest,'S')||{x:1,y:1};
  q.activeQuestId=String(quest.id);q.x=start.x;q.y=start.y;q.clearedGuards=[];
  q.startedAt=Number(now);q.deadlineAt=Number(now)+5*60*1000;
  return {ok:true,message:`${quest.name} iniciada. Você tem 5 minutos para concluir; se o tempo acabar, voltará ao PZ e deverá recomeçar do início.`,state:q};
}

export function moveProgressionQuest(state,quest,dx,dy){
  const q=ensureProgressionQuestState(state);
  if(!quest||String(q.activeQuestId)!==String(quest.id))return {ok:false,message:'Nenhuma Quest de progressão ativa.'};
  if(q.deadlineAt&&Date.now()>=q.deadlineAt)return {ok:false,timeout:true,message:'O tempo da Quest acabou. Você deve tentar novamente desde o início.'};
  dx=Math.trunc(Number(dx)||0);dy=Math.trunc(Number(dy)||0);
  if(Math.abs(dx)+Math.abs(dy)!==1)return {ok:false,message:'Movimento inválido.'};
  const nx=q.x+dx,ny=q.y+dy,tile=questTile(quest,nx,ny);
  if(tile==='#')return {ok:false,message:'O caminho está bloqueado.'};
  const guard=questGuardAt(quest,nx,ny);
  if(guard&&!q.clearedGuards.includes(Number(guard.index))){
    return {ok:false,guard:true,guardIndex:Number(guard.index),zoneId:String(guard.zoneId),message:`${guard.name} bloqueia o caminho.`};
  }
  q.x=nx;q.y=ny;
  const exit=findQuestTile(quest,'E');
  const complete=Boolean(exit&&q.x===exit.x&&q.y===exit.y&&((quest.guards||[]).every(g=>q.clearedGuards.includes(Number(g.index)))));
  return {ok:true,x:q.x,y:q.y,complete,message:complete?'Você chegou ao final da expedição.':''};
}

export function clearProgressionQuestGuard(state,questId,guardIndex){
  const q=ensureProgressionQuestState(state);
  if(String(q.activeQuestId)!==String(questId))return false;
  const index=Number(guardIndex);
  if(!q.clearedGuards.includes(index))q.clearedGuards.push(index);
  return true;
}

export function markProgressionQuestComplete(state,questId){
  const q=ensureProgressionQuestState(state);
  const id=String(questId||'');
  if(!id)return false;
  if(!q.completed.includes(id))q.completed.push(id);
  q.activeQuestId=null;q.clearedGuards=[];q.x=0;q.y=0;q.startedAt=0;q.deadlineAt=0;
  return true;
}

export function abandonProgressionQuest(state){
  const q=ensureProgressionQuestState(state);
  q.activeQuestId=null;q.clearedGuards=[];q.x=0;q.y=0;q.startedAt=0;q.deadlineAt=0;
  return true;
}


export const PROGRESSION_QUEST_TIME_LIMIT_MS=5*60*1000;
export function progressionQuestRemainingMs(state,now=Date.now()){
  const q=ensureProgressionQuestState(state);if(!q.activeQuestId||!q.deadlineAt)return 0;
  return Math.max(0,Number(q.deadlineAt)-Number(now));
}
export function progressionQuestExpired(state,now=Date.now()){
  const q=ensureProgressionQuestState(state);return Boolean(q.activeQuestId&&q.deadlineAt&&Number(now)>=Number(q.deadlineAt));
}
