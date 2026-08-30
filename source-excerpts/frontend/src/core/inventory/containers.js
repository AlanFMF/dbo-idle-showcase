function createId(prefix) {
  return crypto.randomUUID?.() ||
    `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createContainer(itemId, capacity = 20, parentId = null) {
  return {
    id:createId('container'),
    itemId,
    capacity,
    parentId,
    items:[],
    // V21.13: UI layout is independent from the dense storage array.  This
    // lets players keep deliberate gaps and organize a bag/depot exactly the
    // way they want without changing all inventory algorithms to sparse
    // arrays (JSON would otherwise turn holes into null entries).
    layoutLocked:false,
    lootFilter:{categories:[]}
  };
}

export const CONTAINER_LOOT_FILTER_CATEGORIES = Object.freeze([
  'potions','senzus','equipment','collectibles'
]);

export function normalizeContainerLayout(container) {
  if (!container || !Array.isArray(container.items)) return container;
  container.layoutLocked = Boolean(container.layoutLocked);
  const rawCategories = Array.isArray(container.lootFilter?.categories)
    ? container.lootFilter.categories
    : [];
  container.lootFilter = {
    categories:[...new Set(rawCategories
      .map(value => String(value || '').toLowerCase())
      .filter(value => CONTAINER_LOOT_FILTER_CATEGORIES.includes(value)))]
  };

  const occupied = new Set();
  const capacity = Math.max(0,Number(container.capacity || 0));
  for (const entry of container.items) {
    let slot = Math.trunc(Number(entry?.uiSlot));
    if (!Number.isFinite(slot) || slot < 0 || slot >= capacity || occupied.has(slot)) {
      slot = -1;
      for (let candidate = 0; candidate < capacity; candidate++) {
        if (!occupied.has(candidate)) { slot = candidate; break; }
      }
    }
    if (slot >= 0) {
      entry.uiSlot = slot;
      occupied.add(slot);
    } else {
      delete entry.uiSlot;
    }
  }
  return container;
}

export function containerSlots(container) {
  normalizeContainerLayout(container);
  const slots = Array.from({length:Math.max(0,Number(container?.capacity || 0))},()=>null);
  (container?.items || []).forEach((entry,index) => {
    const slot = Math.trunc(Number(entry?.uiSlot));
    if (slot >= 0 && slot < slots.length) slots[slot] = {entry,index};
  });
  return slots;
}

function firstFreeUiSlot(container) {
  const slots = containerSlots(container);
  return slots.findIndex(value => !value);
}

export function itemLootCategory(item = {}) {
  const name = String(item?.name || '').toLowerCase();
  if (item?.consumableKind === 'senzu' || name.includes('senzu')) return 'senzus';
  if (item?.consumableKind === 'hp' || item?.consumableKind === 'ki' || name.includes('potion')) return 'potions';
  if (['helmet','necklace','armor','weapon','legs','boots','ring','ammo','shield'].includes(String(item?.type || ''))) return 'equipment';
  if (
    String(item?.id || '').startsWith('dragon_ball_') ||
    /ticket|doll|esfera|dragon ball|collect/i.test(`${item?.id || ''} ${item?.name || ''} ${item?.type || ''}`)
  ) return 'collectibles';
  return null;
}

export function containerAcceptsAutoLoot(container,item={}) {
  normalizeContainerLayout(container);
  const categories = container?.lootFilter?.categories || [];
  if (!categories.length) return true;
  const category = itemLootCategory(item);
  return Boolean(category && categories.includes(category));
}

export function normalizeInventoryState(state) {
  state.containers ||= {};
  state.equipment ||= {};
  state.equipmentMeta ||= {};
  state.groundLoot ||= [];

  // V21.20: o slot de backpack pode ficar explicitamente vazio.  Saves
  // antigos que nunca tiveram a chave ainda recebem a mochila inicial, mas
  // depois que o jogador joga/move a BP equipada para o chão/Depot não
  // recriamos uma Backpack artificial no próximo normalize().
  const hasBackpackKey = Object.prototype.hasOwnProperty.call(state.equipment,'backpack');
  const backpackExplicitlyEmpty = hasBackpackKey && state.equipment.backpack == null;
  const backpackMissing = state.equipment.backpack && !state.containers[state.equipment.backpack];
  if ((!hasBackpackKey || backpackMissing) && !backpackExplicitlyEmpty) {
    const main = createContainer('starter_backpack', 20);
    state.containers[main.id] = main;
    state.equipment.backpack = main.id;

    for (const legacy of state.inventory || []) {
      main.items.push({
        itemId:legacy.itemId,
        quantity:Number(legacy.quantity) || 1
      });
    }
  }

  // Characters saved before the depot existed won't have one yet — give
  // them a fresh 400-slot depot rather than losing the feature entirely.
  if (!state.depotContainerId || !state.containers[state.depotContainerId]) {
    const depot = createContainer('depot', 400);
    state.containers[depot.id] = depot;
    state.depotContainerId = depot.id;
  }

  // V20.67: tres abas de Depot VIP, 400 slots cada. Existem no estado para persistencia,
  // mas o acesso e liberado somente quando a conta possui VIP ativo.
  state.vipDepotContainerIds = Array.isArray(state.vipDepotContainerIds) ? state.vipDepotContainerIds.filter(id=>state.containers[id]) : [];
  while (state.vipDepotContainerIds.length < 3) { const n=state.vipDepotContainerIds.length+1; const vip=createContainer(`vip_depot_${n}`,400); state.containers[vip.id]=vip; state.vipDepotContainerIds.push(vip.id); }
  state.vipDepotContainerIds=state.vipDepotContainerIds.slice(0,3);

  for (const container of Object.values(state.containers || {})) {
    normalizeContainerLayout(container);
  }

  state.inventory = [];
  return state;
}

export function equippedBackpack(state) {
  return state.containers?.[state.equipment?.backpack] || null;
}

export function allContainers(state) {
  return Object.values(state.containers || {});
}

export function inventoryContainers(state) {
  const root = equippedBackpack(state);
  if (!root) return [];

  const result = [];
  const visited = new Set();
  const visit = container => {
    if (!container || visited.has(container.id)) return;
    visited.add(container.id);
    result.push(container);
    for (const entry of container.items || []) {
      if (!entry.containerId) continue;
      visit(state.containers?.[entry.containerId]);
    }
  };
  visit(root);
  return result;
}

export function usedSlots(container) {
  return container?.items?.length || 0;
}

export function freeSlots(container) {
  return Math.max(
    0,
    Number(container?.capacity || 0) - usedSlots(container)
  );
}

export function totalAvailableSlots(state) {
  return inventoryContainers(state).reduce(
    (sum, container) => sum + freeSlots(container),
    0
  );
}

export function findItemEntry(state, itemId, instanceId = null) {
  for (const container of inventoryContainers(state)) {
    const index = container.items.findIndex(item =>
      item.itemId === itemId &&
      (instanceId == null || String(item.instanceId || '') === String(instanceId))
    );
    if (index >= 0) {
      return {container, entry:container.items[index], index};
    }
  }
  return null;
}

export function findEntryByLocation(state, containerId, index) {
  const container = state.containers?.[containerId];
  const entry = container?.items?.[Number(index)];
  return container && entry
    ? {container, entry, index:Number(index)}
    : null;
}

export function itemQuantity(state, itemId) {
  return inventoryContainers(state).reduce(
    (total, container) => total + container.items
      .filter(item => item.itemId === itemId)
      .reduce((sum, item) => sum + Number(item.quantity || 0), 0),
    0
  );
}

export function canAcceptItem(state, itemId, quantity = 1, catalog = {}) {
  normalizeInventoryState(state);
  const item = catalog[itemId];
  const stackable = item?.stackable === true && item?.type !== 'backpack';

  // V21.24.6: uma Backpack/Cápsula é justamente o item que deve recuperar
  // um personagem que ficou sem mochila principal. Sem esta exceção,
  // inventoryContainers() fica vazio, totalAvailableSlots() retorna 0 e o
  // cliente bloqueia a compra/coleta antes mesmo de consultar o servidor.
  if (item?.type === 'backpack' && !equippedBackpack(state)) return true;

  if (stackable) {
    const existing = inventoryContainers(state).some(container =>
      container.items.some(entry =>
        entry.itemId === itemId && !entry.containerId
      )
    );
    if (existing) return true;
  }

  return totalAvailableSlots(state) > 0;
}

export function addItemToInventory(
  state,
  itemId,
  quantity = 1,
  catalog = {},
  preferredContainerId = null,
  entryMeta = null,
  options = {}
) {
  normalizeInventoryState(state);
  const item = catalog[itemId];
  const stackable = item?.stackable === true && item?.type !== 'backpack';

  // V21.24.6: se o slot principal está vazio, a primeira Backpack/Cápsula
  // adquirida passa a ser a própria mochila equipada. Ela não precisa de um
  // slot dentro de outra backpack — exigir isso criava o estado impossível
  // em que o jogador estava sem BP e não conseguia comprar/criar uma nova.
  if (item?.type === 'backpack' && !equippedBackpack(state)) {
    const main = createContainer(
      itemId,
      Math.max(1, Number(item.containerCapacity || 20)),
      null
    );
    state.containers[main.id] = main;
    state.equipment.backpack = main.id;
    if (state.equipmentMeta) delete state.equipmentMeta.backpack;
    return {
      ok:true,
      containerId:main.id,
      nestedContainerId:main.id,
      equipped:true,
      usedSlots:0
    };
  }

  // Filtered backpacks are routing rules, not hard inventory restrictions.
  // Matching filtered bags get first priority; filtered bags that do not
  // match are skipped for automatic loot. Manual drag/drop remains free.
  const accessible = inventoryContainers(state);
  const respectLootFilter = options?.respectLootFilter === true;
  const matchingFiltered = respectLootFilter ? accessible.filter(container =>
    (container.lootFilter?.categories || []).length &&
    containerAcceptsAutoLoot(container,item)
  ) : [];
  const unrestricted = respectLootFilter ? accessible.filter(container =>
    !(container.lootFilter?.categories || []).length
  ) : accessible;
  const preferred = state.containers[preferredContainerId];
  const ordered = (respectLootFilter ? [
    preferred && containerAcceptsAutoLoot(preferred,item) ? preferred : null,
    ...matchingFiltered,
    ...unrestricted,
    (equippedBackpack(state) && containerAcceptsAutoLoot(equippedBackpack(state),item)) ? equippedBackpack(state) : null
  ] : [preferred,...unrestricted,equippedBackpack(state)])
    .filter(Boolean)
    .filter((container, index, array) =>
      array.findIndex(entry => entry.id === container.id) === index
    );

  if (stackable) {
    for (const container of ordered) {
      const existing = container.items.find(entry =>
        entry.itemId === itemId && !entry.containerId
      );
      if (existing) {
        existing.quantity += quantity;
        return {
          ok:true,
          containerId:container.id,
          stacked:true,
          usedSlots:usedSlots(container)
        };
      }
    }
  }

  const target = ordered.find(container => freeSlots(container) > 0);
  if (!target) return {ok:false, reason:'full'};

  if (item?.type === 'backpack') {
    const nested = createContainer(
      itemId,
      Number(item.containerCapacity || 20),
      target.id
    );
    state.containers[nested.id] = nested;
    target.items.push({
      itemId,
      quantity:1,
      containerId:nested.id,
      uiSlot:firstFreeUiSlot(target)
    });
    return {
      ok:true,
      containerId:target.id,
      nestedContainerId:nested.id,
      usedSlots:usedSlots(target)
    };
  }

  const entry = {itemId, quantity, uiSlot:firstFreeUiSlot(target)};
  if (entryMeta && typeof entryMeta === 'object') {
    for (const key of ['instanceId','rarity','rarityTier','rarityMultiplier','source','locked']) {
      if (entryMeta[key] != null) entry[key] = entryMeta[key];
    }
  }
  target.items.push(entry);
  return {
    ok:true,
    containerId:target.id,
    usedSlots:usedSlots(target)
  };
}

export function removeItemFromInventory(state, itemId, quantity = 1) {
  const found = findItemEntry(state, itemId);
  if (!found) return false;
  found.entry.quantity -= quantity;
  if (found.entry.quantity <= 0) {
    found.container.items.splice(found.index, 1);
  }
  return true;
}

export function removeEntryAt(
  state,
  containerId,
  index,
  quantity = null
) {
  const found = findEntryByLocation(state, containerId, index);
  if (!found) return null;

  const removedQuantity = quantity == null
    ? Number(found.entry.quantity || 1)
    : Math.min(Number(quantity), Number(found.entry.quantity || 1));

  const removed = {
    ...found.entry,
    quantity:removedQuantity
  };

  found.entry.quantity -= removedQuantity;
  if (found.entry.quantity <= 0) {
    found.container.items.splice(found.index, 1);
  }
  return removed;
}

export function restoreEntryAt(
  state,
  containerId,
  index,
  entry
) {
  const container = state.containers?.[containerId];
  if (!container || !entry) return false;
  container.items.splice(
    Math.max(0, Math.min(Number(index), container.items.length)),
    0,
    entry
  );
  return true;
}

export function autoOrganizeContainer(state, containerId, catalog = {}) {
  const container = state?.containers?.[String(containerId || '')];
  if (!container) return {ok:false,reason:'missing-container'};
  normalizeContainerLayout(container);
  if (container.layoutLocked) return {ok:false,reason:'layout-locked'};

  // Primeiro compacte todas as pilhas do mesmo item.  Isso também corrige
  // stacks que foram separados manualmente e depois precisam ser reunidos.
  // Se qualquer uma das pilhas estava protegida para venda, mantemos a
  // proteção na pilha final (comportamento mais seguro para o jogador).
  const beforeCount=container.items.length;
  const merged=[];
  const stackByItem=new Map();
  for(const entry of container.items){
    const item=catalog[entry?.itemId]||{};
    const stackable=item?.stackable===true && item?.type!=='backpack' && !entry?.containerId;
    if(!stackable){merged.push(entry);continue;}
    const key=String(entry.itemId||'');
    const existing=stackByItem.get(key);
    if(existing){
      existing.quantity=Number(existing.quantity||0)+Math.max(1,Number(entry.quantity||1));
      existing.locked=Boolean(existing.locked||entry.locked);
      continue;
    }
    const clone={...entry,quantity:Math.max(1,Number(entry.quantity||1))};
    stackByItem.set(key,clone);merged.push(clone);
  }
  container.items=merged;

  const typeOrder = Object.freeze({
    backpack:0,consumable:1,helmet:2,necklace:3,armor:4,legs:5,boots:6,
    weapon:7,ring:8,ammo:9,currency:10,misc:11
  });
  container.items.sort((a,b) => {
    const ia=catalog[a?.itemId]||{}, ib=catalog[b?.itemId]||{};
    const ta=typeOrder[String(ia.type||'misc')] ?? 99;
    const tb=typeOrder[String(ib.type||'misc')] ?? 99;
    if (ta!==tb) return ta-tb;
    const ra=Number(a?.rarityTier ?? ia?.rarityTier ?? 0), rb=Number(b?.rarityTier ?? ib?.rarityTier ?? 0);
    if (ra!==rb) return rb-ra;
    return String(ia.name||a?.itemId||'').localeCompare(String(ib.name||b?.itemId||''),'pt-BR');
  });
  container.items.forEach((entry,index)=>{entry.uiSlot=index;});
  normalizeContainerLayout(container);
  return {ok:true,count:container.items.length,mergedStacks:Math.max(0,beforeCount-container.items.length)};
}

export function setContainerLayoutLocked(state,containerId,locked) {
  const container = state.containers?.[containerId];
  if (!container) return false;
  container.layoutLocked = Boolean(locked);
  return true;
}

export function setContainerLootFilter(state,containerId,categories=[]) {
  const container = state.containers?.[containerId];
  if (!container) return false;
  container.lootFilter = {
    categories:[...new Set((Array.isArray(categories)?categories:[])
      .map(value=>String(value||'').toLowerCase())
      .filter(value=>CONTAINER_LOOT_FILTER_CATEGORIES.includes(value)))]
  };
  return true;
}

export function moveEntryToSlot(
  state,
  sourceContainerId,
  sourceIndex,
  targetContainerId,
  targetSlot,
  catalog = {},
  quantity = null
) {
  normalizeInventoryState(state);
  const source = state.containers?.[sourceContainerId];
  const target = state.containers?.[targetContainerId];
  if (!source || !target) return {ok:false,reason:'missing-container'};
  normalizeContainerLayout(source); normalizeContainerLayout(target);
  if (source.layoutLocked || target.layoutLocked) return {ok:false,reason:'layout-locked'};
  const found = findEntryByLocation(state,sourceContainerId,sourceIndex);
  if (!found) return {ok:false,reason:'missing-entry'};
  targetSlot = Math.trunc(Number(targetSlot));
  if (!Number.isFinite(targetSlot) || targetSlot < 0 || targetSlot >= Number(target.capacity||0)) {
    return {ok:false,reason:'invalid-slot'};
  }

  const sourceEntry = found.entry;
  const sourceSlot = Math.trunc(Number(sourceEntry.uiSlot));
  const targetHit = containerSlots(target)[targetSlot];
  const item = catalog[sourceEntry.itemId];
  const stackable = item?.stackable === true && item?.type !== 'backpack';
  const available = Math.max(1,Number(sourceEntry.quantity||1));
  const requested = quantity == null ? available : Math.max(1,Math.min(available,Math.trunc(Number(quantity)||1)));
  const partial = stackable && requested < available;

  // Reagrupar pilhas dentro do mesmo container. Antes, arrastar uma pilha
  // inteira sobre outra do mesmo item apenas trocava os uiSlots.
  if (source.id === target.id && targetHit && targetHit.index !== found.index &&
      stackable && targetHit.entry.itemId === sourceEntry.itemId && !targetHit.entry.containerId) {
    targetHit.entry.quantity = Number(targetHit.entry.quantity||0) + requested;
    targetHit.entry.locked = Boolean(targetHit.entry.locked || sourceEntry.locked);
    if (requested >= available) source.items.splice(found.index,1);
    else sourceEntry.quantity = available-requested;
    return {ok:true,moved:{...sourceEntry,quantity:requested},stacked:true,partial:requested<available};
  }

  if (source.id === target.id) {
    if (partial) {
      if (targetHit && targetHit.index === found.index) return {ok:false,reason:'same-slot'};
      if (targetHit && targetHit.entry.itemId !== sourceEntry.itemId) return {ok:false,reason:'partial-swap'};
      sourceEntry.quantity = available-requested;
      if (targetHit) {
        targetHit.entry.quantity = Number(targetHit.entry.quantity||0)+requested;
        return {ok:true,moved:{...sourceEntry,quantity:requested},stacked:true,partial:true};
      }
      const moved={...sourceEntry,quantity:requested,uiSlot:targetSlot};
      target.items.push(moved);
      return {ok:true,moved,swapped:false,partial:true};
    }
    if (targetHit && targetHit.index !== found.index) targetHit.entry.uiSlot = sourceSlot;
    sourceEntry.uiSlot = targetSlot;
    return {ok:true,moved:sourceEntry,swapped:Boolean(targetHit)};
  }

  if (sourceEntry.containerId && !canPlaceContainerInside(state,sourceEntry.containerId,target.id)) {
    return {ok:false,reason:'container-cycle'};
  }

  if (partial) {
    if (targetHit && targetHit.entry.itemId !== sourceEntry.itemId) return {ok:false,reason:'partial-swap'};
    sourceEntry.quantity = available-requested;
    if (targetHit) {
      targetHit.entry.quantity = Number(targetHit.entry.quantity||0)+requested;
      return {ok:true,moved:{...sourceEntry,quantity:requested},stacked:true,partial:true};
    }
    const moved={...sourceEntry,quantity:requested,uiSlot:targetSlot};
    target.items.push(moved);
    return {ok:true,moved,swapped:false,partial:true};
  }

  if (targetHit && stackable && targetHit.entry.itemId === sourceEntry.itemId && !targetHit.entry.containerId) {
    targetHit.entry.quantity = Number(targetHit.entry.quantity||0)+available;
    source.items.splice(found.index,1);
    return {ok:true,moved:sourceEntry,stacked:true};
  }

  if (targetHit) {
    if (targetHit.entry.containerId && !canPlaceContainerInside(state,targetHit.entry.containerId,source.id)) {
      return {ok:false,reason:'container-cycle'};
    }
    const incoming = targetHit.entry;
    target.items.splice(targetHit.index,1);
    source.items.splice(found.index,1);
    incoming.uiSlot = sourceSlot;
    source.items.push(incoming);
    sourceEntry.uiSlot = targetSlot;
    target.items.push(sourceEntry);
    if (incoming.containerId && state.containers?.[incoming.containerId]) state.containers[incoming.containerId].parentId=source.id;
    if (sourceEntry.containerId && state.containers?.[sourceEntry.containerId]) state.containers[sourceEntry.containerId].parentId=target.id;
    return {ok:true,moved:sourceEntry,swapped:true};
  }

  source.items.splice(found.index,1);
  sourceEntry.uiSlot = targetSlot;
  target.items.push(sourceEntry);
  if (sourceEntry.containerId && state.containers?.[sourceEntry.containerId]) state.containers[sourceEntry.containerId].parentId=target.id;
  return {ok:true,moved:sourceEntry,swapped:false};
}

export function moveEntryBetweenContainers(
  state,
  sourceContainerId,
  sourceIndex,
  targetContainerId,
  catalog = {},
  quantity = null
) {
  normalizeInventoryState(state);
  const source = state.containers?.[sourceContainerId];
  const target = state.containers?.[targetContainerId];
  if (!source || !target) return {ok:false, reason:'missing-container'};
  if (source.id === target.id) return {ok:false, reason:'same-container'};
  if (source.layoutLocked || target.layoutLocked) return {ok:false,reason:'layout-locked'};

  const found = findEntryByLocation(state, source.id, sourceIndex);
  if (!found) return {ok:false, reason:'missing-entry'};
  const entry = found.entry;
  const item = catalog[entry.itemId];

  if (entry.containerId) {
    if (!canPlaceContainerInside(state, entry.containerId, target.id)) return {ok:false, reason:'container-cycle'};
    if (freeSlots(target) <= 0) return {ok:false, reason:'full'};
    source.items.splice(found.index, 1);
    entry.uiSlot=firstFreeUiSlot(target);
    target.items.push(entry);
    const child = state.containers?.[entry.containerId];
    if (child) child.parentId = target.id;
    return {ok:true, moved:entry, stacked:false};
  }

  const stackable = item?.stackable === true && item?.type !== 'backpack';
  const available=Math.max(1,Number(entry.quantity||1));
  const requested=quantity==null?available:Math.max(1,Math.min(available,Math.trunc(Number(quantity)||1)));
  const existing = stackable ? target.items.find(targetEntry =>
    targetEntry.itemId === entry.itemId && !targetEntry.containerId
  ) : null;

  if (stackable && existing) {
    existing.quantity = Number(existing.quantity || 0) + requested;
    if(requested>=available) source.items.splice(found.index, 1);
    else entry.quantity=available-requested;
    return {ok:true, moved:{...entry,quantity:requested}, stacked:true, partial:requested<available};
  }

  if (freeSlots(target) <= 0) return {ok:false, reason:'full'};
  if(stackable && requested<available){
    entry.quantity=available-requested;
    const moved={...entry,quantity:requested,uiSlot:firstFreeUiSlot(target)};
    target.items.push(moved);
    return {ok:true,moved,stacked:false,partial:true};
  }

  source.items.splice(found.index, 1);
  entry.uiSlot=firstFreeUiSlot(target);
  target.items.push(entry);
  return {ok:true, moved:entry, stacked:false};
}

export function openContainer(state, containerId) {
  return state.containers?.[containerId] || null;
}

export function containerPath(state, containerId) {
  const path = [];
  let current = state.containers?.[containerId];
  while (current) {
    path.unshift(current);
    current = current.parentId
      ? state.containers?.[current.parentId]
      : null;
  }
  return path;
}

export function canPlaceContainerInside(state, childId, parentId) {
  if (childId === parentId) return false;
  let current = state.containers?.[parentId];
  while (current) {
    if (current.id === childId) return false;
    current = current.parentId
      ? state.containers?.[current.parentId]
      : null;
  }
  return true;
}

export function moveContainerInside(state, childId, parentId) {
  const child = state.containers?.[childId];
  const parent = state.containers?.[parentId];
  if (!child || !parent || freeSlots(parent) <= 0) return false;
  if (!canPlaceContainerInside(state, childId, parentId)) return false;

  const oldParent = child.parentId
    ? state.containers?.[child.parentId]
    : null;
  if (oldParent) {
    oldParent.items = oldParent.items.filter(entry =>
      entry.containerId !== childId
    );
  }

  child.parentId = parentId;
  parent.items.push({
    itemId:child.itemId,
    quantity:1,
    containerId:childId
  });
  return true;
}

// V21.14 — backpacks podem existir no chão sem perder a árvore interna.
// O payload retornado é puro JSON e pode viajar pelo websocket/ser persistido
// em ground loot. IDs são remapeados ao restaurar para evitar colisões quando
// outro jogador recolhe a mochila.
export function extractContainerTree(state,rootContainerId){
  normalizeInventoryState(state);
  const rootId=String(rootContainerId||'');
  if(!rootId||!state.containers?.[rootId])return null;
  const ids=[];const visit=id=>{const c=state.containers?.[id];if(!c||ids.includes(id))return;ids.push(id);for(const e of c.items||[])if(e?.containerId)visit(String(e.containerId));};
  visit(rootId);
  const containers={};for(const id of ids)containers[id]=structuredClone(state.containers[id]);
  for(const id of ids)delete state.containers[id];
  return {rootId,containers};
}

export function restoreContainerTree(state,tree,catalog={},preferredContainerId=null){
  normalizeInventoryState(state);
  if(!tree?.rootId||!tree?.containers?.[tree.rootId])return {ok:false,reason:'invalid-tree'};
  const rootSource=tree.containers[tree.rootId];
  const restoreAsEquippedRoot = !state.equipment?.backpack && catalog[rootSource.itemId]?.type==='backpack';
  const target=restoreAsEquippedRoot?null:(state.containers?.[preferredContainerId] || inventoryContainers(state).find(c=>freeSlots(c)>0));
  if(!restoreAsEquippedRoot && (!target||freeSlots(target)<=0))return {ok:false,reason:'full'};
  const oldIds=Object.keys(tree.containers);const idMap=new Map();
  for(const oldId of oldIds)idMap.set(oldId,createId('container'));
  const clones={};
  for(const oldId of oldIds){
    const source=structuredClone(tree.containers[oldId]);const newId=idMap.get(oldId);source.id=newId;
    source.parentId=oldId===String(tree.rootId)?(restoreAsEquippedRoot?null:target.id):(source.parentId?idMap.get(String(source.parentId))||null:null);
    source.items=(source.items||[]).map(entry=>({...entry,...(entry.containerId?{containerId:idMap.get(String(entry.containerId))||entry.containerId}:{})}));
    normalizeContainerLayout(source);clones[newId]=source;
  }
  Object.assign(state.containers,clones);
  const newRootId=idMap.get(String(tree.rootId));
  if(restoreAsEquippedRoot){
    state.equipment.backpack=newRootId;
    return {ok:true,containerId:newRootId,nestedContainerId:newRootId,equipped:true};
  }
  target.items.push({itemId:rootSource.itemId,quantity:1,containerId:newRootId,uiSlot:firstFreeUiSlot(target)});
  return {ok:true,containerId:target.id,nestedContainerId:newRootId};
}
