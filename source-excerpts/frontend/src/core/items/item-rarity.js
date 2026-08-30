const RARITIES = Object.freeze([
  {id:'common',name:'Comum',tier:0,multiplier:1.00,weight:700009},
  {id:'rare',name:'Raro',tier:1,multiplier:1.15,weight:200000},
  {id:'super_rare',name:'Super Raro',tier:2,multiplier:1.30,weight:70000},
  {id:'epic',name:'Épico',tier:3,multiplier:1.45,weight:20000},
  {id:'legendary',name:'Lendário',tier:4,multiplier:1.60,weight:9000},
  {id:'super_legendary',name:'Super Lendário',tier:5,multiplier:1.75,weight:900},
  {id:'mythic',name:'Mítico',tier:6,multiplier:1.90,weight:90},
  {id:'divine',name:'Divino',tier:7,multiplier:2.05,weight:1}
]);

export const ITEM_RARITIES = RARITIES;
export const ITEM_RARITY_BY_ID = Object.freeze(Object.fromEntries(RARITIES.map(r=>[r.id,r])));
const ELIGIBLE_TYPES = new Set(['helmet','necklace','armor','weapon','legs','boots','ring','ammo']);
const NON_SCALING_STATS = new Set(['range','charges']);

export function normalizeRarityId(value='common'){
  const raw=String(value||'common').trim().toLowerCase().replace(/[ -]+/g,'_');
  return ITEM_RARITY_BY_ID[raw] ? raw : 'common';
}
export function rarityDefinition(value='common'){
  return ITEM_RARITY_BY_ID[normalizeRarityId(value)] || ITEM_RARITY_BY_ID.common;
}
export function rarityMultiplier(value='common'){ return Number(rarityDefinition(value).multiplier||1); }
export function rarityName(value='common'){ return rarityDefinition(value).name; }
export function isRarityEligibleItem(item){
  if(!item || !ELIGIBLE_TYPES.has(String(item.type||''))) return false;
  if(item.stackable===true) return false;
  // Itens de treino especiais (ex.: Two Tones Band) mantêm os stats fixos
  // e nunca recebem tier/raridade aleatória, inclusive na Forja.
  if(item.noRarityTier===true || item.trainingSkill) return false;
  return true;
}
// One million exact buckets. The requested percentages total 99.9991%;
// the 0.0009% remainder is assigned to Common so every roll has an outcome.
export function rollItemRarity(random=Math.random){
  const roll=Math.max(0,Math.min(999999,Math.floor(Number(random())*1000000)));
  let cursor=0;
  for(const rarity of RARITIES){ cursor+=rarity.weight; if(roll<cursor) return rarity; }
  return RARITIES[0];
}
export function createItemInstanceMeta(item, rarity='common', source='drop'){
  const def=rarityDefinition(rarity?.id||rarity);
  const instanceId=globalThis.crypto?.randomUUID?.() || `item-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {instanceId,rarity:def.id,rarityTier:def.tier,rarityMultiplier:def.multiplier,source:String(source||'drop').slice(0,40)};
}
export function itemEntryRarity(entry,item=null){
  if(!isRarityEligibleItem(item)) return rarityDefinition('common');
  return rarityDefinition(entry?.rarity||'common');
}
export function scaleStatValue(key,value,multiplier){
  const numeric=Number(value); if(!Number.isFinite(numeric)) return value;
  if(NON_SCALING_STATS.has(String(key))) return numeric;
  // attackSpeed e intervalo em ms: menor e melhor. Dividir pelo mesmo
  // multiplicador entrega o ganho de poder sem inverter o significado.
  if(String(key)==='attackSpeed')return Math.round((numeric/Number(multiplier||1))*100)/100;
  return Math.round(numeric*Number(multiplier||1)*100)/100;
}
export function scaledItemStats(item,rarity='common'){
  const stats=item?.stats||{}; if(!isRarityEligibleItem(item)) return structuredClone(stats);
  const mult=rarityMultiplier(rarity),out={};
  for(const [key,value] of Object.entries(stats)){
    if(key==='skillBonuses'){
      out.skillBonuses={}; for(const [skill,bonus] of Object.entries(value||{}))out.skillBonuses[skill]=scaleStatValue(skill,bonus,mult);
    }else out[key]=scaleStatValue(key,value,mult);
  }
  return out;
}
export function rarityAdjustedItem(item,meta=null){
  if(!item) return item;
  const def=itemEntryRarity(meta,item);
  if(!isRarityEligibleItem(item)) return {...item,rarity:'common',rarityTier:0,rarityMultiplier:1};
  return {...item,rarity:def.id,rarityTier:def.tier,rarityMultiplier:def.multiplier,stats:scaledItemStats(item,def.id),name:`${item.name} [${def.name}]`};
}

export function ensureItemInstancesInState(state,catalog={},source='legacy'){
  state.equipmentMeta ||= {};
  const normalizeEntry=(entry,item)=>{
    if(!isRarityEligibleItem(item)) return [{...entry}];
    const qty=Math.max(1,Math.trunc(Number(entry.quantity)||1));
    const rows=[];
    for(let i=0;i<qty;i++){
      const existingId=i===0?String(entry.instanceId||''):'';
      const def=rarityDefinition(i===0?entry.rarity:'common');
      rows.push({
        ...entry,
        quantity:1,
        instanceId:existingId || createItemInstanceMeta(item,'common',source).instanceId,
        rarity:def.id,
        rarityTier:def.tier,
        rarityMultiplier:def.multiplier,
        source:String(entry.source||source).slice(0,40)
      });
    }
    return rows;
  };
  for(const container of Object.values(state.containers||{})){
    const next=[];
    for(const entry of container.items||[]){
      const item=catalog[entry?.itemId];
      next.push(...normalizeEntry(entry,item));
    }
    container.items=next;
  }
  for(const [slot,itemId] of Object.entries(state.equipment||{})){
    if(slot==='backpack'||!itemId)continue;
    const item=catalog[itemId];
    if(!isRarityEligibleItem(item)){delete state.equipmentMeta[slot];continue;}
    const current=state.equipmentMeta[slot];
    if(current?.instanceId){
      const def=rarityDefinition(current.rarity);
      state.equipmentMeta[slot]={...current,rarity:def.id,rarityTier:def.tier,rarityMultiplier:def.multiplier,source:String(current.source||source).slice(0,40)};
    }else state.equipmentMeta[slot]=createItemInstanceMeta(item,'common',source);
  }
  for(const corpse of state.hunt?.corpses||[]){
    const next=[];
    for(const entry of corpse.loot||[]){ next.push(...normalizeEntry(entry,catalog[entry?.itemId])); }
    corpse.loot=next;
  }
  return state;
}
