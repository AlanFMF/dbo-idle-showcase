import { defaultSkills, normalizeSkills } from './skills/skills.js';
import {
  createContainer,
  normalizeInventoryState
} from './inventory/containers.js';

const LEGACY_KEY = 'dbo-idle-v12-12-save';
const EARTH_SPAWN = { x: 99, y: 189, z: 7, direction: 2 };

export function createCharacterState({
  name = 'Guerreiro',
  characterId = 'goku'
} = {}) {
  const backpack = createContainer('starter_backpack', 20);
  backpack.items = [
    {itemId:'server_12775', quantity:100},
    {itemId:'server_12776', quantity:100},
    {itemId:'starter_gloves', quantity:1},
    {itemId:'starter_sword', quantity:1},
    {itemId:'starter_blaster', quantity:1}
  ];
  const depot = createContainer('depot', 400);
  const vipDepots = [1,2,3].map(n=>createContainer(`vip_depot_${n}`,400));
  return {
    version: 2032,
    profile: {
      id: crypto.randomUUID?.() || String(Date.now()),
      name,
      characterId,
      level: 1,
      xp: 0,
      bank: 0,
      zenis: 0,
      premiumPoints: 0,
      vipUntil: 0, xpBoostUntil: 0, lootBoostUntil: 0, gamePass: false, supplyLastBoughtAt: 0, dailyLoginStreak: 0,
      vipCredits: 0,
      hp: 120,
      maxHp: 120,
      ki: 100,
      maxKi: 100,
      capacity: 420,
      deaths: 0,
      profileIcon:'default',
      profileBorder:'default',
      unlockedProfileIcons:['default'],
      unlockedProfileBorders:['default'],
      mailbox:[]
    },
    skills: defaultSkills(),
    temple: { ...EARTH_SPAWN },
    hunt: {
      zoneId: 'earth-outskirts',
      lureCount: 1,
      running: false,
      monsterIndex: 0,
      playerHp: null,
      playerMaxHp: null,
      lastTick: Date.now(),
      enemies: [],
      effects: [],
      corpses: [],
      lootFilter: { ignored: [] },
      favoriteZoneIds: [],
      pendingLureCount: null,
      lastSwitchAt: 0,
      waveGeneration: 0,
      arena: {
        playerX: 50,
        playerY: 52,
        direction: 1,
        phase: 'paused',
        targetId: null
      }
    },
    training:{
      running:false,
      roomId:'punching-bag',
      playerX:32,
      playerY:54,
      playerDirection:1,
      targetX:68,
      targetY:52,
      targetHp:100000,
      targetMaxHp:100000,
      targetAlive:true,
      targetRespawnAt:0,
      effects:[]
    },
    rebornQuest:{
      started:false,
      stage:0,
      readyForReborn:false,
      completed:false
    },
    questStorages:{},
    completedQuests:[],
    bestiary:{kills:{},upgrades:{hp:0,ki:0,critical:0,defense:0,barrier:0},bossKills:{},bossUpgrades:{critical:0,strength:0,distance:0}},
    progressionQuest:{activeQuestId:null,x:0,y:0,clearedGuards:[],completed:[],startedAt:0,deadlineAt:0},
    forge:{pending:null,lastResult:null,history:[],totalSpent:0},
    containers: {
      [backpack.id]: backpack,
      [depot.id]: depot,
      ...Object.fromEntries(vipDepots.map(container=>[container.id,container]))
    },
    depotContainerId: depot.id,
    vipDepotContainerIds: vipDepots.map(container=>container.id),
    inventory: [],
    equipment: {
      helmet:'starter_helmet',
      necklace:null,
      backpack:backpack.id,
      armor:'starter_armor',
      weapon:null,
      offhand:null,
      legs:'starter_legs',
      boots:'starter_boots',
      ring:null,
      ammo:null
    },
    chat: [],
    supportSpellCooldowns:{buff:0,speed:0},
    settings: {
      sound:false,
      classicInterface:true,
      spellBar:{
        slots:Array(4).fill(null),
        enabled:Array(4).fill(true),
        auto:Array(4).fill(false),
        minTargets:Array(4).fill(1),
        support:{
          buff:{spellId:null,auto:false},
          speed:{spellId:null,auto:false},
          healing:{spellId:null,auto:false,threshold:75},
          aggro:{spellId:'guardian-taunt',auto:false},
        }
      },
      autoConsumables:{
        hp:{enabled:false,threshold:50,itemId:'server_12775'},
        ki:{enabled:false,threshold:50,itemId:'server_12776'},
        senzu:{enabled:false,hpThreshold:75,kiThreshold:75,itemId:'server_12777',autoBest:false}
      },
      containerWindowPositions:{
        backpack:null,
        depot:null
      }
    }
  };
}

export function defaultState() {
  return createCharacterState();
}

function migrateHunt(base, oldHunt = {}) {
  return {
    ...base,
    ...oldHunt,
    enemies: Array.isArray(oldHunt.enemies) ? oldHunt.enemies : [],
    effects: Array.isArray(oldHunt.effects) ? oldHunt.effects : [],
    corpses: Array.isArray(oldHunt.corpses) ? oldHunt.corpses : [],
    lootFilter: {
      ignored:Array.isArray(oldHunt.lootFilter?.ignored)
        ? oldHunt.lootFilter.ignored
        : []
    },
    arena: { ...base.arena, ...(oldHunt.arena || {}) }
  };
}

export function migrateCharacterState(value) {
  const base = createCharacterState({
    name:value?.profile?.name || 'Guerreiro',
    characterId:value?.profile?.characterId || 'goku'
  });
  if (!value) return base;

  const legacySword = value.skills?.sword || null;
  const migrated = {
    ...base,
    ...value,
    version:2032,
    profile:{
      ...base.profile,
      ...value.profile,
      bank:Number(value.profile?.bank ?? value.profile?.zenis ?? 0),
      premiumPoints:Number(value.profile?.premiumPoints ?? value.profile?.vipCredits ?? 0),
      vipCredits:Number(value.profile?.premiumPoints ?? value.profile?.vipCredits ?? 0),
      vipUntil:Number(value.profile?.vipUntil||0), xpBoostUntil:Number(value.profile?.xpBoostUntil||0), lootBoostUntil:Number(value.profile?.lootBoostUntil||0), gamePass:Boolean(value.profile?.gamePass), supplyLastBoughtAt:Number(value.profile?.supplyLastBoughtAt||0), dailyLoginStreak:Number(value.profile?.dailyLoginStreak||0),
      zenis:0
    },
    skills:normalizeSkills(value.skills),
    temple:{...base.temple, ...(value.temple || {})},
    hunt:migrateHunt(base.hunt, value.hunt),
    rebornQuest:{
      ...base.rebornQuest,
      ...(value.rebornQuest || {})
    },
    questStorages:{
      ...base.questStorages,
      ...(value.questStorages || {})
    },
    completedQuests:Array.isArray(value.completedQuests)
      ? value.completedQuests
      : [],
    bestiary:{
      ...base.bestiary,
      ...(value.bestiary || {}),
      kills:{...(base.bestiary.kills||{}),...(value.bestiary?.kills||{})},
      upgrades:{...(base.bestiary.upgrades||{}),...(value.bestiary?.upgrades||{})},
      bossKills:{...(base.bestiary.bossKills||{}),...(value.bestiary?.bossKills||{})},
      bossUpgrades:{...(base.bestiary.bossUpgrades||{}),...(value.bestiary?.bossUpgrades||{})}
    },
    progressionQuest:{
      ...base.progressionQuest,
      ...(value.progressionQuest || {}),
      clearedGuards:Array.isArray(value.progressionQuest?.clearedGuards)?value.progressionQuest.clearedGuards:[],
      completed:Array.isArray(value.progressionQuest?.completed)?value.progressionQuest.completed:[]
    },
    forge:{
      pending:value.forge?.pending?structuredClone(value.forge.pending):null,
      lastResult:value.forge?.lastResult?structuredClone(value.forge.lastResult):null,
      history:Array.isArray(value.forge?.history)?structuredClone(value.forge.history).slice(-50):[],
      totalSpent:Math.max(0,Number(value.forge?.totalSpent||0))
    },
    settings:{
      ...base.settings,
      ...(value.settings || {}),
      spellBar:{
        slots:Array.from(
          {length:4},
          (_, index) => value.settings?.spellBar?.slots?.[index] || null
        ),
        enabled:Array.from(
          {length:4},
          (_, index) => value.settings?.spellBar?.enabled?.[index] !== false
        ),
        auto:Array.from(
          {length:4},
          (_, index) => value.settings?.spellBar?.auto?.[index] === true
        ),
        minTargets:Array.from(
          {length:4},
          (_, index) => {
            const valueAtIndex=Number(
              value.settings?.spellBar?.minTargets?.[index] || 1
            );
            return Math.max(1,Math.min(5,valueAtIndex));
          }
        ),
        support:{
          buff:{
            spellId:value.settings?.spellBar?.support?.buff?.spellId || null,
            auto:value.settings?.spellBar?.support?.buff?.auto === true
          },
          speed:{
            spellId:value.settings?.spellBar?.support?.speed?.spellId || null,
            auto:value.settings?.spellBar?.support?.speed?.auto === true
          },
          healing:{
            spellId:value.settings?.spellBar?.support?.healing?.spellId || null,
            auto:value.settings?.spellBar?.support?.healing?.auto === true,
            threshold:[25,50,75,90].includes(
              Number(value.settings?.spellBar?.support?.healing?.threshold)
            )
              ? Number(value.settings.spellBar.support.healing.threshold)
              : 75
          },
          aggro:{
            spellId:value.settings?.spellBar?.support?.aggro?.spellId || 'guardian-taunt',
            auto:false
          }
        }
      },
      autoConsumables:{
        ...base.settings.autoConsumables,
        ...(value.settings?.autoConsumables || {}),
        hp:{
          ...base.settings.autoConsumables.hp,
          ...(value.settings?.autoConsumables?.hp || {}),
          itemId:value.settings?.autoConsumables?.hp?.itemId || 'server_12775'
        },
        ki:{
          ...base.settings.autoConsumables.ki,
          ...(value.settings?.autoConsumables?.ki || {}),
          itemId:value.settings?.autoConsumables?.ki?.itemId || 'server_12776'
        },
        senzu:{
          ...base.settings.autoConsumables.senzu,
          ...(value.settings?.autoConsumables?.senzu || {}),
          hpThreshold:Number(value.settings?.autoConsumables?.senzu?.hpThreshold ?? value.settings?.autoConsumables?.senzu?.threshold ?? 75),
          kiThreshold:Number(value.settings?.autoConsumables?.senzu?.kiThreshold ?? value.settings?.autoConsumables?.senzuKi?.threshold ?? 75),
          enabled:Boolean(value.settings?.autoConsumables?.senzu?.enabled || value.settings?.autoConsumables?.senzuKi?.enabled),
          itemId:value.settings?.autoConsumables?.senzu?.itemId || value.settings?.autoConsumables?.senzuKi?.itemId || 'server_12777',
          autoBest:Boolean(value.settings?.autoConsumables?.senzu?.autoBest)
        }
      },
      containerWindowPositions:{
        backpack:value.settings?.containerWindowPositions?.backpack || null,
        depot:value.settings?.containerWindowPositions?.depot || null
      }
    },
    equipment:{
      ...base.equipment,
      ...(value.equipment || {}),
      shield:undefined
    }
  };

  if (legacySword) {
    const strength = migrated.skills.gloves;
    strength.level = Math.max(
      strength.level,
      Number(legacySword.level) || 1
    );
    strength.tries += Number(legacySword.tries) || 0;
  }
  delete migrated.skills.sword;

  if (migrated.equipment.shield) {
    migrated.equipment.offhand = null;
    delete migrated.equipment.shield;
  }

  normalizeInventoryState(migrated);

  // V20.29: previous builds accidentally mapped Rose Senzu to server_2155
  // (green gem). The real Absolute item is server_2151 / sprite 39707.
  if (Number(value.version || 0) < 2029) {
    for (const container of Object.values(migrated.containers || {})) {
      for (const entry of container.items || []) {
        if (entry.itemId === 'server_2155') entry.itemId = 'server_2151';
      }
    }
    for (const entry of migrated.groundLoot || []) {
      if (entry.itemId === 'server_2155') entry.itemId = 'server_2151';
    }
    if (migrated.settings?.autoConsumables?.senzu?.itemId === 'server_2155') {
      migrated.settings.autoConsumables.senzu.itemId = 'server_2151';
    }
    if (migrated.settings?.autoConsumables?.senzuKi?.itemId === 'server_2155') {
      migrated.settings.autoConsumables.senzuKi.itemId = 'server_2151';
    }
  }

  if (!value.starterCombatKitGranted) {
    const backpack = migrated.containers[migrated.equipment.backpack];
    const starterEntries = [
      ['server_12775', 100],
      ['server_12776', 100],
      ['starter_gloves', 1],
      ['starter_sword', 1],
      ['starter_blaster', 1]
    ];
    // O jogador pode deixar o slot de Backpack vazio. Não recrie nem force
    // uma mochila apenas para aplicar o kit legado; marque a migração como
    // concluída e deixe os itens existentes intactos.
    if (backpack) {
      for (const [itemId, quantity] of starterEntries) {
        const existing = Object.values(migrated.containers).find(container =>
          container.items.some(entry => entry.itemId === itemId)
        );
        const equipped = Object.values(migrated.equipment).includes(itemId);
        if (!existing && !equipped && backpack.items.length < backpack.capacity) {
          backpack.items.push({itemId, quantity});
        }
      }
    }
    migrated.starterCombatKitGranted = true;
  }

  if (
    !value.containers &&
    Array.isArray(value.inventory) &&
    value.inventory.length
  ) {
    const backpack = migrated.containers[migrated.equipment.backpack];
    if (backpack) {
      backpack.items = value.inventory.map(entry => ({
        itemId:entry.itemId,
        quantity:Number(entry.quantity) || 1
      }));
    }
  }
  return migrated;
}

export function loadLegacyCharacter() {
  try {
    const old = JSON.parse(localStorage.getItem(LEGACY_KEY));
    return old ? migrateCharacterState(old) : null;
  } catch {
    return null;
  }
}

export function loadState(state = null) {
  return migrateCharacterState(state);
}

export function resetToEarth(state) {
  state.temple = { ...EARTH_SPAWN };
}

export function saveState(state) {
  return state;
}
