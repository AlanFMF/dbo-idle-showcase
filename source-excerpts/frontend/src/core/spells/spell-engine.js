import { spells } from '../../data/game-content.js';

export const GLOBAL_SPELL_EXHAUSTION_MS = 1_000;
export const ATTACK_SPELL_EXHAUSTION_GROUP = 'attack:spell-exhaustion';
export const SUPPORT_SPELL_EXHAUSTION_GROUP = 'support:spell-exhaustion';
// Backward-compatible alias used by older tests/callers. Attack spells use this group.
export const GLOBAL_SPELL_EXHAUSTION_GROUP = ATTACK_SPELL_EXHAUSTION_GROUP;

export function spellExhaustionGroup(spell) {
  return spell?.aggressive === true || spell?.runtimeKind === 'damage'
    ? ATTACK_SPELL_EXHAUSTION_GROUP
    : SUPPORT_SPELL_EXHAUSTION_GROUP;
}

function sourceCooldownMs(spell) {
  const explicit = Number(
    spell?.sourceExhaustionMs ??
    spell?.exhaustionMs ??
    spell?.exhaustion ??
    spell?.cooldownMs ??
    0
  );
  return Number.isFinite(explicit) ? Math.max(0, explicit) : 0;
}

function cooldownSetGroups(spell) {
  const explicit = Array.isArray(spell?.cooldownSetGroups)
    ? spell.cooldownSetGroups
      .map(entry => ({
        group:String(entry?.group || ''),
        durationMs:Math.max(0, Number(entry?.durationMs || 0))
      }))
      .filter(entry => entry.group)
    : [];

  if (explicit.length) return explicit;

  if (spell?.cooldownGroup) {
    return [{
      group:String(spell.cooldownGroup),
      durationMs:Math.max(
        0,
        Number(spell?.cooldownGroupMs ?? spell?.scriptCooldownMs ?? 0)
      )
    }];
  }
  return [];
}

function cooldownBlockGroups(spell) {
  const explicit = Array.isArray(spell?.cooldownBlockGroups)
    ? spell.cooldownBlockGroups.map(String).filter(Boolean)
    : [];
  const groups = explicit.length
    ? explicit
    : spell?.cooldownGroup
      ? [String(spell.cooldownGroup)]
      : [];
  return [...new Set(groups)];
}

function normalizedCooldown(spell) {
  return Math.max(
    sourceCooldownMs(spell),
    ...cooldownSetGroups(spell).map(entry => entry.durationMs),
    Number(spell?.cooldownMs || 0)
  );
}

function normalizedKiCost(spell, state) {
  const fixedCost = Math.max(
    0,
    Number(spell?.kiCost ?? spell?.mana ?? 0)
  );
  const percent = Math.max(
    0,
    Number(spell?.kiCostPercent ?? spell?.manaPercent ?? spell?.manapercent ?? 0)
  );
  const maxKi = Math.max(
    0,
    Number(state.profile.maxKi ?? state.profile.ki ?? 0)
  );
  const percentCost = percent > 0
    ? Math.ceil(maxKi * percent / 100)
    : 0;
  // V21.23: spells marcadas como percentuais abandonam o custo fixo da
  // base original. Assim o gasto continua relevante em personagens com Ki
  // muito alto, sem transformar o valor antigo em um piso artificial.
  if (spell?.kiCostMode === 'percent') return percentCost;
  return Math.max(fixedCost, percentCost);
}

export function availableSpells(state, spellCatalog = spells) {
  const vocationId = Number(state.profile.vocationSourceId || 0);
  const level = Number(state.profile.level || 1);
  const character = state.characterDefinition;
  const vipActive = Number(state.profile.vipUntil || 0) > Date.now();
  const allowedVocationIds = new Set([
    vocationId,
    Number(character?.vocationSourceId || 0),
    ...(character?.forms || []).map(form => Number(form.vocationId || 0)),
    ...(character?.legacyVocationIds || []).map(Number)
  ]);

  return spellCatalog
    .filter(spell =>
      spell.kind === 'instant' &&
      spell.level <= level &&
      (!spell.premium || vipActive) &&
      (
        !spell.vocationIds.length ||
        spell.vocationIds.some(id => allowedVocationIds.has(Number(id)))
      )
    )
    .sort((a,b) =>
      a.level - b.level ||
      a.name.localeCompare(b.name)
    );
}

export function createSpellController({
  state,
  spellCatalog = spells,
  onCast = () => ({ok:true}),
  onLog = () => {}
}) {
  state.spellCooldowns ||= {};
  state.spellCooldownGroups ||= {};

  const cooldowns = new Map(
    Object.entries(state.spellCooldowns).map(([id, readyAt]) => [
      id,
      Number(readyAt || 0)
    ])
  );
  const groupCooldowns = new Map(
    Object.entries(state.spellCooldownGroups).map(([id, readyAt]) => [
      id,
      Number(readyAt || 0)
    ])
  );

  function persistCooldown(spellId, readyAt) {
    cooldowns.set(spellId, readyAt);
    state.spellCooldowns[spellId] = readyAt;
  }

  function persistGroupCooldown(groupId, readyAt) {
    if (!groupId) return;
    groupCooldowns.set(groupId, readyAt);
    state.spellCooldownGroups[groupId] = readyAt;
  }

  function spellById(spellId) {
    return availableSpells(state, spellCatalog).find(entry =>
      entry.id === spellId
    );
  }

  // V21.25: o objeto `state` e a fonte autoritativa dos cooldowns.
  // O cliente recebe snapshots do servidor depois de cada cast; manter o maior
  // valor entre um Map criado no boot e o snapshot fazia cooldowns antigos
  // permanecerem visiveis mesmo depois de o servidor ja os ter liberado.
  function stateSpellReadyAt(spellId) {
    return Number(state.spellCooldowns?.[spellId] || 0);
  }

  function stateGroupReadyAt(groupId) {
    return Number(state.spellCooldownGroups?.[groupId] || 0);
  }

  function remainingForSpell(spell, now = Date.now()) {
    if (!spell) return 0;
    const ownRemaining = stateSpellReadyAt(spell.id) - now;
    const groupRemaining = cooldownBlockGroups(spell)
      .map(group => stateGroupReadyAt(group) - now);
    const exhaustionRemaining =
      stateGroupReadyAt(spellExhaustionGroup(spell)) - now;
    return Math.max(0, ownRemaining, exhaustionRemaining, ...groupRemaining);
  }

  return {
    available() {
      return availableSpells(state, spellCatalog);
    },
    cooldownRemaining(spellId, now = Date.now()) {
      return remainingForSpell(spellById(spellId), now);
    },
    cooldownDuration(spellId) {
      const spell = spellById(spellId);
      return spell ? Math.max(normalizedCooldown(spell), GLOBAL_SPELL_EXHAUSTION_MS) : 0;
    },
    setCooldown(spellId, readyAt) {
      persistCooldown(spellId, Number(readyAt || 0));
      return Number(readyAt || 0);
    },

    cast(spellId) {
      const spell = spellById(spellId);
      if (!spell) {
        return {
          ok:false,
          message:'Spell indisponível para esta vocação ou level.'
        };
      }

      const now = Date.now();
      const remainingMs = remainingForSpell(spell, now);
      if (remainingMs > 0) {
        return {
          ok:false,
          reason:'cooldown',
          remainingMs,
          message:`Aguarde ${(remainingMs / 1000).toFixed(1)}s.`
        };
      }

      const currentKi = Math.max(
        0,
        Number(state.profile.ki || 0)
      );
      const kiCost = normalizedKiCost(spell, state);

      if (kiCost > 0 && currentKi < kiCost) {
        return {
          ok:false,
          reason:'ki',
          kiCost,
          message:`Ki insuficiente. Necessário: ${kiCost}.`
        };
      }

      const ownCooldownMs = sourceCooldownMs(spell);
      const setGroups = cooldownSetGroups(spell);
      const exhaustionGroup = spellExhaustionGroup(spell);
      const touchedGroups = new Set([
        exhaustionGroup,
        ...cooldownBlockGroups(spell),
        ...setGroups.map(entry => entry.group)
      ]);
      const oldOwnReadyAt = stateSpellReadyAt(spell.id);
      const oldGroupReadyAt = new Map(
        [...touchedGroups].map(group => [
          group,
          stateGroupReadyAt(group)
        ])
      );

      // O servidor original possui duas camadas: exhaustion do spells.xml
      // e storages Lua. Uma spell pode consultar mais de um storage e
      // atualizar apenas um deles (ex.: beams que também respeitam o
      // exhaustion do Ghost Blaster).
      state.profile.ki = Math.max(0, currentKi - kiCost);
      persistCooldown(spell.id, now + ownCooldownMs);
      persistGroupCooldown(
        exhaustionGroup,
        now + GLOBAL_SPELL_EXHAUSTION_MS
      );
      for (const group of setGroups) {
        persistGroupCooldown(group.group, now + group.durationMs);
      }

      const result = onCast(spell) || {ok:true};
      if (result.ok === false) {
        state.profile.ki = currentKi;
        persistCooldown(spell.id, oldOwnReadyAt);
        for (const [group, readyAt] of oldGroupReadyAt) {
          persistGroupCooldown(group, readyAt);
        }
        return result;
      }

      const cooldownMs = Math.max(normalizedCooldown(spell), GLOBAL_SPELL_EXHAUSTION_MS);
      onLog(`${spell.name} utilizada.`);
      return {
        ok:true,
        spell,
        cooldownMs,
        kiCost,
        readyAt:now + cooldownMs,
        ...result
      };
    }
  };
}
