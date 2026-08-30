// =====================================================================
// V22.4 — SPRITE FORGE (HD-2D)
//
// Pega um frame 32x64 de spritesheet estilo Tibia 8.54 e devolve um
// canvas iluminado, com volume, como nos clientes modernos:
//
//   1. campo de distancia interno da silhueta  -> altura (relevo)
//   2. luminancia do proprio pixel art         -> detalhe do relevo
//   3. normal map derivado da altura           -> luz direcional real
//   4. luz-chave + luz de preenchimento        -> volume
//   5. rim light na borda iluminada            -> separacao do fundo
//   6. specular suave                          -> pele/armadura brilhando
//   7. oclusao de contato na silhueta e nos pes
//   8. contorno escuro externo                 -> o sprite "descola" do chao
//
// Nada disso altera arquivo nenhum em disco: e feito uma unica vez por
// frame, em memoria, e fica em cache. Serve para QUALQUER spritesheet do
// jogo (as 812 transformacoes, monstros, bosses) sem redesenhar arte.
// =====================================================================

const SS = 2;          // supersample do canvas de saida (nitidez do contorno)
const PAD = 1;         // 1 pixel de arte de folga para o contorno externo
const CACHE_LIMIT = 420;

const cache = new Map();
const auraCache = new Map();

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') {
    return new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  return canvas;
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0 || 1), 0, 1);
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------
// Perfis de luz por tema de arena. Sao os mesmos vetores usados pelas
// sombras projetadas do renderer, entao a luz do sprite bate com a luz
// do cenario.
// ---------------------------------------------------------------------
export const LIGHT_PROFILES = {
  earth: { key:[1.00,0.94,0.82], fill:[0.55,0.68,0.92], rim:[0.72,0.88,1.00], strength:1.00 },
  dirt:  { key:[1.00,0.84,0.62], fill:[0.62,0.44,0.38], rim:[1.00,0.78,0.52], strength:1.06 },
  stone: { key:[0.78,0.88,1.00], fill:[0.34,0.44,0.60], rim:[0.62,0.82,1.00], strength:1.12 },
  snow:  { key:[1.00,1.00,1.00], fill:[0.70,0.82,0.96], rim:[0.88,0.96,1.00], strength:0.94 }
};

// Direcao da luz-chave (x para a direita, y para BAIXO, z para o jogador).
const LX = -0.42, LY = -0.34, LZ = 0.84;
const LLEN = Math.hypot(LX, LY, LZ);
const L = [LX / LLEN, LY / LLEN, LZ / LLEN];

// Rim vem do lado oposto e um pouco de tras.
const RX = 0.58, RY = -0.42, RZ = 0.24;
const RLEN = Math.hypot(RX, RY, RZ);
const R = [RX / RLEN, RY / RLEN, RZ / RLEN];

// Meio-vetor para o specular (visao = 0,0,1).
const HX = L[0], HY = L[1], HZ = L[2] + 1;
const HLEN = Math.hypot(HX, HY, HZ);
const H = [HX / HLEN, HY / HLEN, HZ / HLEN];

// ---------------------------------------------------------------------
// Distance transform (chamfer 3-4) da parte interna da silhueta.
// ---------------------------------------------------------------------
function innerDistance(alpha, w, h) {
  const INF = 1e6;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i += 1) d[i] = alpha[i] ? INF : 0;

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (!d[i]) continue;
      let best = d[i];
      if (y > 0) {
        if (x > 0) best = Math.min(best, d[i - w - 1] + 4);
        best = Math.min(best, d[i - w] + 3);
        if (x < w - 1) best = Math.min(best, d[i - w + 1] + 4);
      }
      if (x > 0) best = Math.min(best, d[i - 1] + 3);
      d[i] = best;
    }
  }
  for (let y = h - 1; y >= 0; y -= 1) {
    for (let x = w - 1; x >= 0; x -= 1) {
      const i = y * w + x;
      if (!d[i]) continue;
      let best = d[i];
      if (y < h - 1) {
        if (x < w - 1) best = Math.min(best, d[i + w + 1] + 4);
        best = Math.min(best, d[i + w] + 3);
        if (x > 0) best = Math.min(best, d[i + w - 1] + 4);
      }
      if (x < w - 1) best = Math.min(best, d[i + 1] + 3);
      d[i] = best;
    }
  }
  for (let i = 0; i < d.length; i += 1) d[i] /= 3; // volta para ~pixels
  return d;
}

function boxBlur(src, w, h, mask) {
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (!mask[i]) { out[i] = 0; continue; }
      let sum = 0, count = 0;
      for (let oy = -1; oy <= 1; oy += 1) {
        const yy = y + oy;
        if (yy < 0 || yy >= h) continue;
        for (let ox = -1; ox <= 1; ox += 1) {
          const xx = x + ox;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (!mask[j]) continue;
          sum += src[j];
          count += 1;
        }
      }
      out[i] = count ? sum / count : src[i];
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Nucleo: transforma um frame em um frame com volume.
// ---------------------------------------------------------------------
function shadeFrame(pixels, w, h, profile, options) {
  const total = w * h;
  const mask = new Uint8Array(total);
  const lum = new Float32Array(total);

  for (let i = 0; i < total; i += 1) {
    const a = pixels[i * 4 + 3];
    mask[i] = a > 16 ? 1 : 0;
    if (mask[i]) {
      lum[i] = (
        pixels[i * 4] * 0.299 +
        pixels[i * 4 + 1] * 0.587 +
        pixels[i * 4 + 2] * 0.114
      ) / 255;
    }
  }

  const dist = innerDistance(mask, w, h);
  // Raio do "abaulamento". Proporcional a largura do corpo, com limites
  // para o sprite nao virar uma bola nem ficar chapado.
  const radius = clamp(Math.min(w, h * 0.5) * 0.30, 2.6, 6.4);

  const height = new Float32Array(total);
  for (let i = 0; i < total; i += 1) {
    if (!mask[i]) continue;
    // Cupula: 0 na borda, 1 no miolo, com curva de seno (mais redonda).
    const dome = Math.sin(smoothstep(0, radius, dist[i]) * Math.PI * 0.5);
    // Detalhe vindo do proprio pixel art: partes claras sobem, escuras afundam.
    const detail = (lum[i] - 0.52) * options.detail;
    height[i] = dome + detail;
  }
  const smooth = boxBlur(height, w, h, mask);

  const key = profile.key, fill = profile.fill, rim = profile.rim;
  const strength = profile.strength * options.relief;
  const out = new Uint8ClampedArray(pixels.length);

  const sample = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return 0;
    const i = y * w + x;
    return mask[i] ? smooth[i] : 0;
  };

  // Normaliza a luz difusa pelo valor que uma superficie CHAPADA receberia.
  // Assim o miolo do sprite sai com a cor original, pixel por pixel, e so
  // as partes inclinadas (bordas, vincos, volumes) escurecem ou clareiam.
  // E o que separa "sprite com volume" de "sprite com filtro por cima".
  const flat = 0.52 + 0.48 * L[2];

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      const o = i * 4;
      if (!mask[i]) { out[o + 3] = 0; continue; }

      const gx = (sample(x + 1, y) - sample(x - 1, y)) * strength;
      const gy = (sample(x, y + 1) - sample(x, y - 1)) * strength;
      const nl = Math.hypot(-gx, -gy, 1) || 1;
      const nx = -gx / nl, ny = -gy / nl, nz = 1 / nl;

      const ndl = nx * L[0] + ny * L[1] + nz * L[2];
      const ndr = nx * R[0] + ny * R[1] + nz * R[2];
      const ndh = nx * H[0] + ny * H[1] + nz * H[2];
      // Curvatura: 0 no chapado, 1 na quina. Segura o specular e o rim
      // longe das areas planas — e o que evitava lavar a cor.
      const curve = clamp(Math.hypot(gx, gy) * 1.5, 0, 1);

      // Oclusao de contato: a borda da silhueta escurece de leve.
      const ao = 0.80 + 0.20 * smoothstep(0, radius * 1.15, dist[i]);
      // Sombra de contato nos pes.
      const floor = 1 - 0.22 * smoothstep(h * 0.86, h * 1.0, y);
      // Faixa fina junto da silhueta, onde o rim pode aparecer.
      const edge = 1 - smoothstep(0, radius * 0.55, dist[i]);

      const shade = clamp((0.52 + 0.48 * ndl) / flat, 0.38, 1.20) * ao * floor;
      const rimAmt = Math.pow(Math.max(0, ndr), 3) * edge * curve * options.rim;
      const spec = Math.pow(Math.max(0, ndh), 18) * curve * options.spec * (0.35 + 0.65 * lum[i]);
      // Luz de preenchimento entra como TINTA multiplicativa na sombra,
      // nao como cor somada: a sombra ganha o tom frio do ambiente sem
      // perder saturacao nem clarear.
      const shadowAmt = clamp(1 - shade, 0, 1) * options.fill;

      for (let c = 0; c < 3; c += 1) {
        let v = pixels[o + c] * shade;
        v = v * (1 - shadowAmt) + v * fill[c] * 1.45 * shadowAmt;
        v += rim[c] * 255 * rimAmt;
        v += key[c] * 255 * spec;
        out[o + c] = v;
      }
      out[o + 3] = pixels[o + 3];
    }
  }
  return out;
}

const DEFAULTS = { detail:0.34, relief:1.95, rim:0.38, spec:0.32, fill:0.55, outline:0.32 };

/**
 * Devolve {canvas, pad, ss, w, h} com o frame ja iluminado, ou null se
 * o canvas estiver "tainted" ou a imagem ainda nao carregou.
 * O canvas tem PAD pixels de arte de folga em cada lado.
 */
export function forgeFrame(image, sx, sy, sw, sh, themeKey = 'earth', overrides = null) {
  if (!image || !image.naturalWidth) return null;
  const opts = overrides ? { ...DEFAULTS, ...overrides } : DEFAULTS;
  const cacheKey = `${image.src}|${sx}|${sy}|${sw}|${sh}|${themeKey}|${opts.relief}|${opts.rim}`;
  const hit = cache.get(cacheKey);
  if (hit !== undefined) return hit;

  let result = null;
  try {
    const read = makeCanvas(sw, sh);
    const rctx = read.getContext('2d', { willReadFrequently:true });
    rctx.imageSmoothingEnabled = false;
    rctx.clearRect(0, 0, sw, sh);
    rctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
    const source = rctx.getImageData(0, 0, sw, sh);

    let any = false;
    for (let i = 3; i < source.data.length; i += 4) {
      if (source.data[i] > 16) { any = true; break; }
    }
    if (!any) { cache.set(cacheKey, null); return null; }

    const profile = LIGHT_PROFILES[themeKey] || LIGHT_PROFILES.earth;
    const shaded = shadeFrame(source.data, sw, sh, profile, opts);

    const lit = makeCanvas(sw, sh);
    const lctx = lit.getContext('2d');
    lctx.putImageData(new ImageData(shaded, sw, sh), 0, 0);

    const outW = (sw + PAD * 2) * SS;
    const outH = (sh + PAD * 2) * SS;
    const out = makeCanvas(outW, outH);
    const ctx = out.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    const ox = PAD * SS, oy = PAD * SS;
    const dw = sw * SS, dh = sh * SS;

    // ---- contorno externo -------------------------------------------
    if (opts.outline > 0) {
      const ring = makeCanvas(outW, outH);
      const rctx2 = ring.getContext('2d');
      rctx2.imageSmoothingEnabled = false;
      const step = SS;
      const offsets = [
        [-step,0],[step,0],[0,-step],[0,step],
        [-step,-step],[step,-step],[-step,step],[step,step]
      ];
      for (const [dx, dy] of offsets) {
        rctx2.drawImage(image, sx, sy, sw, sh, ox + dx, oy + dy, dw, dh);
      }
      rctx2.globalCompositeOperation = 'source-in';
      rctx2.fillStyle = `rgba(6,9,14,${opts.outline})`;
      rctx2.fillRect(0, 0, outW, outH);
      ctx.drawImage(ring, 0, 0);
    }

    ctx.drawImage(lit, 0, 0, sw, sh, ox, oy, dw, dh);
    result = { canvas:out, pad:PAD, ss:SS, w:sw, h:sh };
  } catch {
    result = null; // canvas tainted (imagem de outra origem) -> desenho cru
  }

  if (cache.size > CACHE_LIMIT) {
    let drop = Math.ceil(CACHE_LIMIT * 0.35);
    for (const k of cache.keys()) {
      cache.delete(k);
      if (--drop <= 0) break;
    }
  }
  cache.set(cacheKey, result);
  return result;
}

export function clearForgeCache() {
  cache.clear();
}

// ---------------------------------------------------------------------
// Cor da aura: pega o tom saturado dominante do sprite (cabelo, ki,
// armadura) para que cada uma das transformacoes ganhe uma aura com a
// cor certa sem ninguem cadastrar nada a mao.
// ---------------------------------------------------------------------
export function auraColorFor(image, sx, sy, sw, sh, fallback = '#ffd05a') {
  if (!image || !image.naturalWidth) return fallback;
  const cacheKey = `${image.src}|${sx}|${sy}|${sw}|${sh}`;
  const hit = auraCache.get(cacheKey);
  if (hit) return hit;

  let color = fallback;
  try {
    const read = makeCanvas(sw, sh);
    const rctx = read.getContext('2d', { willReadFrequently:true });
    rctx.imageSmoothingEnabled = false;
    rctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
    const data = rctx.getImageData(0, 0, sw, sh).data;

    const bins = new Float64Array(18);
    const rs = new Float64Array(18);
    const gs = new Float64Array(18);
    const bs = new Float64Array(18);

    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 64) continue;
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const l = (max + min) / 2;
      if (l < 0.16 || l > 0.94) continue;
      const delta = max - min;
      if (delta < 0.16) continue;
      const sat = delta / (1 - Math.abs(2 * l - 1) || 1);
      let hue;
      if (max === r) hue = ((g - b) / delta) % 6;
      else if (max === g) hue = (b - r) / delta + 2;
      else hue = (r - g) / delta + 4;
      hue = ((hue * 60) + 360) % 360;
      const bin = Math.floor(hue / 20) % 18;
      const weight = sat * sat * (a / 255);
      bins[bin] += weight;
      rs[bin] += r * weight; gs[bin] += g * weight; bs[bin] += b * weight;
    }

    let best = -1, bestValue = 0;
    for (let i = 0; i < 18; i += 1) {
      if (bins[i] > bestValue) { bestValue = bins[i]; best = i; }
    }
    if (best >= 0 && bestValue > 0) {
      // Media da faixa dominante, empurrada para cima em brilho: aura e luz.
      let r = rs[best] / bins[best], g = gs[best] / bins[best], b = bs[best] / bins[best];
      const max = Math.max(r, g, b) || 1;
      const boost = Math.min(1 / max, 1.85);
      r = clamp(r * boost * 1.02, 0, 1);
      g = clamp(g * boost * 1.02, 0, 1);
      b = clamp(b * boost * 1.02, 0, 1);
      color = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
    }
  } catch {
    color = fallback;
  }

  auraCache.set(cacheKey, color);
  return color;
}

// ---------------------------------------------------------------------
// Silhueta chapada de um frame — usada para o flash branco de dano e
// para o brilho de aura por cima do sprite.
// ---------------------------------------------------------------------
const silhouetteCache = new Map();

export function forgeSilhouette(image, sx, sy, sw, sh, color = '#ffffff') {
  if (!image || !image.naturalWidth) return null;
  const cacheKey = `${image.src}|${sx}|${sy}|${sw}|${sh}|${color}`;
  const hit = silhouetteCache.get(cacheKey);
  if (hit !== undefined) return hit;

  let out = null;
  try {
    const canvas = makeCanvas(sw * SS, sh * SS);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw * SS, sh * SS);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, sw * SS, sh * SS);
    out = canvas;
  } catch {
    out = null;
  }

  if (silhouetteCache.size > 240) {
    let drop = 90;
    for (const k of silhouetteCache.keys()) {
      silhouetteCache.delete(k);
      if (--drop <= 0) break;
    }
  }
  silhouetteCache.set(cacheKey, out);
  return out;
}

// ---------------------------------------------------------------------
// Altura real da arte dentro da moldura.
//
// Uma moldura de 32x64 quase nunca é preenchida até em cima: sobra
// transparência acima da cabeça. Quem desenha aura precisa da altura do
// CORPO, não da moldura — senão as chamas sobem muito além do personagem
// e a aura vira holofote.
// ---------------------------------------------------------------------
const artTopCache = new Map();

export function frameArtTop(image, sx, sy, sw, sh) {
  if (!image?.naturalWidth) return 0;
  const cacheKey = `${image.src}|${sx}|${sy}|${sw}|${sh}`;
  const hit = artTopCache.get(cacheKey);
  if (hit !== undefined) return hit;

  let top = 0;
  try {
    const canvas = makeCanvas(sw, sh);
    const ctx = canvas.getContext('2d', { willReadFrequently:true });
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
    const data = ctx.getImageData(0, 0, sw, sh).data;
    let found = sh;
    outer:
    for (let y = 0; y < sh; y += 1) {
      for (let x = 0; x < sw; x += 1) {
        if (data[(y * sw + x) * 4 + 3] > 16) { found = y; break outer; }
      }
    }
    top = found >= sh ? 0 : found;
  } catch {
    top = 0;
  }

  if (artTopCache.size > 600) artTopCache.clear();
  artTopCache.set(cacheKey, top);
  return top;
}

/** Altura da arte visível, em pixels da moldura. */
export function frameArtHeight(image, sx, sy, sw, sh) {
  return Math.max(12, sh - frameArtTop(image, sx, sy, sw, sh));
}
