// =====================================================================
// V22.4 — AURA DE KI + CINEMATICA DE TRANSFORMACAO
//
// A aura e desenhada por codigo (nao e sprite), entao vale para as 812
// formas do jogo automaticamente. A cor sai da paleta do proprio sprite
// (ver auraColorFor em sprite-forge.js), e a intensidade sai do indice
// da forma na cadeia de transformacao do personagem.
// =====================================================================

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function parseColor(color) {
  if (typeof color !== 'string') return [255, 208, 90];
  if (color.startsWith('#')) {
    const hex = color.length === 4
      ? color.slice(1).split('').map(c => c + c).join('')
      : color.slice(1);
    const int = parseInt(hex, 16);
    return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
  }
  const match = color.match(/(\d+(?:\.\d+)?)/g);
  if (match && match.length >= 3) return [Number(match[0]), Number(match[1]), Number(match[2])];
  return [255, 208, 90];
}

function rgba(rgb, alpha) {
  return `rgba(${Math.round(rgb[0])},${Math.round(rgb[1])},${Math.round(rgb[2])},${clamp(alpha, 0, 1)})`;
}

function lighten(rgb, amount) {
  return [
    rgb[0] + (255 - rgb[0]) * amount,
    rgb[1] + (255 - rgb[1]) * amount,
    rgb[2] + (255 - rgb[2]) * amount
  ];
}

function hash(n) {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

// ---------------------------------------------------------------------
// Aura persistente
// ---------------------------------------------------------------------

/**
 * ctx ja deve estar transladado para os PES do ator (0,0 = contato com
 * o chao). geo = {width, height, depth}.
 */
export function drawKiAura(ctx, geo, options) {
  const intensity = clamp(Number(options.intensity || 0), 0, 1.6);
  if (intensity <= 0.01) return;

  const time = Number(options.time || 0);
  const seed = Number(options.seed || 1);
  const rgb = parseColor(options.color);
  const hot = lighten(rgb, 0.34);
  const width = Math.max(12, geo.width);
  const height = Math.max(18, geo.height);
  const pulse = 0.82 + 0.18 * Math.sin(time / 210 + seed);
  const power = intensity * pulse;

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  // --- 1. poca de luz no chao ---------------------------------------
  const poolR = width * (0.78 + intensity * 0.30);
  ctx.save();
  ctx.scale(1, 0.34);
  const pool = ctx.createRadialGradient(0, 0, poolR * 0.1, 0, 0, poolR);
  pool.addColorStop(0, rgba(hot, 0.34 * power));
  pool.addColorStop(0.5, rgba(rgb, 0.18 * power));
  pool.addColorStop(1, rgba(rgb, 0));
  ctx.fillStyle = pool;
  ctx.beginPath();
  ctx.arc(0, 0, poolR, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // --- 2. brilho de corpo -------------------------------------------
  const glowR = Math.max(width, height) * (0.58 + intensity * 0.12);
  const body = ctx.createRadialGradient(0, -height * 0.52, glowR * 0.12, 0, -height * 0.52, glowR);
  body.addColorStop(0, rgba(hot, 0.22 * power));
  body.addColorStop(0.45, rgba(rgb, 0.13 * power));
  body.addColorStop(1, rgba(rgb, 0));
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(0, -height * 0.52, glowR, 0, Math.PI * 2);
  ctx.fill();

  // --- 3. linguas de fogo de ki -------------------------------------
  // As linguas de ki abracam o corpo: nascem nos pes, abrem na altura do
  // tronco e convergem numa ponta logo acima da cabeca. Se a ponta passar
  // muito disso, deixa de parecer aura e vira holofote.
  const licks = 11 + Math.round(intensity * 6);
  for (let i = 0; i < licks; i += 1) {
    const r1 = hash(seed + i * 3.7);
    const r2 = hash(seed + i * 8.3 + 11);
    const side = (i % 2 === 0 ? 1 : -1) * (0.35 + r1 * 0.65);
    const wobble = Math.sin(time / (150 + r2 * 170) + i * 1.7) * width * 0.13;
    const baseX = side * width * 0.26;
    const bulgeX = side * width * (0.52 + r2 * 0.34) + wobble;
    const tipY = -height * (0.96 + r1 * 0.26) * (0.82 + intensity * 0.20);
    const tipX = side * width * 0.14 + wobble * 0.55;
    const flick = 0.55 + 0.45 * Math.sin(time / 95 + i * 2.3);

    const grad = ctx.createLinearGradient(0, -height * 0.05, 0, tipY);
    grad.addColorStop(0, rgba(hot, 0.24 * power * flick));
    grad.addColorStop(0.40, rgba(rgb, 0.18 * power * flick));
    grad.addColorStop(0.80, rgba(rgb, 0.05 * power * flick));
    grad.addColorStop(1, rgba(rgb, 0));

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(baseX - width * 0.09, -height * 0.02);
    ctx.quadraticCurveTo(bulgeX - width * 0.10, -height * 0.46, tipX, tipY);
    ctx.quadraticCurveTo(bulgeX + width * 0.10, -height * 0.46, baseX + width * 0.09, -height * 0.02);
    ctx.closePath();
    ctx.fill();
  }

  // --- 4. faiscas subindo -------------------------------------------
  const sparks = Math.round(6 + intensity * 10);
  for (let i = 0; i < sparks; i += 1) {
    const r1 = hash(seed * 3 + i * 5.1);
    const r2 = hash(seed * 7 + i * 2.9);
    const life = 620 + r1 * 700;
    const t = ((time + r2 * life) % life) / life;
    const x = (r1 * 2 - 1) * width * 0.62 + Math.sin(time / 260 + i) * width * 0.10;
    const y = -t * height * (1.15 + intensity * 0.4) - height * 0.05;
    const size = (0.7 + r2 * 1.5) * (1 - t * 0.55) * (1 + intensity * 0.4);
    ctx.globalAlpha = (1 - t) * 0.75 * power;
    ctx.fillStyle = rgba(hot, 1);
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.35, size), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // --- 5. arcos eletricos (so em formas fortes) ----------------------
  if (intensity > 0.72) {
    const bolts = Math.round((intensity - 0.72) * 6) + 1;
    for (let i = 0; i < bolts; i += 1) {
      const phase = Math.floor(time / 130) + i * 17;
      if (hash(phase + seed) > 0.42) continue;
      const r1 = hash(phase * 1.7 + i);
      const r2 = hash(phase * 2.3 + i * 3);
      // Os arcos ficam presos ao corpo: soltos no ar viravam rabiscos.
      let x = (r1 * 2 - 1) * width * 0.52;
      let y = -height * (0.20 + r2 * 0.62);
      ctx.strokeStyle = rgba(lighten(rgb, 0.7), 0.34 * intensity);
      ctx.lineWidth = Math.max(0.6, width * 0.016);
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let s = 0; s < 4; s += 1) {
        x = clamp(x + (hash(phase + s * 3.1 + i) * 2 - 1) * width * 0.22, -width * 0.72, width * 0.72);
        y = clamp(y - height * 0.06 * (0.5 + hash(phase + s * 5.7)), -height * 1.02, -height * 0.05);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  ctx.restore();
}

// ---------------------------------------------------------------------
// Cinematica de transformacao
// ---------------------------------------------------------------------

const CHARGE_MS = 950;
const BURST_MS = 260;
const SETTLE_MS = 1050;
const TOTAL_MS = CHARGE_MS + BURST_MS + SETTLE_MS;

export class TransformationCinematic {
  constructor() {
    this.startedAt = -1e9;
    this.color = '#ffd05a';
    this.nextColor = '#ffd05a';
    this.previousOutfitId = null;
    this.label = '';
    this.seed = 1;
  }

  start(now, options = {}) {
    this.startedAt = now;
    this.color = options.fromColor || options.color || '#ffd05a';
    this.nextColor = options.color || this.color;
    this.previousOutfitId = options.previousOutfitId || null;
    this.label = options.label || '';
    this.seed = Math.random() * 1000;
  }

  active(now) {
    return now - this.startedAt < TOTAL_MS;
  }

  /** 0 = carga, 1 = estouro, 2 = assentamento. */
  phase(now) {
    const t = now - this.startedAt;
    if (t < 0 || t >= TOTAL_MS) return -1;
    if (t < CHARGE_MS) return 0;
    if (t < CHARGE_MS + BURST_MS) return 1;
    return 2;
  }

  /** Enquanto true, o renderer ainda desenha a forma ANTIGA. */
  showsPreviousForm(now) {
    return this.phase(now) === 0;
  }

  /** Tremor da camera, em pixels. */
  shake(now) {
    const t = now - this.startedAt;
    if (t < 0 || t >= TOTAL_MS) return 0;
    if (t < CHARGE_MS) {
      const k = t / CHARGE_MS;
      return Math.pow(k, 3) * 3.2;
    }
    const k = clamp((t - CHARGE_MS) / (BURST_MS + 620), 0, 1);
    return (1 - k) * 13;
  }

  /** Vibracao do proprio sprite durante a carga. */
  tremor(now) {
    const t = now - this.startedAt;
    if (t < 0 || t >= CHARGE_MS) return { x:0, y:0 };
    const k = Math.pow(t / CHARGE_MS, 2.4);
    return {
      x: (Math.random() - 0.5) * 3.4 * k,
      y: (Math.random() - 0.5) * 2.0 * k
    };
  }

  /** Intensidade extra de aura durante a cinematica. */
  auraBoost(now) {
    const t = now - this.startedAt;
    if (t < 0 || t >= TOTAL_MS) return 0;
    if (t < CHARGE_MS) return Math.pow(t / CHARGE_MS, 2) * 0.85;
    if (t < CHARGE_MS + BURST_MS) return 1.6;
    const k = (t - CHARGE_MS - BURST_MS) / SETTLE_MS;
    return 1.6 * (1 - k) * (1 - k);
  }

  colorAt(now) {
    return this.phase(now) === 0 ? this.color : this.nextColor;
  }

  /** Camadas atras do sprite: coluna de luz e aneis no chao. */
  drawUnder(ctx, geo, now) {
    const t = now - this.startedAt;
    if (t < 0 || t >= TOTAL_MS) return;
    const rgb = parseColor(this.colorAt(now));
    const hot = lighten(rgb, 0.6);
    const width = Math.max(14, geo.width);
    const height = Math.max(20, geo.height);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    if (t < CHARGE_MS) {
      // Particulas convergindo para o corpo.
      const k = t / CHARGE_MS;
      const count = 20;
      for (let i = 0; i < count; i += 1) {
        const r1 = hash(this.seed + i * 4.3);
        const r2 = hash(this.seed + i * 9.1 + 5);
        const cycle = 520 + r1 * 420;
        const local = ((t + r2 * cycle) % cycle) / cycle;
        const angle = r1 * Math.PI * 2 + t / 700;
        const radius = (1 - local) * width * (2.6 + r2 * 2.2);
        const x = Math.cos(angle) * radius;
        const y = -height * 0.5 + Math.sin(angle) * radius * 0.55;
        ctx.globalAlpha = local * 0.85 * k;
        ctx.fillStyle = rgba(hot, 1);
        ctx.beginPath();
        ctx.arc(x, y, (0.8 + r2 * 1.6) * (0.4 + local), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // Anel de energia fechando no chao.
      const ringR = width * (2.8 - 2.0 * k);
      ctx.save();
      ctx.scale(1, 0.34);
      ctx.strokeStyle = rgba(hot, 0.16 + 0.26 * k);
      ctx.lineWidth = 1.0 + k * 1.6;
      ctx.beginPath();
      ctx.arc(0, 0, Math.max(2, ringR), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    } else {
      // Coluna de luz saindo do chao.
      const k = clamp((t - CHARGE_MS) / (BURST_MS + SETTLE_MS), 0, 1);
      const fade = Math.pow(1 - k, 1.5);
      const colW = width * (1.5 + 0.6 * Math.sin(now / 120));
      const colH = height * (2.5 + 1.2 * (1 - fade));
      const column = ctx.createLinearGradient(0, 0, 0, -colH);
      column.addColorStop(0, rgba(hot, 0.30 * fade));
      column.addColorStop(0.42, rgba(rgb, 0.15 * fade));
      column.addColorStop(1, rgba(rgb, 0));
      ctx.fillStyle = column;
      ctx.beginPath();
      ctx.moveTo(-colW * 0.5, 0);
      ctx.lineTo(-colW * 0.24, -colH);
      ctx.lineTo(colW * 0.24, -colH);
      ctx.lineTo(colW * 0.5, 0);
      ctx.closePath();
      ctx.fill();

      // Ondas de choque no chao.
      for (let i = 0; i < 3; i += 1) {
        const delay = i * 130;
        const wt = (t - CHARGE_MS - delay) / 720;
        if (wt < 0 || wt > 1) continue;
        ctx.save();
        ctx.scale(1, 0.32);
        ctx.strokeStyle = rgba(hot, (1 - wt) * 0.34);
        ctx.lineWidth = (1 - wt) * 2.2 + 0.5;
        ctx.beginPath();
        ctx.arc(0, 0, width * (0.5 + wt * 6.5), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.restore();
  }

  /** Raios radiais e faiscas por cima do sprite. */
  drawOver(ctx, geo, now) {
    const t = now - this.startedAt;
    if (t < CHARGE_MS || t >= TOTAL_MS) return;
    const rgb = parseColor(this.nextColor);
    const hot = lighten(rgb, 0.7);
    const width = Math.max(14, geo.width);
    const height = Math.max(20, geo.height);
    const k = clamp((t - CHARGE_MS) / 620, 0, 1);
    const fade = Math.pow(1 - k, 2.4);
    if (fade <= 0.01) return;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(0, -height * 0.55);

    const rays = 16;
    for (let i = 0; i < rays; i += 1) {
      const angle = (i / rays) * Math.PI * 2 + this.seed * 0.01 + t / 2600;
      const len = width * (1.4 + hash(this.seed + i) * 2.4) * (0.45 + k * 1.1);
      const spread = 0.012 + hash(this.seed + i * 2.3) * 0.026;
      // Degrade ao longo do raio: sem isso vira um triangulo chapado.
      const tipX = Math.cos(angle) * len;
      const tipY = Math.sin(angle) * len;
      const grad = ctx.createLinearGradient(0, 0, tipX, tipY);
      grad.addColorStop(0, rgba(hot, 0.30 * fade));
      grad.addColorStop(0.55, rgba(rgb, 0.14 * fade));
      grad.addColorStop(1, rgba(rgb, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(angle - spread) * len, Math.sin(angle - spread) * len);
      ctx.lineTo(tipX, tipY);
      ctx.lineTo(Math.cos(angle + spread) * len, Math.sin(angle + spread) * len);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * Flash e vinheta em tela cheia. ctx aqui esta em coordenadas de tela.
   */
  drawScreen(ctx, w, h, now) {
    const t = now - this.startedAt;
    if (t < 0 || t >= TOTAL_MS) return;
    const rgb = parseColor(this.nextColor);

    if (t < CHARGE_MS) {
      // Escurece a cena em volta enquanto carrega.
      const k = Math.pow(t / CHARGE_MS, 2);
      const vignette = ctx.createRadialGradient(w / 2, h * 0.58, h * 0.12, w / 2, h * 0.58, Math.max(w, h) * 0.72);
      vignette.addColorStop(0, 'rgba(0,0,0,0)');
      vignette.addColorStop(1, `rgba(0,0,0,${0.52 * k})`);
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, w, h);
      return;
    }

    const flashT = (t - CHARGE_MS) / 520;
    if (flashT < 1) {
      const alpha = Math.pow(1 - flashT, 2.2);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const flash = ctx.createRadialGradient(w / 2, h * 0.55, 0, w / 2, h * 0.55, Math.max(w, h) * 0.85);
      flash.addColorStop(0, `rgba(255,255,255,${0.92 * alpha})`);
      flash.addColorStop(0.35, rgba(lighten(rgb, 0.5), 0.55 * alpha));
      flash.addColorStop(1, rgba(rgb, 0));
      ctx.fillStyle = flash;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
  }
}

export const CINEMATIC_TOTAL_MS = TOTAL_MS;
