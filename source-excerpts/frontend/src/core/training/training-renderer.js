import {
  worldMapLoader
} from '../map/world-map-loader.js';
import {
  assetRegistry
} from '../assets/asset-registry.js';
// V22.4.4 — a sala de treino passou a usar a mesma camada HD-2D da arena:
// volume por normal map, animação procedural e aura de ki. O `?v=` é o mesmo
// usado pelos outros renderers de propósito — especificador igual, instância
// de módulo compartilhada, caches de sprite reaproveitados.
import { forgeFrame, forgeSilhouette, auraColorFor, frameArtHeight } from '../render/sprite-forge.js?v=22.4.4';
import { MotionDirector } from '../render/actor-motion.js?v=22.4.4';
import { drawKiAura } from '../render/ki-aura.js?v=22.4.4';
import { resolveOutfit } from '../render/outfit-fallback.js?v=22.4.4';

// V22 — the training room shares the Hunt arena's "fake 3D" language: a
// perspective ground plane, a lit backdrop, projected soft shadows and
// depth-scaled actors. Same 2D canvas, same sprites, no engine change.
const FAR_SCALE = 0.60;
const ACTOR_DEPTH_MIX = 0.72;

// V22.3 — Sala do Tempo.
//
// Antes o personagem era um sprite parado deslizando de um lado ao outro por
// cima de um mapa desenhado de cima. Agora ele caminha de verdade: pisa tile a
// tile no piso livre da sala, usa as linhas de direção e os quadros de passo da
// própria spritesheet do outfit e escolhe destinos aleatórios pelo cenário.
//
// O manifesto de outfits não é importado do map-renderer de propósito: o app.js
// importa cada renderer com o seu próprio `?v=`, então um import cruzado criaria
// uma segunda instância do módulo em vez de reaproveitar o cache dele. Aqui o
// custo é um fetch com cache forçado quando a sala abre.
const OUTFIT_MANIFEST_URL = './assets/generated/outfit-manifest.json?v=22.4.4';
const outfitImages = new Map();
let outfitManifest = null;
let outfitManifestPromise = null;

function loadOutfitManifest() {
  if (outfitManifest) return Promise.resolve(outfitManifest);
  if (!outfitManifestPromise) {
    outfitManifestPromise = fetch(OUTFIT_MANIFEST_URL, {cache:'force-cache'})
      .then(response => response.json())
      .then(manifest => (outfitManifest = manifest))
      .catch(error => {
        outfitManifestPromise = null;
        throw error;
      });
  }
  return outfitManifestPromise;
}

function outfitImage(source) {
  if (!source) return null;
  if (!outfitImages.has(source)) {
    const image = new Image();
    image.decoding = 'async';
    image.src = source;
    outfitImages.set(source, image);
  }
  return outfitImages.get(source);
}

// Ritmo do passeio. Um passo por tile, pausas curtas entre trechos e destino
// sorteado a cada trecho — nada de vaivém fixo entre duas bordas.
const WALK = {
  stepMs:430,
  minStepMs:200,
  pauseMinMs:500,
  pauseMaxMs:2400,
  minDistance:3,
  maxDistance:11,
  pauseChance:0.45
};

const WALK_NEIGHBOURS = [[0,-1],[1,0],[0,1],[-1,0]];

function tileKey(column, row) {
  return `${column},${row}`;
}

const ROOM_THEMES = {
  'ki-barrier': {
    skyTop:'#071426', skyBottom:'#17395e', fog:'#4e7fae',
    floorNear:'#1b3a5c', floorFar:'#0d1f34',
    grid:'rgba(120,200,255,.16)', key:'#8fd4ff', keyAlpha:0.16,
    accent:'#77dcff'
  },
  default: {
    skyTop:'#1a1108', skyBottom:'#4a3018', fog:'#8a6238',
    floorNear:'#4a3722', floorFar:'#241a10',
    grid:'rgba(255,215,160,.13)', key:'#ffd8a0', keyAlpha:0.15,
    accent:'#e9c187'
  }
};

function roundedRectPath(ctx, x, y, width, height, radius) {
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

export class TrainingRenderer {
  constructor(canvas, {
    getState,
    getRoom,
    playerImage = null,
    punchingBagImage = null,
    outfitId = null,
    getAgility = null,
    getFormTier = null,
    playerName = 'Você'
  }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.getState = getState;
    this.getRoom = getRoom;
    this.playerImage = playerImage;
    this.punchingBagImage = punchingBagImage;
    this.outfitId = outfitId || null;
    this.playerName = playerName || 'Você';
    this.getAgility = typeof getAgility === 'function' ? getAgility : () => 1;
    // 0 = forma base, 1 = última da cadeia. Define a força da aura de ki.
    this.getFormTier = typeof getFormTier === 'function' ? getFormTier : () => 0;
    this.motion = new MotionDirector();
    this.seenEffects = new Set();
    this.outfit = null;
    this.walk = null;
    this.timeChamberMap = {
      ready:false,
      loading:false,
      center:{x:524,y:247,z:7},
      radiusX:16,
      radiusY:11,
      tiles:[],
      images:new Map(),
      view:null
    };
    if (this.outfitId) {
      loadOutfitManifest()
        .then(manifest => {
          this.outfit = manifest[this.outfitId] || null;
          if (this.outfit?.src) outfitImage(this.outfit.src);
        })
        .catch(() => {});
    }
    this.prepareTimeChamberMap();
    this.resizeHandler = () => this.resize();
    window.addEventListener('resize', this.resizeHandler);
    this.resize();
    this.running = true;
    this.frame = requestAnimationFrame(time => this.draw(time));
  }

  async prepareTimeChamberMap() {
    if (
      this.timeChamberMap.ready ||
      this.timeChamberMap.loading
    ) {
      return;
    }

    this.timeChamberMap.loading = true;

    try {
      const {x,y,z} = this.timeChamberMap.center;
      await worldMapLoader.initialize();
      await worldMapLoader.loadAround(x, y, z, 1);
      await assetRegistry.initialize();

      const itemCategory = await assetRegistry.loadCategory('item');
      const idMap = await assetRegistry.loadItemIdMap();
      const tiles = worldMapLoader.visibleTiles(
        x,
        y,
        z,
        this.timeChamberMap.radiusX,
        this.timeChamberMap.radiusY
      );

      const images = new Map();
      const clientIds = new Set();

      for (const tile of tiles) {
        for (const rawItem of tile.items || []) {
          const serverId = Number(rawItem[0] || 0);
          const clientId = Number(
            idMap.serverToClient[String(serverId)] || 0
          );
          if (clientId > 0) clientIds.add(clientId);
        }
      }

      await Promise.all(
        [...clientIds].map(async clientId => {
          const entry = itemCategory.byId.get(clientId);
          if (!entry?.preview) return;

          const image = new Image();
          const loaded = new Promise(resolve => {
            image.onload = () => resolve();
            image.onerror = () => resolve();
          });
          image.src = entry.preview;
          await loaded;
          images.set(clientId, {image,entry});
        })
      );

      this.timeChamberMap.tiles = tiles;
      this.timeChamberMap.images = images;
      this.buildTimeChamberFloor(tiles);
      this.timeChamberMap.ready = true;
    } catch (error) {
      console.error(
        'Falha ao carregar a Sala do Tempo original:',
        error
      );
    } finally {
      this.timeChamberMap.loading = false;
    }
  }

  // O piso livre da sala é o tile que traz só o chão. Paredes, portas e o
  // interior da construção ao norte carregam itens extras e ficam de fora.
  // Depois disso só interessa a região ligada ao centro: assim o personagem
  // nunca nasce dentro de uma sala fechada nem numa ilha solta do cenário.
  buildTimeChamberFloor(tiles) {
    const map = this.timeChamberMap;
    const {x:centerX,y:centerY} = map.center;
    const columns = map.radiusX * 2 + 1;
    const rows = map.radiusY * 2 + 1;

    const open = new Set();
    for (const tile of tiles) {
      if ((tile.items || []).length !== 1) continue;
      const column = tile.x - (centerX - map.radiusX);
      const row = tile.y - (centerY - map.radiusY);
      if (column < 0 || row < 0 || column >= columns || row >= rows) continue;
      open.add(tileKey(column, row));
    }

    const startColumn = map.radiusX;
    const startRow = map.radiusY;
    const walkable = new Set();
    if (open.has(tileKey(startColumn, startRow))) {
      const queue = [[startColumn, startRow]];
      walkable.add(tileKey(startColumn, startRow));
      while (queue.length) {
        const [column,row] = queue.pop();
        for (const [dx,dy] of WALK_NEIGHBOURS) {
          const nextColumn = column + dx;
          const nextRow = row + dy;
          const id = tileKey(nextColumn, nextRow);
          if (walkable.has(id) || !open.has(id)) continue;
          walkable.add(id);
          queue.push([nextColumn, nextRow]);
        }
      }
    }

    this.walk = {
      ready:walkable.size > 1,
      columns,
      rows,
      walkable,
      spots:[...walkable].map(id => id.split(',').map(Number)),
      column:startColumn,
      row:startRow,
      fromColumn:startColumn,
      fromRow:startRow,
      toColumn:startColumn,
      toRow:startRow,
      direction:2,
      moving:false,
      stepStartedAt:0,
      stepDurationMs:WALK.stepMs,
      path:[],
      pauseUntil:0
    };
  }

  // Busca em largura no piso livre. A sala é aberta, então o caminho quase
  // sempre é reto — o pathfinding existe para contornar a construção do norte
  // sem que o personagem atravesse parede.
  walkPath(fromColumn, fromRow, toColumn, toRow) {
    const walk = this.walk;
    const start = tileKey(fromColumn, fromRow);
    const goal = tileKey(toColumn, toRow);
    if (start === goal) return [];

    const previous = new Map([[start, null]]);
    const queue = [[fromColumn, fromRow]];
    let head = 0;
    let found = false;

    while (head < queue.length) {
      const [column,row] = queue[head];
      head += 1;
      if (tileKey(column, row) === goal) {
        found = true;
        break;
      }
      for (const [dx,dy] of WALK_NEIGHBOURS) {
        const nextId = tileKey(column + dx, row + dy);
        if (previous.has(nextId) || !walk.walkable.has(nextId)) continue;
        previous.set(nextId, tileKey(column, row));
        queue.push([column + dx, row + dy]);
      }
    }

    if (!found) return [];

    const path = [];
    let cursor = goal;
    while (cursor && cursor !== start) {
      path.unshift(cursor.split(',').map(Number));
      cursor = previous.get(cursor);
    }
    return path;
  }

  // Destino aleatório a uma distância confortável. Sem o piso mínimo o
  // personagem ficaria trocando de tile vizinho e pareceria tremer no lugar.
  pickWalkTarget() {
    const walk = this.walk;
    if (!walk?.spots.length) return;

    for (let attempt = 0; attempt < 24; attempt += 1) {
      const [column,row] = walk.spots[
        Math.floor(Math.random() * walk.spots.length)
      ];
      const distance =
        Math.abs(column - walk.column) + Math.abs(row - walk.row);
      if (distance < WALK.minDistance || distance > WALK.maxDistance) continue;
      const path = this.walkPath(walk.column, walk.row, column, row);
      if (!path.length) continue;
      walk.path = path;
      return;
    }

    const neighbours = WALK_NEIGHBOURS
      .map(([dx,dy]) => [walk.column + dx, walk.row + dy])
      .filter(([column,row]) => walk.walkable.has(tileKey(column, row)));
    if (neighbours.length) {
      walk.path = [neighbours[Math.floor(Math.random() * neighbours.length)]];
    }
  }

  startWalkStep(now) {
    const walk = this.walk;
    const next = walk.path.shift();
    if (!next) return;

    const [column,row] = next;
    walk.fromColumn = walk.column;
    walk.fromRow = walk.row;
    walk.toColumn = column;
    walk.toRow = row;

    const dx = column - walk.column;
    const dy = row - walk.row;
    walk.direction = dy < 0 ? 0 : dy > 0 ? 2 : dx > 0 ? 1 : 3;

    // Agility continua acelerando o passo, como na versão anterior — só que
    // agora ela encurta a duração do passo em vez de aumentar um deslizamento.
    const agility = Math.max(1, Number(this.getAgility() || 1));
    walk.stepDurationMs = Math.max(
      WALK.minStepMs,
      WALK.stepMs / (1 + (agility - 1) * 0.0025)
    );
    walk.stepStartedAt = now;
    walk.moving = true;
  }

  updateTimeChamberWalk(now) {
    const walk = this.walk;
    if (!walk?.ready) return;

    if (walk.moving) {
      if (now - walk.stepStartedAt < walk.stepDurationMs) return;
      walk.column = walk.toColumn;
      walk.row = walk.toRow;
      walk.moving = false;
      if (walk.path.length) {
        this.startWalkStep(now);
        return;
      }
      walk.pauseUntil = Math.random() < WALK.pauseChance
        ? now + WALK.pauseMinMs +
          Math.random() * (WALK.pauseMaxMs - WALK.pauseMinMs)
        : now;
      return;
    }

    if (now < walk.pauseUntil) return;
    if (!walk.path.length) this.pickWalkTarget();
    if (walk.path.length) this.startWalkStep(now);
    else walk.pauseUntil = now + 400;
  }

  walkPosition(now) {
    const walk = this.walk;
    if (!walk.moving) return {column:walk.column, row:walk.row};
    const progress = Math.max(
      0,
      Math.min(1, (now - walk.stepStartedAt) / walk.stepDurationMs)
    );
    return {
      column:walk.fromColumn + (walk.toColumn - walk.fromColumn) * progress,
      row:walk.fromRow + (walk.toRow - walk.fromRow) * progress
    };
  }

  // O personagem é desenhado no mesmo sistema de tiles do cenário — pés no
  // centro da base do tile, escala amarrada ao tamanho do tile. É o que faz
  // ele pisar no chão em vez de flutuar por cima dele.
  drawTimeChamberActor(now) {
    const view = this.timeChamberMap.view;
    const walk = this.walk;
    if (!view || !walk?.ready) return;

    const ctx = this.ctx;
    const {tileSize,offsetX,offsetY} = view;
    const {column,row} = this.walkPosition(now);
    const footX = offsetX + (column + 0.5) * tileSize;
    const footY = offsetY + (row + 1) * tileSize;

    ctx.save();
    ctx.translate(footX, footY);
    this.groundShadow(0, 0, tileSize * 0.36, 1, 0.45);

    const resolvedChamber = this.outfitId
      ? resolveOutfit(this.outfitId, outfitManifest || {}, src => outfitImage(src))
      : null;
    const outfit = resolvedChamber?.outfit || this.outfit;
    const sheet = resolvedChamber?.image || (outfit?.src ? outfitImage(outfit.src) : null);
    const scale = tileSize / 32;
    let spriteHeight = 40 * scale;

    if (sheet?.complete && sheet.naturalWidth && outfit) {
      const directions = Number(outfit.directions || 4);
      const gameDirection = Math.max(
        0,
        Math.min(directions - 1, Number(walk.direction) || 0)
      );
      const spriteRow = outfit.directionRows?.[gameDirection] ?? gameDirection;
      const walkFrames = outfit.walkFrames?.length ? outfit.walkFrames : [0];
      const frame = walk.moving
        ? walkFrames[
            Math.floor(now / (outfit.frameMs || 150)) % walkFrames.length
          ]
        : (outfit.idleFrame ?? 0);
      const drawWidth = outfit.frameWidth * scale;
      const drawHeight = outfit.frameHeight * scale;
      spriteHeight = drawHeight;

      // V22.4.4 — o sprite passa pela forja (relevo + luz) e recebe a
      // respiração/balanço do caminhar. A arte original não é alterada:
      // a iluminação é calculada em memória, por quadro, e fica em cache.
      const chamber = this.motion.get('chamber', now);
      chamber.observe(now, column * 10, row * 10, NaN, 0);
      const cm = chamber.sample(now);

      const sxFrame = frame * outfit.frameWidth;
      const syFrame = spriteRow * outfit.frameHeight;
      const inBounds =
        sxFrame + outfit.frameWidth <= sheet.naturalWidth &&
        syFrame + outfit.frameHeight <= sheet.naturalHeight;
      const forged = inBounds
        ? forgeFrame(sheet, sxFrame, syFrame, outfit.frameWidth, outfit.frameHeight, 'snow')
        : null;

      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.translate(cm.offsetX * scale, cm.offsetY * scale);
      if (cm.rotation) ctx.rotate(cm.rotation);
      if (cm.scaleX !== 1 || cm.scaleY !== 1) ctx.scale(cm.scaleX, cm.scaleY);
      if (forged) {
        const pad = forged.pad;
        ctx.drawImage(
          forged.canvas,
          -(outfit.frameWidth + pad * 2) * scale / 2,
          -(outfit.frameHeight + pad * 2) * scale + pad * scale,
          (outfit.frameWidth + pad * 2) * scale,
          (outfit.frameHeight + pad * 2) * scale
        );
      } else {
        ctx.drawImage(
          sheet, sxFrame, syFrame, outfit.frameWidth, outfit.frameHeight,
          -drawWidth / 2, -drawHeight, drawWidth, drawHeight
        );
      }
      ctx.restore();
    } else if (this.playerImage?.complete && this.playerImage.naturalWidth) {
      // Enquanto o manifesto de outfits não chega, o retrato antigo segura a
      // cena. Sem isso a sala ficaria vazia nos primeiros quadros.
      const drawWidth = 56 * scale;
      const drawHeight = 64 * scale;
      spriteHeight = drawHeight;
      ctx.drawImage(
        this.playerImage,
        -drawWidth / 2,
        -drawHeight,
        drawWidth,
        drawHeight
      );
    }

    ctx.font = `bold ${Math.max(9, 11 * scale)}px Tahoma`;
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(3,6,11,.9)';
    ctx.lineWidth = 3.5;
    ctx.strokeText(this.playerName, 0, -spriteHeight - 6);
    ctx.fillStyle = '#fff';
    ctx.fillText(this.playerName, 0, -spriteHeight - 6);
    ctx.restore();
  }

  drawOriginalTimeChamber(now = Date.now()) {
    const ctx = this.ctx;
    const map = this.timeChamberMap;
    const {x:centerX,y:centerY} = map.center;

    if (!map.ready) {
      const loading = ctx.createLinearGradient(0, 0, 0, this.height);
      loading.addColorStop(0, '#101d31');
      loading.addColorStop(1, '#04070d');
      ctx.fillStyle = loading;
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.fillStyle = '#ffd166';
      ctx.font = 'bold 13px Tahoma';
      ctx.textAlign = 'center';
      ctx.fillText(
        'Carregando Sala do Tempo original...',
        this.width / 2,
        this.height / 2
      );
      this.prepareTimeChamberMap();
      return;
    }

    const columns = map.radiusX * 2 + 1;
    const rows = map.radiusY * 2 + 1;
    // Mesma faixa de tamanho de tile do mapa do Templo (24–40 px): o
    // personagem aparece na Sala do Tempo na mesma escala em que aparece no
    // PZ, em vez de encolher só aqui.
    const tileSize = Math.max(
      18,
      Math.min(
        40,
        this.width / columns,
        this.height / rows
      )
    );

    const mapWidth = columns * tileSize;
    const mapHeight = rows * tileSize;
    const offsetX = (this.width - mapWidth) / 2;
    const offsetY = (this.height - mapHeight) / 2;

    // As mesmas métricas servem para o cenário e para o personagem — é o que
    // garante que ele pise exatamente no tile em que está.
    map.view = {tileSize, offsetX, offsetY, columns, rows};

    // A Sala do Tempo é um vazio branco — o piso carregado termina, o ambiente
    // não. Pintar o fundo de branco em vez de preto faz a sala continuar para
    // fora dos tiles em vez de virar uma moldura preta em volta do mapa.
    const emptiness = ctx.createRadialGradient(
      this.width / 2, this.height * 0.42, Math.min(this.width, this.height) * 0.10,
      this.width / 2, this.height * 0.50, Math.max(this.width, this.height) * 0.72
    );
    emptiness.addColorStop(0, '#ffffff');
    emptiness.addColorStop(0.62, '#f3f5f8');
    emptiness.addColorStop(1, '#ccd3dd');
    ctx.fillStyle = emptiness;
    ctx.fillRect(0, 0, this.width, this.height);

    const orderedTiles = [...map.tiles].sort((a,b) =>
      a.y === b.y ? a.x - b.x : a.y - b.y
    );

    for (const tile of orderedTiles) {
      const screenX =
        offsetX +
        (tile.x - (centerX - map.radiusX)) * tileSize;
      const screenY =
        offsetY +
        (tile.y - (centerY - map.radiusY)) * tileSize;

      if (!tile.items?.length) {
        // Buraco no piso: um tom quase branco em vez do quadrado preto de
        // antes, que recortava a sala com furos escuros.
        ctx.fillStyle = '#f1f3f6';
        ctx.fillRect(screenX, screenY, tileSize, tileSize);
        continue;
      }

      for (const rawItem of tile.items) {
        const serverId = Number(rawItem[0] || 0);
        const clientId = Number(
          assetRegistry.itemIdMap?.serverToClient?.[
            String(serverId)
          ] || 0
        );
        const resource = map.images.get(clientId);

        if (
          resource?.image?.complete &&
          resource.image.naturalWidth
        ) {
          const sourceWidth = resource.image.naturalWidth;
          const sourceHeight = resource.image.naturalHeight;
          const drawWidth = tileSize * Math.max(
            1,
            Number(resource.entry.width || 1)
          );
          const drawHeight = tileSize * Math.max(
            1,
            Number(resource.entry.height || 1)
          );

          ctx.drawImage(
            resource.image,
            screenX - (drawWidth - tileSize),
            screenY - (drawHeight - tileSize),
            drawWidth,
            drawHeight
          );
        }
      }
    }

    this.updateTimeChamberWalk(now);
    this.drawTimeChamberActor(now);

    // Vinheta fria e discreta só nas bordas: fecha o quadro sem tingir o piso,
    // que é branco de propósito.
    const vignette = ctx.createRadialGradient(
      this.width / 2, this.height / 2, Math.min(this.width, this.height) * 0.42,
      this.width / 2, this.height / 2, Math.max(this.width, this.height) * 0.74
    );
    vignette.addColorStop(0, 'rgba(88,110,142,0)');
    vignette.addColorStop(1, 'rgba(74,94,124,.32)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, this.width, this.height);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(rect.width * ratio));
    this.canvas.height = Math.max(1, Math.round(rect.height * ratio));
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.width = rect.width;
    this.height = rect.height;
    this.layout();
  }

  layout() {
    this.cx = this.width / 2;
    this.groundTop = Math.min(this.height * 0.44, Math.max(56, this.height * 0.32));
    this.groundBottom = this.height - Math.min(44, this.height * 0.10);
    this.groundH = Math.max(40, this.groundBottom - this.groundTop);
    this.halfW = Math.max(40, (this.width - Math.min(60, this.width * 0.08)) / 2);
  }

  depthScale(t) {
    const clamped = Math.max(0, Math.min(1, t));
    return FAR_SCALE / (1 - clamped * (1 - FAR_SCALE));
  }

  // Same hyperbolic projection the Hunt arena uses, so both screens read as
  // the same world seen from the same camera height.
  screen(x, y) {
    if (!this.groundH) this.layout();
    const t = Math.max(0, Math.min(1, Number(y || 0) / 100));
    const scale = this.depthScale(t);
    const rowRatio = (scale - FAR_SCALE) / (1 - FAR_SCALE);
    return {
      x:this.cx + ((Number(x || 0) - 50) / 50) * this.halfW * scale,
      y:this.groundTop + rowRatio * this.groundH,
      scale
    };
  }

  depthSpriteScale(y) {
    const t = Math.max(0, Math.min(1, Number(y || 0) / 100));
    const scale = this.depthScale(t);
    const normalized = scale * (2 / (1 + FAR_SCALE));
    return 1 + (normalized - 1) * ACTOR_DEPTH_MIX;
  }

  groundShadow(x, y, radius, depth, alpha = 0.5) {
    const ctx = this.ctx;
    const rx = Math.max(5, radius * depth);
    const ry = rx * 0.34;
    ctx.save();
    ctx.translate(x + rx * 0.22, y + ry * 0.12);
    ctx.scale(1, ry / rx);
    const gradient = ctx.createRadialGradient(0, 0, rx * 0.15, 0, 0, rx);
    gradient.addColorStop(0, `rgba(2,4,8,${alpha})`);
    gradient.addColorStop(0.55, `rgba(2,4,8,${alpha * 0.5})`);
    gradient.addColorStop(1, 'rgba(2,4,8,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  drawRoom(room, now = Date.now()) {
    const ctx = this.ctx;
    if (room.id === 'time-chamber') {
      this.drawOriginalTimeChamber(now);
      return;
    }

    const palette = ROOM_THEMES[room.id] || ROOM_THEMES.default;
    this.palette = palette;

    // Backdrop above the horizon.
    const sky = ctx.createLinearGradient(0, 0, 0, this.groundTop + 10);
    sky.addColorStop(0, palette.skyTop);
    sky.addColorStop(1, palette.skyBottom);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, this.width, this.groundTop + 10);

    // Ground plane: a flat colour ramp plus a perspective grid, which is all
    // an abstract training room needs to read as a receding floor.
    const floor = ctx.createLinearGradient(0, this.groundTop, 0, this.groundBottom);
    floor.addColorStop(0, palette.floorFar);
    floor.addColorStop(1, palette.floorNear);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(this.cx - this.halfW * FAR_SCALE, this.groundTop);
    ctx.lineTo(this.cx + this.halfW * FAR_SCALE, this.groundTop);
    ctx.lineTo(this.cx + this.halfW, this.groundBottom);
    ctx.lineTo(this.cx - this.halfW, this.groundBottom);
    ctx.closePath();
    ctx.fillStyle = floor;
    ctx.fill();
    ctx.clip();

    ctx.strokeStyle = palette.grid;
    ctx.lineWidth = 1;
    // Depth lines: spaced by the same 1/z curve as the actors.
    for (let i = 0; i <= 10; i += 1) {
      const t = i / 10;
      const scale = this.depthScale(t);
      const ratio = (scale - FAR_SCALE) / (1 - FAR_SCALE);
      const y = this.groundTop + ratio * this.groundH;
      const halfRow = this.halfW * scale;
      ctx.globalAlpha = 0.35 + t * 0.5;
      ctx.beginPath();
      ctx.moveTo(this.cx - halfRow, y);
      ctx.lineTo(this.cx + halfRow, y);
      ctx.stroke();
    }
    // Converging lines towards the vanishing point.
    ctx.globalAlpha = 0.5;
    for (let i = -6; i <= 6; i += 1) {
      const arenaX = 50 + i * 9;
      const near = this.screen(arenaX, 100);
      const far = this.screen(arenaX, 0);
      ctx.beginPath();
      ctx.moveTo(far.x, far.y);
      ctx.lineTo(near.x, near.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // Horizon haze so the plane fades out instead of ending on a hard line.
    const fog = ctx.createLinearGradient(0, this.groundTop - this.height * 0.12, 0, this.groundTop + this.height * 0.10);
    fog.addColorStop(0, `${palette.fog}00`);
    fog.addColorStop(0.6, `${palette.fog}66`);
    fog.addColorStop(1, `${palette.fog}00`);
    ctx.fillStyle = fog;
    ctx.fillRect(0, this.groundTop - this.height * 0.14, this.width, this.height * 0.26);

    // Fill outside the trapezoid.
    const voidFill = ctx.createLinearGradient(0, this.groundTop, 0, this.height);
    voidFill.addColorStop(0, palette.fog);
    voidFill.addColorStop(0.2, palette.skyTop);
    voidFill.addColorStop(1, '#04070b');
    ctx.fillStyle = voidFill;
    ctx.beginPath();
    ctx.moveTo(0, this.groundTop);
    ctx.lineTo(this.cx - this.halfW * FAR_SCALE, this.groundTop);
    ctx.lineTo(this.cx - this.halfW, this.groundBottom);
    ctx.lineTo(this.cx - this.halfW, this.height);
    ctx.lineTo(0, this.height);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(this.width, this.groundTop);
    ctx.lineTo(this.cx + this.halfW * FAR_SCALE, this.groundTop);
    ctx.lineTo(this.cx + this.halfW, this.groundBottom);
    ctx.lineTo(this.cx + this.halfW, this.height);
    ctx.lineTo(this.width, this.height);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(0, this.groundBottom, this.width, this.height - this.groundBottom);

    // Key light + vignette.
    const key = ctx.createRadialGradient(
      this.cx, this.groundTop + this.groundH * 0.25, Math.min(this.width, this.height) * 0.04,
      this.cx, this.groundTop + this.groundH * 0.5, Math.max(this.width, this.height) * 0.6
    );
    key.addColorStop(0, `${palette.key}${Math.round(palette.keyAlpha * 255).toString(16).padStart(2,'0')}`);
    key.addColorStop(1, '#00000000');
    ctx.fillStyle = key;
    ctx.fillRect(0, 0, this.width, this.height);

    const vignette = ctx.createRadialGradient(
      this.cx, this.height * 0.52, Math.min(this.width, this.height) * 0.2,
      this.cx, this.height * 0.52, Math.max(this.width, this.height) * 0.76
    );
    vignette.addColorStop(0, '#00000000');
    vignette.addColorStop(1, '#000000a0');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, this.width, this.height);
  }

  /**
   * Desenha o jogador da sala de treino com a spritesheet direcional do
   * outfit, iluminada e com aura de ki. Antes daqui a sala usava o retrato
   * do personagem: uma figura chapada, sempre de frente e sem animação.
   * Devolve false quando o outfit ainda não está disponível.
   */
  drawPlayerSprite(ctx, depth, m) {
    const resolved = this.outfitId
      ? resolveOutfit(this.outfitId, outfitManifest || {}, src => outfitImage(src))
      : null;
    const outfit = resolved?.outfit || this.outfit;
    const image = resolved?.image || (this.outfit?.src ? outfitImage(this.outfit.src) : null);
    if (!outfit || !image?.complete || !image.naturalWidth) return false;

    const fw = Number(outfit.frameWidth || 32);
    const fh = Number(outfit.frameHeight || 64);
    const state = this.getState?.() || {};
    // O personagem encara o saco de pancadas em vez de olhar sempre para a
    // câmera. 0=norte, 1=leste, 2=sul, 3=oeste, como na spritesheet.
    const dx = Number(state.targetX ?? 50) - Number(state.playerX ?? 50);
    const gameDirection = Math.abs(dx) < 4 ? 2 : (dx > 0 ? 1 : 3);
    const row = outfit.directionRows?.[gameDirection] ?? gameDirection;
    const frames = outfit.walkFrames?.length ? outfit.walkFrames : [outfit.idleFrame ?? 0];
    const motion = this.motion.get('player', Date.now());
    const frame = m.moving
      ? frames[Math.floor(motion.walkPhase / Math.PI) % frames.length]
      : (outfit.idleFrame ?? 0);

    const sx = frame * fw, sy = row * fh;
    if (sx + fw > image.naturalWidth || sy + fh > image.naturalHeight) return false;

    // Altura alvo do personagem na sala. O retrato antigo tinha 64 px e
    // ficava pequeno demais no chão em perspectiva.
    const scale = (98 / fh) * depth;
    const w = fw * scale, h = fh * scale;
    const tier = Math.max(0, Math.min(1, Number(this.getFormTier() || 0)));
    const intensity = tier <= 0.001 ? 0 : Math.min(0.8, 0.28 + tier * 0.5);
    const color = intensity > 0 ? auraColorFor(image, sx, sy, fw, fh) : null;

    if (intensity > 0) {
      // A aura mede o CORPO, não a moldura: a parte transparente acima da
      // cabeça faria as chamas subirem muito além do personagem.
      const bodyH = frameArtHeight(image, sx, sy, fw, fh) * scale;
      drawKiAura(ctx, { width:w, height:bodyH, depth:1 },
        { color, intensity, time:Date.now(), seed:11 });
    }

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.translate(m.offsetX * scale, m.offsetY * scale);
    if (m.rotation) ctx.rotate(m.rotation);
    if (m.scaleX !== 1 || m.scaleY !== 1) ctx.scale(m.scaleX, m.scaleY);

    const forged = forgeFrame(image, sx, sy, fw, fh, 'earth');
    if (forged) {
      const pad = forged.pad;
      ctx.drawImage(
        forged.canvas,
        -(fw + pad * 2) * scale / 2, -(fh + pad * 2) * scale + pad * scale,
        (fw + pad * 2) * scale, (fh + pad * 2) * scale
      );
    } else {
      ctx.drawImage(image, sx, sy, fw, fh, -w / 2, -h, w, h);
    }

    const flash = Math.max(m.flash, m.glow * 0.55);
    if (flash > 0.01) {
      const white = forgeSilhouette(image, sx, sy, fw, fh, '#ffffff');
      if (white) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = Math.min(1, flash) * 0.85;
        ctx.drawImage(white, -w / 2, -h, w, h);
        ctx.restore();
      }
    }
    ctx.restore();

    if (intensity > 0 && color) {
      const shape = forgeSilhouette(image, sx, sy, fw, fh, color);
      if (shape) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = Math.min(1, intensity * 0.55) * 0.085;
        const spread = (1.6 + Math.min(1, intensity * 0.55) * 3.2) * scale;
        for (let i = 0; i < 8; i += 1) {
          const a = (i / 8) * Math.PI * 2;
          ctx.drawImage(shape, -w / 2 + Math.cos(a) * spread, -h + Math.sin(a) * spread, w, h);
        }
        ctx.restore();
      }
    }
    return true;
  }

  /**
   * Liga o estado do treino às animações. Nada de regra de jogo aqui: só
   * observa posição e HP, do mesmo jeito que o renderer da Hunt faz.
   *   - jogador se move -> caminhada, balanço, poeira
   *   - HP do saco cai   -> recuo e flash no saco + investida do jogador
   */
  drawTrainingDust(uid, depth) {
    const motion = this.motion.peek(uid);
    const dust = motion?.sampleDust?.(Date.now());
    if (!dust?.length) return;
    const ctx = this.ctx;
    const palette = this.palette || ROOM_THEMES.default;
    ctx.save();
    ctx.fillStyle = palette.fog || palette.key || '#c9d8e8';
    for (const particle of dust) {
      ctx.globalAlpha = particle.alpha * 0.6;
      ctx.beginPath();
      ctx.ellipse(
        particle.x * depth, particle.y * depth * 0.5,
        particle.size * depth, particle.size * depth * 0.55,
        0, 0, Math.PI * 2
      );
      ctx.fill();
    }
    ctx.restore();
  }

  observeTraining(now, state) {
    const player = this.motion.get('player', now);
    player.observe(now, Number(state.playerX || 50), Number(state.playerY || 50), NaN, 0);

    const bag = this.motion.get('bag', now);
    bag.observe(
      now,
      Number(state.targetX || 50),
      Number(state.targetY || 50),
      Number(state.targetHp),
      Number(state.targetMaxHp || 0)
    );

    const hp = Number(state.targetHp);
    if (Number.isFinite(hp)) {
      if (this.lastTargetHp != null && hp < this.lastTargetHp - 0.001) {
        player.strike(
          now,
          Number(state.targetX || 50) - Number(state.playerX || 50),
          Number(state.targetY || 50) - Number(state.playerY || 50),
          false
        );
      }
      this.lastTargetHp = hp;
    }
    this.motion.prune(now);
  }

  drawActor(position, label, kind = 'player', arenaY = 50) {
    const ctx = this.ctx;
    const depth = this.depthSpriteScale(arenaY);
    const radius = (kind === 'target' ? 27 : 22) * depth;
    ctx.save();
    ctx.translate(position.x, position.y);

    this.groundShadow(0, 0, radius * 0.92, 1, kind === 'target' ? 0.5 : 0.55);
    this.drawTrainingDust(kind === 'target' ? 'bag' : 'player', depth);

    const palette = this.palette || ROOM_THEMES.default;
    // Contact ring, matching the Hunt arena's actor markers.
    ctx.save();
    ctx.scale(1, 0.34);
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = kind === 'target'
      ? 'rgba(255,150,120,.45)'
      : `${palette.accent}88`;
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.85, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Luz refletida no chão sob o ator. Vem antes do sprite de propósito:
    // desenhada depois, encostaria nos pixels do personagem.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.16;
    ctx.scale(1, 0.3);
    const bounce = ctx.createRadialGradient(0, 0, 0, 0, 0, radius * 1.5);
    bounce.addColorStop(0, palette.key);
    bounce.addColorStop(1, '#00000000');
    ctx.fillStyle = bounce;
    ctx.beginPath();
    ctx.arc(0, 0, radius * 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const uid = kind === 'target' ? 'bag' : 'player';
    const motion = this.motion.get(uid, Date.now());
    const m = motion.sample(Date.now());
    const applyMotion = () => {
      ctx.translate(m.offsetX * depth, m.offsetY * depth);
      if (m.rotation) ctx.rotate(m.rotation);
      if (m.scaleX !== 1 || m.scaleY !== 1) ctx.scale(m.scaleX, m.scaleY);
    };

    if (
      kind === 'target' &&
      this.punchingBagImage?.complete &&
      this.punchingBagImage.naturalWidth
    ) {
      // O saco de pancadas é uma imagem só, não uma spritesheet — mas passa
      // pela mesma forja, então ganha volume e recua quando leva golpe.
      const bagW = 68 * depth, bagH = 78 * depth;
      ctx.save();
      applyMotion();
      const forgedBag = forgeFrame(
        this.punchingBagImage, 0, 0,
        this.punchingBagImage.naturalWidth, this.punchingBagImage.naturalHeight,
        'earth'
      );
      if (forgedBag) {
        const pad = forgedBag.pad;
        const px = bagW / this.punchingBagImage.naturalWidth;
        const py = bagH / this.punchingBagImage.naturalHeight;
        ctx.drawImage(
          forgedBag.canvas,
          -bagW / 2 - pad * px, -bagH - pad * py,
          bagW + pad * 2 * px, bagH + pad * 2 * py
        );
      } else {
        ctx.drawImage(this.punchingBagImage, -bagW / 2, -bagH, bagW, bagH);
      }
      if (m.flash > 0.01) {
        const white = forgeSilhouette(
          this.punchingBagImage, 0, 0,
          this.punchingBagImage.naturalWidth, this.punchingBagImage.naturalHeight, '#ffffff'
        );
        if (white) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = Math.min(1, m.flash) * 0.85;
          ctx.drawImage(white, -bagW / 2, -bagH, bagW, bagH);
          ctx.restore();
        }
      }
      ctx.restore();
    } else if (kind === 'target') {
      ctx.fillStyle = '#80654c';
      ctx.fillRect(-18 * depth, -54 * depth, 36 * depth, 54 * depth);
      ctx.fillStyle = '#a88b68';
      ctx.beginPath();
      ctx.arc(0, -57 * depth, 18 * depth, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#5b3824';
      ctx.lineWidth = 4 * depth;
      ctx.stroke();
    } else if (this.drawPlayerSprite(ctx, depth, m)) {
      // desenhado com a spritesheet do outfit
    } else if (this.playerImage?.complete && this.playerImage.naturalWidth) {
      // Enquanto o manifesto de outfits não chega, o retrato segura a cena.
      ctx.drawImage(this.playerImage, -28 * depth, -64 * depth, 56 * depth, 64 * depth);
    } else {
      ctx.fillStyle = '#e5a44e';
      ctx.beginPath();
      ctx.arc(0, -30 * depth, 18 * depth, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.font = `bold ${Math.max(10, 11 * depth)}px Tahoma`;
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(3,6,11,.9)';
    ctx.lineWidth = 3.5;
    ctx.strokeText(label, 0, -74 * depth);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, 0, -74 * depth);
    ctx.restore();
  }

  drawEffects(effects) {
    const ctx = this.ctx;
    const now = Date.now();

    for (const effect of effects || []) {
      const progress = Math.min(
        1,
        Math.max(0, (now - effect.createdAt) / effect.duration)
      );
      const position = this.screen(effect.x, effect.y);
      const depth = this.depthSpriteScale(effect.y);
      const alpha = 1 - progress;

      if (effect.kind === 'damage') {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.font = 'bold 18px Tahoma';
        ctx.textAlign = 'center';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 4;
        ctx.fillStyle = '#fff';
        ctx.strokeText(
          String(effect.value || 0),
          position.x,
          position.y - 55 - progress * 28
        );
        ctx.fillText(
          String(effect.value || 0),
          position.x,
          position.y - 55 - progress * 28
        );
        ctx.restore();
        continue;
      }

      // Impact ring, drawn flat on the ground plane and additively blended
      // so it reads as light rather than a painted circle.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = alpha;
      ctx.translate(position.x, position.y);
      ctx.scale(1, 0.34);
      ctx.strokeStyle =
        effect.kind.includes('ki') ? '#77dcff' : '#e9c187';
      ctx.lineWidth = (3 + progress * 4) * depth;
      ctx.beginPath();
      ctx.arc(0, 0, (8 + progress * 26) * depth, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = alpha * 0.55;
      const burst = ctx.createRadialGradient(
        position.x, position.y - 26 * depth, 0,
        position.x, position.y - 26 * depth, (14 + progress * 26) * depth
      );
      burst.addColorStop(0, effect.kind.includes('ki') ? '#bdeeff' : '#ffe0b0');
      burst.addColorStop(1, '#00000000');
      ctx.fillStyle = burst;
      ctx.beginPath();
      ctx.arc(position.x, position.y - 26 * depth, (14 + progress * 26) * depth, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      if (effect.value) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.font = 'bold 16px Tahoma';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 4;
        ctx.strokeText(
          String(effect.value),
          position.x,
          position.y - 58 - progress * 20
        );
        ctx.fillText(
          String(effect.value),
          position.x,
          position.y - 58 - progress * 20
        );
        ctx.restore();
      }
    }
  }

  draw() {
    if (!this.running) return;
    const now = Date.now();
    const state = this.getState();
    const room = this.getRoom();
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.drawRoom(room, now);

    // A Sala do Tempo roda no mapa original, em tiles. O personagem dela já foi
    // desenhado ali dentro — a projeção em perspectiva abaixo é das outras
    // salas, e aplicá-la aqui era o que fazia o sprite flutuar sobre o chão.
    if (room.id === 'time-chamber') {
      this.frame = requestAnimationFrame(() => this.draw());
      return;
    }

    this.observeTraining(now, state);

    const player = this.screen(state.playerX, state.playerY);

    const targetVisible = room.id !== 'time-chamber' && state.targetAlive;
    const target = targetVisible ? this.screen(state.targetX, state.targetY) : null;

    // Painter's order: whoever is further from the camera is drawn first.
    const cast = [
      {pos:player, label:'Você', kind:'player', y:Number(state.playerY || 50)}
    ];
    if (targetVisible) {
      cast.push({
        pos:target,
        label:room.id === 'ki-barrier' ? 'Energy Punching Bag' : 'Punching Bag',
        kind:'target',
        y:Number(state.targetY || 50)
      });
    }
    cast.sort((a, b) => a.y - b.y);
    for (const actor of cast) {
      this.drawActor(actor.pos, actor.label, actor.kind, actor.y);
    }

    if (targetVisible) {
      const depth = this.depthSpriteScale(Number(state.targetY || 50));
      const hpWidth = 110 * depth;
      const hpHeight = 10 * depth;
      const hpY = target.y - 94 * depth;
      const ratio = Math.max(
        0,
        Math.min(1, state.targetHp / state.targetMaxHp)
      );
      const ctx = this.ctx;
      ctx.save();
      roundedRectPath(ctx, target.x - hpWidth / 2, hpY, hpWidth, hpHeight, hpHeight / 2);
      ctx.fillStyle = 'rgba(4,7,12,.92)';
      ctx.fill();
      ctx.save();
      roundedRectPath(ctx, target.x - hpWidth / 2, hpY, hpWidth, hpHeight, hpHeight / 2);
      ctx.clip();
      const fill = ctx.createLinearGradient(0, hpY, 0, hpY + hpHeight);
      fill.addColorStop(0, '#ff8a7c');
      fill.addColorStop(0.5, '#c9302c');
      fill.addColorStop(1, '#7c1414');
      ctx.fillStyle = fill;
      ctx.fillRect(target.x - hpWidth / 2, hpY, hpWidth * ratio, hpHeight);
      const gloss = ctx.createLinearGradient(0, hpY, 0, hpY + hpHeight * 0.55);
      gloss.addColorStop(0, 'rgba(255,255,255,.32)');
      gloss.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gloss;
      ctx.fillRect(target.x - hpWidth / 2, hpY, hpWidth * ratio, hpHeight * 0.55);
      ctx.restore();
      ctx.strokeStyle = 'rgba(150,180,210,.3)';
      ctx.lineWidth = 1;
      roundedRectPath(ctx, target.x - hpWidth / 2 + .5, hpY + .5, hpWidth - 1, hpHeight - 1, hpHeight / 2);
      ctx.stroke();
      ctx.restore();
    }

    this.drawEffects(state.effects);
    this.frame = requestAnimationFrame(time => this.draw(time));
  }

  destroy() {
    this.running = false;
    cancelAnimationFrame(this.frame);
    window.removeEventListener('resize', this.resizeHandler);
  }
}
