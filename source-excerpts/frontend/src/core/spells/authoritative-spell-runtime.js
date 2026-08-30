import {
  vocationFormula,
  compatibleDamage,
  attackIntervalMs
} from '../balance/absolute-balance-engine.js?v=22.4.4';

function seededRange(min, max, seed = Math.random()) {
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  return low + (high - low) * seed;
}

// --- Spell damage balance -------------------------------------------
// The original per-spell min/max formulas (minA/minB/maxA/maxB) come from
// the source server's Lua scripts, tuned for that server's own player
// power curve. Only formulas of kind COMBAT_FORMULA_LEVELMAGIC scale with
// the caster's level/Ki Level at all — every other spell had a flat,
// level-independent damage range. In practice this meant spells quietly
// fell behind basic attacks after the first few dozen levels (not worth
// their Ki cost or cooldown), while a handful of high level-magic spells
// with many hits per cast (e.g. Final Flash) could deal 10x+ a basic
// attack's DPS and one-shot anything.
//
// To keep every damage spell meaningfully better than autoattack without
// any single spell trivializing the game, real (non-healing) damage spell
// values are re-derived from the caster's own basic melee DPS: each spell
// targets a DPS multiplier of that baseline (ramped by required level, so
// a low-level spell is a modest step up from autoattack while a
// high-level one is a dramatically bigger payoff — a level 30 spell and a
// level 150 spell should not feel interchangeable), then splits that DPS
// across its own cooldown and hit count.
// V20.25 — global spell progression.
//
// The old sqrt curve had one important product-level flaw: after applying
// Explosive's intentional 0.70 free-tier multiplier, a level 50 spell could
// fall below ordinary level 30 techniques.  Explicit anchors make progression
// auditable and guarantee meaningful steps between the server's real spell
// requirement bands while staying close to V20.24's overall power budget.
const SPELL_DPS_TIER_CURVE = Object.freeze([
  [1, 1.50],
  [30, 2.50],
  [50, 3.60],
  [75, 4.15],
  [100, 4.70],
  [150, 5.60],
  [200, 6.50],
  [250, 7.20],
  [400, 8.80],
  [600, 10.50],
  [1000, 12.50]
]);

export function kiLevelDamageMultiplier(state, now = Date.now()) {
  const trained=Math.max(1,Number(state?.skills?.kiLevel?.level||1));
  const temporary=Math.max(0,Number(activeSkillBonus(state,'kiLevel',now)||0));
  const effective=trained+temporary;
  // V21.25.9: +0,5% de dano por Ki Level acima de 1, com teto de +150%.
  // Lv 50 = +24,5% | Lv 100 = +49,5% | Lv 200 = +99,5% | Lv 301+ = +150%.
  return 1 + Math.min(1.5,Math.max(0,effective-1)*0.005);
}

export function spellDpsMultiplier(spell) {
  const requiredLevel = Math.max(1, Number(spell?.level || 1));
  if (requiredLevel <= SPELL_DPS_TIER_CURVE[0][0]) {
    return SPELL_DPS_TIER_CURVE[0][1];
  }

  for (let index = 1; index < SPELL_DPS_TIER_CURVE.length; index += 1) {
    const [level, multiplier] = SPELL_DPS_TIER_CURVE[index];
    const [previousLevel, previousMultiplier] = SPELL_DPS_TIER_CURVE[index - 1];
    if (requiredLevel > level) continue;
    const span = Math.max(1, level - previousLevel);
    const progress = (requiredLevel - previousLevel) / span;
    return previousMultiplier + (multiplier - previousMultiplier) * progress;
  }

  return SPELL_DPS_TIER_CURVE[SPELL_DPS_TIER_CURVE.length - 1][1];
}

function referenceMeleeDps(state, character) {
  const level = Number(state?.profile?.level || 1);
  const vocationGrowth =
    Number(character?.base?.attack || 0) +
    Math.max(0, level - 1) * Number(character?.base?.attackPerLevel || 1);

  const attack = compatibleDamage({
    state,
    character,
    style:'melee',
    level,
    techniquePower:4,
    skillLevel:1,
    equipmentAttack:vocationGrowth * 0.42
  });
  const intervalMs = attackIntervalMs(state, character, {});
  return attack / Math.max(0.2, intervalMs / 1000);
}

function isHealingCombat(combat) {
  return Boolean(combat?.formula?.healing) ||
    combat?.combatType === 'COMBAT_HEALING';
}

// V20.38 — healing spells use an Idle-scale recovery budget instead of the
// raw Absolute LEVELMAGIC coefficients.  The source formulas multiply Ki
// Level by values as high as 1,300; at trained skill levels a basic heal could
// recover more HP than rare Senzus.  Consumables must remain the emergency
// recovery option, while healing spells are sustainable maintenance.
//
// Per-cast targets are intentionally below the Senzu curve from V20.29:
//   Leaf 3,800 / Root 5,200 / Bean 8,000 HP.
// Basic Regeneration never reaches Leaf; the strongest vocation heals remain
// below a normal Senzu Bean.  Area/friend heals are lower per target because
// they provide additional utility.
const HEALING_SPELL_BUDGETS = Object.freeze({
  'regeneration':          Object.freeze({min:1800, max:2600}),
  'heal-friend':           Object.freeze({min:2200, max:3200}),
  'regeneration-area':     Object.freeze({min:1700, max:2500}),
  'big-regeneration':      Object.freeze({min:3600, max:4800}),
  'majin-regeneration':    Object.freeze({min:5900, max:7400}),
  'saiyajin-regeneration': Object.freeze({min:5700, max:7200}),
  'perfect-regeneration':  Object.freeze({min:5900, max:7400}),
  'namekian-regeneration': Object.freeze({min:5900, max:7400})
});

export function healingSpellBounds(spell, combat, state) {
  const tuned = HEALING_SPELL_BUDGETS[String(spell?.id || '')];
  if (tuned) return {...tuned};

  // Safe fallback for any future healing spell imported from the source:
  // preserve its relative formula, but cap one cast below Senzu Bean.
  const kiLevel = Number(state?.skills?.kiLevel?.level || 1);
  const original = formulaBounds(combat?.formula, {
    level:Number(state?.profile?.level || 1),
    kiLevel
  });
  return {
    min:Math.min(7200, Math.max(1, Number(original.min || 1))),
    max:Math.min(7800, Math.max(1, Number(original.max || 1)))
  };
}

function hasFormulaDamageCombat(spell) {
  return (spell?.combats || []).some(combat =>
    Boolean(combat?.formula) && !isHealingCombat(combat)
  );
}

function sequenceDamageHitCount(spell, sequence) {
  if (!hasFormulaDamageCombat(spell)) {
    return Math.max(1, Number(sequence?.length || 1));
  }

  const count = (sequence || []).filter(entry => {
    const combat = spell?.combats?.[Number(entry?.combatIndex || 0)] || null;
    return Boolean(combat?.formula) && !isHealingCombat(combat);
  }).length;
  return Math.max(1, count);
}

function levelMagicBounds(formula, level, kiLevel) {
  const baseLevel = Number(level || 1) / 5;
  const min =
    baseLevel +
    Number(kiLevel || 1) * Math.abs(Number(formula.minA || 0)) +
    Math.abs(Number(formula.minB || 0));
  const max =
    baseLevel +
    Number(kiLevel || 1) * Math.abs(Number(formula.maxA || 0)) +
    Math.abs(Number(formula.maxB || 0));
  return {
    min:Math.max(0, Math.min(min, max)),
    max:Math.max(0, Math.max(min, max))
  };
}

export function formulaBounds(
  formula,
  {level = 1, kiLevel = 1} = {}
) {
  if (!formula) return {min:1, max:1};
  if (formula.kind === 'COMBAT_FORMULA_LEVELMAGIC') {
    return levelMagicBounds(formula, level, kiLevel);
  }

  const min =
    Math.abs(Number(formula.minA || 0)) +
    Math.abs(Number(formula.minB || 0));
  const max =
    Math.abs(Number(formula.maxA || 0)) +
    Math.abs(Number(formula.maxB || 0));
  return {
    min:Math.max(0, Math.min(min, max)),
    max:Math.max(0, Math.max(min, max))
  };
}

export function combatStepValue({
  spell,
  combat,
  state,
  character,
  random = Math.random()
}) {
  const isHealing = isHealingCombat(combat);
  const formulaDamageExists = hasFormulaDamageCombat(spell);

  // A physical combat without any formula is not automatically a damage hit.
  // The source contains utility spells (notably Teleport) that call doCombat
  // only to trigger effects/targeting.  Real formula-less offensive scripts
  // are repaired at the data layer from their Lua callbacks instead of using
  // the old 1-damage fallback.
  if (
    spell?.runtimeKind === 'damage' &&
    spell?.aggressive &&
    !formulaDamageExists &&
    !spell?.allowFormulaLessDamage
  ) {
    return 0;
  }

  // When a source spell mixes one real damage combat with extra doCombat
  // calls that only carry areas/effects, those extra calls are animation
  // stages — they must neither deal the old 1-point fallback damage nor
  // dilute the real hit by increasing runtimeHitCount.
  if (
    spell?.runtimeKind === 'damage' &&
    spell?.aggressive &&
    formulaDamageExists &&
    !combat?.formula
  ) {
    return 0;
  }

  // Real damage formulas get rebalanced against the caster's own melee
  // DPS (see spellDpsMultiplier/referenceMeleeDps above). Everything else
  // (no formula at all, or a healing formula) keeps the original
  // source-driven bounds untouched.
  if (combat.formula && !isHealing) {
    const meleeDps = referenceMeleeDps(state, character);
    const cooldownSeconds = Math.max(
      0.2,
      Number(spell.cooldownMs || spell.sourceExhaustionMs || 1000) / 1000
    );
    const hitCount = Math.max(
      1,
      Number(spell.runtimeHitCount || spell.hitCount || 1)
    );
    const damageMultiplier = Math.max(0, Number(spell?.damageMultiplier ?? 1));
    const kiMultiplier=kiLevelDamageMultiplier(state);
    const targetDps = meleeDps * spellDpsMultiplier(spell) * damageMultiplier * kiMultiplier;
    const averagePerHit = (targetDps * cooldownSeconds) / hitCount;
    const variance = 0.85 + random * 0.30; // +-15%
    return Math.max(1, Math.round(averagePerHit * variance));
  }

  const bounds = isHealing
    ? healingSpellBounds(spell, combat, state)
    : formulaBounds(combat.formula, {
        level:state.profile.level,
        kiLevel:Number(state.skills?.kiLevel?.level || 1)
      });

  // Damage formulas keep their source/runtime treatment above. Healing is
  // intentionally normalized to the consumable economy so trained Ki Level
  // cannot turn a free 1-second heal into a better Senzu.
  return Math.max(
    1,
    Math.round(seededRange(bounds.min, bounds.max, random))
  );
}

export function spellHitPlan({
  spell,
  state,
  character,
  direction = null,
  random = Math.random
}) {
  // V20.26: every directional spell imported from the Absolute Lua pack
  // uses combat matrices whose source-facing key is the opposite of the
  // client/game direction used by the Idle renderer.  The previous runtime
  // selected the raw key, so North fired South, East fired West, etc.  This
  // 180-degree remap restores the visible/source direction for all 34
  // directional techniques (Kamehameha, Final Flash, Masenko, beams, etc.).
  const sourceDirection = direction !== null
    ? (Number(direction) + 2) % 4
    : null;
  const directional = sourceDirection !== null && spell.directionalSequence
    ? spell.directionalSequence[String(sourceDirection)]
    : null;
  const sourceSequence = directional?.length
    ? directional
    : spell.sequence?.length
      ? spell.sequence
      : [{combatIndex:0, delayMs:0}];

  // Some legacy parsers captured a visual combat in the timeline but missed
  // the parallel damage loop (Turtle Devastation is the canonical example).
  // If the spell unquestionably has a real formula but none of the parsed
  // timeline entries point at one, append the first real damage combat. This
  // preserves the visual event and, more importantly, prevents a valid server
  // spell from silently dealing zero damage. The tier budget is still applied
  // once, so this fallback cannot inflate total DPS.
  const sequenceHasFormulaDamage = sourceSequence.some(entry => {
    const combat = spell?.combats?.[Number(entry?.combatIndex || 0)] || null;
    return Boolean(combat?.formula) && !isHealingCombat(combat);
  });
  const firstFormulaDamageIndex = (spell?.combats || []).findIndex(
    combat => Boolean(combat?.formula) && !isHealingCombat(combat)
  );
  const sequence =
    hasFormulaDamageCombat(spell) &&
    !sequenceHasFormulaDamage &&
    firstFormulaDamageIndex >= 0
      ? [
          ...sourceSequence,
          {
            combatIndex:firstFormulaDamageIndex,
            delayMs:Math.max(0, ...sourceSequence.map(entry => Number(entry?.delayMs || 0)))
          }
        ]
      : sourceSequence;
  // Split the target damage only across combats that truly carry damage.
  // Many DBO scripts use additional doCombat calls solely to draw expanding
  // rings/areas. Counting those as hits made spells such as Explosive and
  // Namekjin Rage dramatically weaker than their intended tier.
  const runtimeSpell = {
    ...spell,
    runtimeHitCount:sequenceDamageHitCount(spell, sequence)
  };
  const formulaDamageExists = hasFormulaDamageCombat(spell);

  return sequence.map((sequenceEntry, index) => {
    const combat =
      spell.combats?.[sequenceEntry.combatIndex] ||
      spell.combats?.[0] ||
      {
        formula:null,
        effectId:spell.effectId,
        missileId:spell.missileId,
        combatType:null
      };

    const healing = isHealingCombat(combat);
    const dealsDamage = Boolean(
      spell?.runtimeKind === 'damage' &&
      spell?.aggressive &&
      (formulaDamageExists
        ? Boolean(combat?.formula) && !healing
        : Boolean(spell?.allowFormulaLessDamage))
    );

    return {
      index,
      delayMs:Number(sequenceEntry.delayMs || 0),
      combatIndex:Number(sequenceEntry.combatIndex || 0),
      value:combatStepValue({
        spell:runtimeSpell,
        combat,
        state,
        character,
        random:random()
      }),
      healing,
      dealsDamage,
      effectId:
        combat.effectId ??
        spell.visualEffectId ??
        spell.effectId ??
        null,
      missileId:combat.missileId ?? spell.missileId ?? null,
      areaMetrics:combat.areaMetrics || null,
      area:Array.isArray(combat.area) ? combat.area : [],
      combatName:combat.name || null
    };
  });
}

export function targetLimit(spell, lureCount = 1) {
  const name=String(spell.name || '').toLowerCase();
  const multi=
    spell.targetMode === 'area' ||
    spell.targetMode === 'wave' ||
    /kamehameha|wave|beam|cannon/.test(name);
  if (!multi) return 1;
  const cells = Math.max(1, Number(spell.areaCells || 1));
  return Math.max(
    1,
    Math.min(Number(lureCount || 1), cells, 10)
  );
}

export function conditionBuffs(spell, now = Date.now()) {
  const buffs = [];
  const name = String(spell?.name || '').toLowerCase();
  const nonAggressive = spell?.aggressive === false;
  const hasAttributeCondition = (spell.conditions || []).some(
    condition => condition.type === 'CONDITION_ATTRIBUTES'
  );
  const hasHasteCondition = (spell.conditions || []).some(
    condition => condition.type === 'CONDITION_HASTE'
  );
  const isPowerUp = nonAggressive && (
    hasAttributeCondition ||
    /power|strength|rage|berserk|boost|kaioken|potential|super saiyan/.test(name)
  );
  const isSpeed = nonAggressive && (
    hasHasteCondition || /speed|haste|dash|agility/.test(name)
  );

  const sourceDurationMs = Math.max(
    0,
    ...(spell.conditions || []).map(condition =>
      Number(condition.params?.CONDITION_PARAM_TICKS || 0)
    )
  );

  if (isPowerUp) {
    // V20.26 balance rule: attribute/power buffs always last one minute.
    // Source scripts varied between 30s and 60s, but the Idle progression
    // now uses a single predictable support window.
    const durationMs = Math.max(1, Number(spell?.supportDurationMs || 60 * 1000));
    const magnitude = Math.max(
      5,
      Math.min(100, Math.round(Number(spell.level || 1) / 10))
    );

    buffs.push({
      id:`${spell.id}-power`,
      type:'power',
      sourceSpellId:spell.id,
      expiresAt:now + durationMs,
      durationMs,
      skillBonuses:{
        strength:magnitude,
        kiLevel:magnitude,
        kiBlasting:magnitude,
        attackSpeed:Math.max(1, Math.round(magnitude * .35)),
        critical:Math.max(1, Math.round(magnitude * .2))
      }
    });
  }

  if (isSpeed) {
    // Speed Up/Super Speed follow the same one-minute active window.
    const durationMs = Math.max(1, Number(spell?.supportDurationMs || 60 * 1000));
    buffs.push({
      id:`${spell.id}-haste`,
      type:'haste',
      sourceSpellId:spell.id,
      expiresAt:now + durationMs,
      durationMs,
      attackSpeedMultiplier:1.20,
      multiplier:1.20,
      flat:0
    });
  }


  for (const condition of spell.conditions || []) {
    const ticks = Number(
      condition.params?.CONDITION_PARAM_TICKS || 0
    );
    const expiresAt = ticks > 0
      ? now + ticks
      : condition.type === 'CONDITION_HASTE'
        ? now + 60 * 1000
        : isPowerUp
          ? now + 60 * 1000
          : now + 1_000;

    if (condition.type === 'CONDITION_HASTE') {
      continue;
    } else if (condition.type === 'CONDITION_REGENERATION') {
      buffs.push({
        id:`${spell.id}-regeneration`,
        type:'regeneration',
        sourceSpellId:spell.id,
        expiresAt,
        hpGain:Number(
          condition.params?.CONDITION_PARAM_HEALTHGAIN || 0
        ),
        hpTicks:Number(
          condition.params?.CONDITION_PARAM_HEALTHTICKS || 1_000
        ),
        kiGain:Number(
          condition.params?.CONDITION_PARAM_MANAGAIN || 0
        ),
        kiTicks:Number(
          condition.params?.CONDITION_PARAM_MANATICKS || 1_000
        )
      });
    } else if (!isPowerUp) {
      buffs.push({
        id:`${spell.id}-${condition.type}`,
        type:condition.type,
        sourceSpellId:spell.id,
        expiresAt,
        params:condition.params
      });
    }
  }

  return buffs;
}

export function activeSkillBonus(
  state,
  skillName,
  now = Date.now()
) {
  state.activeSpellBuffs ||= [];
  state.activeSpellBuffs = state.activeSpellBuffs.filter(
    buff => Number(buff.expiresAt || 0) > now
  );

  return state.activeSpellBuffs.reduce(
    (total, buff) =>
      total + Number(buff.skillBonuses?.[skillName] || 0),
    0
  );
}

export function applySpellBuffs(state, spell, now = Date.now()) {
  state.activeSpellBuffs ||= [];
  state.activeSpellBuffs = state.activeSpellBuffs.filter(
    buff => Number(buff.expiresAt || 0) > now
  );

  const incoming = conditionBuffs(spell, now);
  for (const buff of incoming) {
    state.activeSpellBuffs = state.activeSpellBuffs.filter(
      current => current.id !== buff.id
    );
    state.activeSpellBuffs.push(buff);
  }
  return incoming;
}
