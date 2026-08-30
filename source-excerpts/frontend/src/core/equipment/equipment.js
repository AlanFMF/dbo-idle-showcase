import {
  addItemToInventory,
  findEntryByLocation,
  findItemEntry,
  freeSlots,
  removeEntryAt,
  removeItemFromInventory,
  restoreEntryAt,
  normalizeContainerLayout
} from '../inventory/containers.js';
import { scaledItemStats } from '../items/item-rarity.js';


const starterLevelOneIds = new Set([
  'starter_helmet','starter_armor','starter_legs','starter_boots',
  'starter_gloves','starter_sword','starter_blaster','starter_backpack'
]);
const starterLevelOneServerIds = new Set([
  13391,12640,12667,12697,12699,12716,12747,12764
]);

function itemServerId(item) {
  if (!item) return 0;
  const explicit = Number(item.serverId || 0);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const match = /^server_(\d+)$/.exec(String(item.id || ''));
  return match ? Number(match[1]) : 0;
}

export function isStarterLevelOneItem(item) {
  if (!item) return false;
  return starterLevelOneIds.has(String(item.id || '')) ||
    starterLevelOneServerIds.has(itemServerId(item));
}

export function equipmentRequiredLevel(item) {
  if (!item) return 0;
  // O kit inicial sempre e level 1, inclusive quando um save antigo carrega
  // requiredLevel 11 ou quando a copia do item perdeu o campo serverId e
  // chegou apenas como id "server_XXXXX".
  if (isStarterLevelOneItem(item)) return 1;
  return Number(item.requiredLevel || item.requirements?.level || 0);
}

export const equipmentSlots = [
  'helmet','necklace','backpack','armor','weapon',
  'offhand','legs','boots','ring','ammo'
];

export const slotNames = {
  helmet:'Cabeça',
  necklace:'Colar',
  backpack:'Mochila',
  armor:'Armadura',
  weapon:'Mão esquerda',
  offhand:'Mão direita',
  legs:'Calças',
  boots:'Botas',
  ring:'Anel',
  ammo:'Munição'
};


export function isShieldItem(item) {
  return Boolean(
    item &&
    item.type === 'weapon' &&
    String(item.sourceAttributes?.weaponType || item.weapon?.type || '').toLowerCase() === 'shield'
  );
}

export function normalizeShieldHandState(state, catalog) {
  if (!state || !catalog) return false;
  state.equipment ||= {};
  state.equipmentMeta ||= {};
  const mainId = state.equipment.weapon;
  const main = catalog[mainId];
  if (!mainId || !isShieldItem(main)) return false;

  const mainMeta = state.equipmentMeta.weapon || null;
  const offId = state.equipment.offhand;
  if (!offId) {
    state.equipment.weapon = null;
    state.equipment.offhand = mainId;
    delete state.equipmentMeta.weapon;
    if (mainMeta) state.equipmentMeta.offhand = mainMeta;
    else delete state.equipmentMeta.offhand;
    return true;
  }

  // Saves antigos podem ter uma Training Band na direita e o escudo na
  // esquerda. Como a Band também é válida na mão esquerda, fazemos um swap
  // sem perder instância/raridade de nenhum dos dois itens.
  const offItem = catalog[offId];
  if (allowedSlotsForItem(offItem).includes('weapon')) {
    const offMeta = state.equipmentMeta.offhand || null;
    state.equipment.weapon = offId;
    state.equipment.offhand = mainId;
    if (offMeta) state.equipmentMeta.weapon = offMeta;
    else delete state.equipmentMeta.weapon;
    if (mainMeta) state.equipmentMeta.offhand = mainMeta;
    else delete state.equipmentMeta.offhand;
    return true;
  }
  return false;
}

export function allowedSlotsForItem(item) {
  if (!item) return [];

  if (item.type === 'helmet') return ['helmet'];
  if (item.type === 'necklace') return ['necklace'];
  if (item.type === 'backpack') return ['backpack'];
  if (item.type === 'armor') return ['armor'];
  if (item.type === 'legs') return ['legs'];
  if (item.type === 'boots') return ['boots'];
  if (item.type === 'ring') return ['ring'];
  if (item.type === 'ammo') return ['ammo'];

  if (item.type === 'weapon') {
    // Escudos ocupam a mão direita (offhand). Eles não substituem a arma
    // ofensiva da mão esquerda e continuam contribuindo normalmente com
    // Defense/Resistance pelo totalStats().
    if (isShieldItem(item)) return ['offhand'];
    if (item.trainingSkill === 'attackSpeed') {
      return ['weapon', 'offhand'];
    }
    return ['weapon'];
  }

  return [];
}

export function canEquipInSlot(item, slot, state, catalog) {
  const allowed = allowedSlotsForItem(item);
  if (!allowed.includes(slot)) {
    return {
      ok:false,
      message:'Você não pode equipar aqui.'
    };
  }


  const requiredLevel = equipmentRequiredLevel(item);
  if (
    requiredLevel > 0 &&
    Number(state.profile?.level || 1) < requiredLevel
  ) {
    return {
      ok:false,
      message:`Você precisa estar no level ${requiredLevel}.`
    };
  }

  const requiredMagicLevel = Number(
    item.requiredMagicLevel ||
    item.requirements?.magicLevel ||
    0
  );
  const currentKiLevel = Number(
    state.skills?.kiLevel?.level || 1
  );
  if (
    requiredMagicLevel > 0 &&
    currentKiLevel < requiredMagicLevel
  ) {
    return {
      ok:false,
      message:
        `Você precisa de Ki Level ${requiredMagicLevel}.`
    };
  }

  if (slot === 'offhand') {
    if (isShieldItem(item)) return {ok:true};
    if (item?.trainingSkill !== 'attackSpeed') {
      return {
        ok:false,
        message:'Você não pode equipar aqui.'
      };
    }
    const main = catalog[state.equipment?.weapon];
    if (main?.trainingSkill !== 'attackSpeed') {
      return {
        ok:false,
        message:'Equipe uma Training Band na mão esquerda primeiro.'
      };
    }
  }

  return {ok:true};
}

export function equippedItemId(state, slot) {
  if (slot === 'backpack') {
    return state.containers?.[state.equipment.backpack]?.itemId || null;
  }
  return state.equipment?.[slot] || null;
}

export function totalStats(state, catalog) {
  const total = {
    attack:0,
    defense:0,
    armor:0,
    extraDefense:0,
    hp:0,
    ki:0,
    hpRegenPerSecond:0,
    kiRegenPerSecond:0,
    speed:0,
    attackSpeed:0,
    crit:0,
    criticalDamage:0,
    dodge:0,
    range:0,
    physicalResistance:0,
    kiResistance:0,
    allResistance:0,
    skillBonuses:{}
  };

  const skillAliases = {
    strength:'gloves',
    gloves:'gloves',
    kiBlasting:'kiBlasting',
    defenseSkill:'defense',
    defense:'defense',
    barrier:'barrier',
    kiLevel:'kiLevel',
    attackSpeed:'attackSpeed',
    critical:'critical',
    agility:'agility'
  };

  // A ranged weapon (bow, crossbow, "Makankosappo Power", etc.) needs a
  // matching ammo item in the ammo slot to actually fire — without it,
  // the weapon contributes nothing, the same way an unloaded crossbow
  // shouldn't out-damage bare fists. Self-contained throwables (spears,
  // stones — no declared ammoType) still work on their own.
  const weaponItem = catalog[equippedItemId(state, 'weapon')];
  const weaponAmmoType = weaponItem?.sourceAttributes?.ammoType;
  const ammoItem = catalog[equippedItemId(state, 'ammo')];
  const weaponIsUnloadedRangedWeapon = Boolean(
    weaponAmmoType &&
    ammoItem?.sourceAttributes?.ammoType !== weaponAmmoType
  );

  for (const slot of equipmentSlots) {
    if (slot === 'weapon' && weaponIsUnloadedRangedWeapon) continue;

    const id = equippedItemId(state, slot);
    const item = catalog[id];
    const stats = item ? scaledItemStats(item, state.equipmentMeta?.[slot]?.rarity || 'common') : {};

    for (const [key, rawValue] of Object.entries(stats)) {
      if (key === 'skillBonuses') {
        for (const [rawSkillId, rawBonus] of Object.entries(rawValue || {})) {
          const skillId = skillAliases[rawSkillId] || rawSkillId;
          total.skillBonuses[skillId] =
            (total.skillBonuses[skillId] || 0) + Number(rawBonus || 0);
        }
        continue;
      }

      const value = Number(rawValue || 0);
      if (!Number.isFinite(value)) continue;

      if (key === 'critical') {
        total.crit += value;
      } else {
        total[key] = (total[key] || 0) + value;
      }
    }

    // Preserve compatibility with records that expose armor but not defense.
    if (stats.armor && !stats.defense) {
      total.defense += Number(stats.armor || 0);
    }
  }

  total.defense += Number(total.extraDefense || 0);
  return total;
}


function isAttackSpeedTrainingBand(item) {
  return Boolean(item?.trainingSkill === 'attackSpeed');
}

function hasSecondaryTrainingBand(state, catalog) {
  const main = catalog?.[state?.equipment?.weapon];
  const off = catalog?.[state?.equipment?.offhand];
  return Boolean(isAttackSpeedTrainingBand(main) && isAttackSpeedTrainingBand(off));
}

function equipmentSnapshot(state) {
  return {
    containers:structuredClone(state.containers || {}),
    equipment:structuredClone(state.equipment || {}),
    equipmentMeta:structuredClone(state.equipmentMeta || {})
  };
}

function restoreEquipmentSnapshot(state, snapshot) {
  state.containers = snapshot.containers;
  state.equipment = snapshot.equipment;
  state.equipmentMeta = snapshot.equipmentMeta;
}

function moveSecondaryTrainingBandToBackpack(state, catalog) {
  if (!hasSecondaryTrainingBand(state, catalog)) return {ok:true, moved:false};
  const offId = state.equipment.offhand;
  const offMeta = state.equipmentMeta?.offhand || null;
  const result = addItemToInventory(state, offId, 1, catalog, null, offMeta);
  if (!result.ok) {
    return {
      ok:false,
      moved:false,
      message:'Backpack cheia. Libere espaço para guardar a Two Tones Band da mão direita.'
    };
  }
  state.equipment.offhand = null;
  if (state.equipmentMeta) delete state.equipmentMeta.offhand;
  return {ok:true, moved:true};
}

export function dualTrainingGloves(state, catalog) {
  const main = catalog[equippedItemId(state, 'weapon')];
  const off = catalog[equippedItemId(state, 'offhand')];
  return Boolean(
    main?.trainingSkill === 'attackSpeed' &&
    off?.trainingSkill === 'attackSpeed'
  );
}

function resolveSlot(item, requestedSlot) {
  if (item.type === 'weapon') {
    if (isShieldItem(item)) return requestedSlot || 'offhand';
    return requestedSlot || 'weapon';
  }
  return requestedSlot || item.type;
}

function backpackMetaFromEntry(entry = null) {
  if (!entry) return null;
  const meta = {};
  for (const key of ['instanceId','rarity','rarityTier','rarityMultiplier','source','locked']) {
    if (entry[key] != null) meta[key] = entry[key];
  }
  return Object.keys(meta).length ? meta : null;
}

function backpackEntry(container, meta = null) {
  return {
    itemId:container.itemId,
    quantity:1,
    containerId:container.id,
    ...(meta || {})
  };
}

function findBackpackEntryAnywhere(state,targetContainerId){
  const targetId=String(targetContainerId||'');
  for(const container of Object.values(state.containers||{})){
    const index=(container.items||[]).findIndex(entry=>String(entry?.containerId||'')===targetId);
    if(index>=0)return {container,index,entry:container.items[index]};
  }
  return null;
}

// V21.20: o slot de mochila pode ficar vazio. A BP equipada vira um item
// normal dentro do container de destino (ex.: Depot), preservando toda a
// árvore de conteúdo e metadados cosméticos/raridade do item mochila.
export function unequipBackpackToContainer(state,targetContainerId){
  state.equipment ||= {};
  state.equipmentMeta ||= {};
  const rootId=String(state.equipment.backpack||'');
  const root=state.containers?.[rootId];
  const target=state.containers?.[String(targetContainerId||'')];
  if(!root)return {ok:false,message:'O slot de Backpack já está vazio.'};
  if(!target)return {ok:false,message:'Container de destino não encontrado.'};
  if(root.id===target.id || !canPlaceBackpackRootInside(state,root.id,target.id)){
    return {ok:false,message:'A Backpack equipada não pode ser colocada dentro dela mesma.'};
  }
  if(freeSlots(target)<=0)return {ok:false,message:'O container de destino está cheio.'};
  const meta=state.equipmentMeta.backpack||null;
  root.parentId=target.id;
  target.items.push(backpackEntry(root,meta));
  normalizeContainerLayout(target);
  state.equipment.backpack=null;
  delete state.equipmentMeta.backpack;
  return {ok:true,itemId:root.itemId,containerId:root.id,message:`${state.containers[root.id]?.itemId||'Backpack'} foi movida para o container. O slot de Mochila ficou vazio.`};
}

function canPlaceBackpackRootInside(state,rootId,targetId){
  if(String(rootId)===String(targetId))return false;
  let cursor=state.containers?.[String(targetId||'')];
  const seen=new Set();
  while(cursor && !seen.has(String(cursor.id))){
    if(String(cursor.id)===String(rootId))return false;
    seen.add(String(cursor.id));
    cursor=cursor.parentId?state.containers?.[cursor.parentId]:null;
  }
  return true;
}

/**
 * Promove uma backpack que já está dentro da árvore da mochila atual para o
 * slot equipado sem perder a mochila anterior nem o conteúdo de nenhuma das
 * duas. O caminho de containers é invertido (root -> ... -> nova BP vira
 * nova BP -> ... -> root), portanto a antiga mochila passa a ficar guardada
 * dentro da nova e pode ser reequipada depois.
 */
export function equipBackpackContainer(state, targetContainerId) {
  state.equipment ||= {};
  state.equipmentMeta ||= {};
  const currentRootId = String(state.equipment.backpack || '');
  const targetId = String(targetContainerId || '');
  const currentRoot = state.containers?.[currentRootId];
  const target = state.containers?.[targetId];
  if (!target) return {ok:false, message:'Backpack não encontrada.'};
  if (currentRootId === targetId) return {ok:true, message:'Esta backpack já está equipada.'};

  // Se o slot está vazio, a Backpack pode vir de qualquer container válido
  // (incluindo Depot). Remova somente o item-referência do pai; a árvore
  // interna permanece no próprio target.
  if(!currentRoot){
    const located=findBackpackEntryAnywhere(state,targetId);
    if(located){
      located.container.items.splice(located.index,1);
      normalizeContainerLayout(located.container);
    }
    target.parentId=null;
    state.equipment.backpack=target.id;
    const targetMeta=backpackMetaFromEntry(located?.entry||null);
    if(targetMeta)state.equipmentMeta.backpack=targetMeta;else delete state.equipmentMeta.backpack;
    return {ok:true,message:`${target.itemId||'Backpack'} equipada.`};
  }

  // A nova backpack precisa estar na árvore acessível da mochila equipada.
  // Monte o caminho target -> ... -> root usando parentId.
  const path = [];
  const seen = new Set();
  let cursor = target;
  while (cursor && !seen.has(String(cursor.id))) {
    path.push(cursor);
    if (String(cursor.id) === currentRootId) break;
    seen.add(String(cursor.id));
    cursor = state.containers?.[cursor.parentId];
  }
  if (!path.length || String(path.at(-1)?.id || '') !== currentRootId) {
    return {ok:false, message:'A backpack precisa estar dentro da mochila equipada.'};
  }

  // O novo root precisa de um slot para armazenar a antiga árvore. Os demais
  // containers do caminho liberam exatamente um slot ao remover o filho que
  // será promovido, então não precisam de espaço extra.
  if (freeSlots(target) <= 0) {
    return {ok:false, message:'A nova backpack precisa de 1 slot livre para guardar a mochila anterior.'};
  }

  const ownMeta = new Map();
  ownMeta.set(currentRootId, state.equipmentMeta.backpack || null);
  const edges = [];

  for (let i = 0; i < path.length - 1; i += 1) {
    const child = path[i];
    const parent = path[i + 1];
    const index = (parent.items || []).findIndex(entry =>
      String(entry?.containerId || '') === String(child.id)
    );
    if (index < 0) {
      return {ok:false, message:'Não foi possível localizar a backpack dentro do container pai.'};
    }
    const entry = parent.items[index];
    ownMeta.set(String(child.id), backpackMetaFromEntry(entry));
    edges.push({child,parent,index});
  }

  // Remova os vínculos antigos. Cada edge vive em um parent diferente, então
  // os índices não interferem entre si.
  for (const edge of edges) {
    edge.parent.items.splice(edge.index, 1);
  }

  // Inverta os vínculos: target vira root; o antigo parent passa a ser item
  // dentro do child. Preserve raridade/instância do item mochila quando havia.
  target.parentId = null;
  for (let i = 0; i < path.length - 1; i += 1) {
    const child = path[i];
    const parent = path[i + 1];
    parent.parentId = child.id;
    child.items.push(backpackEntry(parent, ownMeta.get(String(parent.id))));
    normalizeContainerLayout(child);
  }

  state.equipment.backpack = target.id;
  const targetMeta = ownMeta.get(targetId);
  if (targetMeta) state.equipmentMeta.backpack = targetMeta;
  else delete state.equipmentMeta.backpack;
  for (const container of path) normalizeContainerLayout(container);

  return {ok:true, message:`${target.itemId || 'Backpack'} equipada.`};
}

export function equip(state, item, catalog, requestedSlot = null, instanceId = null) {
  if (!item) {
    return {ok:false, message:'Este item não pode ser equipado.'};
  }

  if (item.type === 'backpack') {
    let found = findItemEntry(state, item.id, instanceId);
    if (!found?.entry?.containerId) {
      for(const container of Object.values(state.containers||{})){
        const index=(container.items||[]).findIndex(entry=>entry?.itemId===item.id&&entry?.containerId&&
          (instanceId==null||String(entry.instanceId||'')===String(instanceId)));
        if(index>=0){found={container,index,entry:container.items[index]};break;}
      }
    }
    if (!found?.entry?.containerId) return {ok:false, message:'Backpack não encontrada.'};
    const result = equipBackpackContainer(state, found.entry.containerId);
    if (result.ok) result.message = `${item.name} equipada.`;
    return result;
  }

  const slot = resolveSlot(item, requestedSlot);
  const validation = canEquipInSlot(item, slot, state, catalog);
  if (!validation.ok) return validation;

  const found = findItemEntry(state, item.id, instanceId);
  if (!found) return {ok:false, message:'Item não encontrado na backpack.'};
  state.equipmentMeta ||= {};

  const currentId = state.equipment[slot];
  if (currentId) {
    const returned = addItemToInventory(state, currentId, 1, catalog, null, state.equipmentMeta?.[slot] || null);
    if (!returned.ok) {
      return {
        ok:false,
        message:'Backpack cheia. Libere um slot antes de trocar o equipamento.'
      };
    }
  }

  const removed = removeEntryAt(state, found.container.id, found.index, 1);
  if (!removed) return {ok:false, message:'Não foi possível remover o item da backpack.'};

  state.equipment[slot] = item.id;
  state.equipmentMeta[slot] = removed.instanceId ? {instanceId:removed.instanceId,rarity:removed.rarity||'common',rarityTier:Number(removed.rarityTier||0),rarityMultiplier:Number(removed.rarityMultiplier||1),source:removed.source||'unknown'} : null;
  return {
    ok:true,
    slot,
    message:`${item.name} equipado em ${slotNames[slot]}.`
  };
}

export function unequipToContainer(
  state,
  slot,
  catalog,
  targetContainerId
) {
  if (!equipmentSlots.includes(slot) || slot === 'backpack') {
    return {ok:false, message:'Esse slot não pode ser desequipado.'};
  }

  const itemId = state.equipment[slot];
  state.equipmentMeta ||= {};
  const equippedMeta = state.equipmentMeta?.[slot] || null;
  const target = state.containers?.[targetContainerId];
  const item = catalog[itemId];
  if (!itemId || !target || !item) {
    return {ok:false, message:'Não foi possível localizar o item ou o container.'};
  }

  // V21.22 — a mão direita só pode manter a segunda Two Tones Band enquanto
  // existe uma Band na mão principal. Ao retirar a principal, a secundária é
  // automaticamente enviada para a Backpack. A operação é atômica: se não
  // houver espaço para guardar a secundária, nada é removido.
  const autoRemoveSecondary = slot === 'weapon' && isAttackSpeedTrainingBand(item) && hasSecondaryTrainingBand(state, catalog);
  const snapshot = autoRemoveSecondary ? equipmentSnapshot(state) : null;
  if (autoRemoveSecondary) {
    const secondary = moveSecondaryTrainingBandToBackpack(state, catalog);
    if (!secondary.ok) return secondary;
  }

  const stackable = item.stackable === true && item.type !== 'backpack';
  if (stackable) {
    const existing = target.items.find(entry =>
      entry.itemId === itemId && !entry.containerId
    );
    if (existing) {
      existing.quantity = Number(existing.quantity || 0) + 1;
      state.equipment[slot] = null;
      delete state.equipmentMeta[slot];
      return {ok:true, itemId, message:`${item.name} foi movido para o container.${autoRemoveSecondary ? ' A Two Tones Band da mão direita foi para a Backpack.' : ''}`};
    }
  }

  if (freeSlots(target) <= 0) {
    if (snapshot) restoreEquipmentSnapshot(state, snapshot);
    return {ok:false, message:'O container de destino está cheio.'};
  }

  target.items.push({itemId, quantity:1, ...(equippedMeta || {})});
  state.equipment[slot] = null;
  delete state.equipmentMeta[slot];
  return {ok:true, itemId, message:`${item.name} foi movido para o container.${autoRemoveSecondary ? ' A Two Tones Band da mão direita foi para a Backpack.' : ''}`};
}

export function unequipToBackpack(state, slot, catalog) {
  if (!equipmentSlots.includes(slot) || slot === 'backpack') {
    return {ok:false, message:'Esse slot não pode ser desequipado.'};
  }

  const itemId = state.equipment[slot];
  state.equipmentMeta ||= {};
  if (!itemId) return {ok:false, message:'O slot está vazio.'};
  const item = catalog[itemId];
  const autoRemoveSecondary = slot === 'weapon' && isAttackSpeedTrainingBand(item) && hasSecondaryTrainingBand(state, catalog);
  const snapshot = autoRemoveSecondary ? equipmentSnapshot(state) : null;

  // Primeiro guardamos a secundária. Caso qualquer uma das duas não caiba,
  // restauramos containers/equipamentos exatamente ao estado anterior.
  if (autoRemoveSecondary) {
    const secondary = moveSecondaryTrainingBandToBackpack(state, catalog);
    if (!secondary.ok) return secondary;
  }

  const result = addItemToInventory(state, itemId, 1, catalog, null, state.equipmentMeta?.[slot] || null);
  if (!result.ok) {
    if (snapshot) restoreEquipmentSnapshot(state, snapshot);
    return {
      ok:false,
      message:'Backpack cheia. O equipamento permaneceu no corpo.'
    };
  }

  state.equipment[slot] = null;
  delete state.equipmentMeta[slot];
  return {
    ok:true,
    itemId,
    message:`${catalog[itemId]?.name || 'Item'} foi para a backpack.${autoRemoveSecondary ? ' A Two Tones Band da mão direita também foi removida.' : ''}`
  };
}

export function unequip(state, slot) {
  if (!equipmentSlots.includes(slot) || slot === 'backpack') return false;
  state.equipment[slot] = null;
  if(state.equipmentMeta) delete state.equipmentMeta[slot];
  return true;
}


export function equipFromContainer(
  state,
  containerId,
  index,
  catalog,
  requestedSlot = null
) {
  const found = findEntryByLocation(state, containerId, index);
  if (!found) return {ok:false, message:'Item não encontrado.'};
  const item = catalog[found.entry.itemId];
  if (!item || item.type === 'consumable' || item.type === 'misc') {
    return {ok:false, message:'Esse item não pode ser equipado.'};
  }

  if (item.type === 'backpack') {
    if (!found.entry.containerId) {
      return {ok:false, message:'Container inválido.'};
    }
    const result = equipBackpackContainer(state, found.entry.containerId);
    if (result.ok) result.message = `${item.name} equipada.`;
    return result;
  }

  const slot = resolveSlot(item, requestedSlot);

  const validation = canEquipInSlot(item, slot, state, catalog);
  if (!validation.ok) return validation;

  const removed = removeEntryAt(state, containerId, index, 1);
  if (!removed) return {ok:false, message:'Não foi possível mover o item.'};
  state.equipmentMeta ||= {};

  const oldItemId = state.equipment[slot];
  if (oldItemId) {
    const returned = addItemToInventory(state, oldItemId, 1, catalog, null, state.equipmentMeta?.[slot] || null);
    if (!returned.ok) {
      restoreEntryAt(state, containerId, index, removed);
      return {
        ok:false,
        message:'Backpack cheia. Não foi possível trocar o equipamento.'
      };
    }
  }

  state.equipment[slot] = item.id;
  state.equipmentMeta[slot] = removed.instanceId ? {instanceId:removed.instanceId,rarity:removed.rarity||'common',rarityTier:Number(removed.rarityTier||0),rarityMultiplier:Number(removed.rarityMultiplier||1),source:removed.source||'unknown'} : null;
  return {
    ok:true,
    slot,
    message:`${item.name} equipado em ${slotNames[slot]}.`
  };
}
