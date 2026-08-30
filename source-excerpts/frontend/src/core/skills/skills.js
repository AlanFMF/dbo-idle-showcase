import {
  attackIntervalMs,
  compatibleDamage,
  criticalChance as absoluteCriticalChance,
  defenseValues,
  experienceMultiplier,
  skillStageRate,
  vocationSkillMultiplier
} from '../balance/absolute-balance-engine.js?v=22.4.4';
import {
  activeSkillBonus
} from '../spells/authoritative-spell-runtime.js?v=22.4.4';
export const skillDefinitions = {
  agility: {
    name: 'Agility',
    short: 'AGI',
    description: 'Aumenta a velocidade de movimento e concede um pequeno bônus de velocidade ao ataque básico.'
  },
  attackSpeed: {
    name: 'Atk Speed',
    short: 'AS',
    description: 'Reduz o intervalo do ataque básico. Evolui apenas com luvas de treino.'
  },
  kiLevel: {
    name: 'Ki Level',
    short: 'KI',
    description: 'Aumenta o dano das magias de Ki em 0,5% por nível acima de 1 (até +150%).'
  },
  gloves: {
    name: 'Strength',
    short: 'STR',
    description: 'Atributo base de dano melee. Evolui com treino e ataques usando luvas.'
  },
  kiBlasting: {
    name: 'Ki Blasting',
    short: 'KIB',
    description: 'Aumenta a eficiência de ataques à distância realizados com itens de Ki.'
  },
  defense: {
    name: 'Defense',
    short: 'DEF',
    description: 'Reduz dano físico melee e à distância.'
  },
  barrier: {
    name: 'Barrier',
    short: 'BAR',
    description: 'Reduz dano de magias e ataques baseados em Ki.'
  },
  critical: {
    name: 'Critical',
    short: 'CRT',
    description: 'Aumenta a chance de crítico. Evolui apenas por itens equipados e consumíveis específicos.'
  }
};

export function defaultSkills() {
  return Object.fromEntries(
    Object.keys(skillDefinitions).map(id => [
      id,
      { level: 1, tries: 0 }
    ])
  );
}

export function skillTriesRequired(level) {
  return Math.max(20, Math.floor(35 * Math.pow(level, 1.42)));
}

export function normalizeSkills(skills = {}) {
  const base = defaultSkills();
  for (const id of Object.keys(base)) {
    const current = skills[id] || {};
    base[id] = {
      level: Math.max(1, Math.floor(Number(current.level) || 1)),
      tries: Math.max(0, Number(current.tries) || 0)
    };
  }
  return base;
}

const serverSkillByIdleSkill = {
  // Strength represents gloves and swords in the Idle. Using club avoids
  // the original fist cap at level 50, which belongs to Atk Speed.
  gloves:'club',
  attackSpeed:'fist',
  kiBlasting:'distance',
  defense:'shielding',
  barrier:'shielding',
  agility:'fishing',
  kiLevel:'magicLevel',
  critical:'fishing'
};

export function serverSkillForIdleSkill(skillId) {
  return serverSkillByIdleSkill[skillId] || 'club';
}

export function effectiveSkillRate(skillId, skillLevel) {
  return skillStageRate(
    serverSkillForIdleSkill(skillId),
    Math.max(1,Number(skillLevel || 1))
  );
}

export function gainSkill(state, skillId, tries, onLevelUp) {
  if (!state.skills?.[skillId] || tries <= 0) return false;
  // Critical remains item/consumable-only as defined by the game design.
  if (skillId === 'critical') return false;
  const skill = state.skills[skillId];
  const rate = effectiveSkillRate(skillId,skill.level);
  if(rate <= 0) return false;
  skill.tries += tries * rate;
  let leveled = false;

  while (skill.tries >= skillTriesRequired(skill.level)) {
    skill.tries -= skillTriesRequired(skill.level);
    skill.level += 1;
    leveled = true;
    onLevelUp?.(skillId, skill.level);
  }
  return leveled;
}

export function skillProgress(skill) {
  const required = skillTriesRequired(skill.level);
  return {
    required,
    percentage: Math.max(0, Math.min(100, skill.tries / required * 100))
  };
}


export function characterXpRequired(level) {
  return Math.floor(80 * Math.pow(level, 1.45));
}

export function cumulativeCharacterXp(level, currentXp = 0) {
  let total = Math.max(0, Number(currentXp) || 0);
  for (let current = 1; current < Math.max(1, level); current += 1) {
    total += characterXpRequired(current);
  }
  return total;
}

export function characterProgressFromTotal(totalXp) {
  let remaining = Math.max(0, Math.floor(Number(totalXp) || 0));
  let level = 1;
  while (remaining >= characterXpRequired(level)) {
    remaining -= characterXpRequired(level);
    level += 1;
  }
  return { level, xp: remaining };
}

export function characterXpProgress(profile) {
  const required = characterXpRequired(profile.level);
  return {
    required,
    current: profile.xp,
    percentage: Math.max(0, Math.min(100, profile.xp / required * 100))
  };
}

export function cumulativeSkillXp(skill) {
  let total = Math.max(0, Number(skill.tries) || 0);
  for (let current = 1; current < Math.max(1, skill.level); current += 1) {
    total += skillTriesRequired(current);
  }
  return total;
}

export function skillFromTotalXp(totalXp) {
  let remaining = Math.max(0, Number(totalXp) || 0);
  let level = 1;
  while (remaining >= skillTriesRequired(level)) {
    remaining -= skillTriesRequired(level);
    level += 1;
  }
  return { level, tries: remaining };
}


export function experienceRate(level) {
  const current = Math.max(1, Number(level) || 1);
  // V21.22 — redução adicional de ~20% na progressão global. O objetivo é
  // alongar principalmente o mid/end-game sem eliminar a vantagem relativa
  // das Hunts VIP (+20% sobre a Free comparável).
  if (current >= 3000) return 0.004;
  if (current >= 1500) return 0.008;
  if (current >= 1000) return 0.016;
  if (current >= 800) return 0.028;
  if (current >= 600) return 0.048;
  if (current >= 400) return 0.20;
  if (current >= 200) return 0.40;
  return 0.80;
}

export function characterExperienceMultiplier(state, now = Date.now()) {
  const base = experienceRate(state?.profile?.level || 1);
  const vip = Number(state?.profile?.vipUntil || 0) > now ? 0.20 : 0;
  const boost = Number(state?.profile?.xpBoostUntil || 0) > now ? 0.20 : 0;
  // V21.7.0: beneficio persistente da Guild. O backend deriva este valor do
  // level + tecnologias da guilda e o sincroniza no state autoritativo.
  const guild = Math.max(0, Math.min(0.50, Number(state?.profile?.guildBenefits?.xpPercent || 0) / 100));
  return base * (1 + vip + boost + guild);
}

export function applyDeathPenalty(state) {
  const characterTotalBefore = cumulativeCharacterXp(
    state.profile.level,
    state.profile.xp
  );
  const characterLoss = Math.max(
    characterTotalBefore > 0 ? 1 : 0,
    Math.floor(characterTotalBefore * 0.01)
  );
  const characterTotalAfter = Math.max(
    0,
    characterTotalBefore - characterLoss
  );
  const recalculated = characterProgressFromTotal(characterTotalAfter);
  const beforeLevel = state.profile.level;

  state.profile.level = recalculated.level;
  state.profile.xp = recalculated.xp;

  const losses = {};
  for (const [id, skill] of Object.entries(state.skills || {})) {
    const totalBefore = cumulativeSkillXp(skill);
    const lostXp = Math.max(
      totalBefore > 0 ? 1 : 0,
      Math.floor(totalBefore * 0.01)
    );
    const after = skillFromTotalXp(Math.max(0, totalBefore - lostXp));
    const oldLevel = skill.level;
    const oldTries = skill.tries;

    skill.level = after.level;
    skill.tries = after.tries;
    losses[id] = {
      level: oldLevel - skill.level,
      tries: oldTries - skill.tries,
      totalXpLost: lostXp
    };
  }

  return {
    levelLost: beforeLevel - state.profile.level,
    characterXpLost: characterLoss,
    totalXpBefore: characterTotalBefore,
    totalXpAfter: characterTotalAfter,
    losses
  };
}

export function equippedCombatStyle(state, itemCatalog) {
  const weapon = itemCatalog[state.equipment?.weapon];
  const ammo = itemCatalog[state.equipment?.ammo];
  const weaponType = weapon?.sourceAttributes?.weaponType?.toLowerCase() || '';
  const weaponName = weapon?.name?.toLowerCase() || '';

  if (weapon?.trainingSkill === 'attackSpeed') return 'training-gloves';
  if (weapon?.combatStyle) return weapon.combatStyle;
  if (weaponType === 'sword' || weaponName.includes('sword')) return 'sword';
  if (
    weaponName.includes('glove') ||
    weaponName.includes('gauntlet') ||
    weaponName.includes('fist')
  ) return 'gloves';
  if (
    ammo?.combatStyle === 'ki' ||
    weaponType === 'distance' ||
    weaponType === 'ammunition' ||
    weaponName.includes('ki')
  ) return 'ki';
  return 'unarmed';
}




function serverFormulaMultiplier(character, key, fallback = 1) {
  const raw = Number(character?.serverFormula?.[key] || fallback);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  // TFS values are broad coefficients. Log scaling preserves differences
  // without producing millions of browser damage.
  return Math.max(0.65, Math.min(2.5, 0.55 + Math.log10(raw + 1) * 0.72));
}

export function vocationAptitude(character, skillId) {
  const aptitudes = character?.aptitudes || {};
  if (skillId === 'gloves') return Number(aptitudes.strength || 1);
  if (skillId === 'kiBlasting') return Number(aptitudes.kiBlasting || 1);
  if (skillId === 'kiLevel') return Number(aptitudes.kiLevel || 1);
  return 1;
}

export function weaponRange(state, itemCatalog) {
  const weapon = itemCatalog[state.equipment?.weapon];
  const raw = Number(
    weapon?.range ??
    weapon?.sourceAttributes?.range ??
    1
  );
  if (equippedCombatStyle(state, itemCatalog) !== 'ki') return 1.65;
  return Math.max(3, Math.min(10, raw || 5));
}


export function effectiveSkillLevel(
  state,
  equipmentStats,
  skillId
) {
  const trained = state.skills?.[skillId]?.level || 1;
  const bonus =
    equipmentStats.skillBonuses?.[skillId] || 0;
  return trained + bonus;
}

export function techniqueDamage({
  level,
  techniquePower,
  skill,
  equipmentPower = 0,
  vocationPower = 0,
  variance = 1
}) {
  const safeLevel = Math.max(1, Number(level) || 1);
  const safeTechnique = Math.max(0, Number(techniquePower) || 0);
  const safeSkill = Math.max(1, Number(skill) || 1);

  // Weighted additive formula:
  // level supplies progression, technique supplies identity/base power,
  // skill supplies proficiency. No component multiplies the others alone.
  const result =
    safeTechnique +
    safeLevel * 0.82 +
    safeSkill * 0.68 +
    Number(equipmentPower || 0) +
    Number(vocationPower || 0);

  return Math.max(1, result * Number(variance || 1));
}

export function techniqueHealing({
  level,
  techniquePower,
  skill,
  equipmentPower = 0
}) {
  return Math.max(
    1,
    Number(techniquePower || 0) +
    Math.max(1, Number(level) || 1) * 0.7 +
    Math.max(1, Number(skill) || 1) * 0.8 +
    Number(equipmentPower || 0)
  );
}


export function derivedCombatStats(state, character, equipmentStats, itemCatalog) {
  const style = equippedCombatStyle(state, itemCatalog);
  const agility = effectiveSkillLevel(
    state,
    equipmentStats,
    'agility'
  );
  const attackSpeed = effectiveSkillLevel(
    state,
    equipmentStats,
    'attackSpeed'
  );

  let specificSkillId = 'gloves';
  if (style === 'ki') specificSkillId = 'kiBlasting';

  const trainedSpecificSkill = effectiveSkillLevel(
    state,
    equipmentStats,
    specificSkillId
  );
  const specificAptitude = vocationAptitude(
    character,
    specificSkillId
  );
  const specificSkill =
    trainedSpecificSkill * (0.75 + specificAptitude * 0.25);
  const critical = effectiveSkillLevel(
    state,
    equipmentStats,
    'critical'
  );
  const defenseSkill = effectiveSkillLevel(
    state,
    equipmentStats,
    'defense'
  );
  const barrierSkill = effectiveSkillLevel(
    state,
    equipmentStats,
    'barrier'
  );
  const kiLevel = effectiveSkillLevel(
    state,
    equipmentStats,
    'kiLevel'
  );

  const vocationGrowth =
    Number(character.base.attack || 0) +
    Math.max(0, state.profile.level - 1) *
      Number(character.base.attackPerLevel || 1);

  const basicTechniquePower = style === 'ki' ? 5 : 4;
  const bossSkillRank = style === 'ki'
    ? Math.max(0,Number(state.bestiary?.bossUpgrades?.distance||0))
    : Math.max(0,Number(state.bestiary?.bossUpgrades?.strength||0));
  const attack = compatibleDamage({
    state,
    character,
    style:style === 'ki' ? 'ki' : 'melee',
    level:state.profile.level,
    techniquePower:basicTechniquePower,
    skillLevel:specificSkill,
    equipmentAttack:
      Number(equipmentStats.attack || 0) +
      vocationGrowth * 0.42
  }) * (1 + bossSkillRank * 0.01);

  const attackInterval = attackIntervalMs(
    state,
    character,
    equipmentStats
  );

  const movementMultiplier =
    1 +
    Math.max(0, agility - 1) * 0.004 +
    (equipmentStats.speed || 0) * 0.01;

  const vocationDefense =
    Number(character.base.defense || 0) +
    Math.max(0, state.profile.level - 1) *
      Number(character.base.defensePerLevel || 0.5);

  const authoritativeDefense = defenseValues(
    state,
    character,
    equipmentStats,
    defenseSkill,
    barrierSkill
  );

  const bestiaryDefenseRank=Math.max(0,Number(state.bestiary?.upgrades?.defense||0));
  const bestiaryBarrierRank=Math.max(0,Number(state.bestiary?.upgrades?.barrier||0));
  const physicalDefense = (
    authoritativeDefense.physical +
    vocationDefense * 0.35 +
    Number(equipmentStats.physicalResistance || 0) * 0.35 +
    Number(equipmentStats.allResistance || 0) * 0.25
  ) * (1 + bestiaryDefenseRank * 0.01);

  const kiDefense = (
    authoritativeDefense.ki +
    vocationDefense * 0.18 +
    Number(equipmentStats.allResistance || 0) * 0.25
  ) * (1 + bestiaryBarrierRank * 0.01);

  const criticalChance = absoluteCriticalChance(
    state,
    equipmentStats
  );

  return {
    style,
    specificSkillId,
    specificSkill,
    attack,
    attackInterval,
    movementMultiplier,
    physicalDefense,
    kiDefense,
    criticalChance,
    kiLevel,
    basicTechniquePower,
    attackRange:weaponRange(state, itemCatalog),
    specificAptitude
  };
}
