import {
  forgeFrame,
  forgeSilhouette,
  auraColorFor,
  frameArtHeight
} from '../render/sprite-forge.js?v=22.4.4';
import { MotionDirector } from '../render/actor-motion.js?v=22.4.4';
import { resolveOutfit } from '../render/outfit-fallback.js?v=22.4.4';
import { currentTransformationForm } from '../transformations/transformation-engine.js?v=21.26.4';
import {
  drawKiAura,
  TransformationCinematic
} from '../render/ki-aura.js?v=22.4.4';

const sharedHuntImages = new Map();
let sharedHuntAssets = null;
let sharedHuntAssetsPromise = null;

function loadSharedHuntAssets(){
  if(sharedHuntAssets)return Promise.resolve(sharedHuntAssets);
  if(!sharedHuntAssetsPromise){
    sharedHuntAssetsPromise=Promise.all([
      fetch('./assets/generated/outfit-manifest.json?v=22.4.4',{cache:'force-cache'}).then(r=>r.json()),
      fetch('./assets/generated/monster-manifest.json',{cache:'force-cache'}).then(r=>r.json()),
      fetch('./assets/generated/absolute-monster-manifest.json',{cache:'force-cache'}).then(r=>r.json()),
      fetch('./generated/asset-registry/effects.json',{cache:'force-cache'}).then(r=>r.json()),
      fetch('./generated/asset-registry/missiles.json',{cache:'force-cache'}).then(r=>r.json())
    ]).then(([outfits,monsters,absoluteMonsters,effectAssets,missileAssets])=>
      (sharedHuntAssets={outfits,monsters,absoluteMonsters,effectAssets,missileAssets})
    ).catch(error=>{sharedHuntAssetsPromise=null;throw error;});
  }
  return sharedHuntAssetsPromise;
}

// Reused, hand-picked classic-Tibia sprites (already shipped in this
// project's asset pack) used to wall off each arena with a themed border
// instead of a flat repeating tile with nothing around it. Positions are
// derived deterministically from the zone id (see seededRandom below) so
// the scenery doesn't jitter between frames or re-renders, but still
// differs from one hunt to the next.
const ARENA_DECORATION_SPRITES = {
  earth: [
    './assets/generated/full-registry/previews/item/3614.png', // pine tree
    './assets/generated/full-registry/previews/item/3615.png', // pine tree
    './assets/generated/full-registry/previews/item/3681.png', // tree
    './assets/generated/full-registry/previews/item/3680.png'  // flowering bush
  ],
  dirt: [
    './assets/generated/full-registry/previews/item/3682.png', // bush w/ berries
    './assets/generated/full-registry/previews/item/3689.png', // dry bush
    './assets/generated/full-registry/previews/item/3696.png', // dry bush
    './assets/generated/full-registry/previews/item/1864.png'  // rock
  ],
  stone: [
    './assets/generated/full-registry/previews/item/1025.png', // cave wall
    './assets/generated/full-registry/previews/item/1043.png', // cave wall
    './assets/generated/full-registry/previews/item/1042.png', // cave wall corner
    './assets/generated/full-registry/previews/item/1772.png'  // boulder
  ],
  snow: [
    './assets/generated/full-registry/previews/item/1772.png', // boulder
    './assets/generated/full-registry/previews/item/1773.png', // boulder
    './assets/generated/full-registry/previews/item/1864.png'  // rock
  ]
};

// V22 — "fake 3D" arena.
//
// The arena is still a plain 2D canvas with the same sprite sheets, but the
// ground is now projected as a perspective plane (a Mode-7 style scanline
// warp of the same 32px floor tile) with a horizon, a painted backdrop, a
// key light, projected soft shadows, depth-scaled actors and directional
// shading baked onto each sprite frame. Everything below is presentation
// only: arena coordinates, hitboxes and combat logic are untouched.
//
// FAR_SCALE is how wide the back edge of the ground plane is compared to
// the front edge. The projection is hyperbolic (1/z), the same curve a real
// camera produces, so rows bunch up towards the horizon instead of fading
// linearly.
const FAR_SCALE = 0.60;
// How much of the depth scaling is applied to the actors themselves. 1 would
// mean a monster at the back is 60% the size of the same monster at the
// front, which reads as too extreme with 32x64 sprites.
const ACTOR_DEPTH_MIX = 0.72;
// Direction the key light comes from, used for the cast shadows and for the
// optional gradient painted onto the sprites.
const LIGHT_X = -0.42;
const LIGHT_Y = -0.34;

// Quanto da luz da arena é pintada por cima do sprite do player e dos
// monstros, de 0 a 1.
//
//   0    -> sprite 100% original, pixel por pixel, como sempre foi.
//   0.35 -> sombreamento discreto, só para o personagem "pegar" a luz da cena.
//   1    -> sombreamento forte (top-left claro, bottom-right escuro).
//
// Fica em 0 por decisão do projeto: a arte original dos outfits e dos
// monstros não é alterada. Sombra projetada no chão, escala por
// profundidade e iluminação do cenário continuam valendo — nada disso
// toca nos pixels do sprite. Nenhum arquivo de sprite foi modificado.
const SPRITE_SHADING = 0;

// V22.4 — "HD-2D". Em vez de pintar um degrade por cima do sprite (o que
// o SPRITE_SHADING acima fazia e por isso ficou desligado), cada frame
// passa por sprite-forge.js: a silhueta vira um campo de altura, dele sai
// um normal map, e a luz da arena e aplicada por pixel — com rim light,
// oclusao de contato e contorno externo. O resultado tem volume de
// verdade em vez de um filtro por cima, e o pixel art continua nitido.
//
// Ponha em false para voltar ao desenho cru da spritesheet.
const SPRITE_3D = true;
// Inclinacao de billboard: atores longe do centro da tela pendem para
// dentro, como numa lente. Sutil de proposito.
const BILLBOARD_LEAN = 0.030;

const IDENTITY_MOTION = {
  offsetX:0, offsetY:0, scaleX:1, scaleY:1,
  rotation:0, flash:0, alpha:1, glow:0
};

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

const ARENA_THEMES = {
  earth: {
    skyTop:'#0b1a2e', skyBottom:'#2c4a5c', haze:'#7fa8b4',
    ridgeBack:'#16283a', ridgeFront:'#101d2b',
    ambient:'#9fc4ff', ambientAlpha:0.10,
    grade:'#0d1f33', gradeAlpha:0.20,
    key:'#ffe9c2', keyAlpha:0.13,
    fog:'#5f8ba0', silhouette:'ridges'
  },
  dirt: {
    skyTop:'#231423', skyBottom:'#8a4b2c', haze:'#e0a06a',
    ridgeBack:'#39202a', ridgeFront:'#22141c',
    ambient:'#ffbe86', ambientAlpha:0.12,
    grade:'#2a1410', gradeAlpha:0.20,
    key:'#ffd39a', keyAlpha:0.16,
    fog:'#b1794f', silhouette:'mesas'
  },
  stone: {
    skyTop:'#05080c', skyBottom:'#141d26', haze:'#3d5568',
    ridgeBack:'#0d141c', ridgeFront:'#070b10',
    ambient:'#7fb4ff', ambientAlpha:0.09,
    grade:'#060c14', gradeAlpha:0.30,
    key:'#bcd8ff', keyAlpha:0.10,
    fog:'#2b3d4e', silhouette:'cave'
  },
  snow: {
    skyTop:'#152a41', skyBottom:'#8fb6cd', haze:'#dcecf5',
    ridgeBack:'#31506b', ridgeFront:'#1e344a',
    ambient:'#cfe8ff', ambientAlpha:0.14,
    grade:'#12283c', gradeAlpha:0.16,
    key:'#ffffff', keyAlpha:0.14,
    fog:'#a9c9dc', silhouette:'peaks'
  }
};

function hashSeed(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let state = seed;
  return function random() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function alphaHex(value) {
  return Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, '0');
}

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));
  return canvas;
}

export class HuntArenaRenderer {
  constructor(canvas, {
    state,
    characters,
    zones,
    getEnemies,
    getEffects,
    getCorpses,
    onCorpseClick,
    getCombatStats,
    getRemotePlayers = () => [],
    onTargetUpdate
  }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.state = state;
    this.characters = characters;
    this.zones = zones;
    this.getEnemies = getEnemies;
    this.getEffects = getEffects;
    this.getCorpses = getCorpses;
    this.onCorpseClick = onCorpseClick;
    this.getCombatStats = getCombatStats;
    this.getRemotePlayers = getRemotePlayers;
    this.onTargetUpdate = onTargetUpdate;
    this.corpseHitboxes = [];
    this.corpseImages = new Map();
    this.clickHandler = event => this.handleClick(event);
    canvas.addEventListener('click', this.clickHandler);
    this.outfits = {};
    this.monsterOutfits = {};
    this.absoluteMonsterOutfits = {};
    this.effectAssets = new Map();
    this.missileAssets = new Map();
    this.images = sharedHuntImages;
    this.arenaTiles = new Map();

    // Baked scenery (backdrop + perspective ground + props + lighting). It
    // only changes when the canvas is resized or the zone changes, so the
    // per-frame cost of the whole environment is a single drawImage instead
    // of the ~500 tile draws the flat version issued every frame.
    this.ground = null;
    this.groundKey = '';
    this.groundPending = false;
    // Sprite frames shaded with the arena light, cached by frame + theme.
    this.shadedSprites = new Map();
    this.motes = [];
    this.lastTime = 0;

    // V22.4 — animacao procedural, aura de ki e cinematica de transformacao.
    this.motion = new MotionDirector();
    this.transformFx = new TransformationCinematic();
    this.seenEffects = new Set();
    this.deathPoofs = [];
    this.lastPlayerHp = null;
    this.auraColors = new Map();

    this.resizeHandler = () => this.fit();
    window.addEventListener('resize', this.resizeHandler);
    this.fit();
    this.loadAssets();
    this.frame = requestAnimationFrame(time => this.loop(time));
  }

  fit() {
    const rect = this.canvas.getBoundingClientRect();
    const density = Math.min(2, devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.floor(rect.width * density));
    this.canvas.height = Math.max(1, Math.floor(rect.height * density));
    this.ctx.setTransform(density, 0, 0, density, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
    this.w = Math.max(1, rect.width);
    this.h = Math.max(1, rect.height);
    this.density = density;
    this.layout();
    this.ground = null;
    this.groundKey = '';
    this.seedMotes();
  }

  // Vertical band the ground plane occupies. Everything above groundTop is
  // backdrop (sky / cave ceiling / mountains).
  layout() {
    this.cx = this.w / 2;
    this.groundTop = Math.min(this.h * 0.42, Math.max(72, this.h * 0.30));
    this.groundBottom = this.h - Math.min(64, this.h * 0.12);
    this.groundH = Math.max(40, this.groundBottom - this.groundTop);
    this.halfW = Math.max(40, (this.w - Math.min(70, this.w * 0.09)) / 2);
  }

  // Hyperbolic 1/z depth curve: 1 at the front edge, FAR_SCALE at the back.
  depthScale(t) {
    const clamped = Math.max(0, Math.min(1, t));
    return FAR_SCALE / (1 - clamped * (1 - FAR_SCALE));
  }

  screenPosition(x, y) {
    const t = Math.max(0, Math.min(1, Number(y || 0) / 100));
    const scale = this.depthScale(t);
    // Same curve drives the vertical placement, so a step of 10 arena units
    // near the horizon covers far fewer pixels than one at the player's feet.
    const rowRatio = (scale - FAR_SCALE) / (1 - FAR_SCALE);
    return {
      x: this.cx + ((Number(x || 0) - 50) / 50) * this.halfW * scale,
      y: this.groundTop + rowRatio * this.groundH,
      scale
    };
  }

  // Sprites shrink with depth, but only partially — full 1/z on a 64px
  // sprite makes back-row monsters unreadable.
  depthSpriteScale(y) {
    const t = Math.max(0, Math.min(1, Number(y || 0) / 100));
    const scale = this.depthScale(t);
    const normalized = scale * (2 / (1 + FAR_SCALE));
    return 1 + (normalized - 1) * ACTOR_DEPTH_MIX;
  }

  themeFor(zone) {
    return zone?.arenaTheme || (
      /snow|ice|freeza/i.test(`${zone?.name || ''} ${zone?.description || ''}`)
        ? 'snow'
        : /cave|cell|castle|temple/i.test(`${zone?.name || ''} ${zone?.description || ''}`)
          ? 'stone'
          : /bandit|desert|dino/i.test(`${zone?.name || ''} ${zone?.description || ''}`)
            ? 'dirt'
            : 'earth'
    );
  }

  async loadAssets() {
    try {
      const {outfits,monsters,absoluteMonsters,effectAssets,missileAssets}=await loadSharedHuntAssets();
      this.outfits = outfits;
      this.monsterOutfits = monsters;
      this.absoluteMonsterOutfits = absoluteMonsters;
      this.effectAssets = new Map(effectAssets.map(entry => [Number(entry.id), entry]));
      this.missileAssets = new Map(missileAssets.map(entry => [Number(entry.id), entry]));
      this.patchBlankMonsterOutfits(absoluteMonsters);
      for (const theme of ['earth','dirt','stone','snow']) {
        this.arenaTiles.set(theme,this.loadImage(`./assets/generated/arena-floors-v1229/${theme}.png`));
      }
    } catch (error) {
      console.error('Falha ao carregar outfits da Hunt:', error);
    }
  }

  // Some lookTypes in absolute-monster-manifest.json point at a fully
  // blank/transparent spritesheet (a failed extraction upstream, not a
  // loading bug — the file loads fine, it's just empty), so those
  // monsters render invisible in the arena even though their HP bar and
  // name tag show up fine. The exact same lookTypes have real, complete
  // art sitting in the exact-transformations asset pack instead — this
  // just points the manifest entry there. lookType 118 has no art in
  // either pack; it borrows 119's as the closest available stand-in
  // rather than staying invisible.
  patchBlankMonsterOutfits(absoluteMonsters) {
    const replacementSheet = lookType => ({
      src:`./assets/generated/exact-transformations/outfits/${lookType}.png`,
      frameHeight:64
    });
    const overrides = {
      14:replacementSheet(14), 15:replacementSheet(15),
      16:replacementSheet(16), 29:replacementSheet(29),
      30:replacementSheet(30), 41:replacementSheet(41),
      42:replacementSheet(42), 43:replacementSheet(43),
      78:replacementSheet(78), 79:replacementSheet(79),
      105:replacementSheet(105), 118:replacementSheet(119),
      119:replacementSheet(119), 604:replacementSheet(604),
      808:replacementSheet(808), 828:replacementSheet(828),
      829:replacementSheet(829)
    };
    for (const [lookType, patch] of Object.entries(overrides)) {
      const entry = absoluteMonsters[lookType];
      if (!entry) continue;
      entry.src = patch.src;
      entry.frameHeight = patch.frameHeight;
    }
  }

  loadImage(src) {
    if (!src || this.images.has(src)) return this.images.get(src);
    const image = new Image();
    image.decoding='async';
    image.src = src;
    this.images.set(src, image);
    return image;
  }

  assetCell(entry, elapsed, duration, trajectory = null) {
    if (!entry?.cells?.length) return null;

    const frames = Math.max(1, Number(entry.frames || 1));
    // OT/Tibia effects advance in short discrete phases. Using a fixed
    // source-like cadence prevents a 3-frame effect from being stretched
    // to the same duration as a 10-frame transformation aura.
    const frameDuration = 100;
    const frame = Math.min(
      frames - 1,
      Math.max(0, Math.floor(Number(elapsed || 0) / frameDuration))
    );

    if (trajectory && entry.patternX > 1 && entry.patternY > 1) {
      const dx = Number(trajectory.dx || 0);
      const dy = Number(trajectory.dy || 0);
      const patternX = dx > .12 ? 2 : dx < -.12 ? 0 : 1;
      const patternY = dy > .12 ? 2 : dy < -.12 ? 0 : 1;
      return entry.cells.find(cell =>
        Number(cell.patternX) === patternX &&
        Number(cell.patternY) === patternY &&
        Number(cell.frame || 0) === frame
      ) || entry.cells.find(cell =>
        Number(cell.patternX) === patternX &&
        Number(cell.patternY) === patternY
      ) || entry.cells[0];
    }

    return entry.cells.find(cell => Number(cell.frame || 0) === frame) ||
      entry.cells[Math.min(frame, entry.cells.length - 1)] ||
      entry.cells[0];
  }

  playerSpriteScale() {
    return Math.max(1.7, Math.min(2.5, this.h / 330));
  }

  // ---------------------------------------------------------------------
  // Lighting helpers
  // ---------------------------------------------------------------------

  // Bakes the arena key light onto one sprite frame: a warm top-left to cool
  // bottom-right gradient clipped to the sprite silhouette, plus a rim
  // highlight on the lit edge. Cached per (sheet, cell, theme, tint) because
  // walk animations only swap frames every ~150ms.
  shadedSprite(image, sx, sy, sw, sh, tintKey, tint) {
    // Com SPRITE_SHADING em 0 nem chega a criar buffer: o sprite vai para a
    // tela direto da spritesheet, sem nenhuma passada de cor por cima.
    if (SPRITE_SHADING <= 0) return null;

    const key = `${image.src}|${sx}|${sy}|${sw}|${sh}|${tintKey}`;
    const cached = this.shadedSprites.get(key);
    if (cached) return cached;

    const buffer = makeCanvas(sw, sh);
    const bctx = buffer.getContext('2d');
    bctx.imageSmoothingEnabled = false;
    bctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);

    bctx.globalCompositeOperation = 'source-atop';

    const shade = bctx.createLinearGradient(0, 0, sw * 0.85, sh);
    shade.addColorStop(0, `${tint.key}${alphaHex(0x4a * SPRITE_SHADING)}`);
    shade.addColorStop(0.45, '#00000000');
    shade.addColorStop(1, `${tint.shadow}${alphaHex(0x6b * SPRITE_SHADING)}`);
    bctx.fillStyle = shade;
    bctx.fillRect(0, 0, sw, sh);

    // Ambient bounce from the ground colour, only on the lower third.
    const bounce = bctx.createLinearGradient(0, sh * 0.62, 0, sh);
    bounce.addColorStop(0, '#00000000');
    bounce.addColorStop(1, `${tint.ambient}${alphaHex(0x2e * SPRITE_SHADING)}`);
    bctx.fillStyle = bounce;
    bctx.fillRect(0, sh * 0.6, sw, sh * 0.4);

    bctx.globalCompositeOperation = 'source-over';

    if (this.shadedSprites.size > 600) this.shadedSprites.clear();
    this.shadedSprites.set(key, buffer);
    return buffer;
  }

  spriteTint() {
    const theme = ARENA_THEMES[this.theme] || ARENA_THEMES.earth;
    return {
      key: theme.key,
      shadow: theme.grade,
      ambient: theme.ambient,
      tintKey: `${this.theme}|${SPRITE_SHADING}`
    };
  }

  // Soft cast shadow on the ground plane. Squashed and offset along the
  // light direction, scaled by depth so distant actors get smaller, fainter
  // shadows — the single strongest depth cue in the whole scene.
  drawGroundShadow(x, y, radius, depth, alpha = 0.5) {
    const ctx = this.ctx;
    const rx = Math.max(4, radius * depth);
    const ry = Math.max(2, rx * 0.34);
    const offsetX = -LIGHT_X * rx * 0.55;
    const offsetY = -LIGHT_Y * ry * 0.35;

    ctx.save();
    ctx.translate(x + offsetX, y + offsetY);
    ctx.scale(1, ry / rx);
    const gradient = ctx.createRadialGradient(0, 0, rx * 0.15, 0, 0, rx);
    gradient.addColorStop(0, `rgba(3,6,10,${alpha})`);
    gradient.addColorStop(0.55, `rgba(3,6,10,${alpha * 0.55})`);
    gradient.addColorStop(1, 'rgba(3,6,10,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Coloured contact ring used for "this is your target" / "this is you",
  // now drawn as a thin ellipse on the floor plane instead of a flat blob.
  drawGroundRing(x, y, radius, depth, color, pulse = 0) {
    const ctx = this.ctx;
    const rx = Math.max(5, radius * depth) * (1 + pulse * 0.08);
    const ry = rx * 0.34;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, ry / rx);
    ctx.lineWidth = Math.max(1.2, 1.8 * depth);
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // ---------------------------------------------------------------------
  // Baked scenery
  // ---------------------------------------------------------------------

  seedMotes() {
    const random = seededRandom(hashSeed(`motes${Math.round(this.w)}x${Math.round(this.h)}`));
    const count = Math.round(Math.max(18, Math.min(46, this.w / 26)));
    this.motes = Array.from({length:count}, () => ({
      x: random() * 100,
      y: random() * 100,
      size: 0.6 + random() * 1.6,
      drift: (random() - 0.5) * 2.4,
      rise: 1.6 + random() * 4.2,
      phase: random() * Math.PI * 2,
      alpha: 0.10 + random() * 0.24
    }));
  }

  ensureGround(zone) {
    const theme = this.themeFor(zone);
    const tile = this.arenaTiles.get(theme) || this.arenaTiles.get('earth');
    const tileReady = Boolean(tile?.complete && tile.naturalWidth);
    const key = `${zone?.id || 'default'}|${theme}|${Math.round(this.w)}x${Math.round(this.h)}|${tileReady ? 1 : 0}`;
    this.theme = theme;
    if (this.ground && this.groundKey === key) return;
    this.groundKey = key;
    this.ground = this.bakeGround(zone, theme, tileReady ? tile : null);
  }

  bakeGround(zone, theme, tile) {
    const palette = ARENA_THEMES[theme] || ARENA_THEMES.earth;
    const density = this.density || 1;
    const canvas = makeCanvas(this.w * density, this.h * density);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(density, 0, 0, density, 0, 0);
    ctx.imageSmoothingEnabled = false;

    this.paintBackdrop(ctx, palette, zone, theme);
    this.paintGroundPlane(ctx, palette, tile);
    this.paintSceneryProps(ctx, zone, theme);
    this.paintLighting(ctx, palette);

    return canvas;
  }

  // Sky / cave ceiling plus two parallax silhouette bands, all procedural so
  // no new art has to ship with the build.
  paintBackdrop(ctx, palette, zone, theme) {
    const horizon = this.groundTop;
    const sky = ctx.createLinearGradient(0, 0, 0, horizon + 12);
    sky.addColorStop(0, palette.skyTop);
    sky.addColorStop(1, palette.skyBottom);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, this.w, horizon + 12);

    const random = seededRandom(hashSeed(`sky${zone?.id || 'default'}`));

    if (theme === 'stone') {
      // Cave: stalactites hanging from the top instead of a skyline.
      ctx.fillStyle = palette.ridgeBack;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      for (let x = 0; x <= this.w; x += 26) {
        ctx.lineTo(x, 10 + random() * (horizon * 0.55));
        ctx.lineTo(x + 13, 4 + random() * 14);
      }
      ctx.lineTo(this.w, 0);
      ctx.closePath();
      ctx.fill();
    } else {
      const bands = [
        {color:palette.ridgeBack, base:horizon * 0.94, amp:horizon * 0.42, step:74},
        {color:palette.ridgeFront, base:horizon * 1.02, amp:horizon * 0.26, step:46}
      ];
      for (const band of bands) {
        ctx.fillStyle = band.color;
        ctx.beginPath();
        ctx.moveTo(-10, horizon + 14);
        let peak = band.base - random() * band.amp;
        ctx.lineTo(-10, peak);
        for (let x = 0; x <= this.w + band.step; x += band.step) {
          const next = band.base - random() * band.amp;
          if (theme === 'snow' || theme === 'earth') {
            ctx.lineTo(x + band.step * 0.5, Math.min(peak, next) - band.amp * 0.12);
          }
          ctx.lineTo(x + band.step, next);
          peak = next;
        }
        ctx.lineTo(this.w + 10, horizon + 14);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Horizon haze: makes the ground plane read as receding into distance
    // instead of stopping at a hard line.
    const fog = ctx.createLinearGradient(0, horizon - this.h * 0.16, 0, horizon + this.h * 0.10);
    fog.addColorStop(0, `${palette.fog}00`);
    fog.addColorStop(0.62, `${palette.fog}7a`);
    fog.addColorStop(1, `${palette.fog}00`);
    ctx.fillStyle = fog;
    ctx.fillRect(0, horizon - this.h * 0.18, this.w, this.h * 0.30);
  }

  // Mode-7 style scanline projection of the 32px floor tile. Each screen row
  // samples a different texture row (1/z) and is stretched to the projected
  // width of the arena at that depth, which is what turns a flat tiled floor
  // into a receding plane.
  paintGroundPlane(ctx, palette, tile) {
    const top = this.groundTop;
    const height = this.groundH;

    if (!tile) {
      const flat = ctx.createLinearGradient(0, top, 0, this.groundBottom);
      flat.addColorStop(0, '#2f3d2c');
      flat.addColorStop(1, '#586f47');
      ctx.fillStyle = flat;
      ctx.fillRect(0, top, this.w, height);
      return;
    }

    const tileSize = 32;
    const columns = 26;
    const strip = makeCanvas(tileSize * columns, tileSize);
    const sctx = strip.getContext('2d');
    sctx.imageSmoothingEnabled = false;
    for (let i = 0; i < columns; i += 1) {
      sctx.drawImage(tile, i * tileSize, 0, tileSize, tileSize);
    }

    // Constant chosen so the visible depth covers roughly 18 tile rows.
    const depthConstant = 940;
    const sourceWidth = tileSize * (columns - 2);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, this.w, height);
    ctx.clip();

    for (let row = 0; row <= height; row += 1) {
      const ratio = row / height;
      const scale = FAR_SCALE + ratio * (1 - FAR_SCALE);
      const rowWidth = this.halfW * 2 * scale;
      let sourceY = (depthConstant / scale) % tileSize;
      if (sourceY < 0) sourceY += tileSize;
      ctx.drawImage(
        strip,
        0, sourceY, sourceWidth, 1,
        this.cx - rowWidth / 2, top + row, rowWidth, 1.6
      );
    }
    ctx.restore();

    // Depth shading on the plane: darker and hazier towards the horizon.
    const depthShade = ctx.createLinearGradient(0, top - 6, 0, this.groundBottom);
    depthShade.addColorStop(0, `${palette.fog}c4`);
    depthShade.addColorStop(0.10, `${palette.fog}72`);
    depthShade.addColorStop(0.26, '#0000004d');
    depthShade.addColorStop(0.75, '#00000012');
    depthShade.addColorStop(1, '#0000002e');
    ctx.fillStyle = depthShade;
    ctx.fillRect(0, top - 6, this.w, height + 6);

    // Ground outside the playable trapezoid falls off into darkness, which
    // is what gives the plane a readable edge.
    // Everything outside the playable trapezoid is empty canvas, so it gets
    // filled with a vertical fade that starts at the horizon colour and sinks
    // into darkness. Blending it into the backdrop this way keeps the ground
    // plane from ending on a visible horizontal seam.
    const wedge = (points) => {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i][0], points[i][1]);
      ctx.closePath();
      ctx.clip();
      const fade = ctx.createLinearGradient(0, top - 8, 0, this.groundBottom);
      fade.addColorStop(0, palette.fog);
      fade.addColorStop(0.18, palette.ridgeFront);
      fade.addColorStop(1, '#04070b');
      ctx.fillStyle = fade;
      ctx.fillRect(0, top - 10, this.w, height + 12);
      ctx.restore();
    };
    wedge([
      [0, top - 10],
      [this.cx - this.halfW * FAR_SCALE, top - 10],
      [this.cx - this.halfW, this.groundBottom],
      [0, this.groundBottom]
    ]);
    wedge([
      [this.w, top - 10],
      [this.cx + this.halfW * FAR_SCALE, top - 10],
      [this.cx + this.halfW, this.groundBottom],
      [this.w, this.groundBottom]
    ]);

    ctx.restore();

    // Floor below the front edge of the arena.
    if (this.groundBottom < this.h) {
      const skirt = ctx.createLinearGradient(0, this.groundBottom, 0, this.h);
      skirt.addColorStop(0, '#00000066');
      skirt.addColorStop(1, '#02040799');
      ctx.fillStyle = skirt;
      ctx.fillRect(0, this.groundBottom, this.w, this.h - this.groundBottom);
    }
  }

  // Themed props tiled along the back and the two side edges of the ground
  // plane, projected with the same perspective so the arena reads as a room
  // the fight happens inside of.
  paintSceneryProps(ctx, zone, theme) {
    const sprites = ARENA_DECORATION_SPRITES[theme] || ARENA_DECORATION_SPRITES.earth;
    const random = seededRandom(hashSeed(zone?.id || 'default'));
    const props = [];

    const push = (arenaX, arenaY, jitter = 0) => {
      const src = sprites[Math.floor(random() * sprites.length)];
      props.push({
        src,
        x: arenaX + (random() - 0.5) * jitter,
        y: arenaY + (random() - 0.5) * jitter * 0.4,
        variance: 0.82 + random() * 0.4
      });
    };

    // Back wall.
    for (let x = -16; x <= 116; x += 4.2) push(x, -5.5 - random() * 3, 2.4);
    // Side walls.
    for (let y = -4; y <= 104; y += 4.6) {
      push(-8 - random() * 5, y, 2);
      push(108 + random() * 5, y, 2);
    }
    // A few props scattered just past the front corners for framing.
    for (let i = 0; i < 6; i += 1) {
      push(-12 - random() * 8, 92 + random() * 14, 3);
      push(112 + random() * 8, 92 + random() * 14, 3);
    }

    props.sort((a, b) => a.y - b.y);

    for (const prop of props) {
      const image = this.loadImage(prop.src);
      if (!image?.complete || !image.naturalWidth) continue;
      const pos = this.screenPosition(prop.x, prop.y);
      const depth = this.depthSpriteScale(prop.y);
      const scale = prop.variance * depth * 1.05;
      const width = image.naturalWidth * scale;
      const height = image.naturalHeight * scale;

      // Contact shadow so the props sit on the plane instead of floating.
      ctx.save();
      ctx.globalAlpha = 0.34;
      ctx.fillStyle = '#03060a';
      ctx.beginPath();
      ctx.ellipse(pos.x, pos.y, width * 0.36, width * 0.13, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Distance haze is applied inside a per-prop buffer: compositing it
      // straight onto the scene with source-atop would tint everything
      // already painted inside the prop's bounding box, not just the prop.
      const haze = Math.max(0, Math.min(0.34, Math.pow(1 - prop.y / 100, 1.6) * 0.34));
      const source = haze > 0.02
        ? this.hazedProp(image, haze, (ARENA_THEMES[theme] || ARENA_THEMES.earth).fog)
        : image;

      ctx.save();
      ctx.globalAlpha = 0.95;
      ctx.drawImage(source, pos.x - width / 2, pos.y - height, width, height);
      ctx.restore();
    }
  }

  hazedProp(image, amount, color) {
    const key = `${image.src}|${amount.toFixed(2)}|${color}`;
    const cached = this.shadedSprites.get(key);
    if (cached) return cached;
    const buffer = makeCanvas(image.naturalWidth, image.naturalHeight);
    const bctx = buffer.getContext('2d');
    bctx.imageSmoothingEnabled = false;
    bctx.drawImage(image, 0, 0);
    bctx.globalCompositeOperation = 'source-atop';
    bctx.globalAlpha = amount;
    bctx.fillStyle = color;
    bctx.fillRect(0, 0, buffer.width, buffer.height);
    bctx.globalCompositeOperation = 'source-over';
    this.shadedSprites.set(key, buffer);
    return buffer;
  }

  // Key light pool, ambient wash and vignette, baked once with the scenery.
  paintLighting(ctx, palette) {
    const pool = ctx.createRadialGradient(
      this.cx + this.w * LIGHT_X * 0.22,
      this.groundTop + this.groundH * 0.34,
      this.w * 0.04,
      this.cx,
      this.groundTop + this.groundH * 0.5,
      Math.max(this.w, this.h) * 0.62
    );
    pool.addColorStop(0, `${palette.key}${Math.round(palette.keyAlpha * 255).toString(16).padStart(2,'0')}`);
    pool.addColorStop(1, '#00000000');
    ctx.fillStyle = pool;
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.save();
    ctx.globalAlpha = palette.ambientAlpha;
    ctx.fillStyle = palette.ambient;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = palette.gradeAlpha;
    ctx.fillStyle = palette.grade;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.restore();

    const vignette = ctx.createRadialGradient(
      this.w / 2, this.h * 0.52, Math.min(this.w, this.h) * 0.18,
      this.w / 2, this.h * 0.52, Math.max(this.w, this.h) * 0.78
    );
    vignette.addColorStop(0, '#00000000');
    vignette.addColorStop(0.62, '#0000003d');
    vignette.addColorStop(1, '#000000a6');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, this.w, this.h);
  }

  drawRegistryAsset({
    category,
    id,
    x,
    y,
    elapsed,
    duration,
    alpha = 1,
    trajectory = null,
    scale = 1,
    actorAttached = false,
    depth = 1,
    glow = false,
    anchor = category === 'missile' ? 'center' : 'tile'
  }) {
    const registry = category === 'missile'
      ? this.missileAssets
      : this.effectAssets;
    // Lua/TFS magic-effect and distance-shoot enums are zero-based, while
    // DAT object definitions (and therefore our extracted registry) are
    // one-based. Keeping source IDs raw in game data and translating only
    // here prevents every spell from being shifted to the previous sprite.
    const sourceId = Number(id);
    const entry = Number.isFinite(sourceId)
      ? registry.get(sourceId + 1)
      : null;
    if (!entry?.sheet) return false;

    const image = this.loadImage(entry.sheet);
    if (!image?.complete || !image.naturalWidth) return false;

    // Source magic effects are phase animations, not arbitrary fades. Stop
    // drawing once the DAT frame sequence is complete; the hunt runtime keeps
    // the effect object alive long enough for even 50-frame transformations.
    if (
      category === 'effect' &&
      Number(elapsed || 0) >= Math.max(1, Number(entry.frames || 1)) * 100
    ) {
      return true;
    }

    const cell = this.assetCell(entry, elapsed, duration, trajectory);
    if (!cell) return false;

    const pixelWidth = Math.max(1, Number(entry.pixelWidth || 32));
    const pixelHeight = Math.max(1, Number(entry.pixelHeight || 32));
    const arenaScale = Math.max(.65, Math.min(1.05, this.h / 500));
    // Effects attached directly to the caster (buff auras, self-cast speed
    // effects, etc.) must use the same scale as the enlarged hunt outfit.
    const compactActorEffect = pixelWidth <= 64 && pixelHeight <= 64;
    const drawScale = (actorAttached && compactActorEffect
      ? this.playerSpriteScale() * Math.max(.5, Number(scale || 1))
      : arenaScale * Math.max(.5, Number(scale || 1))) * Math.max(.35, Number(depth || 1));
    const drawWidth = pixelWidth * drawScale;
    const drawHeight = pixelHeight * drawScale;

    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    const drawX = anchor === 'tile'
      ? x + 16 * drawScale - drawWidth
      : x - drawWidth / 2;
    const drawY = anchor === 'tile'
      ? y - drawHeight
      : y - drawHeight / 2;
    // Energy attacks read as light sources rather than stickers: an additive
    // bloom pass under the sprite, then the sprite itself on top.
    if (glow) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha)) * 0.42;
      ctx.drawImage(
        image,
        Number(cell.x || 0), Number(cell.y || 0), pixelWidth, pixelHeight,
        drawX - drawWidth * 0.06, drawY - drawHeight * 0.06,
        drawWidth * 1.12, drawHeight * 1.12
      );
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    }
    ctx.drawImage(
      image,
      Number(cell.x || 0),
      Number(cell.y || 0),
      pixelWidth,
      pixelHeight,
      drawX,
      drawY,
      drawWidth,
      drawHeight
    );
    ctx.restore();
    return true;
  }

  loop(time) {
    this.draw(time);
    this.frame = requestAnimationFrame(next => this.loop(next));
  }

  draw(time) {
    const zone = this.zones.find(
      entry => entry.id === this.state.hunt.zoneId
    ) || this.zones[0];
    const arena = this.state.hunt.arena;
    const enemies = this.getEnemies();
    const effects = this.getEffects();
    const corpses = this.getCorpses();
    const target = arena
      ? enemies.find(enemy => enemy.uid === arena.targetId && enemy.alive && enemy.hp > 0) || null
      : null;
    this.onTargetUpdate?.(target, zone);

    const delta = Math.max(0, Math.min(64, time - (this.lastTime || time)));
    this.lastTime = time;

    const now = Date.now();
    const shake = this.transformFx.shake(now);

    this.ctx.clearRect(0, 0, this.w, this.h);
    this.ensureGround(zone);
    this.ctx.save();
    if (shake > 0.05) {
      // Tremor de camera da transformacao. O cenario e desenhado com uma
      // folga do mesmo tamanho para nao abrir borda preta na tela.
      this.ctx.translate(
        (Math.random() - 0.5) * shake,
        (Math.random() - 0.5) * shake * 0.7
      );
    }
    if (this.ground) {
      this.ctx.drawImage(
        this.ground,
        -shake, -shake,
        this.w + shake * 2, this.h + shake * 2
      );
    }
    // A luz de ambiente é aplicada AQUI, sobre o cenário e antes dos atores.
    // Se ela viesse no fim, clarearia também os sprites do player e dos
    // monstros — e a regra do projeto é que a arte original chegue à tela
    // sem nenhuma camada de cor por cima.
    this.drawAtmosphere();
    if (!arena) { this.ctx.restore(); return; }

    // V22.4 — le o estado do combate e dispara as animacoes. Nao altera
    // nada do jogo: so observa HP, posicao e efeitos ja existentes.
    this.scanCombat(effects, enemies, arena, now);
    this.motion.prune(now);

    this.drawRespawnMarkers(enemies);
    this.drawCorpses(corpses);

    const remotePlayers = Array.isArray(this.getRemotePlayers?.())
      ? this.getRemotePlayers().slice(0,12)
      : [];
    const remoteActors=remotePlayers.map((player,index)=>{
      const pos=this.remotePlayerPosition(index,remotePlayers.length,arena);
      return {kind:'remote-player',y:pos.y,player:{...player,...pos}};
    });
    const actors = [
      ...enemies
        .filter(enemy => enemy.alive && enemy.hp > 0)
        .map(enemy => ({ kind: 'enemy', y: enemy.y, enemy })),
      ...remoteActors,
      { kind: 'player', y: arena.playerY, player: arena }
    ].sort((a, b) => a.y - b.y);

    // Shadows for every actor go down first so a nearer actor's sprite can
    // overlap a further actor's shadow, which is what sells the depth order.
    for (const actor of actors) {
      if (actor.kind === 'enemy') {
        const pos = this.screenPosition(actor.enemy.x, actor.enemy.y);
        this.drawGroundShadow(pos.x, pos.y, 21, this.depthSpriteScale(actor.enemy.y), 0.48);
      } else if (actor.kind === 'remote-player') {
        const pos = this.screenPosition(actor.player.x, actor.player.y);
        this.drawGroundShadow(pos.x, pos.y, 17, this.depthSpriteScale(actor.player.y), 0.38);
      } else {
        const pos = this.screenPosition(arena.playerX, arena.playerY);
        this.drawGroundShadow(pos.x, pos.y, 19, this.depthSpriteScale(arena.playerY), 0.52);
      }
    }

    for (const actor of actors) {
      if (actor.kind === 'enemy') {
        this.drawMonster(actor.enemy, time);
      } else if(actor.kind==='remote-player'){
        this.drawRemotePlayer(actor.player,time);
      } else {
        this.drawPlayer(
          arena.playerX,
          arena.playerY,
          arena.direction,
          false,
          time
        );
      }
    }

    this.drawEffects(effects, time);
    this.drawDeathPoofs(now);
    this.drawMotes(delta, time);
    this.ctx.restore();

    // Clarao e vinheta da transformacao vao por ultimo, em coordenadas de
    // tela, para nao serem afetados pelo tremor.
    this.transformFx.drawScreen(this.ctx, this.w, this.h, now);
    this.drawHud(zone, enemies);
  }

  // -------------------------------------------------------------------
  // V22.4 — ponte entre o estado do combate e a animacao
  // -------------------------------------------------------------------

  /**
   * Deriva os eventos de animacao do que ja existe no estado:
   *   - efeito novo saindo da posicao do player  -> investida do player
   *   - HP do player caiu                        -> recuo do player +
   *                                                 golpe do inimigo mais proximo
   *   - inimigo sumiu da lista                   -> baforada de morte
   * (o recuo dos inimigos sai sozinho do HP, dentro de ActorMotion.)
   */
  scanCombat(effects, enemies, arena, now) {
    for (const effect of effects || []) {
      if (!effect?.id || this.seenEffects.has(effect.id)) continue;
      this.seenEffects.add(effect.id);
      const kind = String(effect.kind || '');
      if (kind === 'damage-number' || kind === 'spell-impact') continue;
      const fromPlayer = Math.hypot(
        Number(effect.fromX ?? 0) - arena.playerX,
        Number(effect.fromY ?? 0) - arena.playerY
      ) < 4;
      if (!fromPlayer) continue;
      this.motion.get('player', now).strike(
        now,
        Number(effect.toX ?? arena.playerX) - arena.playerX,
        Number(effect.toY ?? arena.playerY) - arena.playerY,
        kind.startsWith('spell')
      );
    }
    if (this.seenEffects.size > 500) this.seenEffects = new Set();

    const hp = Number(this.state.hunt?.playerHp ?? NaN);
    if (Number.isFinite(hp)) {
      if (this.lastPlayerHp != null && hp < this.lastPlayerHp - 0.001) {
        const maxHp = Number(
          this.state.hunt?.playerMaxHp ||
          this.state.profile?.maxHp ||
          this.getCombatStats?.()?.maxHp ||
          0
        );
        const lost = this.lastPlayerHp - hp;
        const power = maxHp > 0
          ? Math.min(1.3, 0.42 + (lost / maxHp) * 5.5)
          : 0.6;

        let closest = null;
        let best = Infinity;
        for (const enemy of enemies || []) {
          if (!enemy.alive || enemy.hp <= 0) continue;
          const distance = Math.hypot(enemy.x - arena.playerX, enemy.y - arena.playerY);
          if (distance < best) { best = distance; closest = enemy; }
        }
        this.motion.get('player', now).hurt(
          now,
          power,
          closest ? arena.playerX - closest.x : 0,
          closest ? arena.playerY - closest.y : -0.3
        );
        if (closest) {
          this.motion.get(closest.uid, now).strike(
            now,
            arena.playerX - closest.x,
            arena.playerY - closest.y,
            false
          );
        }
      }
      this.lastPlayerHp = hp;
    }

    // Inimigos que sairam da lista viram uma baforada no lugar onde estavam.
    const live = new Set((enemies || []).map(enemy => enemy.uid));
    if (this.previousEnemies) {
      for (const [uid, spot] of this.previousEnemies) {
        if (live.has(uid)) continue;
        this.deathPoofs.push({ x:spot.x, y:spot.y, born:now });
      }
    }
    this.previousEnemies = new Map(
      (enemies || []).map(enemy => [enemy.uid, {x:enemy.x, y:enemy.y}])
    );
    if (this.deathPoofs.length > 12) {
      this.deathPoofs.splice(0, this.deathPoofs.length - 12);
    }
  }

  drawDeathPoofs(now) {
    if (!this.deathPoofs.length) return;
    const ctx = this.ctx;
    const palette = ARENA_THEMES[this.theme] || ARENA_THEMES.earth;
    const alive = [];
    for (const poof of this.deathPoofs) {
      const t = (now - poof.born) / 520;
      if (t >= 1) continue;
      alive.push(poof);
      const pos = this.screenPosition(poof.x, poof.y);
      const depth = this.depthSpriteScale(poof.y);
      ctx.save();
      ctx.translate(pos.x, pos.y);
      ctx.globalAlpha = (1 - t) * 0.5;
      ctx.fillStyle = palette.haze;
      for (let i = 0; i < 7; i += 1) {
        const angle = (i / 7) * Math.PI * 2;
        const spread = t * 22 * depth;
        ctx.beginPath();
        ctx.ellipse(
          Math.cos(angle) * spread,
          -6 * depth - Math.sin(angle) * spread * 0.4 - t * 16 * depth,
          (3.4 + t * 6) * depth,
          (2.4 + t * 4) * depth,
          0, 0, Math.PI * 2
        );
        ctx.fill();
      }
      ctx.restore();
    }
    this.deathPoofs = alive;
  }

  /**
   * Dispara a cinematica de transformacao. Chamado pelo app quando a
   * transformacao e aceita. previousOutfitId e o outfit da forma ANTIGA,
   * capturado antes da troca de estado.
   */
  playTransformation(options = {}) {
    const now = Date.now();
    const previousOutfitId = options.previousOutfitId || null;
    const nextOutfitId = options.outfitId || null;

    const colorFor = outfitId => {
      if (!outfitId) return null;
      const outfit = this.outfits?.[outfitId];
      const image = outfit?.src ? this.loadImage(outfit.src) : null;
      if (!image?.complete || !image.naturalWidth) return null;
      return this.auraColorForOutfit(outfitId, image, outfit);
    };

    this.transformFx.start(now, {
      previousOutfitId,
      fromColor: colorFor(previousOutfitId) || '#9fd0ff',
      color: colorFor(nextOutfitId) || '#ffd05a',
      label: options.label || ''
    });
    this.motion.get('player', now).puff(now, 1.2);
  }

  // Slow drifting dust / ki embers. Parallax comes for free because their
  // arena Y is fed through the same perspective projection as the actors.
  drawMotes(delta, time) {
    if (!this.motes.length) return;
    const ctx = this.ctx;
    const palette = ARENA_THEMES[this.theme] || ARENA_THEMES.earth;
    const step = delta / 1000;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const mote of this.motes) {
      mote.y -= mote.rise * step;
      if (mote.y < -6) {
        mote.y = 104;
        mote.x = Math.random() * 100;
      }
      const sway = Math.sin(time / 1400 + mote.phase) * mote.drift;
      const pos = this.screenPosition(mote.x + sway, mote.y);
      const depth = this.depthSpriteScale(mote.y);
      ctx.globalAlpha = mote.alpha * (0.45 + depth * 0.55);
      ctx.fillStyle = palette.haze;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y - 26 * depth, mote.size * depth, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Banho de luz-chave sobre o cenário. Roda antes dos atores de propósito
  // (ver draw()), para não alterar a cor dos sprites.
  drawAtmosphere() {
    const ctx = this.ctx;
    const palette = ARENA_THEMES[this.theme] || ARENA_THEMES.earth;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const wash = ctx.createRadialGradient(
      this.cx + this.w * LIGHT_X * 0.18, this.groundTop - this.h * 0.05,
      Math.min(this.w, this.h) * 0.05,
      this.cx, this.groundTop + this.groundH * 0.45,
      Math.max(this.w, this.h) * 0.55
    );
    wash.addColorStop(0, `${palette.key}14`);
    wash.addColorStop(0.5, `${palette.key}07`);
    wash.addColorStop(1, '#00000000');
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.restore();
  }

  drawRespawnMarkers(enemies) {
    const now = Date.now();
    const ctx = this.ctx;

    for (const enemy of enemies) {
      if (enemy.alive || !enemy.respawnAt) continue;
      const pos = this.screenPosition(enemy.spawnX, enemy.spawnY);
      const depth = this.depthSpriteScale(enemy.spawnY);
      const remaining = Math.max(0, enemy.respawnAt - now);
      const seconds = Math.ceil(remaining / 1000);
      const pulse = (Math.sin(now / 260) + 1) / 2;

      ctx.save();
      ctx.translate(pos.x, pos.y);
      ctx.scale(1, 0.34);
      ctx.strokeStyle = `rgba(228,169,71,${0.35 + pulse * 0.4})`;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.arc(0, 0, 14 * depth, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.translate(pos.x, pos.y);
      this.drawGlassLabel(`${seconds}s`, 0, -18 * depth, '#f4cd78');
      ctx.restore();
    }
  }

  drawCorpses(corpses) {
    this.corpseHitboxes = [];
    const ctx = this.ctx;
    for (const corpse of corpses || []) {
      const pos = this.screenPosition(corpse.x, corpse.y);
      const depth = this.depthSpriteScale(corpse.y);
      const serverId = corpse.corpseServerId;
      let image = null;
      if (serverId) {
        const src = `./generated/web/corpses/${serverId}.webp`;
        if (!this.corpseImages.has(src)) {
          const loaded = new Image();
          loaded.src = src;
          this.corpseImages.set(src, loaded);
        }
        image = this.corpseImages.get(src);
      }

      this.drawGroundShadow(pos.x, pos.y, 15, depth, 0.42);

      ctx.save();
      ctx.translate(pos.x, pos.y);
      if (image?.complete && image.naturalWidth) {
        const size = 42 * depth;
        ctx.drawImage(image, -size / 2, -size + 8 * depth, size, size);
      } else {
        ctx.fillStyle = '#4b2b1ddd';
        ctx.beginPath();
        ctx.ellipse(0, 0, 19 * depth, 8 * depth, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      if (corpse.loot?.length) {
        const bob = Math.sin(Date.now() / 420 + pos.x) * 2;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = '#f0cb7733';
        ctx.beginPath();
        ctx.arc(0, -26 * depth + bob, 15 * depth, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        this.drawGlassLabel(`Loot ${corpse.loot.length}`, 0, -30 * depth + bob, '#f6d68b');
      }
      ctx.restore();
      this.corpseHitboxes.push({
        id:corpse.id,
        x:pos.x - 26 * depth,
        y:pos.y - 40 * depth,
        width:52 * depth,
        height:48 * depth
      });
    }
  }

  handleClick(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const corpse = this.corpseHitboxes.find(hit =>
      x >= hit.x && x <= hit.x + hit.width &&
      y >= hit.y && y <= hit.y + hit.height
    );
    if (corpse) this.onCorpseClick?.(corpse.id);
  }

  remotePlayerPosition(index,count,arena){
    const slots=[
      [-11,8],[11,8],[-16,-2],[16,-2],[-9,-10],[9,-10],[-21,8],[21,8],[-20,-11],[20,-11],[-3,13],[3,-14]
    ];
    const offset=slots[index%slots.length]||[0,10];
    return {x:Math.max(8,Math.min(92,Number(arena?.playerX||50)+offset[0])),y:Math.max(10,Math.min(86,Number(arena?.playerY||52)+offset[1])),direction:2};
  }

  // Shared sprite blit for every actor: pulls the shaded frame out of the
  // cache and draws it depth-scaled, bottom-anchored on the ground plane.
  // V22.4 — desenha um frame ja "forjado" (com volume) e aplica a
  // transformacao procedural do ator (respiracao, investida, recuo...).
  blitActorSprite(image, outfit, frame, direction, depth, baseScale, alpha = 1, motion = null) {
    if (!image?.complete || !image.naturalWidth || !outfit) return null;
    const frameWidth = Math.max(1, Number(outfit.frameWidth || 32));
    const frameHeight = Math.max(1, Number(outfit.frameHeight || 64));
    const sx = frame * frameWidth;
    const sy = direction * frameHeight;

    // Alguns manifests descrevem uma grade maior do que a folha que
    // realmente veio. O canvas trata o excedente como transparente, entao
    // o desenho cru continua funcionando — mas processar esse frame
    // devolveria um quadro vazio, por isso ele pula a forja.
    const inBounds =
      sx + frameWidth <= image.naturalWidth &&
      sy + frameHeight <= image.naturalHeight;

    const ctx = this.ctx;
    const scale = baseScale * depth;
    const width = frameWidth * scale;
    const height = frameHeight * scale;
    const m = motion || IDENTITY_MOTION;

    ctx.save();
    ctx.globalAlpha = alpha * clamp01(m.alpha ?? 1);
    ctx.translate((m.offsetX || 0) * scale, (m.offsetY || 0) * scale);
    if (m.rotation) ctx.rotate(m.rotation);
    if ((m.scaleX ?? 1) !== 1 || (m.scaleY ?? 1) !== 1) {
      ctx.scale(m.scaleX ?? 1, m.scaleY ?? 1);
    }

    const forged = SPRITE_3D && inBounds
      ? forgeFrame(image, sx, sy, frameWidth, frameHeight, this.theme || 'earth')
      : null;

    if (forged) {
      const pad = forged.pad;
      const dw = (frameWidth + pad * 2) * scale;
      const dh = (frameHeight + pad * 2) * scale;
      ctx.drawImage(forged.canvas, -dw / 2, -dh + pad * scale, dw, dh);
    } else {
      ctx.drawImage(image, sx, sy, frameWidth, frameHeight, -width / 2, -height, width, height);
    }

    // Halo de ki colado na silhueta: a silhueta e carimbada em volta do
    // corpo, oito vezes, com alpha baixo. E o brilho que faz a forma
    // transformada "vazar" luz pelas bordas.
    const halo = Number(m.haloAmount || 0);
    if (halo > 0.01 && inBounds) {
      const shape = forgeSilhouette(image, sx, sy, frameWidth, frameHeight, m.tintColor || '#ffd05a');
      if (shape) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = clamp01(halo * 0.085);
        const spread = (1.6 + halo * 3.2) * scale * (0.85 + 0.15 * Math.sin((m.haloPulse || 0)));
        for (let i = 0; i < 8; i += 1) {
          const angle = (i / 8) * Math.PI * 2;
          ctx.drawImage(
            shape,
            -width / 2 + Math.cos(angle) * spread,
            -height + Math.sin(angle) * spread,
            width, height
          );
        }
        ctx.restore();
      }
    }

    // Brilho de aura por cima do corpo (a forma "acende").
    const tintAmount = Number(m.tintAmount || 0);
    if (tintAmount > 0.01 && inBounds) {
      const tint = forgeSilhouette(image, sx, sy, frameWidth, frameHeight, m.tintColor || '#ffffff');
      if (tint) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = clamp01(tintAmount);
        ctx.drawImage(tint, -width / 2, -height, width, height);
        ctx.restore();
      }
    }

    // Flash branco ao levar dano / clarao do golpe.
    const flash = Math.max(Number(m.flash || 0), Number(m.glow || 0) * 0.55);
    if (flash > 0.01 && inBounds) {
      const white = forgeSilhouette(image, sx, sy, frameWidth, frameHeight, '#ffffff');
      if (white) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = clamp01(flash) * 0.9;
        ctx.drawImage(white, -width / 2, -height, width, height);
        ctx.restore();
      }
    }

    ctx.restore();
    return {width, height, scale};
  }

  // Poeira levantada por passos, pisadas e impactos.
  drawActorDust(motion, now, depth) {
    const dust = motion?.sampleDust?.(now);
    if (!dust?.length) return;
    const palette = ARENA_THEMES[this.theme] || ARENA_THEMES.earth;
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = palette.haze;
    for (const particle of dust) {
      ctx.globalAlpha = particle.alpha;
      ctx.beginPath();
      ctx.ellipse(
        particle.x * depth,
        particle.y * depth * 0.55,
        particle.size * depth,
        particle.size * depth * 0.6,
        0, 0, Math.PI * 2
      );
      ctx.fill();
    }
    ctx.restore();
  }

  // Quanto de aura uma forma tem: a base nao brilha, a ultima forma da
  // cadeia brilha no maximo. Vale para as 812 transformacoes sem cadastro.
  formAuraIntensity(character, form) {
    const forms = character?.forms || [];
    if (forms.length < 2 || !form) return 0;
    const index = forms.findIndex(entry => entry.id === form.id);
    if (index <= 0) return 0;
    return Math.min(1.15, 0.30 + (index / Math.max(1, forms.length - 1)) * 0.90);
  }

  // Cor da aura tirada da paleta do proprio sprite, com cache por outfit.
  auraColorForOutfit(outfitId, image, outfit) {
    if (this.auraColors.has(outfitId)) return this.auraColors.get(outfitId);
    const frameWidth = Math.max(1, Number(outfit?.frameWidth || 32));
    const frameHeight = Math.max(1, Number(outfit?.frameHeight || 64));
    const row = Math.min(2, Math.max(0, Number(outfit?.directionRows?.[2] ?? 2)));
    const color = auraColorFor(image, 0, row * frameHeight, frameWidth, frameHeight);
    this.auraColors.set(outfitId, color);
    return color;
  }

  // Inclinacao de camera: quem esta na borda da tela pende para o centro.
  billboardLean(screenX) {
    if (!this.halfW) return 0;
    return -((screenX - this.cx) / this.halfW) * BILLBOARD_LEAN;
  }

  drawPlayer(x, y, direction, moving, time) {
    const now = Date.now();
    const character =
      this.characters[this.state.profile.characterId] ||
      this.characters.goku;
    const currentForm =
      currentTransformationForm(this.state,character) ||
      character;

    // Durante a fase de carga da transformacao o corpo ainda e o da forma
    // anterior — a troca acontece no estouro, nao no clique do botao.
    const cinematic = this.transformFx;
    const cinematicOn = cinematic.active(now);
    const outfitId =
      (cinematicOn && cinematic.showsPreviousForm(now) && cinematic.previousOutfitId)
        ? cinematic.previousOutfitId
        : (currentForm.outfitId || character.outfitId || 'goku');

    // V22.4.4 — se a spritesheet da forma vier vazia (acontece em alguns
    // lookTypes do pacote de arte), cai para a forma anterior da cadeia em
    // vez de deixar o personagem invisível na arena.
    const resolved =
      resolveOutfit(outfitId, this.outfits, src => this.loadImage(src)) ||
      resolveOutfit(currentForm.outfitId || character.outfitId || 'goku',
        this.outfits, src => this.loadImage(src));
    const outfit = resolved?.outfit || null;
    const image = resolved?.image || null;
    const pos = this.screenPosition(x, y);
    const depth = this.depthSpriteScale(y);
    const scale = this.playerSpriteScale();
    const ctx = this.ctx;

    const motion = this.motion.get('player', now);
    motion.observe(now, x, y, NaN, 0);
    const sample = motion.sample(now);
    sample.rotation += this.billboardLean(pos.x);

    if (cinematicOn) {
      const tremor = cinematic.tremor(now);
      sample.offsetX += tremor.x;
      sample.offsetY += tremor.y;
    }

    const auraColor = (image?.complete && image.naturalWidth && outfit)
      ? this.auraColorForOutfit(resolved.outfitId, image, outfit)
      : '#ffd05a';
    const auraIntensity = Math.min(
      1.6,
      this.formAuraIntensity(character, currentForm) + cinematic.auraBoost(now)
    );

    ctx.save();
    ctx.translate(pos.x, pos.y);
    this.drawGroundRing(0, 0, 17, depth, 'rgba(96,190,255,.55)', (Math.sin(time / 520) + 1) / 2);
    this.drawActorDust(motion, now, depth);

    // A aura acompanha a altura do corpo desenhado, não a da moldura de
    // 64 px — do contrário as chamas sobem bem acima da cabeça.
    const frameH = Number(outfit?.frameHeight || 64);
    const bodyRows = (image?.complete && image.naturalWidth && outfit)
      ? frameArtHeight(image, 0, (outfit.directionRows?.[2] ?? 2) * frameH,
          Number(outfit.frameWidth || 32), frameH)
      : frameH;
    const geo = {width:32 * scale * depth, height:bodyRows * scale * depth, depth};
    if (auraIntensity > 0.01) {
      drawKiAura(ctx, geo, {
        color: cinematicOn ? cinematic.colorAt(now) : auraColor,
        intensity: auraIntensity,
        time,
        seed: 7
      });
    }
    if (cinematicOn) cinematic.drawUnder(ctx, geo, now);

    sample.tintColor = cinematicOn ? cinematic.colorAt(now) : auraColor;
    sample.tintAmount = Math.min(0.42, auraIntensity * 0.17);
    sample.haloAmount = Math.min(1.0, auraIntensity * 0.55);
    sample.haloPulse = time / 260;

    let drawn = null;
    if (image?.complete && image.naturalWidth && outfit) {
      const dir = outfit.directionRows?.[direction] ?? direction;
      const frames = outfit.walkFrames?.length
        ? outfit.walkFrames
        : [0];
      // O frame agora acompanha a velocidade real do player (walkPhase),
      // em vez de um relogio fixo — e o player finalmente anima ao andar.
      const frame = sample.moving
        ? frames[Math.floor(motion.walkPhase / Math.PI) % frames.length]
        : (outfit.idleFrame ?? 0);
      drawn = this.blitActorSprite(image, outfit, frame, dir, depth, scale, 1, sample);
    }

    if (cinematicOn) cinematic.drawOver(ctx, geo, now);

    const height = drawn?.height || 64 * scale * depth;
    this.drawNamePlate(this.state.profile.name, -height - 8, '#e9f4ff');
    ctx.restore();
  }

  drawRemotePlayer(player,time){
    const remote=resolveOutfit(
      String(player?.outfitId||player?.characterId||'goku'),
      this.outfits, src=>this.loadImage(src));
    const outfit=remote?.outfit||null;
    const image=remote?.image||null;
    const pos=this.screenPosition(Number(player?.x||50),Number(player?.y||52));
    const depth=this.depthSpriteScale(Number(player?.y||52));
    const scale=this.playerSpriteScale()*.92;
    const ctx=this.ctx;
    const now=Date.now();
    const motion=this.motion.get(`remote:${player?.profileId||player?.name||'?'}`,now);
    motion.observe(now,Number(player?.x||50),Number(player?.y||52),NaN,0);
    const sample=motion.sample(now);
    sample.rotation+=this.billboardLean(pos.x);

    ctx.save();
    ctx.translate(pos.x,pos.y);
    this.drawGroundRing(0, 0, 15, depth, 'rgba(99,214,255,.4)');
    this.drawActorDust(motion,now,depth);
    let drawn = null;
    if(image?.complete&&image.naturalWidth&&outfit){
      const direction=outfit.directionRows?.[Number(player?.direction??2)]??Number(player?.direction??2);
      const frames=outfit.walkFrames?.length?outfit.walkFrames:[outfit.idleFrame??0];
      const frame=sample.moving
        ?frames[Math.floor(motion.walkPhase/Math.PI)%frames.length]
        :(outfit.idleFrame??0);
      drawn = this.blitActorSprite(image, outfit, frame, direction, depth, scale, .92, sample);
    }
    const height = drawn?.height || 60 * scale * depth;
    this.drawNamePlate(String(player?.name||'Membro'), -height - 6, '#bfe9ff');
    ctx.restore();
  }

  drawMonster(enemy, time) {
    const now = Date.now();
    const monster = enemy.monster;
    const pos = this.screenPosition(enemy.x, enemy.y);
    const depth = this.depthSpriteScale(enemy.y);
    // Guild Bosses use normalized 4-direction outfit sheets. The generic
    // full-registry preview starts on row 0 (north/back), which made Champa
    // and Daishinkan appear with their backs to the player.
    const manifestOutfit = monster.outfitId ? this.outfits[monster.outfitId] : null;
    const forcedOutfit = manifestOutfit || (monster.guildBossOutfitSheet ? {
      src:monster.guildBossOutfitSheet,frameWidth:32,frameHeight:64,directions:4,
      directionRows:[0,1,2,3],walkFrames:[0,1,2],idleFrame:0,frameMs:150
    } : null);
    const outfit = forcedOutfit || (monster.lookType
      ? this.absoluteMonsterOutfits[String(monster.lookType)]
      : this.monsterOutfits[monster.outfitId]);
    const image = outfit?.src
      ? this.loadImage(outfit.src)
      : this.loadImage(
          monster.lookType
            ? `./generated/web/absolute-monsters-png/${monster.lookType}.png`
            : monster.sprite
        );
    const ctx = this.ctx;
    const targeted = enemy.uid === this.state.hunt.arena.targetId;

    // V22.4 — cada inimigo tem seu proprio estado de animacao, alimentado
    // so por posicao e HP: dano, morte e movimento saem dai.
    const motion = this.motion.get(enemy.uid, now);
    motion.observe(now, enemy.x, enemy.y, Number(enemy.hp), Number(enemy.maxHp || 0));
    const sample = motion.sample(now);
    sample.rotation += this.billboardLean(pos.x);

    ctx.save();
    ctx.translate(pos.x, pos.y);
    const age = Math.max(0, now - (enemy.spawnedAt || 0));
    const spawnAlpha = Math.min(1, Math.max(.25, age / 240));
    ctx.globalAlpha = spawnAlpha;

    this.drawGroundRing(
      0, 0, 19, depth,
      targeted ? 'rgba(255,207,75,.85)' : 'rgba(230,78,78,.42)',
      targeted ? (Math.sin(time / 300) + 1) / 2 : 0
    );
    this.drawActorDust(motion, now, depth);

    let drawn = null;
    if (image?.complete && image.naturalWidth && outfit) {
      const direction = outfit.directionRows?.[
        enemy.direction ?? 2
      ] ?? (enemy.direction ?? 2);
      const frames = outfit.walkFrames?.length
        ? outfit.walkFrames
        : [outfit.idleFrame || 0];
      const frame = sample.moving
        ? frames[Math.floor(motion.walkPhase / Math.PI) % frames.length]
        : (outfit.idleFrame || 0);
      const scale = Math.max(1.7, Math.min(2.5, this.h / 330));

      // Bosses ganham aura propria, com a cor tirada do sprite deles.
      const boss = Boolean(
        monster.guildBossOutfitSheet || monster.isBoss || monster.boss
      );
      if (boss) {
        const bossColor = this.auraColorForOutfit(
          `monster:${monster.outfitId || monster.lookType || monster.name}`,
          image,
          outfit
        );
        drawKiAura(ctx, {width:32 * scale * depth, height:64 * scale * depth, depth}, {
          color:bossColor,
          intensity:0.62,
          time,
          seed:(Number(monster.lookType) || 3) % 97
        });
        sample.tintColor = bossColor;
        sample.tintAmount = 0.10;
        sample.haloAmount = 0.34;
        sample.haloPulse = time / 300;
      }

      drawn = this.blitActorSprite(image, outfit, frame, direction, depth, scale, spawnAlpha, sample);
    } else if (image?.complete && image.naturalWidth) {
      const size = 60 * depth;
      ctx.drawImage(image, -size / 2, -size, size, size);
      drawn = {height:size};
    }

    const height = drawn?.height || 64 * depth * 2;
    const hp = Math.max(0, enemy.hp / enemy.maxHp);
    this.drawBar(-27 * depth, -height - 20 * depth, 54 * depth, 7 * depth, hp, targeted ? '#ffb03a' : '#dd493f');
    this.drawNamePlate(monster.name, -height - 26 * depth, targeted ? '#ffdf9a' : '#ffd9d9');
    ctx.restore();
  }

  drawEffects(effects, time) {
    const ctx = this.ctx;
    const now = Date.now();

    for (const effect of effects) {
      const elapsed = now - effect.createdAt;
      if (elapsed < 0) continue;
      const progress = Math.max(
        0,
        Math.min(1, elapsed / effect.duration)
      );
      const from = this.screenPosition(effect.fromX, effect.fromY);
      const to = this.screenPosition(effect.toX, effect.toY);
      const fromDepth = this.depthSpriteScale(effect.fromY);
      const toDepth = this.depthSpriteScale(effect.toY);

      if (effect.kind === 'damage-number') {
        const rise = progress * 38;
        const alpha = Math.max(0, 1 - Math.pow(progress, 2));
        const pop = 1 + Math.max(0, 1 - progress * 5) * 0.35;
        const text = String(Math.max(0, Math.round(effect.damage || 0)));
        const size = (effect.critical ? 21 : 16) * toDepth * pop;

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `bold ${Math.max(10, size)}px Tahoma`;
        ctx.lineWidth = Math.max(3, 4 * toDepth);
        ctx.strokeStyle = 'rgba(4,7,12,.92)';
        const gradient = ctx.createLinearGradient(0, to.y - 60 - rise, 0, to.y - 30 - rise);
        if (effect.critical) {
          gradient.addColorStop(0, '#fff6c9');
          gradient.addColorStop(1, '#ffab21');
        } else {
          gradient.addColorStop(0, '#ffffff');
          gradient.addColorStop(1, '#c9d9e8');
        }
        ctx.shadowColor = effect.critical ? 'rgba(255,180,50,.75)' : 'rgba(0,0,0,.6)';
        ctx.shadowBlur = effect.critical ? 14 : 5;
        ctx.strokeText(text, to.x, to.y - 46 * toDepth - rise);
        ctx.fillStyle = gradient;
        ctx.fillText(text, to.x, to.y - 46 * toDepth - rise);
        ctx.shadowBlur = 0;

        if (effect.critical) {
          ctx.font = `bold ${Math.max(8, 9 * toDepth)}px Tahoma`;
          ctx.fillStyle = '#ffd76b';
          ctx.fillText('CRÍTICO', to.x, to.y - 64 * toDepth - rise);
        }
        ctx.restore();
        continue;
      }

      if (effect.kind === 'spell-source-effect') {
        this.drawRegistryAsset({
          category:'effect',
          id:effect.effectId,
          x:from.x,
          y:from.y,
          elapsed,
          duration:effect.duration,
          alpha:Math.max(0,1-progress*.2),
          depth:fromDepth,
          glow:true,
          actorAttached:effect.attachToActor === true
        });
        continue;
      }

      if (effect.kind === 'spell-combat-area') {
        const area = Array.isArray(effect.area) ? effect.area : [];
        const origin = effect.areaMetrics?.origin || {x:0,y:0};
        let drawnCells = 0;
        for (let row = 0; row < area.length; row += 1) {
          const cells = Array.isArray(area[row]) ? area[row] : [];
          for (let column = 0; column < cells.length; column += 1) {
            const marker = Number(cells[column] || 0);
            // 1 = affected tile, 3 = target-centred affected tile.
            // 2 is only the caster/origin marker and is not affected.
            if (marker !== 1 && marker !== 3) continue;
            const arenaX = Number(effect.fromX || 0) +
              (column - Number(origin.x || 0)) * 4.5;
            const arenaY = Number(effect.fromY || 0) +
              (row - Number(origin.y || 0)) * 4.5;
            const tile = this.screenPosition(arenaX, arenaY);
            if (this.drawRegistryAsset({
              category:'effect',
              id:effect.effectId,
              x:tile.x,
              y:tile.y,
              elapsed,
              duration:effect.duration,
              depth:this.depthSpriteScale(arenaY),
              glow:true,
              alpha:Math.max(0,1-progress*.18)
            })) drawnCells += 1;
          }
        }
        // Some source areas use only the origin marker. In that case the
        // effect still belongs on the origin tile.
        if (!drawnCells && effect.effectId != null) {
          this.drawRegistryAsset({
            category:'effect',
            id:effect.effectId,
            x:from.x,
            y:from.y,
            elapsed,
            depth:fromDepth,
            glow:true,
            duration:effect.duration
          });
        }
        continue;
      }

      if (effect.kind === 'spell-self') {
        const drawn = effect.effectId != null && this.drawRegistryAsset({
          category:'effect',
          id:effect.effectId,
          x:from.x,
          y:from.y,
          elapsed,
          duration:effect.duration,
          alpha:Math.max(0, 1 - progress * .35),
          depth:fromDepth,
          glow:true,
          actorAttached:true
        });
        if (!drawn && effect.sprite) {
          const image = this.loadImage(effect.sprite);
          if (image?.complete && image.naturalWidth) {
            const size = (52 + Math.sin(progress * Math.PI) * 14) * fromDepth;
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = Math.max(0, 1 - progress);
            ctx.drawImage(
              image,
              from.x - size / 2,
              from.y - 22 * fromDepth - size / 2,
              size,
              size
            );
            ctx.restore();
          }
        }
        continue;
      }

      if (effect.kind === 'spell-area') {
        const drawn = effect.effectId != null && this.drawRegistryAsset({
          category:'effect',
          id:effect.effectId,
          x:to.x,
          y:to.y,
          elapsed,
          duration:effect.duration,
          alpha:Math.max(0, 1 - progress * .25),
          depth:toDepth,
          glow:true,
          scale:1.08
        });
        if (drawn) continue;

        // Fallback shockwave, now drawn flat on the ground plane so it reads
        // as an expanding ring on the floor instead of a flat circle.
        const radius=(28+progress*72)*toDepth;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha=Math.max(0,1-progress);
        ctx.translate(to.x, to.y);
        ctx.scale(1, .34);
        ctx.strokeStyle='#77ddff';
        for(let ring=0;ring<3;ring+=1){
          ctx.lineWidth=(5-ring)*toDepth;
          ctx.beginPath();
          ctx.arc(0,0,Math.max(2,radius-ring*14*toDepth),0,Math.PI*2);
          ctx.stroke();
        }
        ctx.restore();
        continue;
      }

      if (effect.kind === 'spell-wave') {
        const radius = Math.max(1, Number(effect.areaMetrics?.radius || 5));
        const distanceRatio = Math.max(.16, Math.min(1, radius / 5));
        const x = from.x + (to.x - from.x) * distanceRatio;
        const y = from.y + (to.y - from.y) * distanceRatio;
        const drawn = effect.effectId != null && this.drawRegistryAsset({
          category:'effect',
          id:effect.effectId,
          x,
          y,
          elapsed,
          duration:effect.duration,
          alpha:Math.max(0, 1 - progress * .18),
          depth:(fromDepth + toDepth) / 2,
          glow:true,
          scale:1.05
        });
        if (drawn) continue;

        const angle=Math.atan2(to.y-from.y,to.x-from.x);
        const length=(50+progress*150)*fromDepth;
        const width=(20+progress*45)*fromDepth;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.translate(from.x,from.y-20*fromDepth);
        ctx.rotate(angle);
        ctx.globalAlpha=Math.max(0,1-progress*.65);
        const gradient=ctx.createLinearGradient(0,0,length,0);
        gradient.addColorStop(0,'#eafcffdd');
        gradient.addColorStop(.35,'#8fe4ff99');
        gradient.addColorStop(1,'#42b9ff00');
        ctx.fillStyle=gradient;
        ctx.beginPath();
        ctx.moveTo(0,-8*fromDepth);
        ctx.lineTo(length,-width);
        ctx.lineTo(length,width);
        ctx.lineTo(0,8*fromDepth);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        continue;
      }

      if (
        effect.kind === 'spell-projectile' ||
        effect.kind === 'spell-impact'
      ) {
        const projectile = effect.kind === 'spell-projectile';
        // Projectiles arc slightly instead of sliding along a flat line,
        // which is what makes them read as travelling through space.
        const arc = projectile ? Math.sin(progress * Math.PI) * 22 : 0;
        const travelDepth = projectile
          ? fromDepth + (toDepth - fromDepth) * progress
          : toDepth;
        const x = projectile
          ? from.x + (to.x - from.x) * progress
          : to.x;
        const y = (projectile
          ? from.y + (to.y - from.y) * progress - 20 * travelDepth
          : to.y) - arc;
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const length = Math.max(1, Math.hypot(dx,dy));

        const drawn = projectile
          ? effect.missileId != null && this.drawRegistryAsset({
              category:'missile',
              id:effect.missileId,
              x,
              y,
              elapsed,
              duration:effect.duration,
              depth:travelDepth,
              glow:true,
              trajectory:{dx:dx/length,dy:dy/length}
            })
          : effect.effectId != null && this.drawRegistryAsset({
              category:'effect',
              id:effect.effectId,
              x,
              y,
              elapsed,
              duration:effect.duration,
              depth:travelDepth,
              glow:true,
              alpha:Math.max(0,1-progress*.35)
            });

        if (!drawn && effect.sprite) {
          const image = this.loadImage(effect.sprite);
          if (image?.complete && image.naturalWidth) {
            const size = (projectile ? 34 : 56) * travelDepth;
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = projectile ? 1 : Math.max(0,1-progress);
            ctx.drawImage(image,x-size/2,y-size/2,size,size);
            ctx.restore();
          }
        }
        continue;
      }

      if (effect.kind === 'ki-projectile') {
        const travelDepth = fromDepth + (toDepth - fromDepth) * progress;
        const arc = Math.sin(progress * Math.PI) * 26;
        const x = from.x + (to.x - from.x) * progress;
        const y = from.y + (to.y - from.y) * progress - arc;
        const core = (effect.critical ? 7 : 5) * travelDepth;

        // Comet trail: a short additive streak behind the bolt.
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 1; i <= 5; i += 1) {
          const back = Math.max(0, progress - i * 0.035);
          const bx = from.x + (to.x - from.x) * back;
          const by = from.y + (to.y - from.y) * back - Math.sin(back * Math.PI) * 26;
          ctx.globalAlpha = (0.30 - i * 0.05) * 1.4;
          ctx.fillStyle = effect.critical ? '#ffdc7a' : '#8fe0ff';
          ctx.beginPath();
          ctx.arc(bx, by - 20 * travelDepth, core * (1 - i * 0.13), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 18 * travelDepth;
        ctx.shadowColor = effect.critical ? '#ffe36b' : '#75d8ff';
        const bolt = ctx.createRadialGradient(x, y - 20 * travelDepth, 0, x, y - 20 * travelDepth, core * 2.1);
        bolt.addColorStop(0, '#ffffff');
        bolt.addColorStop(0.35, effect.critical ? '#fff09b' : '#b8efff');
        bolt.addColorStop(1, effect.critical ? '#ffb02400' : '#3aa8ff00');
        ctx.fillStyle = bolt;
        ctx.beginPath();
        ctx.arc(x, y - 20 * travelDepth, core * 2.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        if (progress > .78) {
          this.drawSmoke(to.x, to.y - 18 * toDepth, progress, effect.critical, toDepth);
        }
      } else {
        this.drawSmoke(to.x, to.y - 16 * toDepth, progress, effect.critical, toDepth);
      }
    }
  }

  drawSmoke(x, y, progress, critical, depth = 1) {
    const ctx = this.ctx;
    const fade = 1 - progress;
    ctx.save();
    ctx.globalCompositeOperation = critical ? 'lighter' : 'source-over';
    ctx.globalAlpha = Math.max(0, fade) * .85;
    for (let i = 0; i < 6; i += 1) {
      const angle = i / 6 * Math.PI * 2 + progress * 1.2;
      const radius = (4 + progress * 18) * depth;
      const size = (3 + progress * 4) * depth;
      const puff = ctx.createRadialGradient(
        x + Math.cos(angle) * radius, y + Math.sin(angle) * radius * .55, 0,
        x + Math.cos(angle) * radius, y + Math.sin(angle) * radius * .55, size
      );
      puff.addColorStop(0, critical ? '#ffe48dcc' : '#e6e0d4bb');
      puff.addColorStop(1, critical ? '#ffb32400' : '#8f8a8000');
      ctx.fillStyle = puff;
      ctx.beginPath();
      ctx.arc(
        x + Math.cos(angle) * radius,
        y + Math.sin(angle) * radius * .55,
        size,
        0,
        Math.PI * 2
      );
      ctx.fill();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------
  // Labels and HUD
  // ---------------------------------------------------------------------

  roundedRect(ctx, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  drawNamePlate(name, y, color = '#ffffff') {
    const ctx = this.ctx;
    const text = String(name || '');
    if (!text) return;
    ctx.save();
    ctx.font = 'bold 11px Tahoma';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    // Outlined text instead of a solid black box: it stays readable over the
    // busy ground plane without stamping a rectangle onto the scene.
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(3,6,11,.9)';
    ctx.strokeText(text, 0, y);
    ctx.fillStyle = color;
    ctx.fillText(text, 0, y);
    ctx.restore();
  }

  drawGlassLabel(text, x, y, color = '#e8f2ff') {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = 'bold 10px Tahoma';
    ctx.textAlign = 'center';
    const width = ctx.measureText(text).width + 14;
    const height = 16;
    ctx.globalAlpha = .82;
    const fill = ctx.createLinearGradient(0, y - height, 0, y + 2);
    fill.addColorStop(0, 'rgba(24,36,52,.94)');
    fill.addColorStop(1, 'rgba(8,14,22,.94)');
    ctx.fillStyle = fill;
    this.roundedRect(ctx, x - width / 2, y - height + 2, width, height, 7);
    ctx.fill();
    ctx.strokeStyle = 'rgba(150,190,230,.32)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.fillText(text, x, y - 2);
    ctx.restore();
  }

  drawHud(zone, enemies) {
    const ctx = this.ctx;
    const playerMax = this.state.hunt.playerMaxHp || 1;
    const playerPct = Math.max(
      0,
      Math.min(1, (this.state.hunt.playerHp || 0) / playerMax)
    );
    const alive = enemies.filter(enemy => enemy.alive && enemy.hp > 0);
    const waiting = enemies.filter(enemy =>
      !enemy.alive && enemy.respawnAt
    );
    const stats = this.getCombatStats();
    const requested = this.state.hunt.pendingLureCount;

    const x = 12;
    const y = 12;
    const width = Math.min(332, this.w - 24);
    const height = 64;

    ctx.save();
    // Glass panel: dark translucent body, lit top edge, cast shadow.
    ctx.shadowColor = 'rgba(0,0,0,.55)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 6;
    const body = ctx.createLinearGradient(0, y, 0, y + height);
    body.addColorStop(0, 'rgba(24,38,56,.90)');
    body.addColorStop(1, 'rgba(7,13,21,.92)');
    ctx.fillStyle = body;
    this.roundedRect(ctx, x, y, width, height, 12);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    ctx.strokeStyle = 'rgba(140,185,230,.30)';
    ctx.lineWidth = 1;
    this.roundedRect(ctx, x + .5, y + .5, width - 1, height - 1, 12);
    ctx.stroke();

    const sheen = ctx.createLinearGradient(0, y, 0, y + height * .48);
    sheen.addColorStop(0, 'rgba(255,255,255,.13)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sheen;
    this.roundedRect(ctx, x + 1, y + 1, width - 2, height * .48, 11);
    ctx.fill();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 13px Tahoma';
    ctx.fillText(this.fitText(zone.name, width - 24, 'bold 13px Tahoma'), x + 12, y + 20);

    ctx.font = '10px Tahoma';
    ctx.fillStyle = '#9db6d0';
    const lureText = requested != null
      ? `Lure ${this.state.hunt.lureCount} → ${requested}`
      : `Lure ${this.state.hunt.lureCount}`;
    ctx.fillText(
      `${lureText} · vivos ${alive.length} · respawn ${waiting.length}`,
      x + 12,
      y + 34
    );

    this.drawBar(x + 12, y + 40, width - 24, 11, playerPct, '#e0434f', true);

    ctx.font = '9px Tahoma';
    ctx.fillStyle = '#8fa6bd';
    ctx.fillText(
      `ATK ${Math.floor(stats.attack)} · ${stats.attackInterval}ms · CRIT ${(stats.criticalChance * 100).toFixed(1)}%`,
      x + 12,
      y + 60
    );
    ctx.restore();
  }

  fitText(text, maxWidth, font) {
    const ctx = this.ctx;
    const value = String(text || '');
    ctx.save();
    ctx.font = font;
    if (ctx.measureText(value).width <= maxWidth) {
      ctx.restore();
      return value;
    }
    let sliced = value;
    while (sliced.length > 3 && ctx.measureText(`${sliced}…`).width > maxWidth) {
      sliced = sliced.slice(0, -1);
    }
    ctx.restore();
    return `${sliced}…`;
  }

  // Glossy capsule bar with an inset track, a lit fill and a moving
  // specular highlight — the same treatment the DOM HUD uses.
  drawBar(x, y, width, height, value, color, glossy = false) {
    const ctx = this.ctx;
    const ratio = Math.max(0, Math.min(1, value));
    const radius = height / 2;

    ctx.save();
    const track = ctx.createLinearGradient(0, y, 0, y + height);
    track.addColorStop(0, 'rgba(4,7,12,.92)');
    track.addColorStop(1, 'rgba(20,28,38,.92)');
    ctx.fillStyle = track;
    this.roundedRect(ctx, x, y, width, height, radius);
    ctx.fill();

    if (ratio > 0) {
      ctx.save();
      this.roundedRect(ctx, x, y, width, height, radius);
      ctx.clip();
      const fillWidth = Math.max(height * .6, width * ratio);
      const fill = ctx.createLinearGradient(0, y, 0, y + height);
      fill.addColorStop(0, this.lighten(color, .38));
      fill.addColorStop(.5, color);
      fill.addColorStop(1, this.darken(color, .34));
      ctx.fillStyle = fill;
      ctx.fillRect(x, y, fillWidth, height);

      if (glossy) {
        const gloss = ctx.createLinearGradient(0, y, 0, y + height * .55);
        gloss.addColorStop(0, 'rgba(255,255,255,.34)');
        gloss.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = gloss;
        ctx.fillRect(x, y, fillWidth, height * .55);
      }
      ctx.restore();
    }

    ctx.strokeStyle = 'rgba(150,180,210,.28)';
    ctx.lineWidth = 1;
    this.roundedRect(ctx, x + .5, y + .5, width - 1, height - 1, radius);
    ctx.stroke();
    ctx.restore();
  }

  lighten(hex, amount) {
    return this.mixHex(hex, 255, amount);
  }

  darken(hex, amount) {
    return this.mixHex(hex, 0, amount);
  }

  mixHex(hex, target, amount) {
    const value = String(hex).replace('#', '');
    const full = value.length === 3
      ? value.split('').map(c => c + c).join('')
      : value.slice(0, 6);
    const number = parseInt(full, 16);
    if (!Number.isFinite(number)) return hex;
    const r = Math.round(((number >> 16) & 255) + (target - ((number >> 16) & 255)) * amount);
    const g = Math.round(((number >> 8) & 255) + (target - ((number >> 8) & 255)) * amount);
    const b = Math.round((number & 255) + (target - (number & 255)) * amount);
    return `rgb(${r},${g},${b})`;
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    window.removeEventListener('resize', this.resizeHandler);
    this.canvas.removeEventListener('click', this.clickHandler);
    this.shadedSprites.clear();
    this.ground = null;
  }
}
