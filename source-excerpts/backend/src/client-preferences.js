function shortString(value,max=120){
  if(value===null||value===undefined||value==='')return null;
  return String(value).slice(0,max);
}
function bool(value, fallback=false){return typeof value==='boolean'?value:fallback;}
function threshold(value,fallback=50){
  const n=Number(value);
  return [25,50,75,90].includes(n)?n:fallback;
}

function sellBelowRarity(value,fallback='legendary'){
  const allowed=new Set(['rare','super_rare','epic','legendary','super_legendary','mythic','divine']);
  const normalized=String(value||fallback).trim().toLowerCase().replace(/[ -]+/g,'_');
  return allowed.has(normalized)?normalized:fallback;
}
function boundedNumber(value,min,max,fallback=0){
  const n=Number(value);
  return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback;
}
function position(value){
  if(!value||typeof value!=='object')return null;
  const x=Number(value.x),y=Number(value.y);
  if(!Number.isFinite(x)||!Number.isFinite(y))return null;
  return {x:Math.round(boundedNumber(x,0,10000)),y:Math.round(boundedNumber(y,0,10000))};
}
function autoConsumable(source,defaults){
  const value=source&&typeof source==='object'?source:{};
  return {
    enabled:bool(value.enabled,defaults.enabled),
    threshold:threshold(value.threshold,defaults.threshold),
    itemId:shortString(value.itemId,80)
  };
}

export function sanitizeClientSettings(input={},previous={}){
  const src=input&&typeof input==='object'?input:{};
  const old=previous&&typeof previous==='object'?previous:{};
  const spell=src.spellBar&&typeof src.spellBar==='object'?src.spellBar:{};
  const oldSpell=old.spellBar&&typeof old.spellBar==='object'?old.spellBar:{};
  const support=spell.support&&typeof spell.support==='object'?spell.support:{};
  const oldSupport=oldSpell.support&&typeof oldSpell.support==='object'?oldSpell.support:{};
  const consumables=src.autoConsumables&&typeof src.autoConsumables==='object'?src.autoConsumables:{};
  const oldConsumables=old.autoConsumables&&typeof old.autoConsumables==='object'?old.autoConsumables:{};
  const defaultConsumables={
    hp:{enabled:false,threshold:50,itemId:'server_12775'},
    ki:{enabled:false,threshold:50,itemId:'server_12776'},
    senzu:{enabled:false,hpThreshold:75,kiThreshold:75,itemId:'server_12777',autoBest:false}
  };
  const base=(key)=>({...defaultConsumables[key],...(oldConsumables[key]||{})});
  const senzuSource=consumables.senzu&&typeof consumables.senzu==='object'?consumables.senzu:{};
  const oldSenzu=oldConsumables.senzu&&typeof oldConsumables.senzu==='object'?oldConsumables.senzu:{};
  const oldSenzuKi=oldConsumables.senzuKi&&typeof oldConsumables.senzuKi==='object'?oldConsumables.senzuKi:{};
  const slots=Array.from({length:4},(_,i)=>shortString(spell.slots?.[i]??oldSpell.slots?.[i],120));
  const enabled=Array.from({length:4},(_,i)=>typeof spell.enabled?.[i]==='boolean'?spell.enabled[i]:(oldSpell.enabled?.[i]!==false));
  const auto=Array.from({length:4},(_,i)=>typeof spell.auto?.[i]==='boolean'?spell.auto[i]:(oldSpell.auto?.[i]===true));
  const minTargets=Array.from({length:4},(_,i)=>Math.max(1,Math.min(5,Math.trunc(Number(spell.minTargets?.[i]??oldSpell.minTargets?.[i]??1)||1))));
  const supportEntry=(key,healing=false)=>{
    const value=support[key]&&typeof support[key]==='object'?support[key]:{};
    const prior=oldSupport[key]&&typeof oldSupport[key]==='object'?oldSupport[key]:{};
    const out={spellId:shortString(value.spellId??prior.spellId,120),auto:typeof value.auto==='boolean'?value.auto:(prior.auto===true)};
    if(healing)out.threshold=threshold(value.threshold??prior.threshold,75);
    return out;
  };
  const positions=src.containerWindowPositions&&typeof src.containerWindowPositions==='object'?src.containerWindowPositions:{};
  const oldPositions=old.containerWindowPositions&&typeof old.containerWindowPositions==='object'?old.containerWindowPositions:{};
  const heights=src.containerWindowHeights&&typeof src.containerWindowHeights==='object'?src.containerWindowHeights:{};
  const oldHeights=old.containerWindowHeights&&typeof old.containerWindowHeights==='object'?old.containerWindowHeights:{};
  return {
    sound:typeof src.sound==='boolean'?src.sound:(old.sound===true),
    classicInterface:typeof src.classicInterface==='boolean'?src.classicInterface:(old.classicInterface!==false),
    npcSellBelowRarity:sellBelowRarity(src.npcSellBelowRarity, sellBelowRarity(old.npcSellBelowRarity,'legendary')),
    spellBar:{slots,enabled,auto,minTargets,support:{buff:supportEntry('buff'),speed:supportEntry('speed'),healing:supportEntry('healing',true),aggro:{...supportEntry('aggro'),auto:false,spellId:supportEntry('aggro').spellId||'guardian-taunt'}}},
    autoConsumables:{
      hp:autoConsumable(consumables.hp,base('hp')),
      ki:autoConsumable(consumables.ki,base('ki')),
      senzu:{
        enabled:typeof senzuSource.enabled==='boolean' ? senzuSource.enabled : Boolean(oldSenzu.enabled || oldSenzuKi.enabled),
        hpThreshold:threshold(senzuSource.hpThreshold ?? senzuSource.threshold ?? oldSenzu.hpThreshold ?? oldSenzu.threshold,75),
        kiThreshold:threshold(senzuSource.kiThreshold ?? oldSenzu.kiThreshold ?? oldSenzuKi.threshold,75),
        itemId:shortString(senzuSource.itemId ?? oldSenzu.itemId ?? oldSenzuKi.itemId ?? 'server_12777',80),
        autoBest:typeof senzuSource.autoBest==='boolean' ? senzuSource.autoBest : Boolean(oldSenzu.autoBest)
      }
    },
    containerWindowPositions:Object.fromEntries(
      Object.entries({...oldPositions,...positions})
        .filter(([key]) => key === 'backpack' || key === 'depot' || key.startsWith('container:'))
        .slice(0,80)
        .map(([key,value]) => [key,position(value)])
    ),
    containerWindowHeights:Object.fromEntries(
      Object.entries({...oldHeights,...heights})
        .filter(([key]) => key === 'backpack' || key.startsWith('container:'))
        .slice(0,80)
        .map(([key,value]) => [key,Math.round(boundedNumber(value,190,780,430))])
    )
  };
}

export function sanitizeIgnoredLoot(value){
  if(!Array.isArray(value))return [];
  return [...new Set(value.map(v=>String(v).slice(0,100)).filter(Boolean))].slice(0,500);
}

export function sanitizeFavoriteZones(value){
  if(!Array.isArray(value))return [];
  return [...new Set(value.map(v=>String(v).slice(0,120)).filter(Boolean))].slice(0,300);
}

export function sanitizeChat(value){
  if(!Array.isArray(value))return [];
  const allowedChannels=new Set(['default','server','loot']);
  return value.slice(-120).map(entry=>{
    if(typeof entry==='string'){
      return {id:'',author:'Servidor',text:entry.slice(0,500),at:0,system:true,channel:'server'};
    }
    if(!entry||typeof entry!=='object')return null;
    const author=String(entry.author ?? entry.name ?? (entry.system?'Servidor':'Jogador')).slice(0,80);
    const text=String(entry.text ?? entry.message ?? '').slice(0,500);
    if(!text)return null;
    const rawAt=entry.at ?? entry.timestamp ?? entry.time ?? 0;
    const numericAt=Number(rawAt);
    // Epoch em ms; timestamps historicos que ja foram perdidos ficam 0 e a UI
    // mostra --:-- em vez de inventar o horario atual a cada reload.
    const at=Number.isFinite(numericAt)&&numericAt>0
      ? Math.trunc(Math.min(numericAt,Date.now()+86400000))
      : 0;
    const system=entry.system===true;
    const requestedChannel=String(entry.channel||'').toLowerCase();
    const channel=allowedChannels.has(requestedChannel)
      ? requestedChannel
      : system?'server':'default';
    const id=String(entry.id||'').slice(0,120);
    return {id,author,text,at,system,channel};
  }).filter(Boolean);
}
