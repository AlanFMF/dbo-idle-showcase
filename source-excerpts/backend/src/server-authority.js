import { characters, zones, itemCatalog, spells, standardTransformationTransitions, rebornQuest, rebornQuestStages, rebornVocationMap, progressionQuestsV212 } from '../../src/data/game-content.js';
import { createHuntEngine, canEnterZone } from '../../src/core/hunt/hunt-engine.js';
import { createTrainingEngine } from '../../src/core/training/training-engine.js';
import { createSpellController } from '../../src/core/spells/spell-engine.js';
import { applyNextTransformation, currentTransformationForm, rebornChoicesFor } from '../../src/core/transformations/transformation-engine.js';
import { addItemToInventory, removeItemFromInventory, itemQuantity, inventoryContainers, findItemEntry, findEntryByLocation, removeEntryAt, normalizeInventoryState, CONTAINER_LOOT_FILTER_CATEGORIES, extractContainerTree, restoreContainerTree } from '../../src/core/inventory/containers.js';
import { unlockedItemQuantity, removeUnlockedMany, toggleItemLock } from '../../src/core/inventory/item-locks.js';
import { canEquipInSlot, equipmentSlots, equip, normalizeShieldHandState, unequipToBackpack, unequipBackpackToContainer } from '../../src/core/equipment/equipment.js';
import { saveAuthoritativeCharacter } from './database.js';
import { sanitizeClientSettings, sanitizeIgnoredLoot, sanitizeFavoriteZones, sanitizeChat } from './client-preferences.js';
import { characterXpRequired } from '../../src/core/skills/skills.js';
import { ensureItemInstancesInState, isRarityEligibleItem, rarityDefinition, createItemInstanceMeta, rollItemRarity } from '../../src/core/items/item-rarity.js';
import { applyBestiaryUpgrade, applyBossBestiaryUpgrade, bestiaryEarnedPoints, bossBestiaryEarnedPoints, ensureBestiaryState } from '../../src/core/bestiary/bestiary.js';
import { addMail, ensureMailbox, removeMail } from '../../src/core/mail/mailbox.js';
import { ensureProgressionQuestState, startProgressionQuest, moveProgressionQuest, clearProgressionQuestGuard, markProgressionQuestComplete, abandonProgressionQuest, findQuestTile, progressionQuestExpired } from '../../src/core/quests/progression-quests.js';
import { GAME_PASS_MISSIONS, GAME_PASS_REWARDS, GAME_PASS_BASE_LEVELS, gamePassLevelFromXp, gamePassRewardFor, gamePassRewardLabel } from '../../src/data/game-pass.js';

const DEPOT_POINTS = [89,91,93,95,97,99,101].map(x => ({x,y:172,z:7}));
const BULMA_POINT = Object.freeze({x:95,y:177,z:7});
const REBORN_NPC_POINT = Object.freeze({x:420,y:392,z:13});
const HUNT_SWITCH_COOLDOWN_MS = 30000;

export function authoritativeEquipItem(state,itemId,requestedSlot=null,instanceId=null){
  if(!state||state.training?.running){
    return {ok:false,message:'Pare o Training antes de trocar equipamentos.'};
  }
  itemId=String(itemId||'');
  const item=itemCatalog[itemId];
  if(!item)return {ok:false,message:'Item de equipamento invalido.'};
  // A rotina equip() procura o item somente na arvore de backpack acessivel,
  // valida slot/level e devolve o equipamento anterior para a backpack.
  // Armor e weapon sao slots independentes: torso nunca bloqueia a mao.
  return equip(state,item,itemCatalog,requestedSlot||null,instanceId||null);
}

export function authoritativeUnequipItem(state,slot){
  if(!state||state.training?.running){
    return {ok:false,message:'Pare o Training antes de trocar equipamentos.'};
  }
  slot=String(slot||'');
  return unequipToBackpack(state,slot,itemCatalog);
}

export function authoritativeUnequipBackpackToContainer(state,targetContainerId){
  if(!state||state.training?.running||state.hunt?.running){
    return {ok:false,message:'Pare a atividade antes de mover a Backpack equipada.'};
  }
  return unequipBackpackToContainer(state,String(targetContainerId||''));
}
const BUY_PRICES = Object.freeze({
  server_12775:200,
  server_12776:200,
  server_12777:400,
  server_12778:1000,
  server_12779:2500,
  server_7636:4500,
  red_capsule:5000,
  silver_capsule:5000
});

function clone(value){ return structuredClone(value); }
function isNpcSaleBlocked(item){
  const name=String(item?.name||'').toLowerCase();
  const isPotionOrSenzu=item?.consumableKind==='hp'||item?.consumableKind==='ki'||item?.consumableKind==='senzu'||name.includes('potion')||name.includes('senzu');
  return !item || item.noNpcSell===true || item.playerMarketOnly===true || isPotionOrSenzu || item.type==='currency' || item.type==='backpack';
}
function npcSellUnitPrice(item){
  if(!item)return 0;
  const explicit=Number(item.sellPrice??item.value??0);
  if(explicit>0)return Math.floor(explicit);
  const base={common:10,uncommon:35,rare:120,epic:450,legendary:1500};
  const rarity=String(item.rarity||'common').toLowerCase();
  const power=Object.entries(item.stats||{}).reduce((sum,[key,value])=>key==='skillBonuses'||typeof value!=='number'?sum:sum+Math.abs(value),0);
  return Math.max(1,Math.floor((base[rarity]||10)+power*2+Number(item.requiredLevel||0)*.25));
}
function removeMany(state,itemId,quantity){
  let remaining=Math.max(0,Math.trunc(Number(quantity)||0));
  while(remaining>0){
    const have=itemQuantity(state,itemId);
    if(have<=0)return false;
    const step=Math.min(remaining,have);
    // removeItemFromInventory only touches the first stack; drain one at a time safely.
    if(!removeItemFromInventory(state,itemId,1))return false;
    remaining-=1;
  }
  return true;
}
function publicSnapshot(state){
  return {
    serverTime:Date.now(),
    profile:clone(state.profile||{}),
    skills:clone(state.skills||{}),
    temple:clone(state.temple||{}),
    hunt:clone(state.hunt||{}),
    training:clone(state.training||{}),
    rebornQuest:clone(state.rebornQuest||{}),
    questStorages:clone(state.questStorages||{}),
    completedQuests:clone(state.completedQuests||[]),
    bestiary:clone(state.bestiary||{kills:{},upgrades:{}}),
    progressionQuest:clone(state.progressionQuest||{activeQuestId:null,x:0,y:0,clearedGuards:[],completed:[]}),
    forge:clone(state.forge||{pending:null}),
    containers:clone(state.containers||{}),
    depotContainerId:state.depotContainerId||null,
    vipDepotContainerIds:clone(state.vipDepotContainerIds||[]),
    equipment:clone(state.equipment||{}),
    equipmentMeta:clone(state.equipmentMeta||{}),
    spellCooldowns:clone(state.spellCooldowns||{}),
    spellCooldownGroups:clone(state.spellCooldownGroups||{}),
    supportSpellCooldowns:clone(state.supportSpellCooldowns||{}),
    protectionFarming:clone(state.protectionFarming||{active:false})
  };
}
function huntFrameSnapshot(state){
  return {
    serverTime:Date.now(),
    profile:{
      hp:Number(state.profile?.hp||0),
      ki:Number(state.profile?.ki||0),
      maxHp:Number(state.profile?.maxHp||0),
      maxKi:Number(state.profile?.maxKi||0)
    },
    hunt:clone(state.hunt||{})
  };
}
function nearDepot(position={}){
  return DEPOT_POINTS.some(p => Number(position.z)===p.z && Math.abs(Number(position.x)-p.x)+Math.abs(Number(position.y)-p.y)<=2);
}
function nearBulma(position={}){
  return Number(position.z)===BULMA_POINT.z &&
    Math.abs(Number(position.x)-BULMA_POINT.x)+Math.abs(Number(position.y)-BULMA_POINT.y)<=2;
}
function nearRebornNpc(position={}){
  return Number(position.z)===REBORN_NPC_POINT.z &&
    Math.abs(Number(position.x)-REBORN_NPC_POINT.x)+Math.abs(Number(position.y)-REBORN_NPC_POINT.y)<=3;
}
function stable(value){ return JSON.stringify(value, Object.keys(value||{}).sort()); }
function equipmentAndInventoryCounts(state){
  const counts=new Map();
  const add=(id,n=1)=>{if(!id)return;counts.set(String(id),(counts.get(String(id))||0)+Number(n||0));};
  for(const container of Object.values(state.containers||{})){
    // Cada container fisico conta uma unica vez. Entradas com containerId
    // sao apenas o ponteiro visual para esse mesmo objeto, nao um segundo item.
    if(container?.itemId)add(container.itemId,1);
    for(const entry of container.items||[]){
      if(!entry.containerId)add(entry.itemId,entry.quantity||1);
    }
  }
  for(const slot of equipmentSlots){
    if(slot==='backpack')continue;
    const id=state.equipment?.[slot];
    if(id)add(id,1);
  }
  return [...counts.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
}
function sameCounts(a,b){return JSON.stringify(equipmentAndInventoryCounts(a))===JSON.stringify(equipmentAndInventoryCounts(b));}
function itemInstanceSignature(state){
  const ids=[];
  for(const container of Object.values(state.containers||{}))for(const entry of container.items||[])if(entry?.instanceId)ids.push(String(entry.instanceId));
  for(const meta of Object.values(state.equipmentMeta||{}))if(meta?.instanceId)ids.push(String(meta.instanceId));
  return JSON.stringify(ids.sort());
}
function sameItemInstances(a,b){return itemInstanceSignature(a)===itemInstanceSignature(b);}
function depotSubtreeSignature(state){
  const depotIds=new Set([state.depotContainerId,...(state.vipDepotContainerIds||[])].filter(Boolean).map(String));
  if(!depotIds.size)return '[]';
  const inside=id=>{
    let current=String(id||'');const seen=new Set();
    while(current){
      if(depotIds.has(current))return true;
      if(seen.has(current))return false;
      seen.add(current);
      current=String(state.containers?.[current]?.parentId||'');
    }
    return false;
  };
  const rows=[];
  for(const [id,container] of Object.entries(state.containers||{})){
    if(!inside(id))continue;
    rows.push([
      id,
      container.parentId||null,
      (container.items||[]).map(entry=>[
        entry.itemId,Number(entry.quantity||1),entry.containerId||null,entry.instanceId||null
      ]).sort((x,y)=>JSON.stringify(x).localeCompare(JSON.stringify(y)))
    ]);
  }
  rows.sort((x,y)=>String(x[0]).localeCompare(String(y[0])));
  return JSON.stringify(rows);
}
function sameDepotContents(a,b){
  return depotSubtreeSignature(a)===depotSubtreeSignature(b);
}
function validContainerGraph(authority,proposed){
  const authIds=new Set(Object.keys(authority.containers||{}));
  const propIds=Object.keys(proposed.containers||{});
  if(propIds.length!==authIds.size||propIds.some(id=>!authIds.has(id)))return false;
  for(const id of propIds){
    const src=authority.containers[id], p=proposed.containers[id];
    if(!p||!Array.isArray(p.items)||p.items.length>Number(src.capacity||0))return false;
    if(p.parentId!=null&&!authIds.has(String(p.parentId)))return false;
    for(const entry of p.items){
      const quantity=Number(entry?.quantity||0);
      if(!entry||!entry.itemId||quantity<=0||!Number.isFinite(quantity)||!Number.isInteger(quantity))return false;
      if(entry.containerId!=null){
        const childId=String(entry.containerId);
        if(!authIds.has(childId))return false;
        const child=authority.containers?.[childId];
        if(!child||String(entry.itemId)!==String(child.itemId)||quantity!==1)return false;
        if(String(proposed.containers?.[childId]?.parentId||'')!==String(id))return false;
      }else if(!itemCatalog[entry.itemId]){
        return false;
      }
    }
  }
  // Parent graph cannot contain cycles.
  for(const id of propIds){
    const seen=new Set([id]); let cur=proposed.containers[id]?.parentId;
    while(cur){if(seen.has(String(cur)))return false;seen.add(String(cur));cur=proposed.containers[cur]?.parentId;}
  }
  return true;
}
function sanitizeLayout(authority,proposed){
  if(!proposed?.containers||!proposed?.equipment)return {ok:false};
  const candidate=clone(authority);
  candidate.containers=clone(proposed.containers);
  candidate.equipment=clone(proposed.equipment);
  candidate.depotContainerId=authority.depotContainerId;
  if(!validContainerGraph(authority,candidate))return {ok:false};
  for(const [id,container] of Object.entries(candidate.containers)){
    const original=authority.containers[id];
    container.id=id;container.itemId=original.itemId;container.capacity=original.capacity;
  }
  if(!sameCounts(authority,candidate)||!sameItemInstances(authority,candidate))return {ok:false};
  if(!sameDepotContents(authority,candidate)&&(!nearDepot(authority.temple)||authority.hunt?.running||authority.training?.running))return {ok:false,reason:'depot-distance'};
  // Backpack equipada precisa vir da arvore de inventario atualmente acessivel.
  // Isso impede apontar equipment.backpack para o Depot (ou para uma BP guardada
  // dentro dele) e usar itens do Depot remotamente durante Hunt/Training.
  const backpackId=String(candidate.equipment.backpack||'');
  const accessibleBackpacks=new Set(inventoryContainers(authority).map(container=>String(container.id)));
  const vipDepotIds=new Set((authority.vipDepotContainerIds||[]).map(String));
  if(Number(authority.profile?.vipUntil||0)<=Date.now()){
    for(const id of vipDepotIds){if(JSON.stringify(authority.containers?.[id]?.items||[])!==JSON.stringify(candidate.containers?.[id]?.items||[]))return {ok:false,reason:'vip-required'};}
  }
  if(backpackId){
    const backpackContainer=candidate.containers[backpackId];
    const backpackItem=itemCatalog[backpackContainer?.itemId];
    if(!backpackContainer||backpackId===String(authority.depotContainerId||'')||vipDepotIds.has(backpackId)||!accessibleBackpacks.has(backpackId)||backpackItem?.type!=='backpack')return {ok:false,reason:'backpack-access'};
  } else if(authority.hunt?.running||authority.training?.running){
    return {ok:false,reason:'backpack-access'};
  }
  for(const slot of equipmentSlots){
    if(slot==='backpack')continue;
    const itemId=candidate.equipment?.[slot];
    if(!itemId)continue;
    const item=itemCatalog[itemId];
    if(!item)return {ok:false};
    const check=canEquipInSlot(item,slot,candidate,itemCatalog);
    if(!check.ok)return {ok:false,reason:'equip'};
  }
  const knownInstances=new Map();
  for(const container of Object.values(authority.containers||{}))for(const entry of container.items||[]){
    if(entry?.instanceId)knownInstances.set(String(entry.instanceId),{itemId:String(entry.itemId),instanceId:String(entry.instanceId),rarity:rarityDefinition(entry.rarity).id,rarityTier:rarityDefinition(entry.rarity).tier,rarityMultiplier:rarityDefinition(entry.rarity).multiplier,source:String(entry.source||'legacy')});
  }
  for(const [slot,meta] of Object.entries(authority.equipmentMeta||{})){
    const itemId=authority.equipment?.[slot];
    if(meta?.instanceId&&itemId)knownInstances.set(String(meta.instanceId),{itemId:String(itemId),instanceId:String(meta.instanceId),rarity:rarityDefinition(meta.rarity).id,rarityTier:rarityDefinition(meta.rarity).tier,rarityMultiplier:rarityDefinition(meta.rarity).multiplier,source:String(meta.source||'legacy')});
  }
  let invalidInstance=false;
  const cleanContainers={};
  for(const [id,container] of Object.entries(candidate.containers)){
    const seenUiSlots=new Set();
    cleanContainers[id]={
      id,
      itemId:String(container.itemId),
      capacity:Math.max(0,Math.trunc(Number(container.capacity)||0)),
      parentId:container.parentId==null?null:String(container.parentId),
      layoutLocked:Boolean(container.layoutLocked),
      lootFilter:{categories:[...new Set((Array.isArray(container.lootFilter?.categories)?container.lootFilter.categories:[])
        .map(value=>String(value||'').toLowerCase())
        .filter(value=>CONTAINER_LOOT_FILTER_CATEGORIES.includes(value)))]},
      items:(container.items||[]).map(entry=>{
        const itemId=String(entry.itemId);
        const item=itemCatalog[itemId];
        const instance=entry.instanceId?knownInstances.get(String(entry.instanceId)):null;
        if(isRarityEligibleItem(item) && (!instance || instance.itemId!==itemId)) invalidInstance=true;
        let uiSlot=Math.trunc(Number(entry.uiSlot));
        if(!Number.isFinite(uiSlot)||uiSlot<0||uiSlot>=Math.max(0,Math.trunc(Number(container.capacity)||0))||seenUiSlots.has(uiSlot)){
          uiSlot=0;while(seenUiSlots.has(uiSlot)&&uiSlot<Math.max(0,Math.trunc(Number(container.capacity)||0)))uiSlot++;
        }
        seenUiSlots.add(uiSlot);
        return {
          itemId,
          quantity:Math.max(1,Math.trunc(Number(entry.quantity)||1)),
          uiSlot,
          ...(entry.locked?{locked:true}:{}),
          ...(entry.containerId!=null?{containerId:String(entry.containerId)}:{}),
          ...(instance?{instanceId:instance.instanceId,rarity:instance.rarity,rarityTier:instance.rarityTier,rarityMultiplier:instance.rarityMultiplier,source:instance.source}:{})
        };
      })
    };
  }
  if(invalidInstance)return {ok:false,reason:'instance'};
  const cleanEquipment={};
  for(const slot of equipmentSlots)cleanEquipment[slot]=candidate.equipment?.[slot]?String(candidate.equipment[slot]):null;
  return {ok:true,containers:cleanContainers,equipment:cleanEquipment,equipmentMeta:clone(authority.equipmentMeta||{})};
}

export function createAuthoritativeRuntime({accountId,characterId,state,send,onPosition,onAppearance,onActivity,onPartyProgress,onPartyDamage,onPartyTankCheck}){
  const authority=state;
  normalizeInventoryState(authority);
  normalizeShieldHandState(authority,itemCatalog);
  ensureItemInstancesInState(authority,itemCatalog,'legacy');
  authority.settings=sanitizeClientSettings(authority.settings||{},authority.settings||{});
  authority.hunt||={};
  authority.hunt.lastSwitchAt=Math.max(0,Number(authority.hunt.lastSwitchAt||0));
  authority.hunt.lootFilter={...(authority.hunt.lootFilter||{}),ignored:sanitizeIgnoredLoot(authority.hunt.lootFilter?.ignored||[])};
  authority.characterDefinition=characters[authority.profile?.characterId];
  authority.profile ||= {};
  authority.forge ||= {pending:null,lastResult:null,history:[],totalSpent:0};
  authority.forge.history=Array.isArray(authority.forge.history)?authority.forge.history.slice(-50):[];
  authority.forge.totalSpent=Math.max(0,Number(authority.forge.totalSpent||0));
  if(authority.forge.pending && Date.now()-Number(authority.forge.pending.createdAt||0)>24*3600000)authority.forge.pending=null;
  authority.hunt.offlineMode ||= {active:false,lastReport:null};
  authority.protectionFarming ||= {active:false,activity:null,startedAt:0,expiresAt:0,lastEndedAt:0,lastReason:null};

  // V21.26.4: an account can still have an old progression quest stored in
  // state after that quest is retired from the catalog. Clear it on runtime
  // creation so removed vocation quests cannot stay active.
  const initialProgressionQuest=ensureProgressionQuestState(authority);
  if(initialProgressionQuest.activeQuestId&&!progressionQuestsV212.some(q=>String(q.id)===String(initialProgressionQuest.activeQuestId))){
    abandonProgressionQuest(authority);
  }

  // V21.25.7: o runtime pode sobreviver temporariamente sem WebSocket.
  // Os callbacks de transporte sao substituiveis para permitir reanexar a
  // mesma autoridade quando a conexao do jogador voltar, sem recarregar um
  // snapshot antigo do PostgreSQL.
  function attachConnection(callbacks={}){
    if(typeof callbacks.send==='function')send=callbacks.send;
    if(typeof callbacks.onPosition==='function')onPosition=callbacks.onPosition;
    if(typeof callbacks.onAppearance==='function')onAppearance=callbacks.onAppearance;
    if(typeof callbacks.onActivity==='function')onActivity=callbacks.onActivity;
    if(typeof callbacks.onPartyProgress==='function')onPartyProgress=callbacks.onPartyProgress;
    if(typeof callbacks.onPartyDamage==='function')onPartyDamage=callbacks.onPartyDamage;
    if(typeof callbacks.onPartyTankCheck==='function')onPartyTankCheck=callbacks.onPartyTankCheck;
  }
  function detachConnection(){
    send=()=>{};
    onPosition=()=>{};
    onAppearance=()=>{};
    onActivity=()=>{};
    onPartyProgress=()=>{};
    onPartyDamage=()=>false;
    onPartyTankCheck=()=>true;
  }

  // V21.24.4: o Bestiário de Boss aceita somente os bosses da aba Boss
  // das Hunts. Limpa registros legados de Guardiões/Quests que versões
  // anteriores classificavam apenas por contentType='boss'.
  const allowedHuntBossIds=new Set();
  for(const bossZone of zones){
    if(bossZone?.contentType!=='boss'||bossZone?.questType||bossZone?.guildBoss||bossZone?.hiddenFromHuntList||bossZone?.disabledForHunt)continue;
    for(const monster of bossZone.monsters||[]){
      const id=String(monster?.id||monster?.name||'').trim();
      const name=String(monster?.name||'').trim();
      if(id)allowedHuntBossIds.add(id);
      if(name)allowedHuntBossIds.add(name);
    }
  }
  const bestiaryState=ensureBestiaryState(authority);
  for(const key of Object.keys(bestiaryState.bossKills||{})){
    if(!allowedHuntBossIds.has(String(key)))delete bestiaryState.bossKills[key];
  }

  if(!Number.isFinite(Number(authority.profile.offlineChargeSeconds))){
    authority.profile.offlineChargeSeconds=21600;
  }
  authority.profile.offlineChargeSeconds=Math.max(0,Math.min(21600,Number(authority.profile.offlineChargeSeconds||0)));

  function analyserRates(){
    const a=authority.hunt?.analyser||{};
    const hours=Math.max(1/60,Number(a.activeMs||0)/3600000);
    const drops={};
    for(const [key,value] of Object.entries(a.drops||{})){
      drops[key]=Math.max(0,Number(value||0))/hours;
    }
    return {
      sampleMs:Number(a.activeMs||0),
      xpPerHour:Math.max(0,Number(a.xp||0))/hours,
      zeniPerHour:Math.max(0,Number(a.zeni||0))/hours,
      dropsPerHour:drops
    };
  }

  function applyOfflineXp(amount){
    let remaining=Math.max(0,Number(amount||0));
    authority.profile.xp=Math.max(0,Number(authority.profile.xp||0))+remaining;
    while(authority.profile.xp>=characterXpRequired(authority.profile.level)){
      authority.profile.xp-=characterXpRequired(authority.profile.level);
      authority.profile.level=Math.max(1,Number(authority.profile.level||1))+1;
    }
  }

  function grantOfflineDrop(key,expected){
    const [itemId,rarity='common']=String(key||'').split('|');
    const item=itemCatalog[itemId];
    if(!item||expected<=0)return 0;
    let quantity=Math.floor(expected);
    if(Math.random()<(expected-quantity))quantity+=1;
    if(quantity<=0)return 0;
    let granted=0;
    if(isRarityEligibleItem(item)){
      for(let i=0;i<quantity;i++){
        const meta=createItemInstanceMeta(item,rarity,'offline-hunt');
        if(addItemToInventory(authority,itemId,1,itemCatalog,null,meta).ok)granted++;
      }
    }else{
      const result=addItemToInventory(authority,itemId,quantity,itemCatalog);
      if(result.ok)granted=quantity;
      else{
        for(let i=0;i<quantity;i++){
          if(addItemToInventory(authority,itemId,1,itemCatalog).ok)granted++;
          else break;
        }
      }
    }
    return granted;
  }

  function finishOfflineMode(now=Date.now(),awaitingReturn=false){
    const mode=authority.hunt?.offlineMode||{};
    if(!mode.active)return {ok:false,message:'O modo offline nao esta ativo.'};
    // Ao reconectar, o relatório é calculado uma única vez e o personagem
    // continua em modo offline até clicar explicitamente em "Desativar".
    if(mode.awaitingReturn && mode.settled && mode.lastReport){
      if(awaitingReturn)return {ok:true,...mode.lastReport,alreadySettled:true};
      authority.hunt.offlineMode={active:false,awaitingReturn:false,settled:true,lastReport:mode.lastReport};
      return {ok:true,...mode.lastReport,message:'Modo offline desativado. Voce voltou ao jogo.'};
    }
    const budget=Math.max(0,Number(mode.budgetSeconds||0));
    const elapsed=Math.max(0,Math.min(budget,(Number(now)-Number(mode.startedAt||now))/1000));
    const hours=elapsed/3600;
    const rates=mode.rates||{};
    const xp=Math.floor(Math.max(0,Number(rates.xpPerHour||0))*hours*0.5);
    const zeni=Math.floor(Math.max(0,Number(rates.zeniPerHour||0))*hours*0.5);
    applyOfflineXp(xp);
    authority.profile.bank=Math.max(0,Number(authority.profile.bank||0))+zeni;
    const drops=[];
    for(const [key,perHour] of Object.entries(rates.dropsPerHour||{})){
      const granted=grantOfflineDrop(key,Math.max(0,Number(perHour||0))*hours*0.5);
      if(granted>0)drops.push({key,quantity:granted});
    }
    authority.profile.offlineChargeSeconds=Math.max(0,Math.min(21600,Number(authority.profile.offlineChargeSeconds||0)-elapsed));
    const report={elapsedSeconds:Math.floor(elapsed),xp,zeni,drops,completedAt:Number(now)};
    authority.hunt.offlineMode=awaitingReturn
      ? {active:true,awaitingReturn:true,settled:true,startedAt:Number(mode.startedAt||now),budgetSeconds:budget,rates,lastReport:report}
      : {active:false,awaitingReturn:false,settled:true,lastReport:report};
    return {ok:true,...report,message:awaitingReturn?'Caça offline concluída. Confira o relatório antes de voltar ao jogo.':`Modo offline concluido: +${xp} XP, +${zeni} Zeni.`};
  }

  // Ao voltar com o jogo fechado, resolve o período apenas uma vez, mas não
  // libera gameplay até o usuário fechar o relatório/desativar o modo offline.
  if(authority.hunt.offlineMode?.active && !authority.hunt.offlineMode?.awaitingReturn){
    finishOfflineMode(Date.now(),true);
  }

  let dirty=true, destroyed=false, saveBusy=false;
  let lastSaveAt=0;
  let mutationRevision=1;
  let lastServerRevision=0;
  // V21.24.2: progressao de level nunca pode regredir por corrida de save,
  // reconnect ou estado corrompido. Reborn e comandos ADM declaram a queda
  // de level explicitamente antes de salvar.
  let levelFloor=Math.max(1,Math.trunc(Number(authority.profile?.level||1)));
  let levelFloorXp=Math.max(0,Number(authority.profile?.xp||0));
  let allowLevelDecreaseOnce=false;
  const acceptIntentionalLevelDecrease=()=>{
    allowLevelDecreaseOnce=true;
  };
  const guardLevelRegression=()=>{
    const level=Math.max(1,Math.trunc(Number(authority.profile?.level||1)));
    const xp=Math.max(0,Number(authority.profile?.xp||0));
    if(level>levelFloor){levelFloor=level;levelFloorXp=xp;return false;}
    if(level===levelFloor){levelFloorXp=Math.max(levelFloorXp,xp);return false;}
    if(allowLevelDecreaseOnce){levelFloor=level;levelFloorXp=xp;allowLevelDecreaseOnce=false;return false;}
    console.error(`[AUTHORITY] Rollback de level bloqueado: ${level} -> ${levelFloor} (${authority.profile?.name||characterId})`);
    authority.profile.level=levelFloor;
    authority.profile.xp=Math.max(xp,levelFloorXp);
    return true;
  };
  // V21.24.7: cada mutacao ganha uma revisao local. Um save que termina
  // depois de novas mudancas nao pode limpar o dirty dessas mudancas.
  const markDirty=()=>{guardLevelRegression();dirty=true;mutationRevision+=1;};
  const isLootLog=text=>/\b(backpack|corpo|loot|gold|zeni|banco)\b|\b\d+×\b/i.test(String(text||''));
  const log=text=>{
    const clean=String(text||'').trim();
    if(!clean)return;
    send({type:'server-log',channel:isLootLog(clean)?'loot':'server',text:clean,at:Date.now()});
  };
  const rebornState=()=>{authority.rebornQuest||={started:false,stage:0,readyForReborn:false,completed:false};authority.questStorages||={};authority.completedQuests||=[];return authority.rebornQuest;};

  function onRebornBossDefeat({monster,zoneId}){
    const zone=zones.find(z=>z.id===zoneId);
    if(zone?.questType!=='reborn')return;
    const quest=rebornState();
    if(quest.completed)return;
    const stageIndex=Number(zone.questStage||0);
    if(stageIndex!==Number(quest.stage||0))return;
    const stage=rebornQuestStages[stageIndex];
    if(!stage||monster.name!==stage.name)return;
    quest.stage=stageIndex+1;quest.started=true;
    if(quest.stage>=rebornQuestStages.length){
      quest.readyForReborn=true;
      hunt.stop();
      authority.temple={...rebornQuest.finalTeleport,direction:Number(rebornQuest.finalTeleport?.direction ?? 2)};
      onPosition?.(authority.temple);
      markDirty();
      send({type:'authority-event',event:'reborn-ready',position:authority.temple});
      sendSnapshot();
      return;
    }
    const next=rebornQuestStages[quest.stage];
    const nextZone=zones.find(z=>z.id===next.id);
    if(nextZone){hunt.setZone(nextZone.id,1);hunt.start();}
    markDirty();
    send({type:'authority-event',event:'reborn-stage',stage:quest.stage});
  }

  function onEnemyDefeated(info){
    onRebornBossDefeat(info);
    const zone=zones.find(z=>z.id===info?.zoneId);
    if(zone?.questType==='reborn'){
      const q=rebornState();
      onPartyProgress?.({type:q.readyForReborn?'reborn-ready':'reborn-stage',zoneId:zone.id,stage:Number(q.stage||0),monsterName:info?.monster?.name||''});
    }else if(zone?.questType==='progression'){
      clearProgressionQuestGuard(authority,zone.progressionQuestId,Number(zone.progressionGuardIndex||0));
      hunt.stop();markDirty();
      send({type:'authority-event',event:'progression-guard-cleared',questId:zone.progressionQuestId,guardIndex:Number(zone.progressionGuardIndex||0)});
      sendSnapshot();
      onPartyProgress?.({type:'progression-guard-cleared',zoneId:zone.id,questId:zone.progressionQuestId,guardIndex:Number(zone.progressionGuardIndex||0),monsterName:info?.monster?.name||''});
    }else if(zone?.guildBoss){
      hunt.stop();markDirty();
      send({type:'authority-event',event:'guild-boss-complete',zoneId:zone.id,monsterName:info?.monster?.name||''});
      sendSnapshot();
      onPartyProgress?.({type:'guild-boss-defeated',zoneId:zone.id,monsterName:info?.monster?.name||''});
    }else if(zone?.contentType==='boss'){
      hunt.stop();markDirty();
      send({type:'authority-event',event:'boss-complete',zoneId:zone.id,monsterName:info?.monster?.name||''});
      sendSnapshot();
      onPartyProgress?.({type:'boss-defeated',zoneId:zone.id,monsterName:info?.monster?.name||''});
    }
  }
  const hunt=createHuntEngine({state:authority,onUpdate:markDirty,onLog:log,onDeath:()=>{
    const deathZone=zones.find(z=>z.id===authority.hunt?.zoneId);
    if(deathZone?.guildBoss)onPartyProgress?.({type:'guild-boss-member-death',zoneId:deathZone.id});
    authority.temple={x:99,y:189,z:7,direction:2};markDirty();onPosition?.(authority.temple);send({type:'authority-event',event:'death'});
  },onEnemyDefeated,onEnemyDamaged:event=>Boolean(onPartyDamage?.(event)),onBossTimeout:({zoneId})=>{
    const timeoutZone=zones.find(z=>String(z.id)===String(zoneId));
    authority.temple={x:99,y:189,z:7,direction:2};markDirty();onPosition?.(authority.temple);
    send({type:'authority-event',event:'boss-timeout',zoneId,message:`O tempo de 5 minutos de ${timeoutZone?.name||'Boss'} acabou.`});
    sendSnapshot();onPartyProgress?.({type:'boss-timeout',zoneId});
  },enemyAttackAllowed:()=>onPartyTankCheck?Boolean(onPartyTankCheck()):true});
  const training=createTrainingEngine({state:authority,characters,itemCatalog,onUpdate:markDirty,onLog:log});
  const spellController=createSpellController({state:authority,spellCatalog:spells,onCast:spell=>hunt.castSpell(spell),onLog:log});

  function beginProtectionFarming(activity,maxMs=3600000){
    const kind=String(activity||'');
    if(!['hunt','training'].includes(kind))return {ok:false,message:'Nenhuma atividade elegivel para farming de protecao.'};
    if(kind==='hunt'&&!authority.hunt?.running)return {ok:false,message:'A Hunt nao esta ativa.'};
    if(kind==='training'&&!authority.training?.running)return {ok:false,message:'O Training nao esta ativo.'};
    const now=Date.now();
    const duration=Math.max(60000,Math.min(3600000,Number(maxMs)||3600000));
    authority.protectionFarming={active:true,activity:kind,startedAt:now,expiresAt:now+duration,lastEndedAt:Number(authority.protectionFarming?.lastEndedAt||0),lastReason:null};
    markDirty();
    return {ok:true,activity:kind,startedAt:now,expiresAt:now+duration};
  }
  function resumeProtectionFarming(){
    const previous=authority.protectionFarming||{};
    if(!previous.active)return {ok:false,activity:null,elapsedMs:0};
    const now=Date.now();
    const activity=String(previous.activity||'');
    authority.protectionFarming={active:false,activity:null,startedAt:0,expiresAt:0,lastEndedAt:now,lastReason:'reconnected'};
    markDirty();
    return {ok:true,activity,elapsedMs:Math.max(0,now-Number(previous.startedAt||now))};
  }
  function finishProtectionFarming(reason='timeout'){
    const previous=authority.protectionFarming||{};
    const activity=String(previous.activity||'');
    if(authority.hunt?.running)hunt.stop();
    if(authority.training?.running)training.stop();
    authority.temple={x:99,y:189,z:7,direction:2};
    authority.protectionFarming={active:false,activity:null,startedAt:0,expiresAt:0,lastEndedAt:Date.now(),lastReason:String(reason||'timeout')};
    markDirty();
    onPosition?.(authority.temple);
    sendSnapshot();
    return {ok:true,activity,reason:String(reason||'timeout')};
  }
  function protectionFarmingStatus(){return structuredClone(authority.protectionFarming||{active:false});}

  let lastPublishedActivity=null;
  function currentActivity(){
    if(authority.hunt?.running)return 'hunt';
    if(authority.training?.running)return 'training';
    if(authority.progressionQuest?.activeQuestId)return 'quest';
    return 'world';
  }
  function syncActivity(){
    const activity=currentActivity();
    if(activity===lastPublishedActivity)return;
    lastPublishedActivity=activity;
    onActivity?.(activity);
  }
  function sendSnapshot(){syncActivity();send({type:'authoritative-state',state:publicSnapshot(authority)});}
  function replaceState(nextState){
    if(!nextState||typeof nextState!=='object')return false;
    for(const key of Object.keys(authority))delete authority[key];
    Object.assign(authority,structuredClone(nextState));
    authority.characterDefinition=characters[authority.profile?.characterId];
    ensureItemInstancesInState(authority,itemCatalog,'market-sync');
    authority.settings=sanitizeClientSettings(authority.settings||{},authority.settings||{});
    authority.hunt||={}; authority.hunt.lootFilter={...(authority.hunt.lootFilter||{}),ignored:sanitizeIgnoredLoot(authority.hunt.lootFilter?.ignored||[])};
    const restoredProgressionQuest=ensureProgressionQuestState(authority);
    if(restoredProgressionQuest.activeQuestId&&!progressionQuestsV212.some(q=>String(q.id)===String(restoredProgressionQuest.activeQuestId))){
      abandonProgressionQuest(authority);
    }
    dirty=false; sendSnapshot(); onAppearance?.(authority); return true;
  }
  function commitExternalState(nextState){
    const ok=replaceState(nextState);
    if(!ok)return false;
    dirty=true;sendSnapshot();onAppearance?.(authority);return true;
  }

  function publicCharacterProfile(){
    const p=authority.profile||{};
    const char=characters[p.characterId];
    const form=currentTransformationForm(authority,char);
    return {
      id:String(p.id||characterId||''),
      name:String(p.name||'Jogador'),
      characterId:String(p.characterId||'goku'),
      formId:String(p.formId||''),
      vocationSourceId:Number(p.vocationSourceId||0),
      level:Math.max(1,Number(p.level||1)),
      sprite:String(form?.portrait||char?.sprite||'./assets/generated/outfits/goku.webp'),
      profileIcon:p.profileIcon||'default',
      profileBorder:p.profileBorder||'default',
      alliance:p.guild?{name:String(p.guild.name||''),tag:String(p.guild.tag||''),role:String(p.guild.role||'member')} : null,
      tournamentsWon:Math.max(0,Number(p.tournamentsWon||0)),
      pvpWins:Math.max(0,Number(p.pvpWins||0)),
      pvpLosses:Math.max(0,Number(p.pvpLosses||0)),
      bestiaryPoints:bestiaryEarnedPoints(authority),
      bossBestiaryPoints:bossBestiaryEarnedPoints(authority),
      equipment:{...clone(authority.equipment||{}),backpack:authority.containers?.[authority.equipment?.backpack]?.itemId||null},
      equipmentMeta:clone(authority.equipmentMeta||{})
    };
  }

  function tradeInventorySnapshot(){
    const rows=[];
    for(const container of inventoryContainers(authority)){
      for(const [index,entry] of (container.items||[]).entries()){
        const item=itemCatalog[entry.itemId];
        if(!item||item.type==='backpack'||entry.containerId||entry.locked)continue;
        const stackable=item.stackable===true;
        const key=entry.instanceId
          ? `instance:${entry.instanceId}`
          : stackable
            ? `stack:${entry.itemId}`
            : `entry:${container.id}:${entry.uiSlot??index}:${entry.itemId}`;
        if(stackable&&rows.some(row=>row.key===key)){
          rows.find(row=>row.key===key).quantity+=Number(entry.quantity||1);
          continue;
        }
        rows.push({
          key,itemId:String(entry.itemId),quantity:Number(entry.quantity||1),
          instanceId:entry.instanceId||null,rarity:entry.rarity||null,
          rarityTier:entry.rarityTier??null,rarityMultiplier:entry.rarityMultiplier??null,
          source:entry.source||null
        });
      }
    }
    return rows;
  }

  function tradePrepare(offer={}){
    const next=clone(authority);
    normalizeInventoryState(next);
    const requested=Array.isArray(offer.items)?offer.items.slice(0,20):[];
    const outgoing=[];
    for(const row of requested){
      const key=String(row?.key||'');
      const quantity=Math.max(1,Math.min(9999,Math.trunc(Number(row?.quantity)||1)));
      if(key.startsWith('stack:')){
        const itemId=key.slice(6);const item=itemCatalog[itemId];
        if(!item||item.type==='backpack'||item.stackable!==true)return {ok:false,message:`Oferta inválida para ${item?.name||itemId}.`};
        let remaining=quantity;
        for(const container of inventoryContainers(next)){
          for(let index=(container.items||[]).length-1;index>=0&&remaining>0;index--){
            const entry=container.items[index];
            if(String(entry.itemId)!==itemId||entry.locked||entry.containerId)continue;
            const take=Math.min(remaining,Math.max(1,Number(entry.quantity||1)));
            entry.quantity=Number(entry.quantity||1)-take;remaining-=take;
            if(entry.quantity<=0)container.items.splice(index,1);
          }
          if(remaining<=0)break;
        }
        if(remaining>0)return {ok:false,message:'O inventário mudou durante o Trade.'};
        outgoing.push({itemId,quantity});
        continue;
      }
      let found=null;
      if(key.startsWith('instance:')){
        const instanceId=key.slice(9);
        for(const container of inventoryContainers(next)){
          const index=(container.items||[]).findIndex(entry=>String(entry.instanceId||'')===instanceId);
          if(index>=0){found={container,index,entry:container.items[index]};break;}
        }
      }else if(key.startsWith('entry:')){
        const parts=key.split(':');const containerId=parts[1],uiSlot=Number(parts[2]),itemId=parts.slice(3).join(':');
        const container=next.containers?.[containerId];const index=(container?.items||[]).findIndex(entry=>Number(entry.uiSlot)===uiSlot&&String(entry.itemId)===itemId);
        if(index>=0)found={container,index,entry:container.items[index]};
      }
      if(!found||found.entry.locked||found.entry.containerId)return {ok:false,message:'Um item oferecido não está mais disponível.'};
      const item=itemCatalog[found.entry.itemId];if(!item||item.type==='backpack')return {ok:false,message:'Backpacks não podem ser negociadas no Trade direto.'};
      if(Number(found.entry.quantity||1)<quantity)return {ok:false,message:'Quantidade oferecida não está mais disponível.'};
      const meta={...found.entry};delete meta.uiSlot;delete meta.quantity;delete meta.locked;
      outgoing.push({itemId:String(found.entry.itemId),quantity,meta});
      found.entry.quantity=Number(found.entry.quantity||1)-quantity;
      if(found.entry.quantity<=0)found.container.items.splice(found.index,1);
    }
    const zeni=Math.max(0,Math.trunc(Number(offer.zeni)||0)),pp=Math.max(0,Math.trunc(Number(offer.pp)||0));
    if(Number(next.profile?.bank||0)<zeni)return {ok:false,message:'Zeni insuficiente para concluir o Trade.'};
    if(Number(next.profile?.premiumPoints||0)<pp)return {ok:false,message:'Premium Points insuficientes para concluir o Trade.'};
    next.profile.bank=Math.max(0,Number(next.profile.bank||0)-zeni);
    return {ok:true,state:next,outgoing,zeni,pp};
  }

  function tradeReceive(preparedState,incoming=[],zeni=0,pp=0){
    const next=clone(preparedState);
    normalizeInventoryState(next);
    for(const row of incoming||[]){
      const quantity=Math.max(1,Math.trunc(Number(row.quantity)||1));
      const item=itemCatalog[row.itemId];if(!item||item.type==='backpack')return {ok:false,message:'Item de Trade inválido.'};
      if(item.stackable===true){
        const add=addItemToInventory(next,row.itemId,quantity,itemCatalog);if(!add.ok)return {ok:false,message:'Sem espaço para receber os itens do Trade.'};
      }else{
        for(let i=0;i<quantity;i++){
          const add=addItemToInventory(next,row.itemId,1,itemCatalog,null,row.meta||null);if(!add.ok)return {ok:false,message:'Sem espaço para receber os itens do Trade.'};
        }
      }
    }
    next.profile.bank=Math.max(0,Number(next.profile?.bank||0)+Math.max(0,Math.trunc(Number(zeni)||0)));
    next.profile.premiumPoints=Math.max(0,Number(next.profile?.premiumPoints||0)+Math.max(0,Math.trunc(Number(pp)||0)));next.profile.vipCredits=next.profile.premiumPoints;
    return {ok:true,state:next};
  }
  async function flush(force=false){
    if(destroyed)return {ok:false,destroyed:true};
    if(saveBusy){
      if(!force)return {ok:false,busy:true};
      while(saveBusy&&!destroyed)await new Promise(resolve=>setTimeout(resolve,20));
      if(destroyed)return {ok:false,destroyed:true};
    }
    if(!dirty&&!force)return {ok:true,skipped:true,serverRevision:lastServerRevision};
    guardLevelRegression();
    if(!force&&Date.now()-lastSaveAt<700)return {ok:false,throttled:true};
    const targetMutationRevision=mutationRevision;
    // Snapshot imutavel ANTES de qualquer await no PostgreSQL. O Hunt pode
    // continuar ticando enquanto o banco grava, sem alterar o snapshot em voo.
    const snapshot=structuredClone(authority);
    delete snapshot.characterDefinition;
    saveBusy=true;
    try{
      const result=await saveAuthoritativeCharacter(accountId,characterId,snapshot);
      if(!result?.ok)throw new Error('PostgreSQL recusou o snapshot autoritativo.');
      lastServerRevision=Math.max(lastServerRevision,Number(result.serverRevision||0));
      lastSaveAt=Date.now();
      // So limpa dirty se nada mudou enquanto este snapshot estava sendo salvo.
      dirty=mutationRevision!==targetMutationRevision;
      return {...result,mutationRevision:targetMutationRevision};
    }catch(error){
      dirty=true;
      throw error;
    }finally{saveBusy=false;}
  }
  async function flushWithRetry(attempts=5){
    let lastError=null;
    for(let attempt=1;attempt<=Math.max(1,attempts);attempt++){
      try{return await flush(true);}
      catch(error){
        lastError=error;
        console.error(`[AUTHORITY] checkpoint ${attempt}/${attempts} falhou (${authority.profile?.name||characterId}):`,error.message);
        if(attempt<attempts)await new Promise(resolve=>setTimeout(resolve,Math.min(1200,150*attempt)));
      }
    }
    throw lastError||new Error('Falha ao salvar checkpoint autoritativo.');
  }
  const interval=setInterval(()=>{
    if(progressionQuestExpired(authority))expireProgressionQuestRuntime();
    if(dirty){sendSnapshot();flush().catch(e=>console.error('[AUTHORITY] save:',e.message));}
  },500);
  // Hunt movement is broadcast separately at a higher cadence than the full
  // character snapshot. This keeps monster movement smooth without sending
  // inventory/equipment/quest data ~8 times per second or writing the DB.
  const huntFrameInterval=setInterval(()=>{
    if(!destroyed && authority.hunt?.running){
      send({type:'hunt-frame',frame:huntFrameSnapshot(authority)});
    }
  },120);

  // V20.68: automatic spells are server-owned. Browser timers are heavily
  // throttled in background tabs, which previously meant Alt+Tab could stop
  // healing/buff/rotation while monsters continued attacking on the server.
  let lastServerAutoSpell=0;
  const autoSpellInterval=setInterval(()=>{
    if(destroyed||!authority.hunt?.running)return;
    const now=Date.now();
    if(now-lastServerAutoSpell<220)return;
    lastServerAutoSpell=now;
    const bar=authority.settings?.spellBar||{};
    const living=(authority.hunt.enemies||[]).filter(e=>e?.alive&&Number(e.hp)>0).length;
    const available=spellController.available();
    const candidates=(bar.slots||[]).map((spellId,index)=>({
      spellId,index,
      enabled:(bar.enabled||[])[index]!==false,
      automatic:(bar.auto||[])[index]===true,
      minimumTargets:Math.max(1,Number((bar.minTargets||[])[index]||1))
    })).filter(x=>x.spellId&&x.enabled&&x.automatic&&living>=x.minimumTargets)
      .sort((a,b)=>b.minimumTargets-a.minimumTargets||a.index-b.index);
    for(const candidate of candidates){
      const def=available.find(x=>x.id===candidate.spellId);
      if(!def?.aggressive)continue;
      const result=spellController.cast(candidate.spellId);
      if(result?.ok){markDirty();break;}
    }
    const hpPct=Number(authority.hunt.playerMaxHp||0)>0
      ? Number(authority.hunt.playerHp||0)/Number(authority.hunt.playerMaxHp)*100 : 100;
    for(const kind of ['healing','buff','speed']){
      const cfg=bar.support?.[kind];
      if(!cfg?.auto||!cfg.spellId)continue;
      if(kind==='healing'&&hpPct>Number(cfg.threshold||75))continue;
      const def=available.find(x=>x.id===cfg.spellId);
      if(!def)continue;
      if(def.premium&&Number(authority.profile?.vipUntil||0)<=Date.now())continue;
      const result=spellController.cast(cfg.spellId);
      if(result?.ok)markDirty();
    }
  },250);

  let offlineRechargeAccumulator=0;
  let offlineRechargeLastAt=Date.now();
  const offlineRechargeInterval=setInterval(()=>{
    if(destroyed)return;
    const now=Date.now();
    const delta=Math.max(0,Math.min(5, (now-offlineRechargeLastAt)/1000));
    offlineRechargeLastAt=now;
    if(authority.hunt?.offlineMode?.active)return;
    const current=Math.max(0,Number(authority.profile.offlineChargeSeconds||0));
    if(current>=21600)return;
    authority.profile.offlineChargeSeconds=Math.min(21600,current+delta);
    offlineRechargeAccumulator+=delta;
    if(offlineRechargeAccumulator>=30){offlineRechargeAccumulator=0;markDirty();}
  },1000);

  function setPosition(position){authority.temple={...authority.temple,...position};markDirty();}
  function applyLayout(message){
    // V21.24.5: organização visual, cadeado e filtros da Backpack podem ser
    // sincronizados durante Hunt/Training. sanitizeLayout continua impedindo
    // alteração remota do Depot e qualquer mudança inválida de inventário.
    const result=sanitizeLayout(authority,message||{});
    if(!result.ok){sendSnapshot();return result;}
    authority.containers=result.containers;authority.equipment=result.equipment;authority.equipmentMeta=result.equipmentMeta||authority.equipmentMeta||{};markDirty();return {ok:true};
  }
  function updatePreferences(pref={}){
    if(pref.settings&&typeof pref.settings==='object')authority.settings=sanitizeClientSettings(pref.settings,authority.settings||{});
    authority.hunt||={};
    if(Array.isArray(pref.ignoredLoot))authority.hunt.lootFilter={...(authority.hunt.lootFilter||{}),ignored:sanitizeIgnoredLoot(pref.ignoredLoot)};
    if(Array.isArray(pref.favoriteZoneIds))authority.hunt.favoriteZoneIds=sanitizeFavoriteZones(pref.favoriteZoneIds);
    if(Array.isArray(pref.chat))authority.chat=sanitizeChat(pref.chat);
    markDirty();
  }
  function enterZone(zoneId,lure=1){
    const zone=zones.find(z=>z.id===zoneId);
    if(!zone||!canEnterZone(zone,authority.profile.level))return false;
    if(zone.questType==='reborn'){
      const q=rebornState();
      if(q.completed)return false;
      const level=Number(authority.profile.level||1);
      if(level<rebornQuest.minimumLevel||level>rebornQuest.maximumLevel)return false;
      const expected=rebornQuestStages[Math.max(0,Number(q.stage||0))]?.id;
      if(zone.id!==expected)return false;
      q.started=true;
    }
    const ok=hunt.setZone(zoneId,lure);if(ok)markDirty();return ok;
  }
  function buy(itemId,quantity){
    itemId=String(itemId||'');quantity=Math.max(1,Math.min(1000,Math.trunc(Number(quantity)||1)));
    const price=BUY_PRICES[itemId],item=itemCatalog[itemId];if(!price||!item)return {ok:false};
    if(authority.hunt?.running||authority.training?.running||!nearBulma(authority.temple))return {ok:false,message:'Chegue perto da Bulma para comprar.'};
    let purchased=0;
    for(let i=0;i<quantity;i++){
      if(Number(authority.profile.bank||0)<price)break;
      const r=addItemToInventory(authority,itemId,1,itemCatalog);if(!r.ok)break;
      authority.profile.bank=Number(authority.profile.bank||0)-price;purchased++;
    }
    if(purchased){markDirty();sendSnapshot();}return {ok:purchased>0,purchased};
  }
  function sell(itemId,quantity,instanceId=null){
    itemId=String(itemId||'');quantity=Math.max(1,Math.min(100000,Math.trunc(Number(quantity)||1)));
    const item=itemCatalog[itemId];if(!item||isNpcSaleBlocked(item))return {ok:false};
    if(authority.hunt?.running||authority.training?.running||!nearBulma(authority.temple))return {ok:false,message:'Chegue perto da Bulma para vender.'};
    if(instanceId && isRarityEligibleItem(item)){
      const found=findItemEntry(authority,itemId,String(instanceId));
      if(!found||found.entry.locked)return {ok:false,message:'Este item esta protegido ou nao foi encontrado.'};
      if(!removeEntryAt(authority,found.container.id,found.index,1))return {ok:false};
      authority.profile.bank=Number(authority.profile.bank||0)+npcSellUnitPrice(item);
      markDirty();sendSnapshot();return {ok:true,sold:1};
    }
    const have=unlockedItemQuantity(authority,itemId);const sold=Math.min(have,quantity);
    if(!sold)return {ok:false,message:'Este item esta protegido contra venda.'};
    if(!removeUnlockedMany(authority,itemId,sold))return {ok:false};
    authority.profile.bank=Number(authority.profile.bank||0)+npcSellUnitPrice(item)*sold;markDirty();sendSnapshot();return {ok:true,sold};
  }
  function sellAll(belowRarity='legendary'){
    if(authority.hunt?.running||authority.training?.running||!nearBulma(authority.temple))return {ok:false,message:'Chegue perto da Bulma para vender.'};
    const allowedThresholds=new Set(['rare','super_rare','epic','legendary','super_legendary','mythic','divine']);
    const requested=String(belowRarity||'legendary').trim().toLowerCase().replace(/[ -]+/g,'_');
    const thresholdDef=rarityDefinition(allowedThresholds.has(requested)?requested:'legendary');
    let totalGold=0,totalItems=0;

    // Remove por entrada/instancia, nunca por itemId agregado. Isso e
    // essencial depois da V20.60: duas Red Armors podem ter raridades
    // diferentes e "vender abaixo de Lendario" nao pode consumir a lendaria.
    for(const container of inventoryContainers(authority)){
      for(let index=(container.items||[]).length-1;index>=0;index--){
        const entry=container.items[index];
        if(!entry||entry.locked||entry.containerId)continue;
        const item=itemCatalog[String(entry.itemId||'')];
        if(!item||isNpcSaleBlocked(item)||npcSellUnitPrice(item)<=0)continue;
        const entryTier=isRarityEligibleItem(item)
          ? rarityDefinition(entry.rarity||'common').tier
          : 0;
        if(entryTier>=thresholdDef.tier)continue;
        const quantity=Math.max(1,Math.trunc(Number(entry.quantity)||1));
        const removed=removeEntryAt(authority,container.id,index,quantity);
        if(!removed)continue;
        totalGold+=npcSellUnitPrice(item)*quantity;
        totalItems+=quantity;
      }
    }
    if(totalItems<=0)return {ok:false,message:`Nao ha itens desbloqueados abaixo de ${thresholdDef.name} para vender.`};
    authority.profile.bank=Number(authority.profile.bank||0)+totalGold;
    authority.settings||={};
    authority.settings.npcSellBelowRarity=thresholdDef.id;
    markDirty();sendSnapshot();
    return {ok:true,sold:totalItems,totalGold,message:`${totalItems} item(ns) abaixo de ${thresholdDef.name} vendidos por ${totalGold} Gold.`};
  }
  function transform(){
    const char=characters[authority.profile.characterId];
    const result=applyNextTransformation(authority,char,standardTransformationTransitions);
    if(result.ok){authority.characterDefinition=char;markDirty();onAppearance?.(authority);sendSnapshot();}
    return result;
  }
  function canTeleportRebornStage(stage){
    const q=rebornState();
    const level=Number(authority.profile?.level||1);
    return !q.completed && level>=rebornQuest.minimumLevel && level<=rebornQuest.maximumLevel &&
      Math.trunc(Number(stage))===Math.max(0,Math.trunc(Number(q.stage||0)));
  }

  function performReborn(requestedPath=null){
    const q=rebornState();
    const level=Number(authority.profile.level||1);
    if(q.completed||!q.readyForReborn||level<rebornQuest.minimumLevel||level>rebornQuest.maximumLevel||!nearRebornNpc(authority.temple)){
      return {ok:false,message:'Chegue ate o NPC Reborn para concluir.'};
    }
    const char=characters[authority.profile.characterId];
    const choices=rebornChoicesFor(authority,char,rebornVocationMap)
      .filter(choice=>choice.available&&choice.entryForm);
    if(!choices.length){
      return {ok:false,message:'Voce precisa estar na ultima transformacao Normal da sua vocacao para rebornar.'};
    }
    const requested=String(requestedPath||'');
    const chosen=requested
      ? choices.find(choice=>choice.path===requested)
      : choices.length===1?choices[0]:null;
    if(!chosen){
      return {ok:false,reason:'reborn-path-required',choices:choices.map(choice=>choice.path),message:'Escolha Reborn ou Super Reborn. A escolha e permanente neste personagem.'};
    }
    const currentForm=currentTransformationForm(authority,char);
    const currentVocation=Number(authority.profile.vocationSourceId||currentForm?.vocationId||0);
    const rebornForm=chosen.entryForm;
    acceptIntentionalLevelDecrease();
    authority.profile.level=1;
    authority.profile.xp=0;
    authority.profile.vocationSourceId=Number(rebornForm.vocationId||0);
    authority.profile.formId=rebornForm.id;
    authority.profile.rebornPath=chosen.path;
    authority.profile.rebornCount=1;
    authority.questStorages[rebornQuest.storageId]=rebornQuest.completedStorageValue;
    q.completed=true;q.readyForReborn=false;q.started=false;
    if(!authority.completedQuests.includes(rebornQuest.id))authority.completedQuests.push(rebornQuest.id);
    authority.temple={x:99,y:189,z:7,direction:2};
    hunt.stop();markDirty();onPosition?.(authority.temple);onAppearance?.(authority);sendSnapshot();
    return {ok:true,path:chosen.path,label:chosen.label,fromVocation:currentVocation,toVocation:Number(rebornForm.vocationId||0),formId:rebornForm.id,lookType:Number(rebornForm.lookType||0)};
  }

  function removeWorldItem(itemId,quantity=1,instanceId=null,containerId=null,sourceContainerId=null,sourceIndex=null){
    itemId=String(itemId||'');quantity=Math.max(1,Math.min(100000,Math.trunc(Number(quantity)||1)));
    if(authority.hunt?.running||authority.training?.running)return {ok:false};
    const item=itemCatalog[itemId];if(!item)return {ok:false};
    if(item.type==='backpack'){
      // A Backpack equipada também pode ser jogada no chão, deixando o slot
      // vazio e preservando toda a árvore interna.
      const equippedRootId=String(authority.equipment?.backpack||'');
      const equippedRoot=authority.containers?.[equippedRootId];
      if(equippedRoot && String(equippedRoot.itemId||'')===itemId &&
        (!containerId || String(containerId)===equippedRootId)){
        const meta=authority.equipmentMeta?.backpack||null;
        const containerTree=extractContainerTree(authority,equippedRootId);
        if(!containerTree)return {ok:false};
        authority.equipment.backpack=null;
        if(authority.equipmentMeta)delete authority.equipmentMeta.backpack;
        markDirty();sendSnapshot();return {ok:true,item,quantity:1,meta:{itemId,quantity:1,containerId:equippedRootId,...(meta||{}),containerTree}};
      }
      let found=null;
      for(const container of Object.values(authority.containers||{})){
        const index=(container.items||[]).findIndex(entry=>String(entry.itemId||'')===itemId&&entry.containerId&&(!containerId||String(entry.containerId)===String(containerId)));
        if(index>=0){found={container,index,entry:container.items[index]};break;}
      }
      if(!found||found.entry.locked)return {ok:false};
      const removed=removeEntryAt(authority,found.container.id,found.index,1);if(!removed?.containerId)return {ok:false};
      const containerTree=extractContainerTree(authority,removed.containerId);if(!containerTree)return {ok:false};
      markDirty();sendSnapshot();return {ok:true,item,quantity:1,meta:{...removed,containerTree}};
    }
    if(instanceId && isRarityEligibleItem(item)){
      // Pode vir da backpack ou de um slot equipado; preserve exatamente a
      // mesma instancia/raridade quando o item for para o chao.
      const wanted=String(instanceId);
      for(const [slot,meta] of Object.entries(authority.equipmentMeta||{})){
        if(String(meta?.instanceId||'')===wanted && String(authority.equipment?.[slot]||'')===itemId){
          authority.equipment[slot]=null;delete authority.equipmentMeta[slot];markDirty();sendSnapshot();
          return {ok:true,item,quantity:1,meta:{...meta}};
        }
      }
      const found=findItemEntry(authority,itemId,wanted);
      if(!found||found.entry.locked)return {ok:false};
      const removed=removeEntryAt(authority,found.container.id,found.index,1);
      if(!removed)return {ok:false};
      markDirty();sendSnapshot();return {ok:true,item,quantity:1,meta:removed};
    }
    if(sourceContainerId!=null && sourceIndex!=null){
      const found=findEntryByLocation(authority,String(sourceContainerId),Math.trunc(Number(sourceIndex)));
      if(!found||String(found.entry?.itemId||'')!==itemId||found.entry?.locked)return {ok:false};
      const available=Math.max(1,Number(found.entry.quantity||1));
      if(quantity>available)return {ok:false};
      const removed=removeEntryAt(authority,found.container.id,found.index,quantity);
      if(!removed)return {ok:false};
      markDirty();sendSnapshot();return {ok:true,item,quantity:removed.quantity,meta:removed};
    }
    if(itemQuantity(authority,itemId)<quantity)return {ok:false};
    if(!removeMany(authority,itemId,quantity))return {ok:false};
    markDirty();sendSnapshot();return {ok:true,item,quantity};
  }
  function addWorldItem(itemId,quantity=1,meta=null,preferredContainerId=null){
    if(authority.hunt?.running||authority.training?.running)return {ok:false};
    itemId=String(itemId||'');quantity=Math.max(1,Math.min(100000,Math.trunc(Number(quantity)||1)));
    const item=itemCatalog[itemId];if(!item)return {ok:false};
    const result=item.type==='backpack'&&meta?.containerTree
      ? restoreContainerTree(authority,meta.containerTree,itemCatalog,preferredContainerId)
      : addItemToInventory(authority,itemId,quantity,itemCatalog,preferredContainerId,meta?.instanceId?meta:null);
    if(!result.ok)return {ok:false,reason:result.reason||'full'};
    markDirty();sendSnapshot();return {ok:true,item,quantity};
  }

  function adminGrantItem(itemId,quantity=1,rarity=null){
    itemId=String(itemId||'');
    quantity=Math.max(1,Math.min(100000,Math.trunc(Number(quantity)||1)));
    const item=itemCatalog[itemId];
    if(!item)return {ok:false,message:'Item invalido.'};
    const requestedRarity=rarity?rarityDefinition(rarity).id:null;
    let created=0;
    // Backpacks são containers individuais. Criá-las em lote como se fossem
    // stackables fazia /i <backpack> N informar N criadas apesar de existir
    // apenas uma. Também garante que, sem BP equipada, a primeira seja
    // equipada e as seguintes sejam inseridas normalmente nela.
    if(item.type==='backpack'){
      for(let i=0;i<quantity;i++){
        const result=addItemToInventory(authority,itemId,1,itemCatalog);
        if(!result.ok)break;
        created++;
      }
    }else if(requestedRarity && isRarityEligibleItem(item)){
      for(let i=0;i<quantity;i++){
        const meta=createItemInstanceMeta(item,requestedRarity,'admin');
        const result=addItemToInventory(authority,itemId,1,itemCatalog,null,meta);
        if(!result.ok)break; created++;
      }
    }else{
      const result=addItemToInventory(authority,itemId,quantity,itemCatalog);
      if(result.ok)created=quantity;
    }
    if(!created)return {ok:false,message:'Backpack sem espaco para criar o item.'};
    markDirty();sendSnapshot();log(`ADM: ${created}x ${item.name}${requestedRarity?` [${rarityDefinition(requestedRarity).name}]`:''} adicionado ao inventario.`);
    return {ok:true,item,quantity:created,message:`${created}x ${item.name}${requestedRarity?` [${rarityDefinition(requestedRarity).name}]`:''} criado.`};
  }
  function adminGrantLevel(amount){
    const delta=Math.trunc(Number(amount)||0);
    if(!delta)return {ok:false,message:'Quantidade de levels invalida.'};
    if(delta<0)acceptIntentionalLevelDecrease();
    authority.profile.level=Math.max(1,Math.trunc(Number(authority.profile.level||1))+delta);
    authority.profile.xp=Math.max(0,Number(authority.profile.xp||0));
    markDirty();sendSnapshot();onAppearance?.(authority);log(`ADM: level alterado em ${delta>0?'+':''}${delta}.`);
    return {ok:true,message:`Level alterado em ${delta>0?'+':''}${delta}.`};
  }
  function adminGrantSkill(skillId,amount){
    skillId=String(skillId||'');
    const delta=Math.trunc(Number(amount)||0);
    if(!authority.skills?.[skillId]||!delta)return {ok:false,message:'Skill/quantidade invalida.'};
    authority.skills[skillId].level=Math.max(1,Math.trunc(Number(authority.skills[skillId].level||1))+delta);
    authority.skills[skillId].tries=Math.max(0,Number(authority.skills[skillId].tries||0));
    markDirty();sendSnapshot();log(`ADM: ${skillId} alterado em ${delta>0?'+':''}${delta}.`);
    return {ok:true,message:`${skillId} alterado em ${delta>0?'+':''}${delta}.`};
  }


  function adminGrantZeni(amount){
    const delta=Math.trunc(Number(amount)||0);
    if(!delta)return {ok:false,message:'Quantidade de Zeni invalida.'};
    authority.profile.bank=Math.max(0,Number(authority.profile.bank||0)+delta);
    markDirty();sendSnapshot();log(`ADM: Zeni alterado em ${delta>0?'+':''}${delta}.`);
    return {ok:true,message:`Zeni alterado em ${delta>0?'+':''}${delta}.`};
  }
  function updateFriend(action,name){
    const clean=String(name||'').replace(/[<>]/g,'').trim().slice(0,16);
    if(!clean)return {ok:false,message:'Informe o nome do amigo.'};
    authority.profile.friends=Array.isArray(authority.profile.friends)?authority.profile.friends:[];
    const key=clean.toLowerCase();
    if(action==='add'){
      if(authority.profile.friends.some(n=>String(n).toLowerCase()===key)){
        return {ok:false,message:`${clean} já está na sua lista de amigos.`};
      }
      if(authority.profile.friends.length>=50){
        return {ok:false,message:'Sua lista de amigos está cheia. O limite é de 50 amigos por conta.'};
      }
      authority.profile.friends.push(clean);
      markDirty();sendSnapshot();return {ok:true,message:`${clean} adicionado aos amigos.`};
    }
    authority.profile.friends=authority.profile.friends.filter(n=>String(n).toLowerCase()!==key);
    markDirty();sendSnapshot();return {ok:true,message:`${clean} removido dos amigos.`};
  }
  function syncAccountPremiumPoints(value){authority.profile.premiumPoints=Math.max(0,Number(value)||0);authority.profile.vipCredits=authority.profile.premiumPoints;markDirty();sendSnapshot();return true;}
  function syncPvpSnapshot(snapshot={}){authority.profile||={};if(snapshot.bank!=null)authority.profile.bank=Math.max(0,Number(snapshot.bank)||0);if(snapshot.premiumPoints!=null){authority.profile.premiumPoints=Math.max(0,Number(snapshot.premiumPoints)||0);authority.profile.vipCredits=authority.profile.premiumPoints;}if(snapshot.pvpWins!=null)authority.profile.pvpWins=Math.max(0,Number(snapshot.pvpWins)||0);if(snapshot.pvpLosses!=null)authority.profile.pvpLosses=Math.max(0,Number(snapshot.pvpLosses)||0);sendSnapshot();return true;}
  function restorePzResources(){const result=hunt.restorePlayerResources();markDirty();sendSnapshot();return result;}
  function syncPartyBossState(shared,options={}){const ok=hunt.syncSharedEnemyState(shared,options);if(ok){markDirty();if(!options.silent)sendSnapshot();}return ok;}
  function partyBossSnapshot(){return hunt.sharedEnemySnapshot();}

  function syncPartyReborn(stage,ready=false){
    const q=rebornState();
    q.started=true;q.stage=Math.max(0,Math.trunc(Number(stage)||0));q.readyForReborn=Boolean(ready);
    if(ready){hunt.stop();authority.temple={...rebornQuest.finalTeleport,direction:Number(rebornQuest.finalTeleport?.direction ?? 2)};onPosition?.(authority.temple);markDirty();send({type:'authority-event',event:'reborn-ready',position:authority.temple});sendSnapshot();return true;}
    const next=rebornQuestStages[q.stage];
    const zone=next?zones.find(z=>z.id===next.id):null;
    if(zone){hunt.stop();hunt.setZone(zone.id,1);hunt.start();}
    markDirty();send({type:'authority-event',event:'reborn-stage',stage:q.stage});sendSnapshot();return true;
  }
  function stopPartyContent(){hunt.stop();markDirty();sendSnapshot();return true;}

  function progressionQuestDefinition(id){return progressionQuestsV212.find(q=>String(q.id)===String(id||''))||null;}
  function startProgressionQuestRuntime(questId){
    const quest=progressionQuestDefinition(questId);const result=startProgressionQuest(authority,quest);
    if(result.ok){hunt.stop();training.stop();markDirty();sendSnapshot();}
    return result;
  }
  function moveProgressionQuestRuntime(dx,dy){
    const q=ensureProgressionQuestState(authority);const quest=progressionQuestDefinition(q.activeQuestId);
    const result=moveProgressionQuest(authority,quest,dx,dy);
    if(result.ok){markDirty();sendSnapshot();}
    return result;
  }
  function syncProgressionQuestState(next){
    authority.progressionQuest=clone(next||{activeQuestId:null,x:0,y:0,clearedGuards:[],completed:[]});markDirty();sendSnapshot();return true;
  }
  function syncProgressionQuestPosition({questId,x,y,clearedGuards=[]}={}){
    const q=ensureProgressionQuestState(authority);q.activeQuestId=questId||q.activeQuestId;q.x=Number(x||0);q.y=Number(y||0);q.clearedGuards=[...new Set((clearedGuards||[]).map(Number))];markDirty();sendSnapshot();return true;
  }
  function syncProgressionGuardCleared(questId,guardIndex){
    clearProgressionQuestGuard(authority,questId,guardIndex);hunt.stop();markDirty();send({type:'authority-event',event:'progression-guard-cleared',questId,guardIndex:Number(guardIndex||0)});sendSnapshot();return true;
  }
  function abandonProgressionQuestRuntime(){hunt.stop();abandonProgressionQuest(authority);markDirty();sendSnapshot();return {ok:true,message:'Expedição encerrada.'};}
  function expireProgressionQuestRuntime(){
    if(!ensureProgressionQuestState(authority).activeQuestId)return false;
    hunt.stop();abandonProgressionQuest(authority);authority.temple={x:99,y:189,z:7,direction:2};
    onPosition?.(authority.temple);markDirty();send({type:'authority-event',event:'progression-timeout',message:'O tempo de 5 minutos da Quest acabou. Você voltou ao PZ e deverá recomeçar do início.'});sendSnapshot();return true;
  }
  function finishProgressionQuestRuntime(questId){
    const quest=progressionQuestDefinition(questId);const q=ensureProgressionQuestState(authority);
    if(!quest||String(q.activeQuestId)!==String(quest.id))return {ok:false,message:'Quest de progressão não está ativa.'};
    const exit=findQuestTile(quest,'E');
    if(!exit||Number(q.x)!==exit.x||Number(q.y)!==exit.y)return {ok:false,message:'Chegue até o baú final antes de concluir.'};
    if(!(quest.guards||[]).every(g=>q.clearedGuards.includes(Number(g.index))))return {ok:false,message:'Ainda existem guardiões bloqueando a expedição.'};
    if(q.completed.includes(String(quest.id)))return {ok:false,message:'Esta Quest já foi concluída.'};
    if(quest.rewardItemId){
      const rewardItem=itemCatalog[quest.rewardItemId];
      const rewardMeta=isRarityEligibleItem(rewardItem)?createItemInstanceMeta(rewardItem,rollItemRarity().id,'quest'):null;
      const reward=addItemToInventory(authority,quest.rewardItemId,1,itemCatalog,null,rewardMeta);
      if(!reward?.ok)return {ok:false,message:'Libere espaço na Backpack para receber a recompensa.'};
    }
    markProgressionQuestComplete(authority,quest.id);authority.completedQuests ||= [];
    if(!authority.completedQuests.includes(quest.id))authority.completedQuests.push(quest.id);
    markDirty();send({type:'authority-event',event:'progression-complete',questId:quest.id,rewardName:quest.rewardName});sendSnapshot();
    return {ok:true,message:`${quest.name} concluída: ${quest.rewardName}.${quest.unlockVocationId?` Vocação ${characters[quest.unlockVocationId]?.name||quest.unlockVocationId} liberada na conta.`:''}`,rewardItemId:quest.rewardItemId||null,unlockVocationId:quest.unlockVocationId||null};
  }

  const gamePassMissions=Object.freeze(Object.fromEntries(GAME_PASS_MISSIONS.map(mission=>[mission.id,mission])));
  function brasiliaDayKey(ts=Date.now()){const d=new Date(Number(ts)-3*3600000);return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;}
  function brasiliaWeekKey(ts=Date.now()){const d=new Date(Number(ts)-3*3600000);const sunday=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()-d.getUTCDay()));return `${sunday.getUTCFullYear()}-${String(sunday.getUTCMonth()+1).padStart(2,'0')}-${String(sunday.getUTCDate()).padStart(2,'0')}`;}
  function ensureGamePassState(){
    authority.profile ||= {};
    authority.profile.gamePassStats ||= {kills:0,bosses:0,xp:0,drops:0,supplies:0};
    authority.profile.gamePassDailyStats ||= {key:brasiliaDayKey(),kills:0,bosses:0,xp:0,drops:0,supplies:0};
    authority.profile.gamePassWeeklyStats ||= {key:brasiliaWeekKey(),kills:0,bosses:0,xp:0,drops:0,supplies:0};
    if(authority.profile.gamePassDailyStats.key!==brasiliaDayKey())authority.profile.gamePassDailyStats={key:brasiliaDayKey(),kills:0,bosses:0,xp:0,drops:0,supplies:0};
    if(authority.profile.gamePassWeeklyStats.key!==brasiliaWeekKey())authority.profile.gamePassWeeklyStats={key:brasiliaWeekKey(),kills:0,bosses:0,xp:0,drops:0,supplies:0};
    authority.profile.gamePassXp=Math.max(0,Number(authority.profile.gamePassXp||0));
    authority.profile.gamePassClaimedMissions=Array.isArray(authority.profile.gamePassClaimedMissions)?authority.profile.gamePassClaimedMissions:[];
    authority.profile.gamePassClaimedFree=Array.isArray(authority.profile.gamePassClaimedFree)?authority.profile.gamePassClaimedFree:[];
    authority.profile.gamePassClaimedPremium=Array.isArray(authority.profile.gamePassClaimedPremium)?authority.profile.gamePassClaimedPremium:[];
    ensureMailbox(authority.profile);
  }
  function missionClaimKey(m){return m.scope==='daily'?`${m.id}:${brasiliaDayKey()}`:m.scope==='weekly'?`${m.id}:${brasiliaWeekKey()}`:m.id;}
  function missionStats(m){return m.scope==='daily'?authority.profile.gamePassDailyStats:m.scope==='weekly'?authority.profile.gamePassWeeklyStats:authority.profile.gamePassStats;}
  function claimGamePassMission(missionId){
    ensureGamePassState();const id=String(missionId||''),m=gamePassMissions[id];if(!m)return {ok:false,message:'Missao do Game Pass invalida.'};
    const claimKey=missionClaimKey(m);if(authority.profile.gamePassClaimedMissions.includes(claimKey))return {ok:false,message:'Esta missao ja foi resgatada neste ciclo.'};
    if(Number(missionStats(m)?.[m.key]||0)<m.target)return {ok:false,message:'Missao ainda nao concluida.'};
    authority.profile.gamePassClaimedMissions.push(claimKey);authority.profile.gamePassXp+=m.xp;markDirty();sendSnapshot();return {ok:true,message:`+${m.xp} XP de Game Pass.`};
  }
  function grantGamePassReward(reward){
    if(!reward)return {ok:false,message:'Recompensa do Game Pass invalida.'};
    if(Array.isArray(reward.bundle)){
      // Os bundles desta temporada possuem no máximo um item físico; valide-o
      // primeiro para não aplicar boost/cosmético se faltar espaço na mochila.
      const physical=reward.bundle.filter(entry=>entry?.item);
      for(const entry of physical){if(!canAcceptItem(authority,entry.item,entry.qty,itemCatalog))return {ok:false,message:'Sem espaco para receber a recompensa do Game Pass.'};}
      const labels=[];
      for(const entry of reward.bundle){const granted=grantGamePassReward(entry);if(!granted.ok)return granted;labels.push(granted.label);}
      return {ok:true,label:labels.join(' + ')};
    }
    if(reward.zeni){authority.profile.bank=Math.max(0,Number(authority.profile.bank||0))+reward.zeni;return {ok:true,label:`${reward.zeni.toLocaleString('pt-BR')} Zeni`};}
    if(reward.boost){addMail(authority.profile,{kind:'boost',title:`Boost de ${reward.kind==='loot'?'Loot':'XP'}`,body:'Recompensa do Game Pass. Use quando quiser; este mail não expira.',attachment:{kind:'boost',boostKind:reward.kind,durationMs:Number(reward.durationMs||3600000)}});return {ok:true,label:`Boost de ${reward.kind==='loot'?'Loot':'XP'} enviado ao Dragon Mail`};}
    if(reward.cosmeticIcon){authority.profile.unlockedProfileIcons=[...new Set([...(authority.profile.unlockedProfileIcons||[]),reward.cosmeticIcon])];authority.profile.profileIcon=reward.cosmeticIcon;return {ok:true,label:'Icone Beta Exclusivo'};}
    if(reward.cosmeticBorder){authority.profile.unlockedProfileBorders=[...new Set([...(authority.profile.unlockedProfileBorders||[]),reward.cosmeticBorder])];authority.profile.profileBorder=reward.cosmeticBorder;return {ok:true,label:'Borda Beta Exclusiva'};}
    const item=itemCatalog[reward.item];if(!item)return {ok:false,message:'Item de recompensa do Game Pass invalido.'};
    const add=addItemToInventory(authority,reward.item,reward.qty,itemCatalog);if(!add?.ok)return {ok:false,message:'Sem espaco para receber a recompensa do Game Pass.'};
    return {ok:true,label:`${reward.qty}x ${item.name}`};
  }
  function claimGamePassTier(track,tier){
    ensureGamePassState();tier=Math.max(1,Math.trunc(Number(tier)||0));const unlocked=gamePassLevelFromXp(authority.profile.gamePassXp);if(tier>unlocked)return {ok:false,message:'Este tier ainda nao foi desbloqueado.'};
    const premium=track==='premium';if(premium&&!authority.profile.gamePass)return {ok:false,message:'Compre o Game Pass na Loja VIP para liberar a trilha do Passe.'};
    if(premium&&tier>GAME_PASS_BASE_LEVELS)return {ok:false,message:'A progressao pos-45 concede 10 Shenlong Senzu somente na trilha Free.'};
    const claimed=premium?authority.profile.gamePassClaimedPremium:authority.profile.gamePassClaimedFree;if(claimed.map(Number).includes(tier))return {ok:false,message:`Recompensa ${premium?'Passe':'Free'} ja resgatada.`};
    const reward=gamePassRewardFor(premium?'premium':'free',tier);if(!reward)return {ok:false,message:'Este tier nao possui recompensa.'};const granted=grantGamePassReward(reward);if(!granted.ok)return granted;
    claimed.push(tier);markDirty();sendSnapshot();return {ok:true,message:`Tier ${tier} ${premium?'Passe':'Free'}: ${granted.label}.`};
  }


  function claimMailboxEntry(mailId){
    authority.profile ||= {};ensureMailbox(authority.profile);
    const mail=authority.profile.mailbox.find(row=>String(row.id)===String(mailId||''));
    if(!mail)return {ok:false,message:'Mail não encontrado ou expirado.'};
    const attachment=mail.attachment||null;
    if(!attachment){removeMail(authority.profile,mail.id);markDirty();sendSnapshot();return {ok:true,message:'Comunicado removido.'};}
    if(attachment.kind==='boost'){
      const key=attachment.boostKind==='loot'?'lootBoostUntil':'xpBoostUntil';
      authority.profile[key]=Math.max(Date.now(),Number(authority.profile[key]||0))+Math.max(1000,Number(attachment.durationMs||3600000));
      removeMail(authority.profile,mail.id);markDirty();sendSnapshot();return {ok:true,message:`${attachment.boostKind==='loot'?'Loot':'XP'} Boost ativado.`};
    }
    if(attachment.kind==='item'){
      const itemId=String(attachment.itemId||''),qty=Math.max(1,Math.trunc(Number(attachment.qty)||1));
      const item=itemCatalog[itemId];if(!item)return {ok:false,message:'Item do presente não existe mais.'};
      const add=addItemToInventory(authority,itemId,qty,itemCatalog);if(!add?.ok)return {ok:false,message:'Sem espaço para receber o presente.'};
      removeMail(authority.profile,mail.id);markDirty();sendSnapshot();return {ok:true,message:`${qty}x ${item.name} recebido pelo Dragon Mail.`};
    }
    if(attachment.kind==='profile-icon'){const value=String(attachment.value||'').replace(/[^a-z0-9_-]/gi,'').toLowerCase();if(!value)return {ok:false,message:'Ícone cosmético inválido.'};authority.profile.unlockedProfileIcons=[...new Set([...(authority.profile.unlockedProfileIcons||[]),value])];removeMail(authority.profile,mail.id);markDirty();sendSnapshot();return {ok:true,message:'Ícone de perfil liberado na conta.'};}
    if(attachment.kind==='profile-border'){const value=String(attachment.value||'').replace(/[^a-z0-9_-]/gi,'').toLowerCase();if(!value)return {ok:false,message:'Borda cosmética inválida.'};authority.profile.unlockedProfileBorders=[...new Set([...(authority.profile.unlockedProfileBorders||[]),value])];removeMail(authority.profile,mail.id);markDirty();sendSnapshot();return {ok:true,message:'Borda de perfil liberada na conta.'};}
    return {ok:false,message:'Anexo de Mail inválido.'};
  }
  function syncMailboxEntry(mail){authority.profile||={};addMail(authority.profile,mail);markDirty();sendSnapshot();return true;}


  const FORGE_REROLL_COST = 2000000;
  const FORGE_BATCH_OPTIONS = new Set([1,5,10,25,50,100]);
  function findForgeInstance(instanceId){
    const id=String(instanceId||'');if(!id)return null;
    for(const container of inventoryContainers(authority)){
      const index=(container.items||[]).findIndex(entry=>String(entry?.instanceId||'')===id);
      if(index>=0){const entry=container.items[index],item=itemCatalog[entry.itemId];return {kind:'container',container,index,entry,item};}
    }
    for(const [slot,meta] of Object.entries(authority.equipmentMeta||{})){
      if(String(meta?.instanceId||'')!==id)continue;
      const itemId=authority.equipment?.[slot],item=itemCatalog[itemId];return {kind:'equipment',slot,meta,itemId,item};
    }
    return null;
  }
  function forgeComparison(oldRarity,newRarity){
    const oldDef=rarityDefinition(oldRarity),newDef=rarityDefinition(newRarity);
    return newDef.tier>oldDef.tier?'better':newDef.tier<oldDef.tier?'worse':'equal';
  }
  function forgeChargeRoll(){
    if(Number(authority.profile?.bank||0)<FORGE_REROLL_COST)return false;
    authority.profile.bank=Math.max(0,Number(authority.profile.bank||0)-FORGE_REROLL_COST);
    authority.forge.totalSpent=Math.max(0,Number(authority.forge.totalSpent||0))+FORGE_REROLL_COST;
    return true;
  }
  function forgeSetLastResult(data){
    authority.forge ||= {pending:null,lastResult:null,history:[],totalSpent:0};
    authority.forge.lastResult={...data,createdAt:Date.now()};
  }
  function forgeAddHistory(data={}){
    authority.forge.history=Array.isArray(authority.forge.history)?authority.forge.history:[];
    authority.forge.history.push({...data,createdAt:Date.now()});
    authority.forge.history=authority.forge.history.slice(-50);
  }
  function forgeActivityLocked(){
    // Hunts/Training/Progression são os estados autoritativos de atividade.
    // Não deixe uma flag de Reborn antiga esconder/bloquear a Forja depois
    // que o personagem já saiu da arena.
    return Boolean(authority.hunt?.running||authority.training?.running||authority.progressionQuest?.activeQuestId);
  }
  function forgeRoll(instanceId,attempts=1){
    if(forgeActivityLocked())return {ok:false,message:'Use a Forja somente no PZ, fora de Treino, Hunts, Bosses e Quests.'};
    authority.forge ||= {pending:null,lastResult:null,history:[],totalSpent:0};
    if(authority.forge?.pending)return {ok:false,message:'Aceite, mantenha ou continue o resultado atual antes de iniciar outra sequência.'};
    const found=findForgeInstance(instanceId);if(!found?.item||!isRarityEligibleItem(found.item))return {ok:false,message:'Este item não pode ser forjado.'};
    if(found.kind==='container'&&found.entry?.locked)return {ok:false,message:'Desbloqueie o item antes de usar a Forja.'};
    const oldDef=rarityDefinition(found.kind==='container'?found.entry?.rarity:found.meta?.rarity);
    attempts=Math.max(1,Math.trunc(Number(attempts)||1));if(!FORGE_BATCH_OPTIONS.has(attempts))attempts=1;
    if(Number(authority.profile?.bank||0)<FORGE_REROLL_COST)return {ok:false,message:'Você precisa de 2.000.000 Zeni para iniciar a Forja.'};
    let used=0,last=oldDef,bestObserved=null;
    while(used<attempts&&forgeChargeRoll()){
      const next=rollItemRarity();used+=1;last=next;
      if(!bestObserved||next.tier>bestObserved.tier)bestObserved=next;
      const better=next.tier>oldDef.tier;
      if(attempts===1||better){
        authority.forge.pending={
          offerId:`forge-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          instanceId:String(instanceId),itemId:found.item.id,itemName:found.item.name,
          oldRarity:oldDef.id,newRarity:next.id,cost:FORGE_REROLL_COST*used,createdAt:Date.now(),
          attemptsRequested:attempts,attemptsUsed:used,attemptsRemaining:Math.max(0,attempts-used),
          comparison:forgeComparison(oldDef.id,next.id)
        };
        forgeSetLastResult({instanceId:String(instanceId),oldRarity:oldDef.id,newRarity:next.id,comparison:forgeComparison(oldDef.id,next.id),attemptsRequested:attempts,attemptsUsed:used});
        markDirty();sendSnapshot();
        return {ok:true,message:better?`Melhoria encontrada em ${used}/${attempts} tentativa(s): ${oldDef.name} → ${next.name}.`:`Forja rolou ${next.name}.`,paused:true,attemptsUsed:used,attemptsRemaining:Math.max(0,attempts-used)};
      }
    }
    const observed=bestObserved||last||oldDef;
    forgeSetLastResult({instanceId:String(instanceId),oldRarity:oldDef.id,newRarity:observed.id,comparison:forgeComparison(oldDef.id,observed.id),attemptsRequested:attempts,attemptsUsed:used,noImprovement:true});
    forgeAddHistory({itemId:found.item.id,itemName:found.item.name,oldRarity:oldDef.id,newRarity:observed.id,comparison:forgeComparison(oldDef.id,observed.id),attemptsRequested:attempts,attemptsUsed:used,cost:FORGE_REROLL_COST*used,accepted:false,noImprovement:true});
    markDirty();sendSnapshot();
    return {ok:true,message:`Sequência concluída: ${used}/${attempts} tentativa(s), sem tier melhor que ${oldDef.name}.`,paused:false,attemptsUsed:used,attemptsRemaining:Math.max(0,attempts-used)};
  }
  function forgeContinue(){
    if(forgeActivityLocked())return {ok:false,message:'Use a Forja somente no PZ, fora de Treino, Hunts, Bosses e Quests.'};
    const pending=authority.forge?.pending;if(!pending)return {ok:false,message:'Não existe melhoria pendente para continuar.'};
    let remaining=Math.max(0,Math.trunc(Number(pending.attemptsRemaining)||0));
    if(!remaining)return {ok:false,message:'A sequência de tentativas já terminou. Aceite ou mantenha o tier atual.'};
    const found=findForgeInstance(pending.instanceId);if(!found||String(found.item?.id||'')!==String(pending.itemId||''))return {ok:false,message:'O item da Forja não foi encontrado.'};
    const benchmark=rarityDefinition(pending.newRarity),oldDef=rarityDefinition(pending.oldRarity);
    let extraUsed=0,last=benchmark;
    while(extraUsed<remaining&&forgeChargeRoll()){
      const next=rollItemRarity();extraUsed+=1;last=next;
      if(next.tier>benchmark.tier){
        pending.newRarity=next.id;
        pending.attemptsUsed=Number(pending.attemptsUsed||0)+extraUsed;
        pending.attemptsRemaining=Math.max(0,remaining-extraUsed);
        pending.cost=Number(pending.cost||0)+FORGE_REROLL_COST*extraUsed;
        pending.comparison=forgeComparison(oldDef.id,next.id);
        pending.createdAt=Date.now();
        forgeSetLastResult({instanceId:pending.instanceId,oldRarity:oldDef.id,newRarity:next.id,comparison:pending.comparison,attemptsRequested:pending.attemptsRequested,attemptsUsed:pending.attemptsUsed});
        markDirty();sendSnapshot();return {ok:true,message:`Nova melhoria encontrada: ${benchmark.name} → ${next.name}.`,paused:true,attemptsRemaining:pending.attemptsRemaining};
      }
    }
    pending.attemptsUsed=Number(pending.attemptsUsed||0)+extraUsed;
    pending.attemptsRemaining=Math.max(0,remaining-extraUsed);
    pending.cost=Number(pending.cost||0)+FORGE_REROLL_COST*extraUsed;
    forgeSetLastResult({instanceId:pending.instanceId,oldRarity:oldDef.id,newRarity:pending.newRarity,comparison:forgeComparison(oldDef.id,pending.newRarity),attemptsRequested:pending.attemptsRequested,attemptsUsed:pending.attemptsUsed,noFurtherImprovement:true,lastRolled:last.id});
    markDirty();sendSnapshot();return {ok:true,message:`Sequência encerrada após ${pending.attemptsUsed}/${pending.attemptsRequested} tentativa(s). A melhor oferta continua ${rarityDefinition(pending.newRarity).name}.`,paused:true,attemptsRemaining:pending.attemptsRemaining};
  }
  function forgeResolve(accept){
    const pending=authority.forge?.pending;if(!pending)return {ok:false,message:'Não existe resultado pendente na Forja.'};
    if(accept){
      const found=findForgeInstance(pending.instanceId);if(!found||String(found.item?.id||'')!==String(pending.itemId||''))return {ok:false,message:'O item da Forja não foi encontrado. Recuse a oferta para limpar o resultado.'};
      const def=rarityDefinition(pending.newRarity);
      if(found.kind==='container')Object.assign(found.entry,{rarity:def.id,rarityTier:def.tier,rarityMultiplier:def.multiplier,source:'forge'});
      else authority.equipmentMeta[found.slot]={...(found.meta||{}),rarity:def.id,rarityTier:def.tier,rarityMultiplier:def.multiplier,source:'forge'};
    }
    const old=rarityDefinition(pending.oldRarity).name,next=rarityDefinition(pending.newRarity).name;
    forgeSetLastResult({instanceId:pending.instanceId,oldRarity:pending.oldRarity,newRarity:pending.newRarity,comparison:forgeComparison(pending.oldRarity,pending.newRarity),attemptsRequested:pending.attemptsRequested,attemptsUsed:pending.attemptsUsed,accepted:Boolean(accept)});
    forgeAddHistory({itemId:pending.itemId,itemName:pending.itemName,oldRarity:pending.oldRarity,newRarity:pending.newRarity,comparison:forgeComparison(pending.oldRarity,pending.newRarity),attemptsRequested:pending.attemptsRequested,attemptsUsed:pending.attemptsUsed,cost:Number(pending.cost||0),accepted:Boolean(accept)});
    authority.forge.pending=null;markDirty();sendSnapshot();return {ok:true,message:accept?`Tier alterado: ${old} → ${next}.`:`Resultado ${next} recusado. O item permanece ${old}.`};
  }

  function bossTicketQuantity(zoneId){const zone=zones.find(z=>z.id===String(zoneId||''));return zone?.bossTicketItemId?itemQuantity(authority,zone.bossTicketItemId):0;}
  function consumeBossTicket(zoneId){
    const zone=zones.find(z=>z.id===String(zoneId||''));const itemId=zone?.bossTicketItemId;if(!itemId)return {ok:true};
    if(itemQuantity(authority,itemId)<1)return {ok:false,message:`Falta ${itemCatalog[itemId]?.name||'ticket do Boss'}.`};
    if(!removeMany(authority,itemId,1))return {ok:false,message:'Não foi possível consumir o ticket do Boss.'};
    markDirty();sendSnapshot();return {ok:true,itemId};
  }

  function syncUnlockedVocation(vocationId){
    const id=String(vocationId||'');if(!id)return false;
    authority.profile.unlockedVocations=Array.isArray(authority.profile.unlockedVocations)?authority.profile.unlockedVocations:[];
    if(!authority.profile.unlockedVocations.includes(id))authority.profile.unlockedVocations.push(id);
    markDirty();sendSnapshot();return true;
  }

  function updateProfileCosmetic(kind,value){
    kind=String(kind||'');value=String(value||'default').replace(/[^a-z0-9_-]/gi,'').toLowerCase()||'default';
    authority.profile||={};
    const listKey=kind==='border'?'unlockedProfileBorders':'unlockedProfileIcons';
    const valueKey=kind==='border'?'profileBorder':'profileIcon';
    authority.profile[listKey]=[...new Set(['default',...(authority.profile[listKey]||[])])];
    if(!authority.profile[listKey].includes(value))return {ok:false,message:'Este cosmético ainda não foi liberado nesta conta.'};
    authority.profile[valueKey]=value;markDirty();sendSnapshot();return {ok:true,message:`${kind==='border'?'Borda':'Ícone'} alterado.`};
  }

  function handleAction(action,payload={}){
    if(authority.hunt?.offlineMode?.active && action!=='offline-stop'){
      return {ok:false,message:'Desative o modo offline no relatório antes de voltar a jogar.'};
    }
    switch(action){
      case 'profile-cosmetic': return updateProfileCosmetic(payload.kind,payload.value);
      case 'friend-add': return updateFriend('add',payload.name);
      case 'friend-remove': return updateFriend('remove',payload.name);
      case 'game-pass-mission-claim': return claimGamePassMission(payload.missionId);
      case 'game-pass-tier-claim': return claimGamePassTier(String(payload.track||'free'),payload.tier);
      case 'bestiary-upgrade': {const r=applyBestiaryUpgrade(authority,String(payload.key||''));if(r.ok){markDirty();sendSnapshot();}return r;}
      case 'boss-bestiary-upgrade': {const r=applyBossBestiaryUpgrade(authority,String(payload.key||''));if(r.ok){markDirty();sendSnapshot();}return r;}
      case 'mail-claim': return claimMailboxEntry(payload.mailId);
      case 'forge-roll': return forgeRoll(payload.instanceId,payload.attempts);
      case 'forge-continue': return forgeContinue();
      case 'forge-accept': return forgeResolve(true);
      case 'forge-reject': return forgeResolve(false);
      case 'progression-quest-start': return startProgressionQuestRuntime(String(payload.questId||''));
      case 'progression-quest-move': return moveProgressionQuestRuntime(payload.dx,payload.dy);
      case 'progression-quest-finish': return finishProgressionQuestRuntime(String(payload.questId||''));
      case 'progression-quest-stop': return abandonProgressionQuestRuntime();
      case 'hunt-zone': {
        if(authority.hunt?.running)return {ok:false,message:'Pare a Hunt antes de trocar de area.'};
        const selected=zones.find(z=>z.id===String(payload.zoneId||''));
        if(selected?.vipOnly && Number(authority.profile?.vipUntil||0)<=Date.now())return {ok:false,message:'Esta Hunt e exclusiva para jogadores VIP.'};
        training.stop();return enterZone(payload.zoneId,payload.lureCount);
      }
      case 'hunt-start': {
        if(authority.hunt?.running)return {ok:false,message:'A Hunt ja esta em andamento.'};
        const selected=zones.find(z=>z.id===String(authority.hunt?.zoneId||''));
        const needsTicket=selected?.contentType==='boss'&&selected?.bossTicketItemId&&!payload.skipBossTicket;
        if(needsTicket&&bossTicketQuantity(selected.id)<1)return {ok:false,message:`Você precisa de ${itemCatalog[selected.bossTicketItemId]?.name||'um ticket'} para iniciar este Boss.`};
        training.stop();const ok=hunt.start();
        if(ok&&needsTicket){const used=consumeBossTicket(selected.id);if(!used.ok){hunt.stop();return used;}}
        if(ok){authority.hunt.lastSwitchAt=Date.now();markDirty();sendSnapshot();}
        return ok;
      }
      case 'hunt-switch': {
        if(!authority.hunt?.running)return {ok:false,message:'Inicie uma Hunt antes de usar Trocar Hunt.'};
        const current=zones.find(z=>z.id===authority.hunt.zoneId);
        const selected=zones.find(z=>z.id===String(payload.zoneId||''));
        if(!selected||!canEnterZone(selected,authority.profile.level))return {ok:false,message:'Hunt indisponivel para este personagem.'};
        if(selected.vipOnly && Number(authority.profile?.vipUntil||0)<=Date.now())return {ok:false,message:'Esta Hunt e exclusiva para jogadores VIP.'};
        if(current?.questType==='reborn'||selected.questType==='reborn')return {ok:false,message:'A Quest Reborn nao pode ser trocada por este botao.'};
        if(String(selected.id)===String(authority.hunt.zoneId||''))return {ok:true,message:'Voce ja esta nesta Hunt.'};
        const now=Date.now();
        const remaining=Math.max(0,HUNT_SWITCH_COOLDOWN_MS-(now-Number(authority.hunt.lastSwitchAt||0)));
        if(remaining>0)return {ok:false,message:`Aguarde ${Math.ceil(remaining/1000)}s para trocar de Hunt.`,remainingMs:remaining};
        // setZone + start acontece dentro da mesma acao do servidor. A Hunt atual
        // continua ativa ate este ponto e a nova formacao nasce imediatamente.
        const ok=enterZone(selected.id,payload.lureCount);
        if(!ok)return {ok:false,message:'Nao foi possivel trocar de Hunt.'};
        if(!hunt.start())return {ok:false,message:'Nao foi possivel iniciar a nova Hunt.'};
        authority.hunt.lastSwitchAt=now;markDirty();sendSnapshot();
        return {ok:true,message:`Hunt alterada para ${selected.name}.`};
      }
      case 'hunt-stop': {hunt.stop();authority.temple={x:99,y:189,z:7,direction:2};onPosition?.(authority.temple);markDirty();sendSnapshot();return {ok:true,message:'Hunt encerrada. Você voltou ao PZ.'};}
      case 'hunt-lure': hunt.setLureCount(payload.value);markDirty();return true;
      case 'cast-spell': {const spellId=String(payload.spellId||'');const def=spells.find(x=>x.id===spellId);if(def?.premium && Number(authority.profile?.vipUntil||0)<=Date.now())return {ok:false,message:'Esta spell e exclusiva para jogadores VIP.'};const r=spellController.cast(spellId);if(r.ok)markDirty();sendSnapshot();return r;}
      case 'use-consumable': {const r=hunt.useConsumable(String(payload.itemId||''));if(r.ok)markDirty();sendSnapshot();return r;}
      case 'loot-corpses': {for(const corpse of [...(authority.hunt?.corpses||[])])hunt.lootCorpse(corpse.id);markDirty();sendSnapshot();return true;}
      case 'drop-hunt-item': {const itemId=String(payload.itemId||'');const qty=Math.max(1,Math.trunc(Number(payload.quantity)||1));if(itemQuantity(authority,itemId)<qty)return false;if(!removeMany(authority,itemId,qty))return false;hunt.dropItemOnHunt(itemId,qty);markDirty();sendSnapshot();return true;}
      case 'hunt-analyser-reset': {
        hunt.resetAnalyser();markDirty();sendSnapshot();return {ok:true,message:'Hunt Analyser zerado.'};
      }
      case 'offline-start': {
        if(authority.hunt?.offlineMode?.active)return {ok:false,message:'O modo offline ja esta ativo.'};
        if(authority.training?.running)return {ok:false,message:'Pare o Training antes de ativar o modo offline.'};
        const rates=analyserRates();
        if(rates.sampleMs<60000)return {ok:false,message:'Cace online por pelo menos 1 minuto para calibrar o Hunt Analyser.'};
        const charge=Math.max(0,Math.min(21600,Number(authority.profile.offlineChargeSeconds||0)));
        if(charge<60)return {ok:false,message:'Voce ainda nao possui ao menos 1 minuto de tempo offline.'};
        hunt.stop();
        authority.hunt.offlineMode={active:true,awaitingReturn:false,settled:false,startedAt:Date.now(),budgetSeconds:charge,rates,lastReport:authority.hunt.offlineMode?.lastReport||null};
        markDirty();sendSnapshot();
        return {ok:true,message:`Modo offline ativado por ate ${Math.floor(charge/60)} minuto(s). Pode fechar o jogo.`};
      }
      case 'offline-stop': {
        const result=finishOfflineMode(Date.now());
        if(result.ok){
          hunt.stop();
          authority.temple={x:99,y:189,z:7,direction:2};
          onPosition?.(authority.temple);
          markDirty();sendSnapshot();
          result.message='Modo offline desativado. Voce voltou ao Templo.';
        }
        return result;
      }
      case 'training-start': {
        if(authority.training?.running)return {ok:false,message:'O treino ja esta em andamento.'};
        hunt.stop();const ok=training.start(String(payload.roomId||''));if(ok){markDirty();sendSnapshot();}return ok;
      }
      case 'training-stop': training.stop();markDirty();sendSnapshot();return true;
      case 'equip-item': {
        const r=authoritativeEquipItem(authority,payload.itemId,payload.slot||null,payload.instanceId||null);
        if(r.ok){markDirty();sendSnapshot();}
        return r;
      }
      case 'unequip-item': {
        const r=authoritativeUnequipItem(authority,payload.slot);
        if(r.ok){markDirty();sendSnapshot();}
        return r;
      }
      case 'unequip-backpack': {
        if(!nearDepot(authority.temple))return {ok:false,message:'Chegue perto do Depot para guardar a Backpack equipada.'};
        const r=authoritativeUnequipBackpackToContainer(authority,payload.targetContainerId);
        if(r.ok){markDirty();sendSnapshot();}
        return r;
      }
      case 'toggle-item-lock': {
        const r=toggleItemLock(authority,payload.containerId,payload.index,payload.itemId,payload.instanceId||null);
        if(r.ok){markDirty();sendSnapshot();}
        return r;
      }
      case 'buy': return buy(payload.itemId,payload.quantity);
      case 'sell': return sell(payload.itemId,payload.quantity,payload.instanceId||null);
      case 'sell-all': return sellAll(payload.belowRarity||authority.settings?.npcSellBelowRarity||'legendary');
      case 'transform': return transform();
      case 'reborn': return performReborn(payload?.path||null);
      default:return false;
    }
  }
  sendSnapshot();
  return {state:authority,sendSnapshot,replaceState,commitExternalState,publicCharacterProfile,tradeInventorySnapshot,tradePrepare,tradeReceive,flush,flushWithRetry,setPosition,applyLayout,updatePreferences,handleAction,syncPartyReborn,stopPartyContent,startProgressionQuestRuntime,moveProgressionQuestRuntime,syncProgressionQuestState,syncProgressionQuestPosition,syncProgressionGuardCleared,finishProgressionQuestRuntime,abandonProgressionQuestRuntime,expireProgressionQuestRuntime,syncUnlockedVocation,syncAccountPremiumPoints,syncPvpSnapshot,restorePzResources,syncPartyBossState,partyBossSnapshot,bossTicketQuantity,consumeBossTicket,removeWorldItem,addWorldItem,adminGrantItem,adminGrantLevel,adminGrantSkill,adminGrantZeni,syncMailboxEntry,canTeleportRebornStage,attachConnection,detachConnection,beginProtectionFarming,resumeProtectionFarming,finishProtectionFarming,protectionFarmingStatus,isRebornReady:()=>Boolean(rebornState().readyForReborn&&!rebornState().completed),destroy:async()=>{clearInterval(interval);clearInterval(huntFrameInterval);clearInterval(autoSpellInterval);clearInterval(offlineRechargeInterval);hunt.destroy();training.destroy();while(saveBusy)await new Promise(resolve=>setTimeout(resolve,25));await flushWithRetry(5);destroyed=true;}};
}
