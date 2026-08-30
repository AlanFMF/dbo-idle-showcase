import {
  gainSkill,
  equippedCombatStyle,
  vocationAptitude
} from '../skills/skills.js';
import {
  dualTrainingGloves,
  totalStats
} from '../equipment/equipment.js';
import { attackIntervalMs } from '../balance/absolute-balance-engine.js';

const TRAINING_MULTIPLIER = 3;
const TICK_MS = 80;

export const trainingRooms = [
  {
    id:'punching-bag',
    name:'Sala de Punching Bag',
    description:'Treina Strength, Ki Blasting, Atk Speed e Defense.',
    skills:['Strength','Ki Blasting','Atk Speed','Defense'],
    color:'melee'
  },
  {
    id:'time-chamber',
    name:'Sala do Tempo',
    description:'Movimento contínuo para treinar Agility no mapa original.',
    skills:['Agility'],
    color:'agility',
    originalMap:{
      x:524,
      y:247,
      z:7,
      radiusX:16,
      radiusY:11
    }
  },
  {
    id:'ki-barrier',
    name:'Treino de Ki e Barrier',
    description:'Treina Ki Level e Barrier.',
    skills:['Ki Level','Barrier'],
    color:'ki'
  }
];

function createDefaultTrainingState() {
  return {
    running:false,
    roomId:'punching-bag',
    playerX:32,
    playerY:54,
    playerDirection:1,
    targetX:68,
    targetY:52,
    targetHp:100_000,
    targetMaxHp:100_000,
    targetAlive:true,
    targetRespawnAt:0,
    lastPlayerAttack:0,
    lastTargetAttack:0,
    lastMoveSwitch:0,
    moveDirection:1,
    effects:[],
    startedAt:0
  };
}

export function normalizeTrainingState(state) {
  state.training = {
    ...createDefaultTrainingState(),
    ...(state.training || {}),
    effects:Array.isArray(state.training?.effects)
      ? state.training.effects
      : []
  };
  return state.training;
}

export function createTrainingEngine({
  state,
  characters,
  itemCatalog,
  onUpdate = () => {},
  onLog = () => {}
}) {
  normalizeTrainingState(state);
  let lastTick = Date.now();
  let effectId = 1;

  function character() {
    return characters[state.profile.characterId];
  }

  function room() {
    return trainingRooms.find(entry =>
      entry.id === state.training.roomId
    ) || trainingRooms[0];
  }

  function skillNotice(skillId, level) {
    onLog(`${skillId} avançou para ${level} durante o treino.`);
  }

  function addEffect(kind, x, y, value = null) {
    state.training.effects.push({
      id:`training-fx-${Date.now()}-${effectId++}`,
      kind,
      x,
      y,
      value,
      createdAt:Date.now(),
      duration:kind === 'damage' ? 800 : 420
    });
    state.training.effects = state.training.effects.slice(-40);
  }

  function trainPhysicalAttack() {
    const style = equippedCombatStyle(state, itemCatalog);
    const aptitude = vocationAptitude(character(), 'gloves');

    if (style === 'gloves' || style === 'sword') {
      gainSkill(
        state,
        'gloves',
        TRAINING_MULTIPLIER * aptitude,
        skillNotice
      );
    } else if (style === 'training-gloves') {
      // V21.22 — Two Tones Band é um equipamento exclusivo de treino de
      // Attack Speed. Ela nunca concede tries de Strength/Gloves. Uma segunda
      // Band na mão direita apenas dobra os tries de Attack Speed.
      gainSkill(
        state,
        'attackSpeed',
        TRAINING_MULTIPLIER * (
          dualTrainingGloves(state, itemCatalog) ? 2 : 1
        ),
        skillNotice
      );
    } else if (style === 'ki') {
      gainSkill(
        state,
        'kiBlasting',
        TRAINING_MULTIPLIER *
          vocationAptitude(character(), 'kiBlasting'),
        skillNotice
      );
    }
  }

  function punchingBagTick(now) {
    const stats = totalStats(state, itemCatalog);
    const style = equippedCombatStyle(state, itemCatalog);
    // Usa exatamente a mesma cadência base da Hunt. Como cada ação de
    // treino concede TRAINING_MULTIPLIER (=3), o ganho por tempo fica 3×.
    const interval = attackIntervalMs(
      state,
      character(),
      stats
    );

    if (state.training.targetAlive && now - state.training.lastPlayerAttack >= interval) {
      state.training.lastPlayerAttack = now;
      const damage = Math.max(
        1,
        Math.round(
          5 +
          Number(stats.attack || 0) +
          state.skills.gloves.level * 0.45 +
          state.skills.kiBlasting.level * (style === 'ki' ? 0.45 : 0)
        )
      );
      state.training.targetHp -= damage;
      addEffect(
        style === 'ki' ? 'ki-hit' : 'melee-hit',
        state.training.targetX,
        state.training.targetY,
        damage
      );
      trainPhysicalAttack();

      // A Punching Bag de treino não interrompe a sessão quando recebe
      // dano suficiente para zerar o HP: mantém 1 HP e regenera em seguida.
      // Isso impede personagens fortes de treinarem mais devagar por causa
      // de respawns sucessivos do dummy.
      state.training.targetHp = Math.max(1, state.training.targetHp);
    }

    // Mesmo ciclo defensivo da Hunt (1 s), porém com ganho 3×.
    if (
      state.training.targetAlive &&
      now - state.training.lastTargetAttack >= 1000
    ) {
      state.training.lastTargetAttack = now;
      gainSkill(
        state,
        'defense',
        TRAINING_MULTIPLIER,
        skillNotice
      );
      addEffect(
        'blocked-hit',
        state.training.playerX,
        state.training.playerY
      );
    }

    // Regenerate 99% of maximum HP each second.
    state.training.targetHp = Math.min(
      state.training.targetMaxHp,
      state.training.targetHp +
        state.training.targetMaxHp * 0.99 * (TICK_MS / 1000)
    );

  }

  // V22.3 — o vaivém fixo entre X=22 e X=78 saiu daqui.
  //
  // O ganho de Agility sempre foi por tempo, nunca por distância percorrida:
  // nada de balanceamento muda com a saída dele. O passeio pela sala é
  // apresentação e passou a viver no training-renderer, que é quem conhece o
  // mapa original e sabe quais tiles são piso livre.
  function timeChamberTick(delta) {
    gainSkill(
      state,
      'agility',
      TRAINING_MULTIPLIER * delta / 1000,
      skillNotice
    );
  }

  function kiBarrierTick(now) {
    const stats = totalStats(state, itemCatalog);
    const attackInterval = attackIntervalMs(
      state,
      character(),
      stats
    );

    if (now - state.training.lastPlayerAttack >= attackInterval) {
      state.training.lastPlayerAttack = now;
      const damage = Math.max(
        1,
        Math.round(
          8 +
          Number(stats.attack || 0) +
          state.skills.kiLevel.level * 0.5 +
          state.skills.kiBlasting.level * 0.55
        )
      );

      gainSkill(
        state,
        'kiLevel',
        TRAINING_MULTIPLIER *
          vocationAptitude(character(), 'kiLevel'),
        skillNotice
      );
      addEffect(
        'ki-hit',
        state.training.targetX,
        state.training.targetY,
        damage
      );
    }

    // Remote energy hits do no damage, but train Barrier.
    if (now - state.training.lastTargetAttack >= 1000) {
      state.training.lastTargetAttack = now;
      gainSkill(
        state,
        'barrier',
        TRAINING_MULTIPLIER,
        skillNotice
      );
      addEffect(
        'ki-block',
        state.training.playerX,
        state.training.playerY
      );
    }

    state.training.targetHp = state.training.targetMaxHp;
    state.training.targetAlive = true;
  }

  function tick() {
    const now = Date.now();
    const delta = Math.min(250, now - lastTick);
    lastTick = now;
    if (!state.training.running) return;

    if (room().id === 'punching-bag') {
      punchingBagTick(now);
    } else if (room().id === 'time-chamber') {
      timeChamberTick(delta);
    } else {
      kiBarrierTick(now);
    }

    state.training.effects = state.training.effects.filter(effect =>
      now - effect.createdAt < effect.duration + 100
    );
    onUpdate();
  }

  const interval = setInterval(() => {
    try {
      tick();
    } catch (error) {
      console.error('Erro no treino:', error);
      onLog('O ciclo de treino encontrou um erro e foi recuperado.');
    }
  }, TICK_MS);

  return {
    rooms:trainingRooms,
    currentRoom:room,
    start(roomId) {
      const selected = trainingRooms.find(entry => entry.id === roomId);
      if (!selected) return false;

      state.training = {
        ...createDefaultTrainingState(),
        roomId:selected.id,
        running:true,
        startedAt:Date.now()
      };

      if (selected.id === 'time-chamber') {
        state.training.targetAlive = false;
      }

      onLog(`Treino iniciado: ${selected.name}.`);
      onUpdate();
      return true;
    },
    stop() {
      state.training.running = false;
      state.training.effects = [];
      onUpdate();
    },
    snapshot() {
      return state.training;
    },
    destroy() {
      clearInterval(interval);
    }
  };
}
