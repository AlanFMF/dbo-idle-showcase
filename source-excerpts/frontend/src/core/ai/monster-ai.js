export function monsterAiProfile(monster) {
  const attacks = monster?.attacks || [];
  const ranged = attacks.filter(a => Number(a.range || 1) > 1);
  const melee = attacks.filter(a => Number(a.range || 1) <= 1);
  const runOnHealth = Number(monster?.flags?.runonhealth || monster?.flags?.runOnHealth || 0);
  const forceClose = Boolean(monster?.isBoss || monster?.questOnly || monster?.bossUsesKiSpells);
  const preferredRange = forceClose
    ? 8.25
    : ranged.length
      ? Math.max(10, Math.min(38, Math.max(...ranged.map(a => Number(a.range || 1))) * 4.2))
      : 8.5;
  return {
    preferredRange,
    fleeThreshold:runOnHealth,
    canFlee:runOnHealth > 0,
    ranged:ranged.length > 0,
    melee:melee.length > 0,
    targetPriority:monster?.flags?.targetdistance ? 'distance' : 'nearest'
  };
}

export function chooseMonsterAttack(monster, enemy, now = Date.now(), random = Math.random, distance = null) {
  enemy.ai ||= {cooldowns:{}};
  const ready=(monster?.attacks||[]).filter(attack => {
    const readyAt=Number(enemy.ai.cooldowns[attack.name || attack.script || 'attack'] || 0);
    const effectiveRange=Math.max(10.5,Number(attack?.range||1)*4.2);
    const inRange=distance==null || !Number.isFinite(Number(distance)) || Number(distance)<=effectiveRange;
    return inRange && now >= readyAt;
  });
  if(!ready.length)return null;

  const rolled=ready.filter(attack => random()*100 <= Number(attack.chance ?? 100));
  if(!rolled.length)return null;

  // Bosses previously had their melee attack competing with every Ki spell in
  // the same random pool. In practice the guaranteed melee entry starved the
  // visual techniques. When a real technique passes its own chance/cooldown,
  // prioritize it; melee remains the fallback.
  const spellCandidates=rolled.filter(attack =>
    String(attack.name||'').toLowerCase()!=='melee' &&
    (Number(attack.range||1)>1 || attack.type==='ki' || attack.effectId!=null || attack.missileId!=null)
  );
  const pool=(monster?.isBoss||monster?.bossUsesKiSpells||monster?.bossSpellPriority) && spellCandidates.length
    ? spellCandidates
    : rolled;
  const selected=pool[Math.floor(random()*pool.length)];
  const key=selected.name || selected.script || 'attack';
  enemy.ai.cooldowns[key]=now+Math.max(100,Number(selected.intervalMs||1000));
  return selected;
}

export function intelligentEnemyStep({enemy, monster, player, allies=[], deltaMs=16}) {
  const profile=monsterAiProfile(monster);
  const dx=player.x-enemy.x, dy=player.y-enemy.y;
  const distance=Math.max(.001,Math.hypot(dx,dy));
  const hpPct=Number(enemy.hp||0)/Math.max(1,Number(enemy.maxHp||1));
  let intent='hold', vx=0, vy=0;
  if(profile.canFlee && Number(enemy.hp||0)<=profile.fleeThreshold){ intent='flee'; vx=-dx/distance; vy=-dy/distance; }
  else if(distance>profile.preferredRange+2){ intent='chase'; vx=dx/distance; vy=dy/distance; }
  else if(profile.ranged && distance<profile.preferredRange-3){ intent='kite'; vx=-dx/distance; vy=-dy/distance; }
  // separation prevents all lured enemies occupying one point
  for(const ally of allies){ if(ally===enemy||!ally.alive)continue; const ax=enemy.x-ally.x, ay=enemy.y-ally.y; const ad=Math.hypot(ax,ay); if(ad>0&&ad<5){vx+=ax/ad*.45;vy+=ay/ad*.45;} }
  const len=Math.max(1,Math.hypot(vx,vy));
  const pursuitBoost=Boolean(monster?.isBoss || monster?.questOnly || monster?.bossUsesKiSpells) ? 1.45 : 1;
  const speed=Math.max(.5,Number(monster?.speed||100)/180)*4.3*pursuitBoost*deltaMs/1000;
  return {intent,x:enemy.x+vx/len*speed,y:enemy.y+vy/len*speed,distance,profile,hpPct};
}

export function targetScore({enemy, player, currentTargetId}) {
  const distance=Math.hypot(enemy.x-player.x,enemy.y-player.y);
  let score=100-distance;
  if(enemy.uid===currentTargetId)score+=1000;
  score+=Math.max(0,1-Number(enemy.hp||0)/Math.max(1,Number(enemy.maxHp||1)))*15;
  return score;
}
