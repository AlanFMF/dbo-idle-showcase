import { characters, zones, itemCatalog } from '../../data/game-content.js';
import {
  dualTrainingGloves,
  totalStats,
  equipmentSlots,
  equipmentRequiredLevel
} from '../equipment/equipment.js';
import {
  addItemToInventory,
  itemQuantity,
  removeItemFromInventory
} from '../inventory/containers.js';
import { createItemInstanceMeta, isRarityEligibleItem, rarityName, rollItemRarity, rarityDefinition } from '../items/item-rarity.js';
import {
  applyDeathPenalty,
  characterXpRequired,
  derivedCombatStats,
  equippedCombatStyle,
  experienceRate,
  characterExperienceMultiplier,
  gainSkill,
  vocationAptitude
} from '../skills/skills.js?v=22.4.4';
import {
  maxResources
} from '../balance/absolute-balance-engine.js?v=22.4.4';
import {
  applySpellBuffs,
  spellHitPlan,
  targetLimit
} from '../spells/authoritative-spell-runtime.js?v=22.4.4';
import {
  chooseMonsterAttack,
  intelligentEnemyStep
} from '../ai/monster-ai.js';
import { recordBestiaryKill } from '../bestiary/bestiary.js';


const RESPAWN_MS = 10_000;
const FULL_CLEAR_RESPAWN_MS = 3_000;
const CORPSE_LIFETIME_MS = 60_000;
// The largest source magic effect in the uploaded DBO.dat has 50 frames.
// Effects animate at ~100 ms/frame, so retain registry-backed spell effects
// long enough for the full source animation instead of cutting them at 900 ms.
const SOURCE_MAGIC_EFFECT_WINDOW_MS = 5_200;

export const DRAGON_BALL_ITEM_IDS = Object.freeze(
  Array.from({length:7}, (_, index) => `dragon_ball_${index + 1}`)
);

export function dragonBallDropChance(currentZone) {
  if (!currentZone) return 0;
  // Bosses de Guild podem definir a chance fixa individual por esfera.
  // Daishinkan usa 5%; Champa usa 1%. Esses valores nao recebem bonus de loot.
  if (currentZone.guildBoss === true) {
    const explicit=Number(currentZone.guildDragonBallChance);
    return Number.isFinite(explicit) ? Math.max(0,Math.min(1,explicit)) : 0.05;
  }
  // Bosses always use the boss rate even when the boss area is also VIP.
  if (currentZone.contentType === 'boss' || currentZone.questType === 'reborn') {
    return 0.001; // 0.1% per sphere
  }
  if (currentZone.vipOnly) return 0.00001; // 0.001% per sphere
  return 0;
}

export function rollDragonBallDrops(currentZone, random = Math.random, additiveChance = 0) {
  const chance = Math.max(0,Math.min(1,dragonBallDropChance(currentZone)+Math.max(0,Number(additiveChance)||0)));
  if (chance <= 0) return [];
  return DRAGON_BALL_ITEM_IDS.filter(() => random() < chance);
}

function levelAdvantage(playerLevel, zoneLevel) {
  const player = Math.max(1, Number(playerLevel || 1));
  const zone = Math.max(1, Number(zoneLevel || 1));
  return Math.max(0.25, Math.min(8, Math.sqrt(player / zone)));
}
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function canEnterZone(zone, playerLevel) {
  if (!zone) return false;
  // A entrada no Boss da Guild e controlada pelo convite autoritativo, nao por level.
  if (zone.guildBoss === true) return true;
  const level = Number(playerLevel || 1);
  if (zone.questType === 'reborn') {
    const minimum = Number(zone.minEntryLevel ?? zone.level ?? 1);
    const maximum = Number.isFinite(Number(zone.maxLevel))
      ? Number(zone.maxLevel)
      : Infinity;
    return level >= minimum && level <= maximum;
  }
  return level >= Number(zone.level || 1);
}

function zoneEntryRequirement(zone) {
  if (zone?.guildBoss === true) return 1;
  if (zone?.questType === 'reborn') {
    return Number(zone.minEntryLevel ?? zone.level ?? 1);
  }
  return Number(zone?.level || 1);
}

export function eligibleMonsters(zone, level) {
  const eligible = zone.monsters.filter(monster =>
    level >= (monster.requiredLevel || zone.level || 1)
  );
  return eligible.length ? eligible : zone.monsters.slice(0, 1);
}

export function allowedLureCounts(zone) {
  // V20.62: todas as hunts normais suportam lure de 1 a 8. Mantemos
  // compatibilidade com zonas especiais que explicitamente travem um limite menor.
  const configured = Array.isArray(zone?.lureOptions) ? zone.lureOptions.map(Number) : [];
  const explicitMax = Number(zone?.maxLure || 8);
  const max = Math.max(1, Math.min(8, Number.isFinite(explicitMax) ? explicitMax : 8));
  return Array.from({length:max}, (_, index) => index + 1);
}

export function normalizeLureCount(zone, value) {
  const allowed = allowedLureCounts(zone);
  const requested = Number(value);
  return allowed.includes(requested) ? requested : (allowed[0] || 1);
}

export function rollOriginalLoot(monster, random = Math.random, multiplier = 1) {
  const results = [];
  for (const drop of monster.loot || []) {
    if (random() * 100000 >= Math.min(100000, Number(drop.chance || 0) * Math.max(1, Number(multiplier)||1))) continue;
    const countMin = Math.max(1, Math.trunc(Number(drop.countMin || 1)));
    const countMax = Math.max(countMin, Math.trunc(Number(drop.countMax || countMin)));
    const count = countMin + Math.floor(random() * (countMax - countMin + 1));
    results.push({ serverId: drop.serverId ?? null, itemId:drop.itemId ?? null, count });
  }
  return results;
}

export function createHuntEngine({
  state,
  onUpdate,
  onLog,
  onDeath,
  onEnemyDefeated,
  onEnemyDamaged,
  onBossTimeout,
  enemyAttackAllowed = () => true,
  shouldTick = () => true
}) {
  state.settings ||= {};
  state.settings.autoConsumables ||= {};
  state.settings.autoConsumables.hp = {
    enabled:false,
    threshold:50,
    itemId:'server_12775',
    ...(state.settings.autoConsumables.hp || {})
  };
  state.settings.autoConsumables.ki = {
    enabled:false,
    threshold:50,
    itemId:'server_12776',
    ...(state.settings.autoConsumables.ki || {})
  };
  const legacySenzuKi = state.settings.autoConsumables.senzuKi || {};
  state.settings.autoConsumables.senzu = {
    enabled:false,
    hpThreshold:75,
    kiThreshold:75,
    itemId:'server_12777',
    ...(state.settings.autoConsumables.senzu || {})
  };
  state.settings.autoConsumables.senzu.hpThreshold = Number(
    state.settings.autoConsumables.senzu.hpThreshold ??
    state.settings.autoConsumables.senzu.threshold ?? 75
  );
  state.settings.autoConsumables.senzu.kiThreshold = Number(
    state.settings.autoConsumables.senzu.kiThreshold ??
    legacySenzuKi.threshold ?? 75
  );
  state.settings.autoConsumables.senzu.enabled = Boolean(
    state.settings.autoConsumables.senzu.enabled || legacySenzuKi.enabled
  );
  delete state.settings.autoConsumables.senzuKi;

  let interval = null;
  let lastTick = Date.now();
  let playerLastAttack = 0;
  const autoConsumableLastUse = {
    hp:0,
    ki:0,
    senzu:0
  };
  let uidCounter = 0;
  const spellTimers = new Set();
  const lastDefensiveSkillGain = {defense:0, barrier:0};
  const HUNT_DEFENSIVE_SKILL_INTERVAL_MS = 1_000;

  const zone = () =>
    zones.find(item => item.id === state.hunt.zoneId) || zones[0];
  const monsterPool = () =>
    eligibleMonsters(zone(), state.profile.level);
  const character = () =>
    characters[state.profile.characterId] || characters.goku;
  const equipmentStats = () => totalStats(state, itemCatalog);
  const combatStats = () =>
    derivedCombatStats(
      state,
      character(),
      equipmentStats(),
      itemCatalog
    );

  function maxPlayerHp() {
    return maxResources(
      state,
      character(),
      equipmentStats()
    ).maxHp;
  }

  // Mantém HP/KI coerentes imediatamente quando o level altera os máximos.
  // O ganho de capacidade é acrescentado ao recurso atual, preservando o dano
  // já sofrido. Assim um jogador cheio continua cheio ao subir de level.
  function refreshPlayerResourceCapsAfterLevelUp() {
    const resources=maxResources(state,character(),equipmentStats());
    const newMaxHp=Math.max(1,Number(resources.maxHp||1));
    const newMaxKi=Math.max(1,Number(resources.maxKi||1));
    const oldMaxHp=Math.max(1,Number(state.hunt.playerMaxHp||state.profile.maxHp||newMaxHp));
    const oldMaxKi=Math.max(1,Number(state.profile.maxKi||newMaxKi));
    const oldHp=Math.max(0,Number(state.hunt.playerHp??state.profile.hp??oldMaxHp));
    const oldKi=Math.max(0,Number(state.profile.ki??oldMaxKi));
    const nextHp=Math.min(newMaxHp,oldHp+Math.max(0,newMaxHp-oldMaxHp));
    const nextKi=Math.min(newMaxKi,oldKi+Math.max(0,newMaxKi-oldMaxKi));
    state.profile.maxHp=newMaxHp;
    state.profile.maxKi=newMaxKi;
    state.profile.hp=nextHp;
    state.profile.ki=nextKi;
    state.hunt.playerMaxHp=newMaxHp;
    state.hunt.playerHp=nextHp;
    return {maxHp:newMaxHp,maxKi:newMaxKi,hp:nextHp,ki:nextKi};
  }

  function ensureAnalyser() {
    state.hunt.analyser ||= {
      startedAt:Date.now(),
      activeMs:0,
      xp:0,
      zeni:0,
      lootValue:0,
      supplySpent:0,
      kills:0,
      drops:{}
    };
    const analyser=state.hunt.analyser;
    analyser.startedAt=Math.max(0,Number(analyser.startedAt||Date.now()));
    analyser.activeMs=Math.max(0,Number(analyser.activeMs||0));
    analyser.xp=Math.max(0,Number(analyser.xp||0));
    analyser.zeni=Math.max(0,Number(analyser.zeni||0));
    analyser.lootValue=Math.max(0,Number(analyser.lootValue||0));
    analyser.supplySpent=Math.max(0,Number(analyser.supplySpent||0));
    analyser.kills=Math.max(0,Number(analyser.kills||0));
    if(!analyser.drops||typeof analyser.drops!=='object')analyser.drops={};
    return analyser;
  }

  function analyserDropKey(itemId,rarity='common'){
    return `${String(itemId)}|${String(rarity||'common')}`;
  }

  const supplyBuyPrices=Object.freeze({
    server_12775:200,server_12776:200,server_12777:400,server_12778:1000,
    server_12779:2500,server_7636:4500,server_12780:6500,server_7634:8500,
    server_2151:12000,server_7635:16000,server_2537:22000,server_2156:30000,
    server_2157:40000,server_2536:52000,server_2158:70000
  });

  function analyserNpcSellUnitPrice(item){
    if(!item)return 0;
    const name=String(item.name||'').toLowerCase();
    if(item.noNpcSell===true||item.playerMarketOnly===true||item.consumableKind==='hp'||item.consumableKind==='ki'||item.consumableKind==='senzu'||name.includes('potion')||name.includes('senzu')||item.type==='currency'||item.type==='backpack')return 0;
    const explicit=Number(item.sellPrice??item.value??0);
    if(explicit>0)return Math.floor(explicit);
    const base={common:10,uncommon:35,rare:120,epic:450,legendary:1500,super_rare:220,super_legendary:3000,mythic:6000,divine:12000};
    const rarity=String(item.rarity||'common').toLowerCase();
    const power=Object.entries(item.stats||{}).reduce((sum,[key,value])=>key==='skillBonuses'||typeof value!=='number'?sum:sum+Math.abs(value),0);
    return Math.max(1,Math.floor((base[rarity]||10)+power*2+Number(item.requiredLevel||0)*.25));
  }

  function brasiliaDayKey(ts=Date.now()){const d=new Date(Number(ts)-3*3600000);return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;}
  function brasiliaWeekKey(ts=Date.now()){const d=new Date(Number(ts)-3*3600000);const sunday=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()-d.getUTCDay()));return `${sunday.getUTCFullYear()}-${String(sunday.getUTCMonth()+1).padStart(2,'0')}-${String(sunday.getUTCDate()).padStart(2,'0')}`;}
  function gamePassStats(){
    state.profile ||= {};
    state.profile.gamePassStats ||= {kills:0,bosses:0,xp:0,drops:0,supplies:0};
    state.profile.gamePassDailyStats ||= {key:brasiliaDayKey(),kills:0,bosses:0,xp:0,drops:0,supplies:0};
    state.profile.gamePassWeeklyStats ||= {key:brasiliaWeekKey(),kills:0,bosses:0,xp:0,drops:0,supplies:0};
    if(state.profile.gamePassDailyStats.key!==brasiliaDayKey())state.profile.gamePassDailyStats={key:brasiliaDayKey(),kills:0,bosses:0,xp:0,drops:0,supplies:0};
    if(state.profile.gamePassWeeklyStats.key!==brasiliaWeekKey())state.profile.gamePassWeeklyStats={key:brasiliaWeekKey(),kills:0,bosses:0,xp:0,drops:0,supplies:0};
    return state.profile.gamePassStats;
  }
  function addGamePassStat(key,value=1){gamePassStats();for(const bucket of [state.profile.gamePassStats,state.profile.gamePassDailyStats,state.profile.gamePassWeeklyStats])bucket[key]=Math.max(0,Number(bucket[key]||0))+Number(value||0);}

  function recordAnalyserDrop(itemId,quantity=1,rarity='common'){
    const analyser=ensureAnalyser();
    const qty=Math.max(0,Number(quantity||0));
    const key=analyserDropKey(itemId,rarity);
    analyser.drops[key]=Math.max(0,Number(analyser.drops[key]||0))+qty;
    const item=itemCatalog[itemId];
    analyser.lootValue += analyserNpcSellUnitPrice(item)*qty;
    addGamePassStat('drops',qty);
  }

  function resetAnalyser(){
    state.hunt.analyser={
      startedAt:Date.now(),
      activeMs:0,
      xp:0,
      zeni:0,
      lootValue:0,
      supplySpent:0,
      kills:0,
      drops:{}
    };
    onUpdate();
    return state.hunt.analyser;
  }

  function ensureArena() {
    state.hunt.enemies ||= [];
    ensureAnalyser();
    const equipment = totalStats(state, itemCatalog);
    const resources = maxResources(
      state,
      character(),
      equipment
    );
    state.profile.maxHp = Math.max(1, resources.maxHp);
    state.profile.maxKi = Math.max(1, resources.maxKi);
    state.profile.capacity = Math.max(
      0,
      resources.capacity
    );
    if (
      state.profile.ki == null ||
      !Number.isFinite(Number(state.profile.ki))
    ) {
      state.profile.ki = state.profile.maxKi;
    }
    state.profile.ki = Math.min(
      state.profile.maxKi,
      Math.max(0, Number(state.profile.ki))
    );
    state.hunt.effects ||= [];
    state.hunt.pendingLureCount ??= null;
    state.hunt.waveGeneration ||= 0;
    state.hunt.arena ||= {
      playerX: 50,
      playerY: 52,
      direction: 1,
      phase: 'paused',
      targetId: null
    };
  }

  function chooseMonster(sequence) {
    const pool = monsterPool();
    return pool[sequence % pool.length];
  }

  function spawnPoint(slotIndex, totalSlots, generation = 0) {
    const points = [
      { x: 8, y: 24 },
      { x: 92, y: 25 },
      { x: 8, y: 76 },
      { x: 92, y: 75 },
      { x: 50, y: 15 },
      { x: 50, y: 85 }
    ];
    const index = (slotIndex + generation) % points.length;
    const point = points[index];
    return {
      x: clamp(point.x + ((slotIndex * 7) % 5) - 2, 4, 96),
      y: clamp(point.y + ((slotIndex * 11) % 7) - 3, 15, 85)
    };
  }

  function createSlot(slotIndex, totalSlots, respawnAt = 0) {
    const monster = chooseMonster(state.hunt.monsterIndex + slotIndex);
    const point = spawnPoint(
      slotIndex,
      totalSlots,
      state.hunt.waveGeneration
    );
    return {
      uid: `enemy-${Date.now()}-${uidCounter++}`,
      slotIndex,
      monsterId: monster.id,
      hp: respawnAt ? 0 : monster.hp,
      maxHp: monster.hp,
      x: point.x,
      y: point.y,
      spawnX: point.x,
      spawnY: point.y,
      direction: point.x < 50 ? 1 : 3,
      lastAttackAt: 0,
      alive: !respawnAt,
      respawnAt,
      spawnedAt: respawnAt ? 0 : Date.now()
    };
  }

  function buildInitialFormation() {
    ensureArena();
    const count = normalizeLureCount(zone(), state.hunt.lureCount);
    state.hunt.lureCount = count;
    state.hunt.pendingLureCount = null;
    state.hunt.waveGeneration += 1;
    state.hunt.arena.playerX = 50;
    state.hunt.arena.playerY = 52;
    state.hunt.arena.direction = 1;
    state.hunt.arena.phase = 'combat';
    state.hunt.arena.targetId = null;
    state.hunt.enemies = Array.from(
      { length: count },
      (_, index) => createSlot(index, count)
    );
  }

  function enemyDefinition(enemy) {
    return zone().monsters.find(monster =>
      monster.id === enemy.monsterId
    ) || monsterPool()[0];
  }

  function livingEnemies() {
    return state.hunt.enemies.filter(enemy =>
      enemy.alive && enemy.hp > 0
    );
  }

  function currentFormationIsDead() {
    return state.hunt.enemies.length > 0 &&
      state.hunt.enemies.every(enemy => !enemy.alive);
  }

  function applyPendingLureAfterWaveDeath(now) {
    const pending = state.hunt.pendingLureCount;
    if (pending == null || !currentFormationIsDead()) return false;

    const count = normalizeLureCount(zone(), pending);
    state.hunt.lureCount = count;
    state.hunt.pendingLureCount = null;
    state.hunt.waveGeneration += 1;
    state.hunt.enemies = Array.from(
      {length:count},
      (_, index) => createSlot(
        index,
        count,
        now + RESPAWN_MS + index * 900
      )
    );
    state.hunt.arena.targetId = null;
    return true;
  }

  function activateRespawnSlot(enemy, now, desired) {
    const monster = chooseMonster(
      state.hunt.monsterIndex + enemy.slotIndex
    );
    const point = spawnPoint(
      enemy.slotIndex,
      desired,
      state.hunt.waveGeneration + 1
    );

    enemy.uid = `enemy-${now}-${uidCounter++}`;
    enemy.monsterId = monster.id;
    enemy.hp = monster.hp;
    enemy.maxHp = monster.hp;
    enemy.x = point.x;
    enemy.y = point.y;
    enemy.spawnX = point.x;
    enemy.spawnY = point.y;
    enemy.direction = point.x < 50 ? 1 : 3;
    enemy.lastAttackAt = 0;
    enemy.alive = true;
    enemy.respawnAt = 0;
    enemy.spawnedAt = now;
    onLog(`${monster.name} renasceu.`);
    onUpdate();
  }

  function respawnReadySlots(now) {
    if (applyPendingLureAfterWaveDeath(now)) return;

    const desired = normalizeLureCount(
      zone(),
      state.hunt.lureCount
    );

    for (const enemy of state.hunt.enemies) {
      if (enemy.slotIndex >= desired || enemy.alive) continue;

      const respawnAt = Number(enemy.respawnAt);
      if (!Number.isFinite(respawnAt) || respawnAt <= 0) {
        const otherLiving = state.hunt.enemies.some(candidate =>
      candidate !== enemy &&
      candidate.alive &&
      candidate.hp > 0
    );
    enemy.respawnAt =
      Number(now) +
      (otherLiving ? RESPAWN_MS : FULL_CLEAR_RESPAWN_MS);
        continue;
      }

      if (Number(now) >= respawnAt) {
        activateRespawnSlot(enemy, Number(now), desired);
      }
    }
  }

  function nearestEnemy(maxRange = Infinity) {
    const arena = state.hunt.arena;
    const alive = livingEnemies();

    // Keep hitting the current target until it dies. A newly approaching
    // monster must not steal focus merely because it became closer.
    const locked = alive.find(enemy => enemy.uid === arena.targetId);
    if (locked) {
      const distance = Math.hypot(
        locked.x - arena.playerX,
        locked.y - arena.playerY
      );
      if (distance <= maxRange) return { enemy:locked, distance };
      // The locked target drifted out of attack range (kiting/ranged AI,
      // or just crowded movement). Previously this made playerAttack()
      // give up entirely every tick — even if another enemy was right
      // next to the player — because nearestEnemy() kept returning the
      // same out-of-reach target forever. Fall through and look for a
      // different, actually-reachable enemy instead of freezing melee.
    }

    const reachable = alive
      .map(enemy => ({
        enemy,
        distance:Math.hypot(
          enemy.x - arena.playerX,
          enemy.y - arena.playerY
        )
      }))
      .filter(entry => entry.distance <= maxRange)
      .sort((a, b) => a.distance - b.distance)[0];

    if (reachable) {
      arena.targetId = reachable.enemy.uid;
      return reachable;
    }

    // Nothing is currently reachable. Keep reporting the locked target
    // (so the UI still shows who we're facing and we resume attacking it
    // the moment it's back in range) instead of relocking every tick.
    if (locked) {
      return {
        enemy:locked,
        distance:Math.hypot(
          locked.x - arena.playerX,
          locked.y - arena.playerY
        )
      };
    }

    const next = alive
      .map(enemy => ({
        enemy,
        distance:Math.hypot(
          enemy.x - arena.playerX,
          enemy.y - arena.playerY
        )
      }))
      .sort((a, b) => a.distance - b.distance)[0] || null;

    if (next) arena.targetId = next.enemy.uid;
    return next;
  }

  function createCorpse(enemy, monster, loot) {
    if (!loot.length) return;
    state.hunt.corpses ||= [];
    state.hunt.corpses.push({
      id:`corpse-${Date.now()}-${uidCounter++}`,
      monsterName:monster.name,
      x:enemy.x,
      y:enemy.y,
      createdAt:Date.now(),
      expiresAt:Date.now() + CORPSE_LIFETIME_MS,
      corpseServerId:monster.corpseServerId || null,
      loot
    });
  }

  function applyOriginalLoot(monster, enemy) {
    const corpseLoot = [];
    const guildDropBonus=1+Math.max(0,Math.min(0.50,Number(state.profile?.guildBenefits?.dropPercent||0)/100));
    const guildBossLootBonus=zone()?.guildBoss
      ? 1+Math.max(0,Math.min(0.10,Number(state.profile?.guildBenefits?.bossLootPercent||0)/100))
      : 1;
    const lootMultiplier=(Number(state.profile?.lootBoostUntil||0)>Date.now()?1.20:1) * (zone()?.vipOnly?Number(zone()?.vipLootMultiplier||1.20):1) * guildDropBonus * guildBossLootBonus;
    for (const drop of rollOriginalLoot(monster, Math.random, lootMultiplier)) {
      const itemId = drop.itemId || `server_${drop.serverId}`;
      const item = itemCatalog[itemId];
      if (!item) continue;

      if (item.type === 'currency') {
        const worth = Number(item.value || 0);
        const gainedZeni=worth * drop.count;
        state.profile.bank =
          Number(state.profile.bank || 0) + gainedZeni;
        ensureAnalyser().zeni += gainedZeni;
        onLog(
          `${drop.count}× ${item.name}: +${worth * drop.count} no banco.`
        );
        continue;
      }

      const ignored = state.hunt.lootFilter?.ignored?.includes(itemId);
      if (isRarityEligibleItem(item)) {
        // Equipamentos sao instancias individuais. A raridade so e rolada
        // DEPOIS que o drop-base do monstro ja aconteceu.
        for (let unit=0; unit<drop.count; unit++) {
          const rarity=rollItemRarity();
          const meta=createItemInstanceMeta(item,rarity,'hunt-drop');
          const display=`${item.name} [${rarityName(rarity.id)}]`;
          recordAnalyserDrop(itemId,1,rarity.id);
          if (ignored) {
            corpseLoot.push({itemId,quantity:1,...meta});
            onLog(`${display} foi ignorado e ficou no corpo.`);
            continue;
          }
          const result=addItemToInventory(state,itemId,1,itemCatalog,null,meta,{respectLootFilter:true});
          if(result.ok) onLog(`1× ${display} foi colocado na backpack.`);
          else {
            corpseLoot.push({itemId,quantity:1,...meta});
            onLog(`Backpack cheia. ${display} ficou no corpo de ${monster.name}.`);
          }
        }
        continue;
      }

      recordAnalyserDrop(itemId,drop.count,item.rarity||'common');
      if (ignored) {
        corpseLoot.push({itemId, quantity:drop.count});
        onLog(`${item.name} foi ignorado e ficou no corpo.`);
        continue;
      }

      const result = addItemToInventory(
        state,
        itemId,
        drop.count,
        itemCatalog,
        null,
        null,
        {respectLootFilter:true}
      );
      if (result.ok) {
        onLog(`${drop.count}× ${item.name} foi colocado na backpack.`);
      } else {
        corpseLoot.push({itemId, quantity:drop.count});
        onLog(
          `Backpack cheia. ${item.name} ficou no corpo de ${monster.name}.`
        );
      }
    }

    // Dragon Balls use their fixed per-sphere chances and are intentionally
    // independent from Loot Boost/VIP loot multipliers.
    const guildSphereBonus=zone()?.guildBoss===true?Math.max(0,Number(state.profile?.guildBenefits?.guildBossDragonBallBonus||0))/100:0;
    for (const itemId of rollDragonBallDrops(zone(), Math.random, guildSphereBonus)) {
      const item = itemCatalog[itemId];
      if (!item) continue;
      recordAnalyserDrop(itemId, 1, item.rarity || 'common');
      const ignored = state.hunt.lootFilter?.ignored?.includes(itemId);
      if (ignored) {
        corpseLoot.push({itemId, quantity:1});
        onLog(`${item.name} foi ignorada e ficou no corpo.`);
        continue;
      }
      const result = addItemToInventory(state, itemId, 1, itemCatalog, null, null, {respectLootFilter:true});
      if (result.ok) {
        onLog(`🐉 ${item.name} encontrada e colocada na backpack!`);
      } else {
        corpseLoot.push({itemId, quantity:1});
        onLog(`Backpack cheia. ${item.name} ficou no corpo de ${monster.name}.`);
      }
    }
    createCorpse(enemy, monster, corpseLoot);
  }

  function rewardEnemy(monster, enemy) {
    const current=zone();
    recordBestiaryKill(state, monster.id || enemy?.monsterId || monster.name, 1,{
      boss:Boolean(
        current?.contentType==='boss' &&
        !current?.questType &&
        !current?.guildBoss &&
        !current?.hiddenFromHuntList &&
        !current?.disabledForHunt
      ),
      guildBoss:Boolean(current?.guildBoss)
    });
    const rate = characterExperienceMultiplier(state);
    const gainedXp = monster.xp * rate;
    state.profile.xp += gainedXp;
    const analyser=ensureAnalyser();
    analyser.xp += gainedXp;
    analyser.kills += 1;
    addGamePassStat('xp',gainedXp);addGamePassStat('kills',1);
    if(zone()?.contentType==='boss'||zone()?.questType==='reborn'||zone()?.guildBoss)addGamePassStat('bosses',1);
    const displayedXp = Number(gainedXp.toFixed(2)).toLocaleString('pt-BR', {
      maximumFractionDigits:2
    });
    onLog(`${monster.name} derrotado. +${displayedXp} XP.`);

    const levelBeforeReward=Math.max(1,Number(state.profile.level||1));
    while (state.profile.xp >= characterXpRequired(state.profile.level)) {
      state.profile.xp -= characterXpRequired(state.profile.level);
      state.profile.level += 1;
      onLog(`Você alcançou o nível ${state.profile.level}!`);
    }
    if(Number(state.profile.level||1)!==levelBeforeReward)refreshPlayerResourceCapsAfterLevelUp();
    applyOriginalLoot(monster, enemy);
  }

  function gainAttackSkills() {
    const style = equippedCombatStyle(state, itemCatalog);
    const notify = (skillId, level) => {
      onLog(`${skillId} avançou para ${level}.`);
    };

    if (style === 'gloves') {
      gainSkill(state, 'gloves', vocationAptitude(character(), 'gloves'), notify);
    } else if (style === 'training-gloves') {
      // V21.22 — Two Tones Band treina somente Attack Speed também quando o
      // personagem está atacando em Hunt. Não deve aumentar Strength.
      gainSkill(
        state,
        'attackSpeed',
        dualTrainingGloves(state, itemCatalog) ? 2 : 1,
        notify
      );
    } else if (style === 'sword') {
      gainSkill(state, 'gloves', vocationAptitude(character(), 'gloves'), notify);
    } else if (style === 'ki') {
      gainSkill(state, 'kiBlasting', vocationAptitude(character(), 'kiBlasting'), notify);
    }
  }

  function pushAttackEffect(
    kind,
    target,
    critical,
    damage,
    spell = null
  ) {
    const arena = state.hunt.arena;
    const projectileDuration = kind === 'spell-projectile'
      ? 420
      : kind === 'ki-projectile'
        ? 420
        : 620;

    state.hunt.effects.push({
      id: `fx-${Date.now()}-${uidCounter++}`,
      kind,
      fromX: arena.playerX,
      fromY: arena.playerY,
      toX: target.x,
      toY: target.y,
      createdAt:Date.now(),
      duration:projectileDuration,
      critical,
      spellId:spell?.id || null,
      sprite:spell?.icon || null,
      effectId:spell?.effectId ?? null,
      missileId:spell?.missileId || null,
      areaMetrics:spell?.areaMetrics || null
    });

    if (
      spell &&
      kind === 'spell-projectile' &&
      (spell.impactEffectId != null || spell.effectId != null)
    ) {
      state.hunt.effects.push({
        id:`spell-impact-${Date.now()}-${uidCounter++}`,
        kind:'spell-impact',
        fromX:target.x,
        fromY:target.y,
        toX:target.x,
        toY:target.y,
        createdAt:Date.now() + projectileDuration * .72,
        duration:620,
        critical,
        spellId:spell.id,
        sprite:spell.effectPreview || spell.icon || null,
        effectId:spell.impactEffectId ?? spell.effectId ?? null,
        missileId:null
      });
    }

    if (Number.isFinite(Number(damage))) {
      state.hunt.effects.push({
        id:`damage-${Date.now()}-${uidCounter++}`,
        kind:'damage-number',
        fromX:target.x,
        fromY:target.y,
        toX:target.x,
        toY:target.y,
        createdAt:Date.now(),
        duration:850,
        critical,
        damage
      });
    }
    state.hunt.effects = state.hunt.effects.slice(-120);
  }

  function pushSelfSpellEffect(spell, hit) {
    const effectId = hit?.effectId ?? spell?.visualEffectId ?? spell?.effectId ?? null;
    if (effectId == null) return;
    const arena = state.hunt.arena;
    state.hunt.effects.push({
      id:`spell-self-${Date.now()}-${uidCounter++}`,
      kind:'spell-self',
      fromX:arena.playerX,
      fromY:arena.playerY,
      toX:arena.playerX,
      toY:arena.playerY,
      createdAt:Date.now(),
      duration:720,
      critical:false,
      spellId:spell?.id || null,
      sprite:spell?.effectPreview || spell?.icon || null,
      effectId,
      missileId:null,
      areaMetrics:hit?.areaMetrics || null
    });
    state.hunt.effects = state.hunt.effects.slice(-120);
  }

  function pushDamageNumber(target, damage, critical = false) {
    if (!target || !Number.isFinite(Number(damage))) return;
    state.hunt.effects.push({
      id:`damage-${Date.now()}-${uidCounter++}`,
      kind:'damage-number',
      fromX:target.x,
      fromY:target.y,
      toX:target.x,
      toY:target.y,
      createdAt:Date.now(),
      duration:850,
      critical,
      damage
    });
    state.hunt.effects = state.hunt.effects.slice(-180);
  }

  function areaAnchorForHit(hit) {
    const area = Array.isArray(hit?.area) ? hit.area : [];
    if (area.some(row => Array.isArray(row) && row.includes(3))) {
      return 'target';
    }
    return 'self';
  }

  function pushSpellHitVisual(spell, hit, target, direction) {
    if (spell?.suppressCombatVisual) return;
    const arena = state.hunt.arena;
    const area = Array.isArray(hit?.area) ? hit.area : [];
    const hasArea = area.some(row =>
      Array.isArray(row) && row.some(cell => Number(cell) === 1 || Number(cell) === 3)
    );
    const now = Date.now();

    if (hasArea && hit?.effectId != null) {
      const anchor = areaAnchorForHit(hit);
      const base = anchor === 'target' && target
        ? target
        : {x:arena.playerX,y:arena.playerY};
      state.hunt.effects.push({
        id:`spell-area-source-${now}-${uidCounter++}`,
        kind:'spell-combat-area',
        fromX:base.x,
        fromY:base.y,
        toX:base.x,
        toY:base.y,
        createdAt:now,
        duration:SOURCE_MAGIC_EFFECT_WINDOW_MS,
        spellId:spell?.id || null,
        effectId:hit.effectId,
        missileId:null,
        area,
        areaMetrics:hit.areaMetrics || null,
        areaAnchor:anchor,
        direction:Number(direction ?? arena.direction ?? 1)
      });
    } else if (hit?.missileId != null && target) {
      const tileDistance = Math.max(1, Math.hypot(
        target.x - arena.playerX,
        target.y - arena.playerY
      ) / 4.5);
      const projectileDuration = Math.max(140, Math.min(900, 90 + tileDistance * 75));
      state.hunt.effects.push({
        id:`spell-projectile-${now}-${uidCounter++}`,
        kind:'spell-projectile',
        fromX:arena.playerX,
        fromY:arena.playerY,
        toX:target.x,
        toY:target.y,
        createdAt:now,
        duration:projectileDuration,
        spellId:spell?.id || null,
        effectId:null,
        missileId:hit.missileId
      });
      if (hit?.effectId != null) {
        state.hunt.effects.push({
          id:`spell-impact-${now}-${uidCounter++}`,
          kind:'spell-impact',
          fromX:target.x,
          fromY:target.y,
          toX:target.x,
          toY:target.y,
          createdAt:now + projectileDuration,
          duration:SOURCE_MAGIC_EFFECT_WINDOW_MS,
          spellId:spell?.id || null,
          effectId:hit.effectId,
          missileId:null
        });
      }
    } else if (hit?.effectId != null) {
      const selfTarget = spell?.targetMode === 'self' || !target;
      const point = selfTarget
        ? {x:arena.playerX,y:arena.playerY}
        : target;
      state.hunt.effects.push({
        id:`spell-effect-${now}-${uidCounter++}`,
        kind:selfTarget ? 'spell-self' : 'spell-impact',
        fromX:point.x,
        fromY:point.y,
        toX:point.x,
        toY:point.y,
        createdAt:now,
        duration:SOURCE_MAGIC_EFFECT_WINDOW_MS,
        spellId:spell?.id || null,
        effectId:hit.effectId,
        missileId:null
      });
    }
    state.hunt.effects = state.hunt.effects.slice(-180);
  }

  function pushSourceVisualEvent(
    spell,
    event,
    primaryTarget,
    repeatIndex = 0,
    repeatCount = 1
  ) {
    const arena = state.hunt.arena;
    const self = {x:arena.playerX,y:arena.playerY};
    let anchor = event?.anchor === 'target' && primaryTarget
      ? primaryTarget
      : self;

    if (event?.anchor === 'path' && primaryTarget) {
      const tile = 4.5;
      const dx = Number(primaryTarget.x || 0) - Number(self.x || 0);
      const dy = Number(primaryTarget.y || 0) - Number(self.y || 0);
      const sourceTiles = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / tile));
      // Source Ghost Blaster advances exactly one tile per scheduled move
      // and keeps casting on the target tile after it arrives.
      const progress = Math.min(1, (Number(repeatIndex || 0) + 1) / sourceTiles);
      anchor = {
        x:Number(self.x || 0) + dx * progress,
        y:Number(self.y || 0) + dy * progress
      };
    }

    const tile = 4.5;
    const x = Number(anchor.x || 0) + Number(event?.offsetX || 0) * tile;
    const y = Number(anchor.y || 0) + Number(event?.offsetY || 0) * tile;
    const rawMissileId = event?.missileId;
    if (rawMissileId != null && Number.isFinite(Number(rawMissileId))) {
      const destinationX = x + Number(event?.destinationOffsetX || 0) * tile;
      const destinationY = y + Number(event?.destinationOffsetY || 0) * tile;
      const tileDistance = Math.max(1, Math.hypot(destinationX - x, destinationY - y) / tile);
      state.hunt.effects.push({
        id:`spell-source-missile-${Date.now()}-${uidCounter++}`,
        kind:'spell-projectile',
        fromX:x,fromY:y,toX:destinationX,toY:destinationY,
        createdAt:Date.now(),
        duration:Math.max(120, Math.min(700, 70 + tileDistance * 65)),
        spellId:spell?.id || null,
        effectId:null,
        missileId:Number(rawMissileId)
      });
    } else {
      const rawEffectId = event?.effectId;
      if (rawEffectId == null || !Number.isFinite(Number(rawEffectId))) return;
      const effectId = Number(rawEffectId);
      state.hunt.effects.push({
        id:`spell-source-${Date.now()}-${uidCounter++}`,
        kind:'spell-source-effect',
        fromX:x,fromY:y,toX:x,toY:y,
        createdAt:Date.now(),
        duration:SOURCE_MAGIC_EFFECT_WINDOW_MS,
        spellId:spell?.id || null,
        effectId,
        missileId:null,
        attachToActor:event?.anchor === 'self' &&
          Number(event?.offsetX || 0) === 0 &&
          Number(event?.offsetY || 0) === 0
      });
    }
    state.hunt.effects = state.hunt.effects.slice(-180);
  }

  function scheduleSourceVisualEvents(spell, primaryTarget) {
    for (const event of spell?.visualEvents || []) {
      const repeatCount = Math.max(1, Math.min(240, Number(event.repeatCount || 1)));
      const startDelayMs = Math.max(0, Number(event.startDelayMs || 0));
      const intervalMs = Math.max(0, Number(event.intervalMs || 0));
      for (let index = 0; index < repeatCount; index += 1) {
        scheduleSpellAction(
          startDelayMs + intervalMs * index,
          () => pushSourceVisualEvent(
            spell,
            event,
            primaryTarget,
            index,
            repeatCount
          )
        );
      }
    }
  }

  function scheduleSpellAction(delayMs, callback) {
    const delay = Math.max(0, Number(delayMs || 0));
    if (delay <= 0) {
      callback();
      return;
    }
    const timer = setTimeout(() => {
      spellTimers.delete(timer);
      callback();
    }, delay);
    spellTimers.add(timer);
  }

  function directionToTarget(target) {
    if (!target) return Number(state.hunt.arena.direction || 1);
    const dx = target.x - state.hunt.arena.playerX;
    const dy = target.y - state.hunt.arena.playerY;
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 1 : 3;
    return dy >= 0 ? 2 : 0;
  }

  function activeHasteMultiplier(now = Date.now()) {
    state.activeSpellBuffs ||= [];
    state.activeSpellBuffs = state.activeSpellBuffs.filter(
      buff => Number(buff.expiresAt || 0) > now
    );

    return state.activeSpellBuffs
      .filter(buff => buff.type === 'haste')
      .reduce(
        (multiplier,buff) => Math.max(
          multiplier,
          Number(
            buff.attackSpeedMultiplier ||
            buff.multiplier ||
            1
          )
        ),
        1
      );
  }

  function effectivePlayerAttackInterval(now = Date.now()) {
    const derived = combatStats();
    return derived.attackInterval / activeHasteMultiplier(now);
  }

  function kiLevelTriesForSpell(spell,hitPlan = []) {
    // V20.23: uma conjuração conta como uma tentativa de Ki Level.
    // Antes o ganho crescia com custo, level e quantidade de hits da spell,
    // fazendo técnicas multi-hit avançarem skill muitas vezes mais rápido.
    void spell;
    void hitPlan;
    return Math.max(0.1, vocationAptitude(character(), 'kiLevel'));
  }

  function gainDefensiveHuntSkill(skillId, now) {
    if (!lastDefensiveSkillGain[skillId]) {
      lastDefensiveSkillGain[skillId] = 0;
    }
    if (now - lastDefensiveSkillGain[skillId] < HUNT_DEFENSIVE_SKILL_INTERVAL_MS) {
      return false;
    }
    lastDefensiveSkillGain[skillId] = now;
    gainSkill(state, skillId, 1, (id, level) => {
      onLog(`${id} avançou para ${level}.`);
    });
    return true;
  }

  function movePlayer(deltaMs) {
    const arena=state.hunt.arena;
    arena.playerX=50;
    arena.playerY=52;

    const target=nearestEnemy();
    if(!target){
      arena.targetId=null;
      return;
    }

    arena.targetId=target.enemy.uid;
    const dx=target.enemy.x-arena.playerX;
    const dy=target.enemy.y-arena.playerY;
    arena.direction=Math.abs(dx)>=Math.abs(dy)
      ?(dx>0?1:3)
      :(dy>0?2:0);
  }

  function moveEnemies(deltaMs) {
    const arena = state.hunt.arena;
    const alive = livingEnemies();
    for (const enemy of alive) {
      const monster = enemyDefinition(enemy);
      const step = intelligentEnemyStep({
        enemy,
        monster,
        player:{x:arena.playerX,y:arena.playerY},
        allies:alive,
        deltaMs
      });
      enemy.aiIntent = step.intent;
      enemy.x = clamp(step.x, 5, 95);
      enemy.y = clamp(step.y, 15, 85);

      const playerStyle=equippedCombatStyle(state,itemCatalog);
      const distanceToPlayer=Math.hypot(
        arena.playerX-enemy.x,
        arena.playerY-enemy.y
      );
      if(playerStyle!=='ki' && distanceToPlayer>9.5){
        const pull=Math.min(
          distanceToPlayer-9.5,
          Math.max(0.35,deltaMs/1000*7)
        );
        enemy.x+=(
          arena.playerX-enemy.x
        )/distanceToPlayer*pull;
        enemy.y+=(
          arena.playerY-enemy.y
        )/distanceToPlayer*pull;
      }

      const dx=arena.playerX-enemy.x, dy=arena.playerY-enemy.y;
      enemy.direction=Math.abs(dx)>=Math.abs(dy)?(dx>0?1:3):(dy>0?2:0);
    }
  }

  function defeatEnemy(enemy, now = Date.now(), options = {}) {
    const notifyProgress = options.notifyProgress !== false;
    const reward = options.reward !== false;
    if (!enemy || !enemy.alive) return false;

    const monster = enemyDefinition(enemy);
    enemy.hp = 0;
    enemy.alive = false;
    const otherLiving = state.hunt.enemies.some(candidate =>
      candidate !== enemy &&
      candidate.alive &&
      candidate.hp > 0
    );
    enemy.respawnAt =
      Number(now) +
      (otherLiving ? RESPAWN_MS : FULL_CLEAR_RESPAWN_MS);
    enemy.lastAttackAt = 0;

    if (reward) rewardEnemy(monster, enemy);
    const currentZone=zone();
    if(currentZone?.vipOnly){
      state.profile.vipQuestKills=Math.max(0,Number(state.profile.vipQuestKills||0))+1;
      if(state.profile.vipQuestKills>=100 && !(state.completedQuests||[]).includes('vip-hunter-quest')){
        state.completedQuests ||= []; state.completedQuests.push('vip-hunter-quest');
        addItemToInventory(state,'server_2151',100,itemCatalog);
        onLog('Quest VIP Caçador Premium concluída: +100 Rose Senzu.');
      }
    }
    state.hunt.monsterIndex += 1;

    if (state.hunt.arena.targetId === enemy.uid) {
      state.hunt.arena.targetId = null;
    }

    onUpdate();
    if (notifyProgress) onEnemyDefeated?.({
      monster,
      enemy,
      zoneId:state.hunt.zoneId,
      defeatedAt:Number(now)
    });
    return true;
  }

  function playerAttack(now) {
    const derived = combatStats();
    const meleeReach=Math.max(
      12,
      Number(derived.attackRange || 1) * 4.5
    );
    const attackDistance =
      derived.style === 'ki'
        ? Math.max(13.5,derived.attackRange * 4.5)
        : meleeReach;

    const target = nearestEnemy(attackDistance);
    if (!target) return;
    if (target.distance > attackDistance) return;
    const effectiveAttackInterval =
      effectivePlayerAttackInterval(now);
    if (now - playerLastAttack < effectiveAttackInterval) return;
    playerLastAttack = now;

    const critical = Math.random() < derived.criticalChance;
    const advantage = levelAdvantage(
      state.profile.level,
      Number(zone()?.level || 1)
    );
    const damage = Math.max(
      1,
      Math.floor(
        derived.attack *
        (zone()?.guildBoss?1+Math.max(0,Number(state.profile?.guildBenefits?.guildBossAttackPercent||0))/100:1) *
        advantage *
        (0.90 + Math.random() * 0.20) *
        (critical ? 1.65 : 1)
      )
    );

    const style = equippedCombatStyle(state, itemCatalog);
    pushAttackEffect(
      style === 'ki' ? 'ki-projectile' : 'melee-smoke',
      target.enemy,
      critical,
      damage
    );

    const partyHandled = onEnemyDamaged?.({
      enemy:target.enemy,damage,zoneId:state.hunt.zoneId,at:now,source:'basic'
    });
    if (!partyHandled) {
      target.enemy.hp -= damage;
      if (target.enemy.hp <= 0) defeatEnemy(target.enemy, now);
    }

    gainAttackSkills();
  }

  function enemyAttacks(now) {
    if (!enemyAttackAllowed?.()) return;
    const arena = state.hunt.arena;
    const derived = combatStats();
    const alive = livingEnemies();
    // Genuine risk/reward for luring more monsters at once: each attack
    // still uses that monster's own damage, but a "surrounded" penalty
    // kicks in once 3+ monsters are actually in range attacking at the
    // same time (not just however many the zone allows) — a 1-2 monster
    // pull is unaffected, a big pull without gear/Senzus/potions can
    // genuinely kill the player.
    const attackersInRange = alive.filter(enemy => Math.hypot(
      enemy.x - arena.playerX,
      enemy.y - arena.playerY
    ) <= 10.5).length;
    const crowdCurve = [1, 1, 1.10, 1.28, 1.52, 1.82, 2.18, 2.60];
    const crowdMultiplier = crowdCurve[Math.max(0, Math.min(7, attackersInRange - 1))] || 2.60;

    // V20.62: raridade e nível do set agora têm peso direto na sustentação.
    // Um set comum no nível recomendado continua viável, porém gasta muito mais
    // cura em lures altos; sets raros reduzem progressivamente essa pressão.
    const combatSlots = equipmentSlots.filter(slot => slot !== 'backpack');
    const equipped = combatSlots.map(slot => {
      const itemId = state.equipment?.[slot];
      const item = itemCatalog[itemId];
      if (!item || !isRarityEligibleItem(item)) return null;
      const rarity = rarityDefinition(state.equipmentMeta?.[slot]?.rarity || 'common');
      return {tier:Number(rarity.tier || 0), level:Math.max(1, equipmentRequiredLevel(item))};
    }).filter(Boolean);
    const averageTier = equipped.length
      ? equipped.reduce((sum, entry) => sum + entry.tier, 0) / equipped.length
      : 0;
    const averageGearLevel = equipped.length
      ? equipped.reduce((sum, entry) => sum + entry.level, 0) / equipped.length
      : Math.max(1, Number(state.profile.level || 1));
    const zoneLevel = Math.max(1, Number(zone()?.level || 1));
    const gearLevelRatio = Math.max(0.60, Math.min(1.15, averageGearLevel / zoneLevel));
    const undergearPressure = gearLevelRatio >= 1 ? 1 : 1 + (1 - gearLevelRatio) * 0.85;
    const raritySurvival = Math.max(0.52, 1 - averageTier * 0.075);
    const huntPressureMultiplier = undergearPressure * raritySurvival;

    for (const enemy of livingEnemies()) {
      const monster = enemyDefinition(enemy);
      const distance = Math.hypot(
        enemy.x - arena.playerX,
        enemy.y - arena.playerY
      );
      const originalMonster = monster.authoritative || monster;
      const maxAttackReach=Math.max(
        10.5,
        ...(monster.attacks||originalMonster.attacks||[]).map(attack=>Number(attack?.range||1)*4.2)
      );
      if (distance > maxAttackReach) continue;

      const selectedAttack = chooseMonsterAttack(
        monster,
        enemy,
        now,
        Math.random,
        distance
      );
      const idealRange = Math.max(
        10.5,
        Number(selectedAttack?.range || 1) * 4.2
      );
      if (distance > idealRange) continue;

      const interval = Math.max(
        400,
        Number(selectedAttack?.intervalMs || monster.attackInterval || 1000)
      );
      if (!selectedAttack && now - enemy.lastAttackAt < interval) continue;
      enemy.lastAttackAt = now;

      const damageType = selectedAttack?.type ||
        selectedAttack?.combatType ||
        monster.damageType || 'physical';
      const attackMin = Math.abs(Number(selectedAttack?.min ?? monster.attackMin ?? 1));
      const attackMax = Math.abs(Number(selectedAttack?.max ?? monster.attackMax ?? attackMin));
      const rawDamage = attackMin + Math.random() * Math.max(0, attackMax - attackMin);

      const mitigation = damageType === 'ki'
        ? derived.kiDefense
        : derived.physicalDefense;

      const advantage = levelAdvantage(
        state.profile.level,
        Number(zone()?.level || 1)
      );
      const taken = Math.max(
        1,
        Math.floor(
          (rawDamage - mitigation * 0.35) /
          advantage * crowdMultiplier * huntPressureMultiplier *
          (zone()?.guildBoss?1/(1+Math.max(0,Number(state.profile?.guildBenefits?.guildBossDefensePercent||0))/100):1)
        )
      );

      // V21.2 — boss/monster Ki techniques are rendered through the same
      // registry-backed projectile/effect pipeline used by player spells.
      // Ki-typed attacks also train Barrier instead of physical Defense.
      if (selectedAttack && (damageType === 'ki' || selectedAttack.effectId != null || selectedAttack.missileId != null)) {
        const projectileDuration=Math.max(320,Math.min(900,Number(selectedAttack.projectileDuration||480)));
        state.hunt.effects.push({
          id:`enemy-spell-${Date.now()}-${uidCounter++}`,
          kind:'spell-projectile',
          fromX:enemy.x,
          fromY:enemy.y,
          toX:arena.playerX,
          toY:arena.playerY,
          createdAt:Date.now(),
          duration:projectileDuration,
          critical:false,
          spellId:`monster:${selectedAttack.name||'ki'}`,
          sprite:selectedAttack.icon||null,
          effectId:null,
          missileId:selectedAttack.missileId ?? null
        });
        if (selectedAttack.effectId != null) {
          state.hunt.effects.push({
            id:`enemy-impact-${Date.now()}-${uidCounter++}`,
            kind:'spell-impact',
            fromX:arena.playerX,
            fromY:arena.playerY,
            toX:arena.playerX,
            toY:arena.playerY,
            createdAt:Date.now()+Math.round(projectileDuration*.72),
            duration:620,
            critical:false,
            spellId:`monster:${selectedAttack.name||'ki'}`,
            sprite:selectedAttack.icon||null,
            effectId:selectedAttack.effectId,
            missileId:null
          });
        }
        state.hunt.effects=state.hunt.effects.slice(-120);
      }

      state.hunt.playerHp -= taken;
      checkAutoConsumables(now);

      if (damageType === 'ki') {
        gainDefensiveHuntSkill('barrier', now);
      } else {
        gainDefensiveHuntSkill('defense', now);
      }

      if (state.hunt.playerHp <= 0) {
        handleDeath();
        return;
      }
    }
  }

  function handleDeath() {
    const penalty = applyDeathPenalty(state);
    state.profile.deaths = (state.profile.deaths || 0) + 1;
    state.hunt.running = false;
    state.hunt.enemies = [];
    state.hunt.effects = [];
    state.hunt.pendingLureCount = null;
    state.hunt.arena.phase = 'paused';
    state.hunt.playerHp = maxPlayerHp();
    state.hunt.playerMaxHp = state.hunt.playerHp;

    const levelMessage = penalty.levelLost > 0
      ? ` e perdeu ${penalty.levelLost} nível`
      : '';
    onLog(
      `Você morreu, perdeu ${penalty.characterXpLost} XP${levelMessage}.`
    );
    onDeath?.(penalty);
    onUpdate();
  }


  let lastSenzuUseAt=Math.max(0,Number(state.hunt?.senzuCooldownUntil||0)-1000);
  function senzuCooldownRemaining(){return Math.max(0,Number(state.hunt?.senzuCooldownUntil||0)-Date.now());}
  function applyConsumable(itemId) {
    const item = itemCatalog[itemId];
    const isSenzu=Boolean(item?.consumableKind==='senzu'||/senzu/i.test(String(item?.name||'')));
    if(isSenzu&&(Date.now()-lastSenzuUseAt<1000||senzuCooldownRemaining()>0))return {ok:false,reason:'cooldown',remainingMs:senzuCooldownRemaining()};
    if (!item || itemQuantity(state, itemId) <= 0) {
      return {ok:false, reason:'missing'};
    }

    const maxHp = state.hunt.playerMaxHp || maxPlayerHp();
    const maxKi = state.profile.maxKi || 100;
    const currentHp = Math.max(0, Number(state.hunt.playerHp ?? maxHp));
    const currentKi = Math.max(0, Number(state.profile.ki ?? maxKi));

    let nextHp = currentHp;
    let nextKi = currentKi;

    if (item.restoreFullHp) {
      nextHp = maxHp;
    } else if (Number(item.restoreHp) > 0) {
      nextHp = Math.min(maxHp, currentHp + Number(item.restoreHp));
    }

    if (item.restoreFullKi) {
      nextKi = maxKi;
    } else if (Number(item.restoreKi) > 0) {
      nextKi = Math.min(maxKi, currentKi + Number(item.restoreKi));
    }

    if (nextHp === currentHp && nextKi === currentKi) {
      return {ok:false, reason:'full'};
    }

    const removed = removeItemFromInventory(state, itemId, 1);
    if (!removed) {
      return {ok:false, reason:'missing'};
    }

    if(isSenzu){lastSenzuUseAt=Date.now();state.hunt.senzuCooldownUntil=lastSenzuUseAt+1000;}
    state.hunt.playerHp = nextHp;
    state.profile.hp = nextHp;
    state.profile.ki = nextKi;
    const analyser=ensureAnalyser();
    analyser.supplySpent += Number(supplyBuyPrices[itemId]||item.buyPrice||0);
    addGamePassStat('supplies',1);
    return {
      ok:true,
      hpRecovered:nextHp - currentHp,
      kiRecovered:nextKi - currentKi
    };
  }

  function consumeConfigured(itemId, configId, now) {
    if (now - autoConsumableLastUse[configId] < (configId==='senzu'?1000:900)) return false;

    const result = applyConsumable(itemId);
    if (!result.ok) return false;

    autoConsumableLastUse[configId] = now;
    const item = itemCatalog[itemId];
    onLog(
      `${item.name} utilizado automaticamente`
      + `${result.hpRecovered ? ` · +${Math.ceil(result.hpRecovered)} HP` : ''}`
      + `${result.kiRecovered ? ` · +${Math.ceil(result.kiRecovered)} Ki` : ''}.`
    );
    onUpdate();
    return true;
  }

  function checkAutoConsumables(now = Date.now()) {
    const config = state.settings?.autoConsumables || {};
    const hpPercent = state.hunt.playerMaxHp > 0
      ? state.hunt.playerHp / state.hunt.playerMaxHp * 100
      : 100;
    const maxKi = state.profile.maxKi || 100;
    const kiPercent = maxKi > 0
      ? (state.profile.ki || 0) / maxKi * 100
      : 100;

    if (config.senzu?.enabled) {
      const hpTrigger = hpPercent <= Number(config.senzu.hpThreshold ?? config.senzu.threshold ?? 75);
      const kiTrigger = kiPercent <= Number(config.senzu.kiThreshold ?? 75);
      if (hpTrigger || kiTrigger) {
        let selectedSenzu=config.senzu.itemId||'server_12777';
        if(config.senzu.autoBest){
          const usableSenzus=Object.values(itemCatalog)
            .filter(item=>item?.consumableKind==='senzu')
            .filter(item=>itemQuantity(state,item.id)>0)
            .filter(item=>state.profile.level>=equipmentRequiredLevel(item))
            .sort((a,b)=>{
              const aValue=Math.max(Number(a.restoreHp||0),Number(a.restoreKi||0),a.restoreFullHp||a.restoreFullKi?Number.MAX_SAFE_INTEGER:0);
              const bValue=Math.max(Number(b.restoreHp||0),Number(b.restoreKi||0),b.restoreFullHp||b.restoreFullKi?Number.MAX_SAFE_INTEGER:0);
              return bValue-aValue;
            });
          selectedSenzu=usableSenzus[0]?.id||null;
        }
        if(selectedSenzu&&consumeConfigured(selectedSenzu,'senzu',now))return;
      }
    }
    if (
      config.hp?.enabled &&
      hpPercent <= Number(config.hp.threshold || 50)
    ) {
      consumeConfigured(
        config.hp.itemId || 'server_12775',
        'hp',
        now
      );
    }
    if (
      config.ki?.enabled &&
      kiPercent <= Number(config.ki.threshold || 50)
    ) {
      consumeConfigured(
        config.ki.itemId || 'server_12776',
        'ki',
        now
      );
    }
  }


  function reconcileRespawnSlots(now) {
    const desired = normalizeLureCount(
      zone(),
      state.hunt.lureCount
    );
    state.hunt.lureCount = desired;
    state.hunt.enemies ||= [];

    while (state.hunt.enemies.length < desired) {
      const slotIndex = state.hunt.enemies.length;
      state.hunt.enemies.push(
        createSlot(
          slotIndex,
          desired,
          now + RESPAWN_MS + slotIndex * 700
        )
      );
    }

    state.hunt.enemies.forEach((enemy, index) => {
      enemy.slotIndex = Number.isInteger(enemy.slotIndex)
        ? enemy.slotIndex
        : index;

      if (!enemy.alive && enemy.slotIndex < desired) {
        const timer = Number(enemy.respawnAt);
        if (!Number.isFinite(timer) || timer <= 0) {
          enemy.respawnAt = now + RESPAWN_MS;
        }
      }
    });
  }

  function expireCorpses(now) {
    state.hunt.corpses ||= [];
    const expired = state.hunt.corpses.filter(
      corpse => (corpse.expiresAt || corpse.createdAt + CORPSE_LIFETIME_MS) <= now
    );
    if (expired.length) {
      state.hunt.corpses = state.hunt.corpses.filter(
        corpse => !expired.includes(corpse)
      );
    }
  }


  function applyEquipmentRegeneration(deltaMs) {
    if (!state.hunt.running || deltaMs <= 0) return;
    const stats = equipmentStats();
    const seconds = deltaMs / 1000;

    const hpRegen = Number(stats.hpRegenPerSecond || 0);
    const kiRegen = Number(stats.kiRegenPerSecond || 0);

    if (hpRegen > 0) {
      state.hunt.playerHp = Math.min(
        state.hunt.playerMaxHp || maxPlayerHp(),
        Number(state.hunt.playerHp || 0) + hpRegen * seconds
      );
    }

    if (kiRegen > 0) {
      state.profile.ki = Math.min(
        state.profile.maxKi || 100,
        Number(state.profile.ki || 0) + kiRegen * seconds
      );
    }
  }

  function tick() {
    const now = Date.now();
    const delta = Math.min(250, now - lastTick);
    lastTick = now;
    if (!state.hunt.running) return;
    const currentZone=zone();
    if(currentZone?.contentType==='boss'&&!currentZone?.guildBoss&&Number(state.hunt.bossDeadlineAt||0)>0&&now>=Number(state.hunt.bossDeadlineAt)){
      state.hunt.bossDeadlineAt=0;
      onLog('O tempo de 5 minutos do Boss terminou.');
      onBossTimeout?.({zoneId:currentZone.id,zone:currentZone});
      stop();
      return;
    }
    ensureArena();
    reconcileRespawnSlots(now);
    respawnReadySlots(now);
    expireCorpses(now);
    ensureAnalyser().activeMs += Math.max(0,delta);
    applyEquipmentRegeneration(delta);
    movePlayer(delta);
    moveEnemies(delta);
    playerAttack(now);
    enemyAttacks(now);
    checkAutoConsumables(now);
    state.profile.hp = Math.max(
      0,
      Math.min(
        Number(state.profile.maxHp || state.hunt.playerMaxHp || 1),
        Number(state.hunt.playerHp || 0)
      )
    );

    state.hunt.effects = state.hunt.effects.filter(effect =>
      now - effect.createdAt < effect.duration + 220
    );
    state.hunt.lastTick = now;
    onUpdate();
  }

  interval = setInterval(() => {
    try {
      // In multiplayer the Node server owns Hunt simulation. The browser
      // keeps this engine only as a read/action facade so it must not run a
      // second AI/combat loop against the same shared state.
      if (!shouldTick()) {
        lastTick = Date.now();
        return;
      }
      tick();
    } catch (error) {
      console.error('Erro no ciclo da Hunt:', error);
      onLog('A Hunt encontrou um erro e recuperou o ciclo automaticamente.');
    }
  }, 80);

  function start() {
    // V21.17: cada nova Hunt começa com uma sessão limpa no Hunt Analyser.
    resetAnalyser();
    const selectedZone = zone();
    if (!canEnterZone(selectedZone, state.profile.level)) {
      const minimum = zoneEntryRequirement(selectedZone);
      if (selectedZone?.questType === 'reborn' && Number.isFinite(Number(selectedZone.maxLevel))) {
        onLog(`A Quest Reborn exige level ${minimum} até ${Number(selectedZone.maxLevel)}.`);
      } else {
        onLog(`Nível ${minimum} necessário para esta área.`);
      }
      return false;
    }

    state.hunt.lureCount = normalizeLureCount(
      zone(),
      state.hunt.lureCount
    );
    state.hunt.running = true;
    state.hunt.bossDeadlineAt=selectedZone?.contentType==='boss'&&!selectedZone?.guildBoss?Date.now()+5*60*1000:0;
    state.hunt.playerHp = maxPlayerHp();
    state.hunt.playerMaxHp = state.hunt.playerHp;
    buildInitialFormation();
    onUpdate();
    return true;
  }

  function restorePlayerResources() {
    const resources = maxResources(state, character(), equipmentStats());
    const maxHp=Math.max(1,Number(resources.maxHp||maxPlayerHp()||1));
    const maxKi=Math.max(1,Number(resources.maxKi||state.profile.maxKi||100));
    state.profile.maxHp=maxHp; state.profile.maxKi=maxKi;
    state.profile.hp=maxHp; state.profile.ki=maxKi;
    state.hunt.playerHp=maxHp; state.hunt.playerMaxHp=maxHp;
    onUpdate();
    return {maxHp,maxKi};
  }

  function syncSharedEnemyState(shared={}, options={}) {
    const enemy=(state.hunt.enemies||[]).find(e=>e?.alive&&Number(e.hp)>0) || (state.hunt.enemies||[])[0];
    if(!enemy)return false;
    if(Number.isFinite(Number(shared.x))) enemy.x=Number(shared.x);
    if(Number.isFinite(Number(shared.y))) enemy.y=Number(shared.y);
    if(Number.isFinite(Number(shared.maxHp))) enemy.maxHp=Math.max(1,Number(shared.maxHp));
    if(Number.isFinite(Number(shared.hp))) enemy.hp=Math.max(0,Number(shared.hp));
    if(shared.defeated && enemy.alive){
      defeatEnemy(enemy,Date.now(),{notifyProgress:options.notifyProgress!==false,reward:options.reward!==false});
    }
    onUpdate();
    return true;
  }

  function sharedEnemySnapshot(){
    const enemy=(state.hunt.enemies||[]).find(e=>e?.alive&&Number(e.hp)>0) || (state.hunt.enemies||[])[0];
    if(!enemy)return null;
    return {uid:enemy.uid,hp:Number(enemy.hp||0),maxHp:Number(enemy.maxHp||0),x:Number(enemy.x||0),y:Number(enemy.y||0),alive:Boolean(enemy.alive)};
  }

  function stop() {
    state.hunt.running = false;
    state.hunt.bossDeadlineAt=0;
    state.hunt.enemies = [];
    state.hunt.effects = [];
    state.hunt.pendingLureCount = null;
    if (state.hunt.arena) {
      state.hunt.arena.phase = 'paused';
      state.hunt.arena.targetId = null;
    }
    state.hunt.playerHp = maxPlayerHp();
    state.hunt.playerMaxHp = state.hunt.playerHp;
    onUpdate();
  }

  return {
    start,
    stop,
    restorePlayerResources,
    syncSharedEnemyState,
    sharedEnemySnapshot,
    setZone(zoneId, lureCount) {
      const selected = zones.find(item => item.id === zoneId);
      if (!selected || !canEnterZone(selected, state.profile.level)) {
        return false;
      }

      state.hunt.zoneId = zoneId;
      state.hunt.lureCount = normalizeLureCount(
        selected,
        lureCount ?? state.hunt.lureCount
      );
      state.hunt.pendingLureCount = null;
      state.hunt.monsterIndex = 0;
      state.hunt.enemies = [];
      state.hunt.effects = [];
      state.hunt.playerHp = maxPlayerHp();
      state.hunt.playerMaxHp = state.hunt.playerHp;
      onUpdate();
      return true;
    },
    setLureCount(value) {
      const normalized = normalizeLureCount(zone(), value);
      if (state.hunt.running) {
        state.hunt.pendingLureCount =
          normalized === state.hunt.lureCount
            ? null
            : normalized;
      } else {
        state.hunt.lureCount = normalized;
      }
      onUpdate();
      return normalized;
    },
    currentMonster() {
      const target = state.hunt.enemies.find(enemy =>
        enemy.uid === state.hunt.arena?.targetId
      ) || livingEnemies()[0];
      return target ? enemyDefinition(target) : monsterPool()[0];
    },
    currentEnemies() {
      return state.hunt.enemies.map(enemy => ({
        ...enemy,
        monster: enemyDefinition(enemy)
      }));
    },
    currentEffects() {
      return state.hunt.effects || [];
    },
    respawnDelayMs() {
      return RESPAWN_MS;
    },
    fullClearRespawnDelayMs() {
      return FULL_CLEAR_RESPAWN_MS;
    },
    effectiveAttackInterval(now = Date.now()) {
      return effectivePlayerAttackInterval(Number(now));
    },
    kiLevelTriesForSpell(spell,hitPlan = []) {
      return kiLevelTriesForSpell(spell,hitPlan);
    },

    forceTick(now = Date.now()) {
      lastTick = Number(now) - 100;
      tick();
    },
    forceRespawnCheck(now = Date.now()) {
      respawnReadySlots(Number(now));
      return state.hunt.enemies;
    },
    castSpell(spell) {
      if (
        spell.aggressive &&
        !state.hunt.running
      ) {
        return {
          ok:false,
          message:'Spells de combate só podem ser usadas na Hunt.'
        };
      }

      const living = livingEnemies();
      const lockedTarget = living.find(enemy =>
        enemy.uid === state.hunt.arena.targetId
      );
      const orderedTargets = [...living].sort((a,b) => {
        const da = Math.hypot(
          a.x - state.hunt.arena.playerX,
          a.y - state.hunt.arena.playerY
        );
        const db = Math.hypot(
          b.x - state.hunt.arena.playerX,
          b.y - state.hunt.arena.playerY
        );
        return da - db;
      });

      const primaryTarget = lockedTarget || orderedTargets[0] || null;

      if (
        spell.targetRequired &&
        !primaryTarget
      ) {
        return {ok:false, message:'Nenhum alvo disponível.'};
      }

      if (
        primaryTarget &&
        Number(spell.range || 0) > 0
      ) {
        const distance = Math.hypot(
          primaryTarget.x - state.hunt.arena.playerX,
          primaryTarget.y - state.hunt.arena.playerY
        );
        const rangePixels = Number(spell.range) * 4.5;
        if (distance > rangePixels) {
          return {ok:false, message:'O alvo está fora do alcance.'};
        }
      }

      const limit = targetLimit(
        spell,
        state.hunt.lureCount || state.hunt.lure || 1
      );
      const spellName=String(spell.name || '').toLowerCase();
      const forwardWave=
        spell.targetMode === 'wave' ||
        /kamehameha|wave|beam|cannon/.test(spellName);
      const multiTarget=
        spell.targetMode === 'area' || forwardWave;

      let targets;
      if(forwardWave && primaryTarget){
        const px=state.hunt.arena.playerX;
        const py=state.hunt.arena.playerY;
        const dx=primaryTarget.x-px;
        const dy=primaryTarget.y-py;
        const length=Math.max(1,Math.hypot(dx,dy));
        const ux=dx/length;
        const uy=dy/length;
        const rangePixels=Math.max(13.5,Number(spell.range || 3)*4.5);
        targets=orderedTargets.filter(enemy => {
          const ex=enemy.x-px;
          const ey=enemy.y-py;
          const forward=ex*ux+ey*uy;
          const sideways=Math.abs(ex*uy-ey*ux);
          return forward>=0 &&
            forward<=rangePixels &&
            sideways<=6.75;
        }).slice(0,limit);
      }else{
        targets=multiTarget
          ? orderedTargets.slice(0,limit)
          : primaryTarget
            ? [primaryTarget]
            : [];
      }

      if (spell.aggressive && !targets.length) {
        return {ok:false, message:'Nenhum alvo disponível.'};
      }

      const char = character();
      const castDirection = directionToTarget(primaryTarget);
      state.hunt.arena.direction = castDirection;
      const hitPlan=spellHitPlan({
        spell,
        state,
        character:char,
        direction:castDirection
      });

      let totalDamage = 0;
      let totalHealing = 0;
      const now = Date.now();

      scheduleSourceVisualEvents(spell, primaryTarget);

      for (const hit of hitPlan) {
        const delayMs = Math.max(0, Number(hit.delayMs || 0));

        if (hit.healing || spell.runtimeKind === 'healing') {
          totalHealing += hit.value;
          scheduleSpellAction(delayMs, () => {
            const currentHp = state.hunt.running
              ? Number(state.hunt.playerHp || 0)
              : Number(state.profile.hp || 0);
            const maxHp = state.hunt.running
              ? Number(state.hunt.playerMaxHp || state.profile.maxHp || 1)
              : Number(state.profile.maxHp || 1);
            const healedHp = Math.min(maxHp, currentHp + hit.value);
            state.hunt.playerHp = healedHp;
            state.profile.hp = healedHp;
            pushSpellHitVisual(spell, hit, null, castDirection);
            onUpdate();
          });
          continue;
        }

        if (!spell.aggressive) {
          scheduleSpellAction(delayMs, () => {
            pushSpellHitVisual(spell, hit, primaryTarget, castDirection);
            onUpdate();
          });
          continue;
        }

        // Extra source combats can be visual-only animation stages. Keep
        // their visuals/timeline, but never convert them into 1-point hits.
        if (hit.dealsDamage === false) {
          scheduleSpellAction(delayMs, () => {
            pushSpellHitVisual(spell, hit, primaryTarget, castDirection);
            onUpdate();
          });
          continue;
        }

        const damageEntries = targets.map(enemy => {
          const advantage = levelAdvantage(
            state.profile.level,
            Number(zone()?.level || 1)
          );
          const finalSpellDamage = Math.max(
            1,
            Math.floor(hit.value * advantage)
          );
          totalDamage += finalSpellDamage;
          return {
            enemy,
            targetUid:enemy.uid,
            damage:finalSpellDamage
          };
        });

        scheduleSpellAction(delayMs, () => {
          const visualTarget = damageEntries.find(entry =>
            entry.enemy.uid === entry.targetUid &&
            entry.enemy.alive &&
            entry.enemy.hp > 0
          )?.enemy || primaryTarget;

          // A source combat produces its visual once per doCombat call.
          // Damage may reach several enemies inside that area, but the
          // effect matrix itself must not be duplicated once per target.
          pushSpellHitVisual(spell, hit, visualTarget, castDirection);

          for (const entry of damageEntries) {
            const {enemy,targetUid,damage} = entry;
            // A spell carregada não deve acertar um monstro novo que
            // renasceu no mesmo slot enquanto o efeito estava pendente.
            if (enemy.uid !== targetUid || !enemy.alive || enemy.hp <= 0) {
              continue;
            }

            pushDamageNumber(enemy, damage, false);
            const hitAt=Date.now();
            const partyHandled = onEnemyDamaged?.({
              enemy,damage,zoneId:state.hunt.zoneId,at:hitAt,source:'spell'
            });
            if (!partyHandled) {
              enemy.hp -= damage;
              if (enemy.hp <= 0) defeatEnemy(enemy, hitAt);
            }
          }
          onUpdate();
        });
      }

      const appliedBuffs = applySpellBuffs(
        state,
        spell,
        now
      );

      gainSkill(
        state,
        'kiLevel',
        kiLevelTriesForSpell(spell,hitPlan),
        (skillId,level) => onLog?.(
          `${skillId} avançou para ${level}.`
        )
      );

      onUpdate();
      return {
        ok:true,
        damage:totalDamage,
        healing:totalHealing,
        targets:targets.length,
        hits:hitPlan.length,
        buffs:appliedBuffs
      };
    },
    useConsumable(itemId) {
      const result = applyConsumable(itemId);
      onUpdate();
      return result;
    },
    consumableCooldownRemaining(itemId){
      const item=itemCatalog[itemId];
      return item?.consumableKind==='senzu'||/senzu/i.test(String(item?.name||''))?senzuCooldownRemaining():0;
    },
    currentCorpses() {
      return state.hunt.corpses || [];
    },
    resetAnalyser() {
      return resetAnalyser();
    },
    dropItemOnHunt(itemId, quantity = 1) {
      const item = itemCatalog[itemId];
      if (!item) return false;
      state.hunt.corpses ||= [];
      state.hunt.corpses.push({
        id:`ground-hunt-${Date.now()}-${uidCounter++}`,
        monsterName:'Item no chão',
        x:state.hunt.arena.playerX,
        y:state.hunt.arena.playerY,
        createdAt:Date.now(),
        expiresAt:Date.now() + CORPSE_LIFETIME_MS,
        corpseServerId:null,
        loot:[{itemId, quantity}]
      });
      onUpdate();
      return true;
    },
    lootCorpse(corpseId) {
      const corpse = (state.hunt.corpses || []).find(entry =>
        entry.id === corpseId
      );
      if (!corpse) return false;
      const remaining = [];
      for (const loot of corpse.loot) {
        const result = addItemToInventory(
          state,
          loot.itemId,
          loot.quantity,
          itemCatalog,
          null,
          loot.instanceId ? loot : null,
          {respectLootFilter:true}
        );
        if (!result.ok) remaining.push(loot);
      }
      corpse.loot = remaining;
      if (!remaining.length) {
        state.hunt.corpses = state.hunt.corpses.filter(entry =>
          entry.id !== corpseId
        );
        onLog(`O corpo de ${corpse.monsterName} foi saqueado.`);
      } else {
        onLog('Ainda não há espaço suficiente na backpack.');
      }
      onUpdate();
      return true;
    },
    eligibleMonsters: monsterPool,
    maxPlayerHp,
    combatStats,
    respawnMs: RESPAWN_MS,
    destroy() {
      clearInterval(interval);
      for (const timer of spellTimers) clearTimeout(timer);
      spellTimers.clear();
    }
  };
}
