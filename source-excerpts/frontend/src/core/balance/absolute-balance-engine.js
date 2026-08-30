import { skillRates } from '../../data/generated/skill-rates-v2015.js';
import { absoluteBalance } from '../../data/generated/absolute-balance.js';
import { activeTransformationPath, currentTransformationForm, transformationRoute } from '../transformations/transformation-engine.js';

const clamp = (value, min, max) =>
  Math.max(min, Math.min(max, value));

// V21.25.17 — progressao de poder por transformacao.
//
// Os dados originais mudam a vocation a cada forma, mas varias vocations
// possuem growth identico e os coeficientes de dano sao comprimidos pela
// formula de compatibilidade. Na pratica, algumas transformacoes quase nao
// eram perceptiveis. Este bonus e deliberadamente pequeno e acumulativo:
// cada forma avancada acrescenta +4% de dano, +2% de defesa e +1,5% de HP/KI.
// Ele e calculado pela posicao real da forma na cadeia do personagem, entao
// funciona igualmente para vocations normais, VIP, Quest e pos-Reborn.
export function transformationStep(state, character = null) {
  const forms = Array.isArray(character?.forms) ? character.forms : [];
  if (!forms.length) return 0;

  const current = currentTransformationForm(state,character);
  const explicitStep = Number(current?.powerStep);
  if (Number.isFinite(explicitStep) && explicitStep >= 0) {
    return Math.max(0,Math.trunc(explicitStep));
  }

  const formId = String(state?.profile?.formId || '');
  const vocationId = Number(state?.profile?.vocationSourceId || 0);
  let index = -1;
  if (formId) index = forms.findIndex(form => String(form?.id || '') === formId);
  if (index < 0 && vocationId > 0) {
    index = forms.findIndex(form => Number(form?.vocationId || 0) === vocationId);
  }
  return Math.max(0,index);
}

function transformationPowerForms(state,character) {
  const forms = Array.isArray(character?.forms) ? character.forms : [];
  if (!character?.wodboPaths) return forms;
  const path = activeTransformationPath(state,character) || 'normal';
  const normal = transformationRoute(character,'normal');
  if (path === 'normal') return normal;
  return [...normal,...transformationRoute(character,path)];
}

export function transformationDamageMultiplier(state, character = null) {
  return 1 + transformationStep(state, character) * 0.04;
}

export function transformationDefenseMultiplier(state, character = null) {
  return 1 + transformationStep(state, character) * 0.02;
}

export function transformationResourceMultiplier(state, character = null) {
  return 1 + transformationStep(state, character) * 0.015;
}

export function transformationDamageBonusPercent(state, character = null) {
  return Math.round((transformationDamageMultiplier(state, character) - 1) * 100);
}


export function transformationPeakFormula(
  state,
  character,
  field,
  fallback = 1
) {
  const forms = transformationPowerForms(state,character);
  const step = transformationStep(state, character);
  let peak = Math.max(0, Number(fallback) || 0);
  for (const form of forms) {
    const formStep = Number.isFinite(Number(form?.powerStep))
      ? Number(form.powerStep)
      : forms.indexOf(form);
    if (formStep > step) continue;
    const vocation = vocationRecord(form?.vocationId);
    const value = Number(vocation?.formula?.[field]);
    if (Number.isFinite(value) && value > peak) peak = value;
  }
  return peak > 0 ? peak : fallback;
}

export function transformationPeakGrowth(
  state,
  character,
  field,
  fallback = 0
) {
  const forms = transformationPowerForms(state,character);
  const step = transformationStep(state, character);
  let peak = Math.max(0, Number(fallback) || 0);
  for (const form of forms) {
    const formStep = Number.isFinite(Number(form?.powerStep))
      ? Number(form.powerStep)
      : forms.indexOf(form);
    if (formStep > step) continue;
    const vocation = vocationRecord(form?.vocationId);
    const value = Number(vocation?.growth?.[field]);
    if (Number.isFinite(value) && value > peak) peak = value;
  }
  return peak;
}

export function vocationRecord(vocationId) {
  return absoluteBalance.vocations[String(Number(vocationId))] || null;
}

export function activeVocation(state, character = null) {
  return vocationRecord(
    state.profile.vocationSourceId ||
    character?.vocationSourceId ||
    character?.forms?.[0]?.vocationId ||
    0
  );
}

export function experienceMultiplier(level, worldId = 0) {
  const numericLevel = Math.max(1, Number(level) || 1);
  const stage = absoluteBalance.experienceStages.find(entry =>
    entry.worldId === Number(worldId) &&
    numericLevel >= entry.minLevel &&
    (entry.maxLevel == null || numericLevel <= entry.maxLevel)
  );
  return stage
    ? stage.multiplier * stage.worldMultiplier
    : 1;
}

export function maxResources(state, character, equipment = {}) {
  const vocation = activeVocation(state, character);
  const level = Math.max(1, Number(state.profile.level) || 1);
  const formResourceMultiplier = transformationResourceMultiplier(state, character);

  const fallbackHp = Number(character?.base?.hp || 120);
  const fallbackKi = Number(character?.base?.ki || 100);
  const gainHp = transformationPeakGrowth(
    state, character, 'gainhp', Number(vocation?.growth?.gainhp || 0)
  );
  const gainKi = transformationPeakGrowth(
    state, character, 'gainmana', Number(vocation?.growth?.gainmana || 0)
  );
  const gainCapacity = transformationPeakGrowth(
    state, character, 'gaincap', Number(vocation?.growth?.gaincap || 0)
  );

  if (!vocation) {
    const hpRank=Math.max(0,Number(state.bestiary?.upgrades?.hp||0));
    const kiRank=Math.max(0,Number(state.bestiary?.upgrades?.ki||0));
    return {
      maxHp:Math.round((fallbackHp + (level - 1) * 8 + Number(equipment.hp || 0)) * (1 + hpRank * 0.01) * formResourceMultiplier),
      maxKi:Math.round((fallbackKi + (level - 1) * 5 + Number(equipment.ki || 0)) * (1 + kiRank * 0.01) * formResourceMultiplier),
      capacity:Number(state.profile.capacity || 420)
    };
  }

  const hpRank=Math.max(0,Number(state.bestiary?.upgrades?.hp||0));
  const kiRank=Math.max(0,Number(state.bestiary?.upgrades?.ki||0));
  return {
    maxHp:Math.round((
      fallbackHp +
      (level - 1) * gainHp +
      Number(equipment.hp || 0)
    ) * (1 + hpRank * 0.01) * formResourceMultiplier),
    maxKi:Math.round((
      fallbackKi +
      (level - 1) * gainKi +
      Number(equipment.ki || 0)
    ) * (1 + kiRank * 0.01) * formResourceMultiplier),
    capacity:
      Number(state.profile.capacity || 0) +
      (level - 1) * gainCapacity
  };
}

export function vocationFormula(state, character, field, fallback = 1) {
  const vocation = activeVocation(state, character);
  const value = Number(vocation?.formula?.[field]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function vocationSkillMultiplier(
  state,
  character,
  serverSkill,
  fallback = 1
) {
  const vocation = activeVocation(state, character);
  const value = Number(vocation?.skills?.[serverSkill]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function skillStageRate(serverSkill, level) {
  const stages = absoluteBalance.skillStages[serverSkill] || [];
  let rate = 1;
  for (const stage of stages) {
    if (Number(level) >= stage.minLevel) rate = stage.rate;
    else break;
  }
  const globalRate = serverSkill === 'magicLevel'
    ? Number(skillRates.rateMagic || 1)
    : Number(skillRates.rateSkill || 1);
  return Math.max(0, rate * globalRate);
}

export function attackIntervalMs(state, character, equipment = {}) {
  const vocation = activeVocation(state, character);
  const source = Number(vocation?.growth?.attackspeed || 1200);
  const itemReduction = Number(equipment.attackSpeed || 0);
  const agility = Number(state.skills?.agility?.level || 1);
  const attackSpeed = Number(state.skills?.attackSpeed?.level || 1);

  return Math.max(
    200,
    Math.round(
      source -
      itemReduction -
      Math.max(0, attackSpeed - 1) * 3 -
      Math.max(0, agility - 1) * 0.5
    )
  );
}

export function criticalChance(state, equipment = {}) {
  const storageEquivalent =
    Number(state.skills?.critical?.level || 1) - 1 +
    Number(equipment.crit || 0) * 10;
  const scriptChance =
    storageEquivalent *
    Number(absoluteBalance.critical.chancePerStoragePoint || 0);

  const configChance =
    Number(absoluteBalance.serverConfig.criticalHitChance || 0) / 100;

  const bestiaryCritical=Math.max(0,Number(state.bestiary?.upgrades?.critical||0))*0.0015;
  const bossBestiaryCritical=Math.max(0,Number(state.bestiary?.bossUpgrades?.critical||0))*0.0020;
  return clamp(Math.max(scriptChance, configChance) + bestiaryCritical + bossBestiaryCritical, 0, 1);
}

export function criticalMultiplier() {
  return Math.max(
    Number(absoluteBalance.critical.damageMultiplier || 2),
    Number(absoluteBalance.serverConfig.criticalHitMultiplier || 1)
  );
}

export function deathLossPercent(state, character) {
  const vocation = activeVocation(state, character);
  const base = Number(
    absoluteBalance.serverConfig.deathLostPercent || 15
  );
  const lessLoss = Number(vocation?.growth?.lessloss || 0);
  return clamp(base * (1 - lessLoss / 100), 0, 100);
}

export function compatibleDamage({
  state,
  character,
  style,
  skillLevel,
  level,
  equipmentAttack = 0,
  techniquePower = 0,
  randomFactor = 1
}) {
  const formulaField = style === 'ki'
    ? 'distDamage'
    : style === 'magic'
      ? 'magDamage'
      : 'meleeDamage';

  const currentCoefficient = vocationFormula(
    state,
    character,
    formulaField,
    1
  );
  const coefficient = transformationPeakFormula(
    state,
    character,
    formulaField,
    currentCoefficient
  );

  // The XML coefficient remains authoritative, but a later transformation
  // never falls below the best coefficient already reached by that same
  // character chain. This prevents Reborn/source vocation resets from making
  // a visually stronger form deal less damage than the previous one.
  // The XML coefficient is authoritative. The expression below is the
  // browser adapter because the original TFS executable formula is not
  // available as source code.
  const coefficientScale = Math.log10(coefficient + 1) + 1;
  const base =
    Number(techniquePower || 0) +
    Number(level || 1) * 0.75 +
    Number(skillLevel || 1) * 0.65 +
    Number(equipmentAttack || 0);

  const formDamageMultiplier = transformationDamageMultiplier(state, character);
  return Math.max(
    1,
    Math.round(
      base * coefficientScale * Number(randomFactor || 1) * formDamageMultiplier
    )
  );
}

export function compatibleHealing({
  state,
  character,
  skillLevel,
  level,
  equipmentPower = 0,
  techniquePower = 0
}) {
  const coefficient = vocationFormula(
    state,
    character,
    'magHealingDamage',
    1
  );
  const scale = Math.log10(coefficient + 1) + 1;

  return Math.max(
    1,
    Math.round(
      (
        Number(techniquePower || 0) +
        Number(level || 1) * 0.7 +
        Number(skillLevel || 1) * 0.8 +
        Number(equipmentPower || 0)
      ) * scale
    )
  );
}

export function defenseValues(
  state,
  character,
  equipment,
  defenseSkill,
  barrierSkill
) {
  const physicalCoefficient = transformationPeakFormula(
    state,
    character,
    'defense',
    vocationFormula(state, character, 'defense', 1)
  );
  const magicCoefficient = transformationPeakFormula(
    state,
    character,
    'magDefense',
    vocationFormula(state, character, 'magDefense', 1)
  );
  const armorCoefficient = transformationPeakFormula(
    state,
    character,
    'armor',
    vocationFormula(state, character, 'armor', 1)
  );

  const formDefenseMultiplier = transformationDefenseMultiplier(state, character);
  return {
    physical:(
      Number(defenseSkill || 1) * physicalCoefficient +
      Number(equipment.defense || 0) * armorCoefficient
    ) * formDefenseMultiplier,
    ki:(
      Number(barrierSkill || 1) * magicCoefficient +
      Number(equipment.kiResistance || 0)
    ) * formDefenseMultiplier,
  };
}
