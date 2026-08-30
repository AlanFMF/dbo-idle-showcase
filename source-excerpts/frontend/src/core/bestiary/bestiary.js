export const BESTIARY_MILESTONES = Object.freeze([
  { kills:100, points:1, label:'Conhecido' },
  { kills:500, points:2, label:'Caçador' },
  { kills:2500, points:3, label:'Mestre' }
]);

export const BOSS_BESTIARY_MILESTONES = Object.freeze([
  { kills:5, points:1, label:'Desafiante' },
  { kills:25, points:2, label:'Caçador de Boss' },
  { kills:100, points:3, label:'Executor' }
]);

export const BESTIARY_UPGRADES = Object.freeze({
  hp:{name:'Vitalidade',short:'HP',maxRank:20,effectPerRank:1,unit:'%',description:'+1% de HP máximo por nível.'},
  ki:{name:'Energia',short:'KI',maxRank:20,effectPerRank:1,unit:'%',description:'+1% de Ki máximo por nível.'},
  critical:{name:'Precisão Crítica',short:'CRT',maxRank:20,effectPerRank:.15,unit:'%',description:'+0,15% de chance crítica por nível.'},
  defense:{name:'Resistência Física',short:'DEF',maxRank:20,effectPerRank:1,unit:'%',description:'+1% de defesa física por nível.'},
  barrier:{name:'Barreira de Ki',short:'BAR',maxRank:20,effectPerRank:1,unit:'%',description:'+1% de defesa contra Ki por nível.'}
});

export const BOSS_BESTIARY_UPGRADES = Object.freeze({
  critical:{name:'Precisão de Boss',short:'CRT',maxRank:20,effectPerRank:.20,unit:'%',description:'+0,20% de chance crítica por nível.'},
  strength:{name:'Força contra Boss',short:'STR',maxRank:20,effectPerRank:1,unit:'%',description:'+1% de dano físico/melee por nível.'},
  distance:{name:'Distância contra Boss',short:'DIST',maxRank:20,effectPerRank:1,unit:'%',description:'+1% de dano de Ki/Distance por nível.'}
});

export function ensureBestiaryState(state){
  state.bestiary ||= {};
  state.bestiary.kills ||= {};
  state.bestiary.upgrades ||= {};
  state.bestiary.bossKills ||= {};
  state.bestiary.bossUpgrades ||= {};
  for(const key of Object.keys(BESTIARY_UPGRADES)){
    state.bestiary.upgrades[key]=Math.max(0,Math.trunc(Number(state.bestiary.upgrades[key]||0)));
  }
  for(const key of Object.keys(BOSS_BESTIARY_UPGRADES)){
    state.bestiary.bossUpgrades[key]=Math.max(0,Math.trunc(Number(state.bestiary.bossUpgrades[key]||0)));
  }
  return state.bestiary;
}

export function recordBestiaryKill(state, monsterId, amount=1, options={}){
  const bestiary=ensureBestiaryState(state);
  const id=String(monsterId||'').trim();
  if(!id)return 0;
  if(options?.guildBoss===true)return 0; // Bosses da Guild possuem Bestiário próprio da Guild.
  const bucket=options?.boss===true?bestiary.bossKills:bestiary.kills;
  const next=Math.max(0,Math.trunc(Number(bucket[id]||0)))+Math.max(0,Math.trunc(Number(amount)||0));
  bucket[id]=next;
  return next;
}

function pointsForKills(kills=0,milestones=BESTIARY_MILESTONES){
  const value=Math.max(0,Math.trunc(Number(kills)||0));
  return milestones.reduce((sum,m)=>sum+(value>=m.kills?m.points:0),0);
}
export function bestiaryPointsForKills(kills=0){return pointsForKills(kills,BESTIARY_MILESTONES);}
export function bossBestiaryPointsForKills(kills=0){return pointsForKills(kills,BOSS_BESTIARY_MILESTONES);}

export function bestiaryEarnedPoints(state){
  const bestiary=ensureBestiaryState(state);
  return Object.values(bestiary.kills).reduce((sum,kills)=>sum+bestiaryPointsForKills(kills),0);
}
export function bossBestiaryEarnedPoints(state){
  const bestiary=ensureBestiaryState(state);
  return Object.values(bestiary.bossKills).reduce((sum,kills)=>sum+bossBestiaryPointsForKills(kills),0);
}
export function bestiaryMaximumPoints(monsterCount=0){return Math.max(0,Math.trunc(Number(monsterCount)||0))*BESTIARY_MILESTONES.reduce((s,m)=>s+m.points,0);}
export function bossBestiaryMaximumPoints(bossCount=0){return Math.max(0,Math.trunc(Number(bossCount)||0))*BOSS_BESTIARY_MILESTONES.reduce((s,m)=>s+m.points,0);}

export function bestiaryUpgradeCostForRank(rank=0){return 1+Math.max(0,Math.trunc(Number(rank)||0));}
export function bossBestiaryUpgradeCostForRank(rank=0){return 1+Math.max(0,Math.trunc(Number(rank)||0));}

function spentFor(state,defs,keyName,costFn){
  const bestiary=ensureBestiaryState(state);let spent=0;
  for(const key of Object.keys(defs)){
    const rank=Math.max(0,Math.trunc(Number(bestiary[keyName]?.[key]||0)));
    for(let i=0;i<rank;i+=1)spent+=costFn(i);
  }
  return spent;
}
export function bestiarySpentPoints(state){return spentFor(state,BESTIARY_UPGRADES,'upgrades',bestiaryUpgradeCostForRank);}
export function bossBestiarySpentPoints(state){return spentFor(state,BOSS_BESTIARY_UPGRADES,'bossUpgrades',bossBestiaryUpgradeCostForRank);}
export function bestiaryAvailablePoints(state){return Math.max(0,bestiaryEarnedPoints(state)-bestiarySpentPoints(state));}
export function bossBestiaryAvailablePoints(state){return Math.max(0,bossBestiaryEarnedPoints(state)-bossBestiarySpentPoints(state));}

function progressFor(bucket,id,milestones,pointFn){
  const kills=Math.max(0,Math.trunc(Number(bucket[String(id||'')]||0)));
  const points=pointFn(kills);const next=milestones.find(m=>kills<m.kills)||null;
  return {kills,points,next,complete:!next};
}
export function bestiaryMonsterProgress(state,monsterId){const b=ensureBestiaryState(state);return progressFor(b.kills,monsterId,BESTIARY_MILESTONES,bestiaryPointsForKills);}
export function bossBestiaryMonsterProgress(state,monsterId){const b=ensureBestiaryState(state);return progressFor(b.bossKills,monsterId,BOSS_BESTIARY_MILESTONES,bossBestiaryPointsForKills);}

function applyUpgrade(state,key,defs,bucketName,availableFn,costFn,label){
  const bestiary=ensureBestiaryState(state),def=defs[key];
  if(!def)return {ok:false,message:`Upgrade de ${label} inválido.`};
  const rank=Math.max(0,Math.trunc(Number(bestiary[bucketName][key]||0)));
  if(rank>=def.maxRank)return {ok:false,message:`${def.name} já está no nível máximo.`};
  const cost=costFn(rank),available=availableFn(state);
  if(available<cost)return {ok:false,message:`Você precisa de ${cost} ponto(s) de ${label}.`};
  bestiary[bucketName][key]=rank+1;
  return {ok:true,message:`${def.name} avançou para ${rank+1}.`,key,rank:rank+1,cost};
}
export function applyBestiaryUpgrade(state,key){return applyUpgrade(state,key,BESTIARY_UPGRADES,'upgrades',bestiaryAvailablePoints,bestiaryUpgradeCostForRank,'Bestiário');}
export function applyBossBestiaryUpgrade(state,key){return applyUpgrade(state,key,BOSS_BESTIARY_UPGRADES,'bossUpgrades',bossBestiaryAvailablePoints,bossBestiaryUpgradeCostForRank,'Bestiário de Boss');}
