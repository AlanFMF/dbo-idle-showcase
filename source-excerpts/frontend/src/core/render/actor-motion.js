// =====================================================================
// V22.4 — ANIMACAO PROCEDURAL DE ATORES
//
// As spritesheets do jogo tem 3 frames por direcao. Isso da uma
// caminhada e nada mais. Este modulo cria, em cima desses mesmos 3
// frames, o resto da animacao que os clientes modernos tem:
//
//   respiracao / balanco no idle, bob e inclinacao na caminhada,
//   squash & stretch na pisada, investida com antecipacao no ataque,
//   recuo + flash branco ao levar dano, tremor, e queda na morte.
//
// Tudo sai de observar o estado do jogo (posicao, hp) — nenhuma regra
// de combate e tocada.
// =====================================================================

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

// Curvas de easing usadas nas fases de ataque.
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
const easeInCubic = t => t * t * t;
const easeOutBack = t => 1 + 2.2 * Math.pow(t - 1, 3) + 1.4 * Math.pow(t - 1, 2);

const HIT_MS = 340;
const STRIKE_MS = 420;
const SPAWN_MS = 420;
const DEATH_MS = 620;

export class ActorMotion {
  constructor(now = 0) {
    this.bornAt = now;
    this.lastSeen = now;
    this.x = null;
    this.y = null;
    this.vx = 0;
    this.vy = 0;
    this.speed = 0;
    this.walkPhase = Math.random() * Math.PI * 2;
    this.idlePhase = Math.random() * Math.PI * 2;
    this.hp = null;
    this.hitAt = -1e9;
    this.hitPower = 0;
    this.hitDirX = 0;
    this.hitDirY = 0;
    this.strikeAt = -1e9;
    this.strikeDirX = 0;
    this.strikeDirY = -1;
    this.strikeHeavy = false;
    this.deadAt = -1e9;
    this.dust = [];
    this.lastFootfall = -1e9;
  }

  /**
   * Alimenta o estado observavel do ator. Detecta movimento e dano
   * sozinho, comparando com o quadro anterior.
   */
  observe(now, x, y, hp, maxHp) {
    const dt = Math.max(1, Math.min(120, now - this.lastSeen));
    this.lastSeen = now;

    if (this.x === null) {
      this.x = x; this.y = y;
    } else {
      const dx = x - this.x;
      const dy = y - this.y;
      // Suavizacao exponencial: a hunt move os atores em passos discretos.
      const k = Math.min(1, dt / 140);
      this.vx += ((dx / dt) * 1000 - this.vx) * k;
      this.vy += ((dy / dt) * 1000 - this.vy) * k;
      this.x = x; this.y = y;
    }
    this.speed = Math.hypot(this.vx, this.vy);

    const moving = this.speed > 2.2;
    if (moving) {
      const before = this.walkPhase;
      this.walkPhase += (dt / 1000) * clamp(this.speed * 0.42, 3.4, 12.5);
      // Poeira a cada pisada (dois passos por ciclo).
      if (Math.floor(before / Math.PI) !== Math.floor(this.walkPhase / Math.PI)) {
        this.puff(now, 0.55);
      }
    } else {
      this.walkPhase += (dt / 1000) * 0.9;
    }
    this.idlePhase += dt / 1000;

    if (Number.isFinite(hp)) {
      if (this.hp !== null && hp < this.hp - 0.001) {
        const lost = this.hp - hp;
        const ratio = maxHp > 0 ? lost / maxHp : 0.05;
        this.hurt(now, clamp(0.42 + ratio * 5.5, 0.42, 1.35));
      }
      this.hp = hp;
    }
  }

  /** Levou dano. dirX/dirY apontam de quem bateu para este ator. */
  hurt(now, power = 0.7, dirX = 0, dirY = 0) {
    this.hitAt = now;
    this.hitPower = Math.max(this.hitPower * 0.4, power);
    const len = Math.hypot(dirX, dirY);
    this.hitDirX = len ? dirX / len : 0;
    this.hitDirY = len ? dirY / len : -0.25;
    this.puff(now, 0.9);
  }

  /** Desferiu um golpe na direcao (dirX, dirY) em unidades de arena. */
  strike(now, dirX, dirY, heavy = false) {
    if (now - this.strikeAt < STRIKE_MS * 0.55) return;
    const len = Math.hypot(dirX, dirY) || 1;
    this.strikeAt = now;
    this.strikeDirX = dirX / len;
    this.strikeDirY = dirY / len;
    this.strikeHeavy = heavy;
  }

  kill(now) {
    if (this.deadAt > -1e8) return;
    this.deadAt = now;
  }

  puff(now, power = 0.6) {
    if (now - this.lastFootfall < 90) return;
    this.lastFootfall = now;
    const count = power > 0.8 ? 4 : 2;
    for (let i = 0; i < count; i += 1) {
      this.dust.push({
        born: now,
        life: 340 + Math.random() * 260,
        x: (Math.random() - 0.5) * 9 * power,
        y: 0,
        vx: (Math.random() - 0.5) * 22 * power,
        vy: -(10 + Math.random() * 26) * power,
        size: (1.4 + Math.random() * 2.4) * power
      });
    }
    if (this.dust.length > 26) this.dust.splice(0, this.dust.length - 26);
  }

  /**
   * Devolve a transformacao a ser aplicada no sprite neste frame.
   * Todos os offsets estao em "pixels de arte" (antes da escala/depth).
   */
  sample(now) {
    let offsetX = 0, offsetY = 0, scaleX = 1, scaleY = 1, rotation = 0;
    let flash = 0, alpha = 1, glow = 0;

    const moving = this.speed > 2.2;

    if (moving) {
      // Caminhada: sobe/desce, comprime na pisada, inclina para a frente.
      const bob = Math.abs(Math.sin(this.walkPhase));
      offsetY -= bob * 1.5;
      scaleY *= 1 + (bob - 0.5) * 0.055;
      scaleX *= 1 - (bob - 0.5) * 0.045;
      rotation += clamp(this.vx / 60, -1, 1) * 0.055;
      offsetX += clamp(this.vx / 70, -1, 1) * 0.9;
    } else {
      // Idle: respiracao no peito + micro balanco lateral.
      const breath = Math.sin(this.idlePhase * 1.65);
      scaleY *= 1 + breath * 0.020;
      scaleX *= 1 - breath * 0.014;
      offsetY -= (breath + 1) * 0.28;
      rotation += Math.sin(this.idlePhase * 0.72) * 0.012;
    }

    // --- surgimento -------------------------------------------------
    const spawnT = (now - this.bornAt) / SPAWN_MS;
    if (spawnT < 1) {
      const t = clamp(spawnT, 0, 1);
      const pop = easeOutBack(t);
      scaleX *= 0.62 + 0.38 * pop;
      scaleY *= 0.62 + 0.38 * pop;
      alpha *= clamp(t * 1.7, 0, 1);
    }

    // --- ataque -----------------------------------------------------
    const strikeT = (now - this.strikeAt) / STRIKE_MS;
    if (strikeT >= 0 && strikeT < 1) {
      const reach = this.strikeHeavy ? 7.5 : 5.0;
      let push = 0, lean = 0;
      if (strikeT < 0.26) {
        // antecipacao: puxa para tras
        const t = strikeT / 0.26;
        push = -easeOutCubic(t) * reach * 0.34;
        lean = -easeOutCubic(t) * 0.10;
        scaleY *= 1 - t * 0.045;
        scaleX *= 1 + t * 0.05;
      } else if (strikeT < 0.52) {
        // golpe: dispara para a frente
        const t = (strikeT - 0.26) / 0.26;
        push = (-0.34 + easeInCubic(t) * 1.34) * reach;
        lean = (-0.10 + t * 0.30);
        scaleY *= 1 + t * 0.07;
        scaleX *= 1 - t * 0.05;
        glow = Math.max(glow, t * (this.strikeHeavy ? 0.55 : 0.28));
      } else {
        // recuperacao
        const t = (strikeT - 0.52) / 0.48;
        push = (1 - easeOutCubic(t)) * reach;
        lean = 0.20 * (1 - easeOutCubic(t));
        glow = Math.max(glow, (1 - t) * (this.strikeHeavy ? 0.35 : 0.16));
      }
      offsetX += this.strikeDirX * push;
      offsetY += this.strikeDirY * push * 0.42;
      rotation += lean * (this.strikeDirX >= 0 ? 1 : -1);
    }

    // --- dano -------------------------------------------------------
    const hitT = (now - this.hitAt) / HIT_MS;
    if (hitT >= 0 && hitT < 1) {
      const decay = Math.pow(1 - hitT, 2.1);
      const shake = Math.sin(hitT * Math.PI * 7.5) * decay * this.hitPower;
      offsetX += shake * 3.4 + this.hitDirX * decay * this.hitPower * 3.0;
      offsetY += this.hitDirY * decay * this.hitPower * 1.6 - decay * this.hitPower * 1.2;
      scaleX *= 1 + decay * this.hitPower * 0.10;
      scaleY *= 1 - decay * this.hitPower * 0.085;
      rotation += shake * 0.045;
      flash = Math.max(flash, Math.pow(clamp(1 - hitT * 2.6, 0, 1), 1.4) * clamp(this.hitPower, 0, 1));
    }

    // --- morte ------------------------------------------------------
    // deadAt fica em -1e9 enquanto o ator esta vivo, entao a checagem
    // precisa ser por "ja morreu mesmo" e nao pelo tempo decorrido — com
    // a comparacao ingenua todo ator vivo entrava na fase de morte e saia
    // com alpha 0, ou seja, invisivel.
    if (this.deadAt > -1e8) {
      const t = clamp((now - this.deadAt) / DEATH_MS, 0, 1);
      rotation += easeOutCubic(t) * 1.18;
      offsetY += easeInCubic(t) * 8;
      alpha *= 1 - t;
      scaleY *= 1 - t * 0.25;
    }

    return { offsetX, offsetY, scaleX, scaleY, rotation, flash, alpha, glow, moving, walkPhase:this.walkPhase };
  }

  /** Poeira do chao. Consumida pelo renderer, ja em coordenadas de tela. */
  sampleDust(now) {
    if (!this.dust.length) return null;
    const alive = [];
    for (const particle of this.dust) {
      const t = (now - particle.born) / particle.life;
      if (t >= 1) continue;
      alive.push({
        x: particle.x + particle.vx * (t * particle.life) / 1000,
        y: particle.y + particle.vy * (t * particle.life) / 1000 + 34 * t * t,
        alpha: (1 - t) * 0.42,
        size: particle.size * (1 + t * 1.7)
      });
    }
    this.dust = this.dust.filter(p => (now - p.born) < p.life);
    return alive.length ? alive : null;
  }
}

export class MotionDirector {
  constructor() {
    this.actors = new Map();
    this.lastPrune = 0;
  }

  get(uid, now) {
    let motion = this.actors.get(uid);
    if (!motion) {
      motion = new ActorMotion(now);
      this.actors.set(uid, motion);
    }
    return motion;
  }

  peek(uid) {
    return this.actors.get(uid) || null;
  }

  prune(now) {
    if (now - this.lastPrune < 2000) return;
    this.lastPrune = now;
    for (const [uid, motion] of this.actors) {
      if (now - motion.lastSeen > 8000) this.actors.delete(uid);
    }
  }
}
