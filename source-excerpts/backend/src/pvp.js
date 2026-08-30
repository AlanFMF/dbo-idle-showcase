import crypto from 'node:crypto';
import { characters, itemCatalog, spells } from '../../src/data/game-content.js';
import { createSpellController } from '../../src/core/spells/spell-engine.js';
import { spellHitPlan, applySpellBuffs, kiLevelDamageMultiplier } from '../../src/core/spells/authoritative-spell-runtime.js';
import { maxResources } from '../../src/core/balance/absolute-balance-engine.js';
import { totalStats } from '../../src/core/equipment/equipment.js';
import { derivedCombatStats } from '../../src/core/skills/skills.js';

const ARENA = Object.freeze({width:24,height:14});
const INVITE_MS = 30_000;
const COUNTDOWN_MS = 3_000;
const MOVE_INTERVAL_MS = 115;
const HASTE_MOVE_INTERVAL_MS = 80;
const PVP_DAMAGE_SCALE = 0.22;
const PVP_MAX_CAST_DAMAGE_RATIO = 0.35;
const PVP_MAX_HIT_DAMAGE_RATIO = 0.18;
const PVP_MAX_HEAL_RATIO = 0.30;
const PVP_BASIC_MIN_DAMAGE_RATIO = 0.035;
const PVP_BASIC_MAX_DAMAGE_RATIO = 0.085;
const PVP_AUTO_ATTACK_TICK_MS = 50;
const MAX_WAGER = Math.floor(Number.MAX_SAFE_INTEGER/2);

const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));

function normalizeWager(payload={}){
  const rawCurrency=String(payload.wagerCurrency||payload.wager?.currency||'none').toLowerCase();
  const currency=['zeni','premium'].includes(rawCurrency)?rawCurrency:'none';
  if(currency==='none')return {currency:'none',amount:0,pot:0};
  const rawAmount=Math.trunc(Number(payload.wagerAmount??payload.wager?.amount??0)||0);
  const amount=Number.isSafeInteger(rawAmount)?clamp(rawAmount,0,MAX_WAGER):0;
  return {currency,amount,pot:amount*2};
}
function wagerBalance(runtime,currency){
  if(currency==='premium')return Math.max(0,Number(runtime?.state?.profile?.premiumPoints??runtime?.state?.profile?.vipCredits??0)||0);
  if(currency==='zeni')return Math.max(0,Number(runtime?.state?.profile?.bank||0));
  return Number.MAX_SAFE_INTEGER;
}
function wagerUnit(currency){return currency==='premium'?'PP':currency==='zeni'?'Zeni':'';}
function wagerText(wager={}){
  const amount=Math.max(0,Number(wager.amount)||0),currency=String(wager.currency||'none');
  return amount>0&&currency!=='none'?`${amount.toLocaleString('pt-BR')} ${wagerUnit(currency)} de cada jogador`:'Sem aposta';
}

function pvpSpellAllowed(spell){
  if(!spell)return false;
  if(spell.aggressive===true || spell.runtimeKind==='damage')return true;
  if(spell.runtimeKind==='healing')return true;
  // Buffs/haste precisam ser clicados manualmente. Utility de mapa,
  // teleport, wall etc. nao fazem parte do duelo 1x1.
  return spell.runtimeKind==='condition';
}

function distance(a,b){
  return Math.abs(Number(a.x||0)-Number(b.x||0))+
    Math.abs(Number(a.y||0)-Number(b.y||0));
}

function directionToward(a,b){
  const dx=Number(b.x||0)-Number(a.x||0),dy=Number(b.y||0)-Number(a.y||0);
  if(Math.abs(dx)>=Math.abs(dy))return dx>=0?1:3;
  return dy>=0?2:0;
}

function activeHaste(state,now=Date.now()){
  return (state?.activeSpellBuffs||[]).some(buff=>
    buff?.type==='haste' && Number(buff.expiresAt||0)>now
  );
}

function activePowerMultiplier(state,now=Date.now()){
  let magnitude=0;
  for(const buff of state?.activeSpellBuffs||[]){
    if(buff?.type!=='power'||Number(buff.expiresAt||0)<=now)continue;
    magnitude=Math.max(magnitude,...Object.values(buff.skillBonuses||{}).map(value=>Number(value||0)));
  }
  return 1+Math.min(0.25,Math.max(0,magnitude)*0.0025);
}

// V21.25.4: o ataque basico do PvP e automatico depois que o jogador
// seleciona um target. Melee sempre exige exatamente 1 SQM. Personagens
// distance/ki usam o range declarado pela arma atualmente equipada.
function pvpBasicAttackRange(combatState,derived){
  if(String(derived?.style||'')!=='ki')return 1;
  const weapon=itemCatalog[combatState?.equipment?.weapon];
  const raw=Number(weapon?.range ?? weapon?.sourceAttributes?.range ?? derived?.attackRange ?? 1);
  return clamp(Math.max(1,Math.round(Number.isFinite(raw)?raw:1)),1,10);
}


// V21.25.5: o sistema de target serve apenas para spells single-target.
// Spells de area preservam o comportamento original: acertam todos os
// adversarios vivos que estiverem dentro das celulas da area da tecnica.
// O helper ja considera teamId quando ele existir, deixando a regra pronta
// para um futuro PvP 2x2 sem transformar AoE em dano de alvo unico.
function pvpAreaSpell(spell){
  return Boolean(
    spell?.isArea===true ||
    ['area','wave'].includes(String(spell?.targetMode||''))
  );
}

function enemyParticipants(duel,caster){
  const casterTeam=String(caster?.teamId||'');
  return (duel?.participants||[]).filter(participant=>{
    if(!participant||participant.id===caster.id)return false;
    if(Number(participant.combatState?.profile?.hp||0)<=0)return false;
    const participantTeam=String(participant.teamId||'');
    if(casterTeam&&participantTeam&&casterTeam===participantTeam)return false;
    return true;
  });
}

function combatAreaOffsets(combat){
  const area=Array.isArray(combat?.area)?combat.area:[];
  const origin=combat?.areaMetrics?.origin;
  if(!area.length||!origin)return [];
  const ox=Number(origin.x),oy=Number(origin.y);
  if(!Number.isFinite(ox)||!Number.isFinite(oy))return [];
  const offsets=[];
  for(let y=0;y<area.length;y+=1){
    const row=Array.isArray(area[y])?area[y]:[];
    for(let x=0;x<row.length;x+=1){
      if(Number(row[x])!==1)continue;
      offsets.push({dx:x-ox,dy:y-oy});
    }
  }
  return offsets;
}

function offsetDirection(offsets){
  if(!offsets.length)return null;
  let farthest=offsets[0],best=-1;
  for(const offset of offsets){
    const score=Math.abs(Number(offset.dx||0))+Math.abs(Number(offset.dy||0));
    if(score>best){best=score;farthest=offset;}
  }
  const dx=Number(farthest.dx||0),dy=Number(farthest.dy||0);
  if(Math.abs(dx)>=Math.abs(dy)&&dx!==0)return dx>0?1:3;
  if(dy!==0)return dy>0?2:0;
  return null;
}

function spellAreaOffsets(spell,direction){
  const unique=new Map();
  for(const combat of spell?.combats||[]){
    const offsets=combatAreaOffsets(combat);
    if(!offsets.length)continue;
    if(combat?.areaMetrics?.directional===true){
      const combatDirection=offsetDirection(offsets);
      if(combatDirection!==null&&combatDirection!==Number(direction))continue;
    }
    for(const offset of offsets){
      unique.set(`${offset.dx}:${offset.dy}`,offset);
    }
  }
  return [...unique.values()];
}

function participantInsideSpellArea(caster,target,spell){
  const dx=Math.round(Number(target?.x||0)-Number(caster?.x||0));
  const dy=Math.round(Number(target?.y||0)-Number(caster?.y||0));
  const offsets=spellAreaOffsets(spell,caster?.direction);
  if(offsets.length){
    return offsets.some(offset=>offset.dx===dx&&offset.dy===dy);
  }
  // Fallback para futuras spells sem matriz importada: usa o radius oficial.
  const radius=Math.max(1,Number(spell?.areaRadius||0),
    ...(spell?.combats||[]).map(combat=>Number(combat?.areaMetrics?.radius||0)));
  return distance(caster,target)<=radius;
}

export function createPvpManager({
  players,
  activeAuthorityRuntimes,
  onlinePlayerByProfileId,
  socketByConnectionId,
  publishPresence,
  partyForCharacter=()=>null,
  tradeSessionFor=()=>null,
  reservePvpDuel=async()=>({ok:false,message:'Persistência PvP indisponível.'}),
  settlePvpDuel=async()=>({ok:false,message:'Persistência PvP indisponível.'}),
  refundPvpDuel=async()=>({ok:false,message:'Persistência PvP indisponível.'})
}){
  const invites=new Map(); // target character id -> invite
  const duels=new Map();
  const duelByCharacter=new Map();

  function socketFor(characterId){
    const player=onlinePlayerByProfileId(String(characterId||''));
    return player?socketByConnectionId(player.id):null;
  }
  function send(characterId,payload){
    const socket=socketFor(characterId);
    if(socket?.readyState===1)socket.send(JSON.stringify(payload));
  }
  function sendEvent(characterId,event,message='',extra={}){
    send(characterId,{type:'pvp-event',event,message,...extra});
  }
  function duelFor(characterId){
    const id=duelByCharacter.get(String(characterId||''));
    return id?duels.get(id)||null:null;
  }
  function opponentOf(duel,characterId){
    const id=String(characterId||'');
    return duel?.participants.find(participant=>participant.id!==id)||null;
  }
  function targetOf(duel,caster){
    if(!duel||!caster?.targetId)return null;
    const targetId=String(caster.targetId||'');
    return duel.participants.find(participant=>participant.id===targetId&&participant.id!==caster.id&&Number(participant.combatState?.profile?.hp||0)>0)||null;
  }

  function selectTarget(characterId,payload={}){
    const duel=duelFor(characterId);
    if(!duel)return sendEvent(characterId,'error','Nenhum duelo PvP ativo.');
    if(Date.now()<Number(duel.startsAt||0))return sendEvent(characterId,'error','Aguarde o fim da contagem regressiva.');
    const caster=duel.participants.find(row=>row.id===String(characterId));
    const targetId=String(payload.targetId||'');
    const target=duel.participants.find(row=>row.id===targetId&&row.id!==String(characterId));
    if(!caster||!target||Number(target.combatState?.profile?.hp||0)<=0){
      sendEvent(characterId,'error','Target PvP inválido.');
      return;
    }
    caster.targetId=target.id;
    caster.direction=directionToward(caster,target);
    const character=characters[caster.combatState.profile?.characterId]||characters.goku;
    const equipment=totalStats(caster.combatState,itemCatalog);
    const derived=derivedCombatStats(caster.combatState,character,equipment,itemCatalog);
    const attackRange=pvpBasicAttackRange(caster.combatState,derived);
    sendEvent(characterId,'target',`Target selecionado: ${target.name}. Ataque basico automatico ativado (${attackRange} SQM).`,{targetId:target.id,attackRange});
    sendState(duel);
    basicAttack(characterId,{automatic:true,silent:true});
  }
  function publicParticipant(participant,now=Date.now()){
    const state=participant.combatState;
    const ready={};
    for(const spell of participant.spellController.available()){
      if(!pvpSpellAllowed(spell))continue;
      ready[spell.id]=now+Math.max(0,participant.spellController.cooldownRemaining(spell.id,now));
    }
    return {
      id:participant.id,
      name:participant.name,
      level:participant.level,
      sprite:participant.sprite,
      outfitId:participant.outfitId,
      characterId:participant.characterId,
      formId:participant.formId,
      x:participant.x,y:participant.y,direction:participant.direction,
      hp:Math.max(0,Math.round(Number(state.profile.hp||0))),
      maxHp:Math.max(1,Math.round(Number(state.profile.maxHp||1))),
      ki:Math.max(0,Math.round(Number(state.profile.ki||0))),
      maxKi:Math.max(1,Math.round(Number(state.profile.maxKi||1))),
      cooldowns:ready,
      basicAttackReadyAt:Math.max(0,Number(participant.basicAttackReadyAt||0)),
      basicAttackRange:(()=>{const character=characters[state.profile?.characterId]||characters.goku;const equipment=totalStats(state,itemCatalog);const derived=derivedCombatStats(state,character,equipment,itemCatalog);return pvpBasicAttackRange(state,derived);})(),
      targetId:participant.targetId?String(participant.targetId):null,
      buffs:(state.activeSpellBuffs||[])
        .filter(buff=>Number(buff.expiresAt||0)>now)
        .map(buff=>({type:String(buff.type||''),expiresAt:Number(buff.expiresAt||0),sourceSpellId:String(buff.sourceSpellId||'')}))
    };
  }
  function publicDuel(duel,viewerId){
    const now=Date.now();
    const status=now>=Number(duel.startsAt||0)?'active':'countdown';
    return {
      id:duel.id,
      status,
      startsAt:duel.startsAt,
      width:ARENA.width,height:ARENA.height,
      ownId:String(viewerId||''),
      wager:duel.wager||{currency:'none',amount:0,pot:0},
      players:duel.participants.map(participant=>publicParticipant(participant,now)),
      serverTime:now
    };
  }
  function sendState(duel){
    if(!duel)return;
    for(const participant of duel.participants){
      send(participant.id,{type:'pvp-state',duel:publicDuel(duel,participant.id)});
    }
  }
  function setActivity(characterId,activity){
    const player=onlinePlayerByProfileId(characterId);
    if(player)player.activity=activity;
  }
  function clearInvitesFor(characterId){
    const id=String(characterId||'');
    invites.delete(id);
    for(const [target,invite] of [...invites.entries()]){
      if(String(invite.fromId||'')===id)invites.delete(target);
    }
  }

  function createParticipant(characterId,start){
    const id=String(characterId||'');
    const runtime=activeAuthorityRuntimes.get(id);
    const player=onlinePlayerByProfileId(id);
    if(!runtime||!player)return null;
    const combatState=structuredClone(runtime.state);
    const character=characters[combatState.profile?.characterId]||characters.goku;
    combatState.characterDefinition=character;
    combatState.spellCooldowns={};
    combatState.spellCooldownGroups={};
    combatState.supportSpellCooldowns={buff:0,speed:0};
    combatState.activeSpellBuffs=[];
    const equipment=totalStats(combatState,itemCatalog);
    const resources=maxResources(combatState,character,equipment);
    combatState.profile.maxHp=Math.max(1,Number(resources.maxHp||1));
    combatState.profile.maxKi=Math.max(1,Number(resources.maxKi||1));
    combatState.profile.hp=combatState.profile.maxHp;
    combatState.profile.ki=combatState.profile.maxKi;
    const participant={
      id,
      name:String(player.name||combatState.profile?.name||'Jogador'),
      level:Math.max(1,Number(combatState.profile?.level||player.level||1)),
      sprite:String(player.sprite||''),outfitId:player.outfitId??null,
      characterId:String(player.characterId||combatState.profile?.characterId||'goku'),
      formId:String(player.formId||combatState.profile?.formId||''),
      x:start.x,y:start.y,direction:start.direction,lastMoveAt:0,
      targetId:null,basicAttackReadyAt:0,
      combatState,
      spellController:null
    };
    participant.spellController=createSpellController({
      state:combatState,
      spellCatalog:spells,
      onCast:spell=>resolveSpell(participant,spell),
      onLog:()=>{}
    });
    return participant;
  }

  async function finishDuel(duel,{winnerId=null,loserId=null,reason='Duelo encerrado.'}={}){
    if(!duel||!duels.has(duel.id)||duel.finishing)return;
    duel.finishing=true;
    let settlement=null,lastError=null;
    for(let attempt=1;attempt<=3;attempt++){
      try{
        settlement=winnerId&&loserId
          ? await settlePvpDuel(duel.id,{winnerCharacterId:String(winnerId),loserCharacterId:String(loserId)})
          : await refundPvpDuel(duel.id);
        if(settlement?.ok)break;
        lastError=new Error(settlement?.message||'Falha ao liquidar duelo PvP.');
      }catch(error){lastError=error;}
      await new Promise(resolve=>setTimeout(resolve,120*attempt));
    }
    if(!settlement?.ok){
      console.error('[PVP] Falha ao liquidar duelo:',duel.id,lastError?.message||'erro desconhecido');
      // O registro permanece ativo no PostgreSQL. O initDatabase devolve
      // automaticamente a custódia caso o processo reinicie.
      settlement={ok:false,wager:duel.wager||{currency:'none',amount:0,pot:0},snapshots:{}};
    }
    for(const participant of duel.participants){
      const snapshot=settlement?.snapshots?.[participant.id];
      if(snapshot)activeAuthorityRuntimes.get(participant.id)?.syncPvpSnapshot?.(snapshot);
    }
    duels.delete(duel.id);
    for(const participant of duel.participants){
      duelByCharacter.delete(participant.id);
      setActivity(participant.id,'world');
      const won=winnerId?String(participant.id)===String(winnerId):null;
      const wager=settlement?.wager||duel.wager||{currency:'none',amount:0,pot:0};
      const prize=won===true&&Number(wager.amount||0)>0
        ? ` Prêmio: ${Number(wager.pot||Number(wager.amount||0)*2).toLocaleString('pt-BR')} ${wagerUnit(wager.currency)}.`
        : '';
      const safeReason=`${reason}${prize}`;
      send(participant.id,{
        type:'pvp-result',
        duelId:duel.id,
        won,
        winnerId:winnerId?String(winnerId):null,
        loserId:loserId?String(loserId):null,
        wager,
        settlementOk:Boolean(settlement?.ok),
        reason:safeReason
      });
      send(participant.id,{type:'pvp-state',duel:null,serverTime:Date.now()});
    }
    publishPresence();
  }

  function applyDamageHit(duel,caster,target,hit,spell,budget){
    if(!duels.has(duel.id)||duelByCharacter.get(caster.id)!==duel.id)return;
    if(Number(target.combatState.profile.hp||0)<=0)return;
    const targetMax=Math.max(1,Number(target.combatState.profile.maxHp||1));
    const raw=Math.max(1,Math.round(Number(hit.value||1)*Number(budget.scale||PVP_DAMAGE_SCALE)));
    const capped=Math.min(raw,Math.max(1,Math.round(targetMax*PVP_MAX_HIT_DAMAGE_RATIO)),budget.remaining);
    const damage=Math.max(0,Math.round(capped));
    if(damage<=0)return;
    budget.remaining=Math.max(0,budget.remaining-damage);
    target.combatState.profile.hp=Math.max(0,Number(target.combatState.profile.hp||0)-damage);
    sendEvent(caster.id,'hit',`${spell.name}: ${damage.toLocaleString('pt-BR')} de dano.`,{spellId:spell.id,damage,targetId:target.id});
    sendEvent(target.id,'damaged',`${caster.name} acertou ${spell.name}: -${damage.toLocaleString('pt-BR')} HP.`,{spellId:spell.id,damage,sourceId:caster.id});
    sendState(duel);
    if(Number(target.combatState.profile.hp||0)<=0){
      void finishDuel(duel,{winnerId:caster.id,loserId:target.id,reason:`${caster.name} venceu o duelo contra ${target.name}.`});
    }
  }

  function resolveSpell(caster,spell){
    const duel=duelFor(caster.id);
    if(!duel)return {ok:false,message:'Nenhum duelo PvP ativo.'};
    if(Date.now()<Number(duel.startsAt||0))return {ok:false,message:'Aguarde o fim da contagem regressiva.'};
    if(!pvpSpellAllowed(spell))return {ok:false,message:'Esta spell não pode ser usada no PvP.'};
    const offensive=spell.aggressive===true||spell.runtimeKind==='damage';
    const areaOffensive=offensive&&pvpAreaSpell(spell);
    const selectedTarget=offensive?targetOf(duel,caster):null;

    // Target explícito é obrigatório apenas em técnicas single-target.
    // AoE continua podendo ser usada sem target e acerta todos que estiverem
    // dentro da área. Se houver target em uma AoE direcional, ele apenas
    // orienta a direção do cast — não transforma a técnica em single-target.
    if(offensive&&!areaOffensive&&!selectedTarget){
      return {ok:false,reason:'target',message:'Selecione um target com o botão direito antes de usar esta spell.'};
    }
    if(areaOffensive&&selectedTarget){
      caster.direction=directionToward(caster,selectedTarget);
    }

    const healing=spell.runtimeKind==='healing';
    if(offensive&&!areaOffensive){
      const allowedRange=Math.max(1,Number(spell.range||0)>0?Number(spell.range):1);
      const currentDistance=distance(caster,selectedTarget);
      if(currentDistance>allowedRange){
        return {ok:false,reason:'range',message:`Aproxime-se do adversário. Alcance: ${allowedRange} SQM.`};
      }
      caster.direction=directionToward(caster,selectedTarget);
    }

    const character=characters[caster.combatState.profile?.characterId]||characters.goku;
    const plan=spellHitPlan({spell,state:caster.combatState,character,direction:caster.direction});
    if(offensive){
      const damaging=plan.filter(hit=>hit.dealsDamage&&Number(hit.value||0)>0);
      if(!damaging.length)return {ok:false,message:'Esta spell não possui dano PvP válido.'};

      const targets=areaOffensive
        ? enemyParticipants(duel,caster).filter(target=>participantInsideSpellArea(caster,target,spell))
        : [selectedTarget];

      // É permitido errar uma spell de área: Ki/cooldown são consumidos e a
      // técnica acontece no mapa, mas ninguém recebe dano se estiver fora dela.
      if(!targets.length){
        sendEvent(caster.id,'cast',`${spell.name} utilizada em área, mas nenhum adversário foi atingido.`,{
          spellId:spell.id,area:true,targetCount:0
        });
        sendState(duel);
        return {ok:true,area:true,targetCount:0};
      }

      for(const target of targets){
        const targetMax=Math.max(1,Number(target.combatState.profile.maxHp||1));
        const rawTotal=Math.max(1,damaging.reduce((sum,hit)=>sum+Math.max(0,Number(hit.value||0)),0));
        // Cada jogador dentro da área recebe o orçamento completo da técnica,
        // como no PvE. O cap PvP continua sendo calculado por alvo para evitar
        // one-shot e não divide o dano da AoE entre os adversários.
        const tierRatio=Math.min(0.20,0.07+Math.max(0,Number(spell.level||1))/2000*0.13);
        const powerMultiplier=activePowerMultiplier(caster.combatState);
        const kiMultiplier=kiLevelDamageMultiplier(caster.combatState);
        const desiredTotal=Math.min(
          targetMax*PVP_MAX_CAST_DAMAGE_RATIO,
          // rawTotal ja carrega Ki Level; o piso por tier tambem precisa carregar
          // o mesmo multiplicador para o balance PvP nao esconder a skill.
          Math.max(rawTotal*PVP_DAMAGE_SCALE,targetMax*tierRatio*kiMultiplier)*powerMultiplier
        );
        const budget={
          remaining:Math.max(1,Math.round(desiredTotal)),
          scale:Math.max(PVP_DAMAGE_SCALE,desiredTotal/rawTotal)
        };
        for(const hit of damaging){
          const delay=Math.max(0,Math.min(5000,Number(hit.delayMs||0)));
          const hitTimer=setTimeout(()=>applyDamageHit(duel,caster,target,hit,spell,budget),delay);
          hitTimer.unref?.();
        }
        sendEvent(target.id,'enemy-cast',`${caster.name} usou ${spell.name}.`,{
          spellId:spell.id,sourceId:caster.id,area:areaOffensive
        });
      }
      sendEvent(caster.id,'cast',areaOffensive
        ? `${spell.name} utilizada em área: ${targets.length} alvo(s) atingido(s).`
        : `${spell.name} utilizada manualmente.`,{
          spellId:spell.id,area:areaOffensive,targetCount:targets.length
        });
      return {ok:true,area:areaOffensive,targetCount:targets.length};
    }
    if(healing){
      const maxHp=Math.max(1,Number(caster.combatState.profile.maxHp||1));
      const missing=Math.max(0,maxHp-Number(caster.combatState.profile.hp||0));
      const requested=plan.filter(hit=>hit.healing).reduce((sum,hit)=>sum+Math.max(0,Number(hit.value||0)),0);
      const healTier=Math.min(0.14,0.06+Math.max(0,Number(spell.level||1))/1000*0.08);
      const normalized=Math.max(requested,maxHp*healTier);
      const amount=Math.max(0,Math.min(missing,normalized,Math.round(maxHp*PVP_MAX_HEAL_RATIO)));
      caster.combatState.profile.hp=Math.min(maxHp,Number(caster.combatState.profile.hp||0)+amount);
      sendEvent(caster.id,'heal',`${spell.name}: +${Math.round(amount).toLocaleString('pt-BR')} HP.`,{spellId:spell.id,healing:Math.round(amount)});
      sendState(duel);
      return {ok:true};
    }
    const buffs=applySpellBuffs(caster.combatState,spell,Date.now());
    if(!buffs.length)return {ok:false,message:'Esta spell de suporte não possui efeito PvP.'};
    sendEvent(caster.id,'buff',`${spell.name} ativada manualmente.`,{spellId:spell.id});
    sendState(duel);
    return {ok:true};
  }

  function basicAttack(characterId,payload={}){
    const duel=duelFor(characterId);
    if(!duel){if(!payload.silent)sendEvent(characterId,'error','Nenhum duelo PvP ativo.');return false;}
    if(Date.now()<Number(duel.startsAt||0)){if(!payload.silent)sendEvent(characterId,'error','Aguarde o fim da contagem regressiva.');return false;}
    const caster=duel.participants.find(row=>row.id===String(characterId));
    if(!caster)return false;
    // Mantemos compatibilidade com clientes antigos, mas o cliente atual nao
    // envia mais clique de ataque basico: selecionar o target liga o auto attack.
    if(payload.targetId&&String(payload.targetId)!==String(caster.targetId||'')){
      const requested=duel.participants.find(row=>row.id===String(payload.targetId)&&row.id!==caster.id);
      if(requested)caster.targetId=requested.id;
    }
    const target=targetOf(duel,caster);
    if(!target){if(!payload.silent)sendEvent(characterId,'error','Selecione um target com o botao direito para ativar o ataque basico automatico.',{reason:'target'});return false;}
    const now=Date.now();
    if(now<Number(caster.basicAttackReadyAt||0))return false;
    const character=characters[caster.combatState.profile?.characterId]||characters.goku;
    const equipment=totalStats(caster.combatState,itemCatalog);
    const derived=derivedCombatStats(caster.combatState,character,equipment,itemCatalog);
    const allowedRange=pvpBasicAttackRange(caster.combatState,derived);
    const currentDistance=distance(caster,target);
    // Fora de alcance o auto attack apenas aguarda; ao entrar no alcance ele
    // dispara automaticamente, sem spam de mensagens no cliente.
    if(currentDistance>allowedRange)return false;
    const interval=Math.max(200,Math.round(Number(derived.attackInterval||900)));
    caster.basicAttackReadyAt=now+interval;
    caster.direction=directionToward(caster,target);
    const targetMax=Math.max(1,Number(target.combatState.profile.maxHp||1));
    const critical=Math.random()<Math.min(0.35,Math.max(0,Number(derived.criticalChance||0)));
    const raw=Math.max(1,Number(derived.attack||1)*PVP_DAMAGE_SCALE);
    const normalized=Math.max(raw,targetMax*PVP_BASIC_MIN_DAMAGE_RATIO);
    const damage=Math.max(1,Math.round(Math.min(targetMax*PVP_BASIC_MAX_DAMAGE_RATIO,normalized*(critical?1.5:1))));
    target.combatState.profile.hp=Math.max(0,Number(target.combatState.profile.hp||0)-damage);
    sendEvent(caster.id,'basic-hit',`Ataque basico automatico${critical?' critico':''}: ${damage.toLocaleString('pt-BR')} de dano em ${target.name}.`,{damage,targetId:target.id,critical,automatic:true,range:allowedRange});
    sendEvent(target.id,'damaged',`${caster.name} acertou um ataque basico${critical?' critico':''}: -${damage.toLocaleString('pt-BR')} HP.`,{damage,sourceId:caster.id,basic:true,critical,automatic:true});
    sendState(duel);
    if(Number(target.combatState.profile.hp||0)<=0){
      void finishDuel(duel,{winnerId:caster.id,loserId:target.id,reason:`${caster.name} venceu o duelo contra ${target.name}.`});
    }
    return true;
  }

  // Um unico loop autoritativo atende todos os duelos. O intervalo real de
  // cada golpe continua sendo o Attack Speed do personagem/arma; este tick
  // apenas verifica se o target entrou no alcance e se o cooldown terminou.
  const autoAttackInterval=setInterval(()=>{
    for(const duel of duels.values()){
      if(!duel||duel.finishing||Date.now()<Number(duel.startsAt||0))continue;
      for(const participant of duel.participants)basicAttack(participant.id,{automatic:true,silent:true});
    }
  },PVP_AUTO_ATTACK_TICK_MS);
  autoAttackInterval.unref?.();

  function startDuel(aId,bId,{duelId=crypto.randomUUID(),wager={currency:'none',amount:0,pot:0}}={}){
    const a=createParticipant(aId,{x:3,y:Math.floor(ARENA.height/2),direction:1});
    const b=createParticipant(bId,{x:ARENA.width-4,y:Math.floor(ARENA.height/2),direction:3});
    if(!a||!b)return null;
    const duel={id:String(duelId),participants:[a,b],createdAt:Date.now(),startsAt:Date.now()+COUNTDOWN_MS,wager,finishing:false};
    duels.set(duel.id,duel);
    duelByCharacter.set(a.id,duel.id);duelByCharacter.set(b.id,duel.id);
    clearInvitesFor(a.id);clearInvitesFor(b.id);
    setActivity(a.id,'pvp');setActivity(b.id,'pvp');
    publishPresence();
    sendEvent(a.id,'started',`Duelo contra ${b.name}. ${wagerText(wager)}. Prepare-se!`,{duelId:duel.id,startsAt:duel.startsAt,wager});
    sendEvent(b.id,'started',`Duelo contra ${a.name}. ${wagerText(wager)}. Prepare-se!`,{duelId:duel.id,startsAt:duel.startsAt,wager});
    sendState(duel);
    const countdownTimer=setTimeout(()=>{if(duels.has(duel.id))sendState(duel);},COUNTDOWN_MS+20);
    countdownTimer.unref?.();
    return duel;
  }

  function availableForDuel(characterId){
    const id=String(characterId||'');
    const player=onlinePlayerByProfileId(id);
    const runtime=activeAuthorityRuntimes.get(id);
    if(!player||!runtime)return {ok:false,message:'Jogador não está mais online.'};
    if(String(player.activity||'world')!=='world')return {ok:false,message:'O jogador precisa estar no PZ para entrar no PvP.'};
    if(duelFor(id))return {ok:false,message:'O jogador já está em um duelo PvP.'};
    if(tradeSessionFor(id))return {ok:false,message:'Finalize o Trade antes de entrar no PvP.'};
    if(partyForCharacter(id))return {ok:false,message:'Saia da Party antes de entrar no duelo PvP 1x1.'};
    return {ok:true,player,runtime};
  }

  function move(characterId,payload={}){
    const duel=duelFor(characterId);
    if(!duel)return sendEvent(characterId,'error','Nenhum duelo PvP ativo.');
    if(Date.now()<duel.startsAt)return sendEvent(characterId,'error','Aguarde o fim da contagem regressiva.');
    const participant=duel.participants.find(row=>row.id===String(characterId));
    const target=opponentOf(duel,characterId);
    if(!participant||!target)return;
    const dx=clamp(Math.trunc(Number(payload.dx||0)),-1,1),dy=clamp(Math.trunc(Number(payload.dy||0)),-1,1);
    if(Math.abs(dx)+Math.abs(dy)!==1)return;
    const now=Date.now(),moveInterval=activeHaste(participant.combatState,now)?HASTE_MOVE_INTERVAL_MS:MOVE_INTERVAL_MS;
    if(now-Number(participant.lastMoveAt||0)<moveInterval)return;
    const x=clamp(participant.x+dx,1,ARENA.width-2),y=clamp(participant.y+dy,1,ARENA.height-2);
    if(x===target.x&&y===target.y)return;
    participant.lastMoveAt=now;participant.x=x;participant.y=y;
    participant.direction=dx>0?1:dx<0?3:dy>0?2:0;
    sendState(duel);
  }

  function cast(characterId,payload={}){
    const duel=duelFor(characterId);
    if(!duel)return sendEvent(characterId,'error','Nenhum duelo PvP ativo.');
    const participant=duel.participants.find(row=>row.id===String(characterId));
    if(!participant)return;
    const spellId=String(payload.spellId||'');
    const result=participant.spellController.cast(spellId);
    if(result?.ok===false)sendEvent(characterId,'error',result.message||'Spell recusada.',{reason:result.reason||''});
    sendState(duel);
  }

  async function handleAction(characterId,action,payload={}){
    const selfId=String(characterId||'');
    const self=onlinePlayerByProfileId(selfId);
    if(!self)return;
    if(action==='status'){
      const duel=duelFor(selfId);
      send(selfId,{type:'pvp-state',duel:duel?publicDuel(duel,selfId):null,serverTime:Date.now()});
      return;
    }
    if(action==='challenge'){
      const targetId=String(payload.characterId||'');
      if(!targetId||targetId===selfId){sendEvent(selfId,'error','Selecione outro jogador para desafiar.');return;}
      const ownAvailable=availableForDuel(selfId),targetAvailable=availableForDuel(targetId);
      if(!ownAvailable.ok){sendEvent(selfId,'error',ownAvailable.message);return;}
      if(!targetAvailable.ok){sendEvent(selfId,'error',targetAvailable.message);return;}
      if(invites.has(targetId)){sendEvent(selfId,'error','Esse jogador já possui um convite PvP pendente.');return;}
      const wager=normalizeWager(payload);
      if(wager.currency!=='none'&&wager.amount<1){sendEvent(selfId,'error','Informe uma quantia válida para apostar.');return;}
      if(wager.amount>0&&wagerBalance(ownAvailable.runtime,wager.currency)<wager.amount){sendEvent(selfId,'error','Você não tem essa quantia para apostar.');return;}
      const invite={fromId:selfId,fromName:String(self.name||'Jogador'),targetId,expiresAt:Date.now()+INVITE_MS,wager};
      invites.set(targetId,invite);
      send(targetId,{type:'pvp-invite',...invite});
      sendEvent(selfId,'invite-sent',`Desafio PvP enviado para ${targetAvailable.player.name}. ${wagerText(wager)}.`);
      const inviteTimer=setTimeout(()=>{
        const current=invites.get(targetId);
        if(current!==invite)return;
        invites.delete(targetId);
        sendEvent(selfId,'expired','O convite PvP expirou.');
        sendEvent(targetId,'expired','O convite PvP expirou.');
      },INVITE_MS+50);
      inviteTimer.unref?.();
      return;
    }
    if(action==='decline'){
      const invite=invites.get(selfId);invites.delete(selfId);
      if(invite?.fromId)sendEvent(invite.fromId,'declined',`${self.name||'Jogador'} recusou o duelo PvP.`);
      sendEvent(selfId,'declined','Desafio PvP recusado.');
      return;
    }
    if(action==='accept'){
      const invite=invites.get(selfId);invites.delete(selfId);
      if(!invite||Number(invite.expiresAt||0)<Date.now()){sendEvent(selfId,'error','O convite PvP expirou.');return;}
      const ownAvailable=availableForDuel(selfId),fromAvailable=availableForDuel(invite.fromId);
      if(!ownAvailable.ok){sendEvent(selfId,'error',ownAvailable.message);return;}
      if(!fromAvailable.ok){sendEvent(selfId,'error',fromAvailable.message);return;}
      const wager=normalizeWager(invite);
      try{
        await Promise.all([
          ownAvailable.runtime.flushWithRetry?.(3),
          fromAvailable.runtime.flushWithRetry?.(3)
        ]);
      }catch(error){
        sendEvent(selfId,'error','Não foi possível confirmar seu saldo no banco. Tente novamente.');
        sendEvent(invite.fromId,'error','Não foi possível confirmar a aposta no banco. Tente novamente.');
        return;
      }
      const duelId=crypto.randomUUID();
      let reserved;
      try{
        reserved=await reservePvpDuel({
          duelId,
          challengerAccountId:fromAvailable.player.accountId,
          challengedAccountId:ownAvailable.player.accountId,
          challengerCharacterId:String(invite.fromId),
          challengedCharacterId:selfId,
          wagerCurrency:wager.currency,
          wagerAmount:wager.amount
        });
      }catch(error){
        console.error('[PVP] Falha ao reservar aposta:',error.message);
        sendEvent(selfId,'error','Não foi possível reservar a aposta. Tente novamente.');
        sendEvent(invite.fromId,'error','Não foi possível reservar a aposta. Tente novamente.');
        return;
      }
      if(!reserved?.ok){
        if(reserved?.insufficient==='challenged'){
          sendEvent(selfId,'error','Você não tem essa quantia para apostar.');
          sendEvent(invite.fromId,'error','O jogador desafiado não possui essa quantia para apostar.');
        }else if(reserved?.insufficient==='challenger'){
          sendEvent(invite.fromId,'error','Você não tem essa quantia para apostar.');
          sendEvent(selfId,'error','O desafiante não possui mais essa quantia para apostar.');
        }else{
          sendEvent(selfId,'error',reserved?.message||'Não foi possível reservar a aposta.');
          sendEvent(invite.fromId,'error',reserved?.message||'Não foi possível reservar a aposta.');
        }
        return;
      }
      for(const [characterId,snapshot] of Object.entries(reserved.snapshots||{}))activeAuthorityRuntimes.get(String(characterId))?.syncPvpSnapshot?.(snapshot);
      const duel=startDuel(invite.fromId,selfId,{duelId,wager:reserved.wager||wager});
      if(!duel){
        const refunded=await refundPvpDuel(duelId).catch(()=>null);
        for(const [characterId,snapshot] of Object.entries(refunded?.snapshots||{}))activeAuthorityRuntimes.get(String(characterId))?.syncPvpSnapshot?.(snapshot);
        sendEvent(selfId,'error','Não foi possível iniciar o duelo. A aposta foi devolvida.');
        sendEvent(invite.fromId,'error','Não foi possível iniciar o duelo. A aposta foi devolvida.');
      }
      return;
    }
    if(action==='target'){selectTarget(selfId,payload);return;}
    if(action==='move'){move(selfId,payload);return;}
    if(action==='basic-attack'){basicAttack(selfId,payload);return;}
    if(action==='cast'){cast(selfId,payload);return;}
    if(action==='forfeit'){
      const duel=duelFor(selfId);
      if(!duel){sendEvent(selfId,'error','Nenhum duelo PvP ativo.');return;}
      const opponent=opponentOf(duel,selfId);
      void finishDuel(duel,{winnerId:opponent?.id||null,loserId:selfId,reason:`${self.name||'Jogador'} abandonou o duelo.`});
    }
  }

  function handleDisconnect(characterId){
    const id=String(characterId||'');
    const duel=duelFor(id);
    if(duel){
      const opponent=opponentOf(duel,id);
      void finishDuel(duel,{winnerId:opponent?.id||null,loserId:id,reason:`${onlinePlayerByProfileId(id)?.name||'Jogador'} desconectou e perdeu o duelo.`});
    }
    clearInvitesFor(id);
  }

  return {
    handleAction,
    handleDisconnect,
    hasDuel:characterId=>Boolean(duelFor(characterId)),
    forfeit(characterId,reason='Duelo abandonado.'){
      const duel=duelFor(characterId);if(!duel)return false;
      const opponent=opponentOf(duel,characterId);
      void finishDuel(duel,{winnerId:opponent?.id||null,loserId:String(characterId||''),reason});
      return true;
    }
  };
}
