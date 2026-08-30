import {
  authoritativeMonsters
} from '../../data/generated/absolute-monsters-v1700.js';

const byId = new Map(
  authoritativeMonsters.map(monster => [monster.id, monster])
);
const byName = new Map(
  authoritativeMonsters.map(monster => [
    monster.name.toLowerCase(),
    monster
  ])
);

export function monsterDefinition(idOrName) {
  return (
    byId.get(idOrName) ||
    byName.get(String(idOrName || '').toLowerCase()) ||
    null
  );
}

export function monsterCombatStats(monster) {
  return {
    hp:Number(monster?.health?.max || 1),
    experience:Number(monster?.experience || 0),
    speed:Number(monster?.speed || 200),
    defense:Number(monster?.defense?.defense || 0),
    armor:Number(monster?.defense?.armor || 0),
    lookType:Number(monster?.look?.type || 0),
    corpseId:Number(monster?.look?.corpse || 0),
  };
}

export function monsterDamage(attack, random = Math.random()) {
  const low = Math.min(
    Math.abs(Number(attack?.min || 0)),
    Math.abs(Number(attack?.max || 0))
  );
  const high = Math.max(
    Math.abs(Number(attack?.min || 0)),
    Math.abs(Number(attack?.max || 0))
  );
  return Math.max(1, Math.round(low + (high - low) * random));
}

export function applyMonsterMitigation(
  damage,
  monster,
  damageType = 'physical'
) {
  const key = `${damageType}Percent`;
  const resistance = Number(monster?.elements?.[key] || 0);
  const defense = Number(monster?.defense?.defense || 0);
  const armor = Number(monster?.defense?.armor || 0);
  return Math.max(
    1,
    Math.round(
      Number(damage || 0) * (1 - resistance / 100) -
      defense * .2 -
      armor * .1
    )
  );
}

export function rollLoot(monster, random = Math.random) {
  const drops = [];
  function visit(entry, parent = null) {
    if (random() * 100000 > Number(entry.chance || 0)) return;
    const count = Math.max(
      1,
      Math.floor(random() * Number(entry.countMax || 1)) + 1
    );
    const drop = {
      id:entry.id,
      name:entry.name,
      count,
      parent
    };
    drops.push(drop);
    for (const child of entry.children || []) visit(child, drop);
  }
  for (const entry of monster?.loot || []) visit(entry);
  return drops;
}
