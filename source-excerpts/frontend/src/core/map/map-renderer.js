// V22.1 — profundidade no PZ/Templo.
//
// O mapa do mundo NÃO recebe deformação de perspectiva: a arte Tibia já vem
// com perspectiva embutida no próprio desenho, e torcer o chão brigaria com
// ela. Aqui a profundidade vem de luz, sombra projetada e câmera — e nada
// disso toca em movimentação, pathfinding ou hitbox.
//
// Regra de arte (a mesma da arena de Hunt): o tint de ambiente, a poça de luz
// e o escurecimento de borda são desenhados ANTES dos atores. Os sprites de
// player, NPC e outros jogadores chegam à tela com a cor original.

// Clima por área, no espírito de "cada lugar tem a sua luz".
//
// O andar (z) NÃO serve de heurística aqui: neste mapa o PZ fica em z=10,
// Premia em z=14 e Ruudo em z=13, então tratar z>7 como subterrâneo pintaria
// o PZ de caverna. As áreas abaixo saem de generated/world-map/landmarks.json,
// que é a lista de lugares do próprio servidor.
// V22.4.4 — os atores do PZ passaram a usar a mesma camada HD-2D da arena:
// volume por normal map, animação procedural e reserva de sprite quando a
// folha da forma vem vazia. O chão continua sem deformação, pelo motivo
// explicado acima.
import { forgeFrame } from '../render/sprite-forge.js?v=22.4.4';
import { MotionDirector } from '../render/actor-motion.js?v=22.4.4';
import { resolveOutfit } from '../render/outfit-fallback.js?v=22.4.4';

const MAP_AMBIENTS = {
  // PZ: santuário. Luz quente e protetora, sem escurecer o cenário.
  sanctuary: {
    tint:'#1b1408', tintAlpha:0.13,
    light:'#ffd9a0', lightAlpha:0.20, lightRadius:8.0,
    vignette:0.30, motes:'#ffe3b5', moteAlpha:0.22
  },
  // PZ/Templo: o prédio da Capsule Corp, com piso azul, jardim e nave. É um
  // lugar claro e moderno, não um templo à luz de tocha — daí a luz fria e a
  // vinheta fraca. Trocar 'capsule' por 'sanctuary' em MAP_AREAS devolve a
  // versão quente; por 'plain', só sombra e vinheta, sem tingir nada.
  capsule: {
    tint:'#16263a', tintAlpha:0.08,
    light:'#e8f4ff', lightAlpha:0.13, lightRadius:9.5,
    vignette:0.22, motes:'#dff0ff', moteAlpha:0.16
  },
  // Só sombra e vinheta, sem tingir a arte.
  plain: {
    tint:'#000000', tintAlpha:0.0,
    light:'#ffffff', lightAlpha:0.06, lightRadius:10,
    vignette:0.16, motes:'#ffffff', moteAlpha:0.10
  },
  town: {
    tint:'#141d2b', tintAlpha:0.15,
    light:'#ffe6bd', lightAlpha:0.15, lightRadius:8.5,
    vignette:0.32, motes:'#e4eeff', moteAlpha:0.18
  },
  frozen: {
    tint:'#16304a', tintAlpha:0.20,
    light:'#dff0ff', lightAlpha:0.16, lightRadius:8.0,
    vignette:0.34, motes:'#ffffff', moteAlpha:0.30
  },
  desert: {
    tint:'#2b1a0a', tintAlpha:0.17,
    light:'#ffd08a', lightAlpha:0.19, lightRadius:9.0,
    vignette:0.30, motes:'#ffdda6', moteAlpha:0.22
  },
  // Sala do Tempo é um vazio branco de propósito: escurecer ali é errado.
  timechamber: {
    tint:'#e9f2ff', tintAlpha:0.05,
    light:'#ffffff', lightAlpha:0.10, lightRadius:10,
    vignette:0.12, motes:'#ffffff', moteAlpha:0.20
  },
  neutral: {
    tint:'#101d2e', tintAlpha:0.14,
    light:'#ffeccd', lightAlpha:0.13, lightRadius:8.5,
    vignette:0.30, motes:'#dbe9ff', moteAlpha:0.16
  }
};

// Coordenadas do PZ/Templo atual conferidas contra os NPCs que o próprio
// app.js posiciona: Bulma em (95,177,z7), os sete Depot Stash em y=172 de
// x=89 a x=101, e webRegionCenter em (99,189,z7). As demais vieram de
// generated/world-map/landmarks.json.
//
// Atenção: "PZ Earth Original" (106,149,z10) é o PZ ANTIGO, que continua no
// landmarks.json como destino de travel. O PZ em uso é o de z=7 logo abaixo.
// Para dar tom próprio a um lugar novo, é só acrescentar uma linha aqui.
const MAP_AREAS = [
  { name:'PZ / Templo',       x:95,   y:180,  z:7,  radius:48, ambient:'capsule' },
  { name:'PZ Earth (antigo)', x:106,  y:149,  z:10, radius:70, ambient:'sanctuary' },
  { name:'Sala do Tempo',     x:524,  y:247,  z:7,  radius:36, ambient:'timechamber' },
  { name:'Small City',        x:655,  y:399,  z:7,  radius:55, ambient:'town' },
  { name:'Frozen City',       x:446,  y:655,  z:7,  radius:55, ambient:'frozen' },
  { name:'Nave Amarela',      x:335,  y:937,  z:7,  radius:55, ambient:'desert' },
  { name:'Premia',            x:105,  y:80,   z:14, radius:55, ambient:'town' },
  { name:'GM Island',         x:357,  y:37,   z:7,  radius:55, ambient:'town' },
  { name:'Castle War',        x:642,  y:719,  z:7,  radius:55, ambient:'town' },
  { name:'Ruudo',             x:528,  y:746,  z:13, radius:55, ambient:'town' },
  { name:'City 17',           x:772,  y:1149, z:7,  radius:55, ambient:'town' },
  { name:'Gardia',            x:56,   y:1257, z:7,  radius:55, ambient:'town' },
  { name:'Vocation Land',     x:289,  y:1425, z:8,  radius:55, ambient:'town' }
];

function ambientFor(x, y, z) {
  const level = Number(z);
  let best = null;
  let bestDistance = Infinity;
  for (const area of MAP_AREAS) {
    if (area.z !== level) continue;
    const distance = Math.hypot(x - area.x, y - area.y);
    if (distance > area.radius || distance >= bestDistance) continue;
    bestDistance = distance;
    best = area;
  }
  return MAP_AMBIENTS[best?.ambient] || MAP_AMBIENTS.neutral;
}

const sharedOutfitImages = new Map();
const sharedWorldItemImages = new Map();
const sharedGroundImages = new Map();
const sharedRegionImages = new Map();
let sharedOutfitManifest = null;
let sharedOutfitManifestPromise = null;

function loadSharedOutfitManifest(){
  if(sharedOutfitManifest)return Promise.resolve(sharedOutfitManifest);
  if(!sharedOutfitManifestPromise){
    sharedOutfitManifestPromise=fetch('./assets/generated/outfit-manifest.json?v=22.4.4',{cache:'force-cache'})
      .then(response=>response.json())
      .then(manifest=>(sharedOutfitManifest=manifest))
      .catch(error=>{sharedOutfitManifestPromise=null;throw error;});
  }
  return sharedOutfitManifestPromise;
}

function sharedImage(cache,src){
  if(!src)return null;
  if(!cache.has(src)){
    const image=new Image();
    image.decoding='async';
    image.src=src;
    cache.set(src,image);
  }
  return cache.get(src);
}

export class MapRenderer {
  constructor(canvas, map, {
    onMoveRequest,
    onGroundClick,
    onNpcClick,
    onPlayerClick,
    regionImage = null,
    regionCenter = null,
    worldLoader = null,
    itemRegistry = null,
    npcs = []
  }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.map = map;
    this.onMoveRequest = onMoveRequest;
    this.onGroundClick = onGroundClick;
    this.onNpcClick = onNpcClick;
    this.onPlayerClick = onPlayerClick;
    this.npcs = npcs;
    this.npcHitboxes = [];
    this.playerHitboxes = [];
    this.groundItems = [];
    this.groundImages = sharedGroundImages;
    this.groundHitboxes = [];
    // Nunca desenhe uma forma base temporaria antes de o app informar o
    // outfit real; isso eliminava o flash de Goku em re-montagens do canvas.
    this.player = { ...map.center, direction: 2, moving: false, outfitId: null };
    this.others = [];
    this.keys = new Set();
    this.lastMove = 0;
    this.lastStepAt = 0;
    this.clickTarget = null;
    this.clickPath = [];
    this.clickMovePending = false;
    this.image = null;
    this.regionImage = regionImage;
    this.worldLoader = worldLoader;
    this.itemRegistry = itemRegistry;
    this.worldItemImages = sharedWorldItemImages;
    this.worldLoadKey = null;
    this.earthLogoServerIds=new Set([
      5569,5570,5571,5572,5573,5574,5575,5576,5577,5583
    ]);
    this.outfits = {};
    this.outfitImages = sharedOutfitImages;
    // Animação procedural dos atores (respiração, balanço, poeira do passo).
    this.motion = new MotionDirector();
    this.regionCenter = regionCenter || { x: 106, y: 149, z: 10 };
    // Câmera com atraso: em vez de saltar de tile em tile junto com o
    // personagem, ela persegue a posição dele. É o que faz o movimento
    // parecer câmera de verdade em vez de troca de quadro.
    this.camera = { x: Number(this.player.x) || 0, y: Number(this.player.y) || 0 };
    this.lastFrameAt = 0;
    this.motes = [];
    this.regionTiles = { width: 25, height: 19, tileSize: 32 };

    this.resize = () => this.fit();
    window.addEventListener('resize', this.resize);
    this.down = event => {
      if (!['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
        const key=event.key.toLowerCase();
        if(['a','d','w','s','arrowleft','arrowright','arrowup','arrowdown'].includes(key)){
          this.clickTarget=null;this.clickPath=[];
        }
        this.keys.add(key);
      }
    };
    this.up = event => this.keys.delete(event.key.toLowerCase());
    window.addEventListener('keydown', this.down);
    window.addEventListener('keyup', this.up);
    this.click = event => this.handleClick(event);
    canvas.addEventListener('click', this.click);
    this.move = event => this.handleHover(event);
    canvas.addEventListener('mousemove', this.move);

    if (regionImage) {
      const image=sharedImage(sharedRegionImages,regionImage);
      if(image?.complete&&image.naturalWidth)this.image=image;
      else if(image)image.addEventListener('load',()=>{this.image=image;},{once:true});
    }

    if(sharedOutfitManifest)this.outfits=sharedOutfitManifest;
    loadSharedOutfitManifest()
      .then(manifest=>{this.outfits=manifest;})
      .catch(()=>{});

    this.fit();
    this.frame = requestAnimationFrame(time => this.loop(time));
  }

  fit() {
    const rect = this.canvas.getBoundingClientRect();
    const density = devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(rect.width * density));
    this.canvas.height = Math.max(1, Math.floor(rect.height * density));
    this.ctx.setTransform(density, 0, 0, density, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
    this.w = rect.width;
    this.h = rect.height;
  }

  setPlayer(player) {
    this.player = { ...this.player, ...player };
    if (
      this.clickTarget &&
      Number(this.player.x) === Number(this.clickTarget.x) &&
      Number(this.player.y) === Number(this.clickTarget.y) &&
      Number(this.player.z) === Number(this.clickTarget.z)
    ) {this.clickTarget = null;this.clickPath=[];}
  }

  setOthers(players) {
    this.others = players || [];
  }

  setGroundItems(items) {
    this.groundItems = items || [];
    for (const item of this.groundItems) {
      const src = String(item.icon||'').startsWith('./') || String(item.icon||'').startsWith('/')
        ? String(item.icon)
        : item.serverId ? `./generated/web/items/${item.serverId}.png` : null;
      if (src && !this.groundImages.has(src)) {
        this.groundImages.set(src, sharedImage(sharedGroundImages,src));
      }
    }
  }

  directionFor(dx, dy) {
    if (dy < 0) return 0;
    if (dx > 0) return 1;
    if (dy > 0) return 2;
    if (dx < 0) return 3;
    return this.player.direction ?? 2;
  }

  // Centro efetivo da tela. Desenho e conversão clique -> tile usam este mesmo
  // valor, então clicar num ponto sempre anda para o tile que está ali,
  // inclusive enquanto a câmera ainda está alcançando o personagem.
  cameraCenter() {
    return this.worldLoader?.index
      ? { x: this.camera.x, y: this.camera.y, z: this.player.z }
      : this.regionCenter;
  }

  updateCamera(time) {
    const previous = this.lastFrameAt || time;
    const delta = Math.max(0, Math.min(120, time - previous));
    this.lastFrameAt = time;
    const targetX = Number(this.player.x) || 0;
    const targetY = Number(this.player.y) || 0;
    // Teleporte (mudança de andar, entrar numa hunt, nascer no templo) não
    // deve virar uma panorâmica pela cidade inteira.
    if (Math.hypot(targetX - this.camera.x, targetY - this.camera.y) > 6) {
      this.camera.x = targetX;
      this.camera.y = targetY;
      return;
    }
    const k = 1 - Math.pow(0.0022, delta / 1000);
    this.camera.x += (targetX - this.camera.x) * k;
    this.camera.y += (targetY - this.camera.y) * k;
    if (Math.abs(targetX - this.camera.x) < 0.002) this.camera.x = targetX;
    if (Math.abs(targetY - this.camera.y) < 0.002) this.camera.y = targetY;
  }

  // Sombra projetada de verdade: elipse achatada com gradiente, deslocada na
  // direção da luz. Substitui a elipse de cor chapada que havia antes.
  castShadow(radius, alpha = 0.5) {
    const ctx = this.ctx;
    const rx = Math.max(5, radius);
    const ry = rx * 0.36;
    ctx.save();
    ctx.translate(rx * 0.16, -1);
    ctx.scale(1, ry / rx);
    const gradient = ctx.createRadialGradient(0, 0, rx * 0.12, 0, 0, rx);
    gradient.addColorStop(0, `rgba(2,5,9,${alpha})`);
    gradient.addColorStop(0.55, `rgba(2,5,9,${alpha * 0.5})`);
    gradient.addColorStop(1, 'rgba(2,5,9,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Anel de identidade no chão (você / NPC / outro jogador), no lugar do
  // borrão colorido que antes fazia as vezes de sombra.
  groundRing(radius, color, pulse = 0) {
    const ctx = this.ctx;
    const rx = Math.max(6, radius) * (1 + pulse * 0.07);
    ctx.save();
    ctx.scale(1, 0.36);
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // Tint de ambiente + poça de luz em volta do personagem + escurecimento de
  // borda. Tudo antes dos atores, para não tingir sprite nenhum.
  paintAmbient(placement, ambient) {
    const ctx = this.ctx;
    const tile = placement.tile;
    const cx = this.w / 2;
    const cy = this.h / 2;

    ctx.save();
    ctx.globalAlpha = ambient.tintAlpha;
    ctx.fillStyle = ambient.tint;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.restore();

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const radius = Math.max(tile * 3, tile * ambient.lightRadius);
    const pool = ctx.createRadialGradient(cx, cy, tile * 0.4, cx, cy, radius);
    pool.addColorStop(0, `${ambient.light}${Math.round(ambient.lightAlpha * 255).toString(16).padStart(2,'0')}`);
    pool.addColorStop(0.55, `${ambient.light}${Math.round(ambient.lightAlpha * 90).toString(16).padStart(2,'0')}`);
    pool.addColorStop(1, '#00000000');
    ctx.fillStyle = pool;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.restore();

    const vignette = ctx.createRadialGradient(
      cx, cy, Math.min(this.w, this.h) * 0.22,
      cx, cy, Math.max(this.w, this.h) * 0.72
    );
    vignette.addColorStop(0, '#00000000');
    vignette.addColorStop(1, `rgba(0,0,0,${ambient.vignette})`);
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, this.w, this.h);
  }

  paintMotes(time, ambient) {
    if (!this.motes.length) {
      const count = Math.round(Math.max(10, Math.min(30, this.w / 44)));
      this.motes = Array.from({length:count}, (unused, index) => ({
        x: (index * 97 % 100) / 100,
        y: (index * 61 % 100) / 100,
        size: 0.6 + (index % 5) * 0.32,
        rise: 4 + (index % 7) * 2.4,
        sway: 6 + (index % 4) * 5,
        phase: index * 0.7
      }));
    }
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const mote of this.motes) {
      const y = (mote.y * this.h - (time / 1000) * mote.rise * 6) % this.h;
      const x = mote.x * this.w + Math.sin(time / 1600 + mote.phase) * mote.sway;
      ctx.globalAlpha = ambient.moteAlpha;
      ctx.fillStyle = ambient.motes;
      ctx.beginPath();
      ctx.arc(x, y < 0 ? y + this.h : y, mote.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  loop(time) {
    let dx = 0;
    let dy = 0;
    if (time - this.lastMove > 125) {
      if (this.keys.has('a') || this.keys.has('arrowleft')) dx = -1;
      else if (this.keys.has('d') || this.keys.has('arrowright')) dx = 1;
      else if (this.keys.has('w') || this.keys.has('arrowup')) dy = -1;
      else if (this.keys.has('s') || this.keys.has('arrowdown')) dy = 1;

      if (dx || dy) {
        const direction = this.directionFor(dx, dy);
        this.player.direction = direction;
        this.player.moving = true;
        this.lastStepAt = time;
        this.onMoveRequest?.(
          this.player.x + dx,
          this.player.y + dy,
          this.player.z,
          direction
        );
        this.lastMove = time;
      } else if (this.clickTarget && !this.clickMovePending) {
        this.stepTowardClickTarget(time);
      }
    }

    if (time - this.lastStepAt > 180) this.player.moving = false;
    this.updateCamera(time);
    this.draw(time);
    this.frame = requestAnimationFrame(next => this.loop(next));
  }

  async stepTowardClickTarget(time) {
    if (!this.clickTarget || this.clickMovePending) return;
    const target=this.clickTarget;
    const deltaX=Number(target.x)-Number(this.player.x);
    const deltaY=Number(target.y)-Number(this.player.y);
    if (!deltaX && !deltaY) { this.clickTarget=null; return; }

    let candidates=[];
    if(this.worldLoader?.index){
      if(!Array.isArray(this.clickPath)||!this.clickPath.length){
        this.clickPath=await this.computeWorldClickPath(target);
      }
      while(this.clickPath.length && Number(this.clickPath[0].x)===Number(this.player.x) && Number(this.clickPath[0].y)===Number(this.player.y))this.clickPath.shift();
      const next=this.clickPath[0];
      if(next)candidates=[{dx:Number(next.x)-Number(this.player.x),dy:Number(next.y)-Number(this.player.y),path:true}];
    }
    if(!candidates.length){
      const horizontal=deltaX ? {dx:Math.sign(deltaX),dy:0} : null;
      const vertical=deltaY ? {dx:0,dy:Math.sign(deltaY)} : null;
      candidates=Math.abs(deltaX)>=Math.abs(deltaY)
        ? [horizontal,vertical].filter(Boolean)
        : [vertical,horizontal].filter(Boolean);
    }

    this.clickMovePending=true;
    let moved=false;
    try {
      for (const step of candidates) {
        const direction=this.directionFor(step.dx,step.dy);
        const result=await this.onMoveRequest?.(
          Number(this.player.x)+step.dx,
          Number(this.player.y)+step.dy,
          this.player.z,
          direction
        );
        if (result !== false) {
          this.player.direction=direction;
          this.player.moving=true;
          this.lastStepAt=time;
          this.lastMove=time;
          moved=true;
          if(step.path)this.clickPath.shift();
          break;
        }
        if(step.path)this.clickPath=[];
      }
      if (!moved) {this.clickTarget=null;this.clickPath=[];}
    } finally {
      this.clickMovePending=false;
    }
  }

  cachedWorldTileWalkable(x,y,z){
    const tile=this.worldLoader?.cachedTile(Number(x),Number(y),Number(z));
    if(!tile||!Array.isArray(tile.items)||!tile.items.length)return false;
    let hasGround=false;
    for(const raw of tile.items){
      const serverId=Array.isArray(raw)?raw[0]:raw;
      const asset=this.itemRegistry?.get(Number(serverId));
      if(!asset)continue;
      if(asset.isGround)hasGround=true;
      if(asset.isBlocking)return false;
    }
    return hasGround;
  }

  async computeWorldClickPath(target){
    const sx=Number(this.player.x),sy=Number(this.player.y),z=Number(this.player.z);
    const tx=Number(target.x),ty=Number(target.y);
    try{await this.worldLoader.loadAround(sx,sy,z,1);}catch{return [];}
    const startKey=`${sx},${sy}`;
    const targetKey=`${tx},${ty}`;
    const open=[{x:sx,y:sy,g:0,h:Math.abs(tx-sx)+Math.abs(ty-sy),key:startKey}];
    const bestCost=new Map([[startKey,0]]),parent=new Map();
    let best=open[0],reached=null,visited=0;
    while(open.length&&visited<1600){
      let pick=0;
      for(let i=1;i<open.length;i++)if(open[i].g+open[i].h<open[pick].g+open[pick].h)pick=i;
      const cur=open.splice(pick,1)[0];visited++;
      if(cur.h<best.h)best=cur;
      if(cur.key===targetKey){reached=cur;break;}
      for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
        const nx=cur.x+dx,ny=cur.y+dy,key=`${nx},${ny}`;
        if(!this.cachedWorldTileWalkable(nx,ny,z))continue;
        const ng=cur.g+1;
        if(ng>=Number(bestCost.get(key)??Infinity))continue;
        bestCost.set(key,ng);parent.set(key,cur.key);
        open.push({x:nx,y:ny,g:ng,h:Math.abs(tx-nx)+Math.abs(ty-ny),key});
      }
    }
    const end=reached||best;
    if(!end||end.key===startKey||(!reached&&end.h>=Math.abs(tx-sx)+Math.abs(ty-sy)))return [];
    const reverse=[];let key=end.key;
    while(key&&key!==startKey){const [x,y]=key.split(',').map(Number);reverse.push({x,y,z});key=parent.get(key);}
    return reverse.reverse();
  }

  mapPlacement() {
    if (!this.image) return null;
    const scale = Math.min(this.w / this.image.width, this.h / this.image.height);
    const width = this.image.width * scale;
    const height = this.image.height * scale;
    return {
      x: (this.w - width) / 2,
      y: (this.h - height) / 2,
      width,
      height,
      scale,
      tile: this.regionTiles.tileSize * scale
    };
  }

  draw(time) {
    const ctx = this.ctx;
    ctx.fillStyle = '#090d12';
    ctx.fillRect(0, 0, this.w, this.h);

    if (this.worldLoader?.index) { this.drawOriginalWorld(time); return; }

    const placement = this.mapPlacement();
    if (!placement) {
      ctx.fillStyle = '#e9c36a';
      ctx.textAlign = 'center';
      ctx.font = 'bold 16px Tahoma';
      ctx.fillText('Carregando mapa Tibia 8.54...', this.w / 2, this.h / 2);
      return;
    }

    ctx.drawImage(
      this.image,
      placement.x,
      placement.y,
      placement.width,
      placement.height
    );

    this.drawGroundItems(placement);

    const actors = [
      ...this.others.map(player => ({ ...player, local: false })),
      { ...this.player, local: true }
    ].sort((a, b) => a.y - b.y);

    for (const actor of actors) this.drawActor(actor, placement, time);
  }


  originalPlacement(){const tile=Math.max(24,Math.min(40,Math.floor(Math.min(this.w/25,this.h/19))));return{x:0,y:0,width:this.w,height:this.h,scale:tile/32,tile}}
  ensureWorldLoaded(){if(!this.worldLoader?.index)return;const key=this.worldLoader.key(this.player.x,this.player.y,this.player.z);if(key===this.worldLoadKey)return;this.worldLoadKey=key;this.worldLoader.loadAround(this.player.x,this.player.y,this.player.z,1).catch(()=>{})}
  worldItemImage(serverId){
    const resolvedId = Number(serverId);
    const e=this.itemRegistry?.get(resolvedId),src=e?.preview;
    if(!src)return null;
    if(!this.worldItemImages.has(src))this.worldItemImages.set(src,sharedImage(sharedWorldItemImages,src))
    return{image:this.worldItemImages.get(src),entry:e};
  }
  outfitImage(src){if(!src)return null;if(!this.outfitImages.has(src))this.outfitImages.set(src,sharedImage(sharedOutfitImages,src));return this.outfitImages.get(src)}

  drawOriginalWorld(time){
    this.ensureWorldLoaded();
    const ctx=this.ctx;
    const p=this.originalPlacement();
    const tile=p.tile;
    // A câmera (não o tile do personagem) define o centro da tela. Desenho,
    // hitboxes e conversão clique -> tile passam todos por aqui.
    this.regionCenter={x:this.camera.x,y:this.camera.y,z:this.player.z};
    const ambient=ambientFor(Number(this.player.x),Number(this.player.y),Number(this.player.z));
    ctx.fillStyle='#05080b';
    ctx.fillRect(0,0,this.w,this.h);

    const hw=Math.ceil(this.w/tile/2)+2;
    const hh=Math.ceil(this.h/tile/2)+2;

    for(const mt of this.worldLoader.visibleTiles(
      this.player.x,
      this.player.y,
      this.player.z,
      hw,
      hh
    )){
      const sx=this.w/2+(mt.x-this.camera.x)*tile;
      const sy=this.h/2+(mt.y-this.camera.y)*tile;
      const items=mt.items||[];
      const hasGroundItem = items.some(pair => {
        const serverId=Array.isArray(pair)?pair[0]:pair;
        return this.itemRegistry?.get(Number(serverId))?.isGround;
      });
      if (!hasGroundItem) {
        ctx.fillStyle = '#05080b';
        ctx.fillRect(sx, sy, tile, tile);
      }
      for(const pair of items){
        const serverId=Array.isArray(pair)?pair[0]:pair;
        const o=this.worldItemImage(serverId);
        if(!o?.image?.complete||!o.image.naturalWidth)continue;
        const w=Math.max(tile,Number(o.entry.width||1)*tile);
        const h=Math.max(tile,Number(o.entry.height||1)*tile);
        // V22.4.4 — o que é mais alto que um tile (árvore, pilar, parede,
        // estátua) ganha uma sombra na base. É o que faz o cenário parar de
        // parecer um adesivo colado no chão. Só os altos: o piso não tem
        // sombra para projetar e desenhar em todos custaria caro.
        if (Number(o.entry.height || 1) > 1) {
          ctx.save();
          ctx.translate(sx + tile * 0.5, sy + tile * 0.86);
          ctx.scale(1, 0.3);
          const shade = ctx.createRadialGradient(0, 0, tile * 0.08, 0, 0, tile * 0.62);
          shade.addColorStop(0, 'rgba(2,5,9,.5)');
          shade.addColorStop(0.6, 'rgba(2,5,9,.24)');
          shade.addColorStop(1, 'rgba(2,5,9,0)');
          ctx.fillStyle = shade;
          ctx.beginPath();
          ctx.arc(0, 0, tile * 0.62, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
        ctx.drawImage(o.image,sx-(w-tile),sy-(h-tile),w,h);
      }
    }

    // Luz e clima entram AQUI: sobre o cenário, antes dos atores.
    this.paintAmbient(p, ambient);

    const actors=[
      ...this.others.map(x=>({...x,local:false})),
      ...this.npcs
        .filter(npc=>(npc.z??this.player.z)===this.player.z)
        .map(npc=>({...npc,npc:true})),
      {...this.player,local:true}
    ].sort((a,b)=>a.y-b.y);

    this.npcHitboxes=[];
    this.playerHitboxes=[];
    for(const actor of actors)this.drawActor(actor,p,time);
    this.drawGroundItems(p);
    this.paintMotes(time, ambient);
  }

  drawGroundItems(placement) {
    this.groundHitboxes = [];
    const tile = placement.tile;

    for (const item of this.groundItems) {
      if (item.z !== this.player.z) continue;
      const sx = placement.x + placement.width / 2
        + (item.x - this.regionCenter.x) * tile + tile / 2;
      const sy = placement.y + placement.height / 2
        + (item.y - this.regionCenter.y) * tile + tile * .82;

      const src = String(item.icon||'').startsWith('./') || String(item.icon||'').startsWith('/')
        ? String(item.icon)
        : item.serverId ? `./generated/web/items/${item.serverId}.png` : null;
      const image = src ? this.groundImages.get(src) : null;
      const size = Math.max(22, tile * .72);

      this.ctx.save();
      this.ctx.translate(sx, sy);
      this.castShadow(size * .40, .40);
      // Brilho dourado pulsante: loot no chão precisa se destacar sem
      // depender de um borrão sólido por baixo do ícone.
      this.ctx.save();
      this.ctx.globalCompositeOperation = 'lighter';
      this.ctx.globalAlpha = .18 + Math.sin(Date.now() / 520 + sx) * .07;
      const halo = this.ctx.createRadialGradient(0, -size * .35, 0, 0, -size * .35, size * .7);
      halo.addColorStop(0, '#ffd98a');
      halo.addColorStop(1, '#ffd98a00');
      this.ctx.fillStyle = halo;
      this.ctx.beginPath();
      this.ctx.arc(0, -size * .35, size * .7, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.restore();

      if (image?.complete && image.naturalWidth) {
        this.ctx.drawImage(image, -size / 2, -size, size, size);
      } else {
        this.ctx.fillStyle = '#f2d37f';
        this.ctx.font = 'bold 10px Tahoma';
        this.ctx.textAlign = 'center';
        this.ctx.fillText(item.icon || 'IT', 0, -8);
      }

      if (item.quantity > 1) {
        this.ctx.fillStyle = '#fff';
        this.ctx.font = 'bold 9px Tahoma';
        this.ctx.textAlign = 'right';
        this.ctx.fillText(String(item.quantity), size / 2, 1);
      }
      this.ctx.restore();

      this.groundHitboxes.push({
        id:item.id,
        x:sx - size / 2,
        y:sy - size,
        width:size,
        height:size
      });
    }
  }

  groundItemAtClient(clientX,clientY){
    const rect=this.canvas.getBoundingClientRect();const x=clientX-rect.left,y=clientY-rect.top;
    const hit=[...this.groundHitboxes].reverse().find(box=>x>=box.x&&x<=box.x+box.width&&y>=box.y&&y<=box.y+box.height);
    return hit?.id||null;
  }

  handleHover(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const overNpc = this.npcHitboxes.some(box =>
      x >= box.x && x <= box.x + box.width &&
      y >= box.y && y <= box.y + box.height
    );
    const overGround = this.groundHitboxes.some(box =>
      x >= box.x && x <= box.x + box.width &&
      y >= box.y && y <= box.y + box.height
    );
    const overPlayer=this.playerHitboxes.some(box=>
      x>=box.x&&x<=box.x+box.width&&y>=box.y&&y<=box.y+box.height
    );
    this.canvas.style.cursor = overNpc || overGround || overPlayer
      ? 'pointer'
      : this.worldLoader?.index ? 'crosshair' : '';
  }

  tileAtClient(clientX,clientY) {
    const rect=this.canvas.getBoundingClientRect();
    const x=Number(clientX)-rect.left,y=Number(clientY)-rect.top;
    const placement=this.worldLoader?.index ? this.originalPlacement() : this.mapPlacement();
    if(!placement?.tile)return null;
    const center=this.worldLoader?.index ? this.player : this.regionCenter;
    const centerX=placement.x+placement.width/2,centerY=placement.y+placement.height/2;
    return {
      x:Number(center.x)+Math.floor((x-centerX)/placement.tile),
      y:Number(center.y)+Math.floor((y-centerY)/placement.tile),
      z:Number(this.player.z)
    };
  }

  handleClick(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    const npcHit = [...this.npcHitboxes].reverse().find(box =>
      x >= box.x && x <= box.x + box.width &&
      y >= box.y && y <= box.y + box.height
    );
    if (npcHit) {
      event.preventDefault();
      this.onNpcClick?.(npcHit.id);
      return;
    }

    const playerHit=[...this.playerHitboxes].reverse().find(box=>
      x>=box.x&&x<=box.x+box.width&&y>=box.y&&y<=box.y+box.height
    );
    if(playerHit){
      event.preventDefault();
      this.onPlayerClick?.(playerHit.profileId,playerHit);
      return;
    }

    const hit = [...this.groundHitboxes].reverse().find(box =>
      x >= box.x && x <= box.x + box.width &&
      y >= box.y && y <= box.y + box.height
    );
    if (hit) {
      event.preventDefault();
      this.onGroundClick?.(hit.id);
      return;
    }

    const placement=this.worldLoader?.index
      ? this.originalPlacement()
      : this.mapPlacement();
    if (!placement?.tile) return;
    // Mesmo centro usado no desenho. Com a câmera em movimento o centro é
    // fracionário, então o piso tem de ser aplicado depois da soma — com a
    // câmera parada em cima de um tile inteiro o resultado é idêntico ao
    // cálculo anterior.
    const center=this.cameraCenter();
    const centerX=placement.x+placement.width/2;
    const centerY=placement.y+placement.height/2;
    const targetX=Math.floor(Number(center.x)+(x-centerX)/placement.tile);
    const targetY=Math.floor(Number(center.y)+(y-centerY)/placement.tile);
    const targetZ=Number(this.player.z);
    if (targetX===Number(this.player.x) && targetY===Number(this.player.y)) {
      this.clickTarget=null;this.clickPath=[];
      return;
    }
    this.clickTarget={x:targetX,y:targetY,z:targetZ};
    this.clickPath=[];
    const dx=targetX-Number(this.player.x),dy=targetY-Number(this.player.y);
    this.player.direction=this.directionFor(
      Math.abs(dx)>=Math.abs(dy)?Math.sign(dx):0,
      Math.abs(dy)>Math.abs(dx)?Math.sign(dy):0
    );
    event.preventDefault();
  }

  // Poeira levantada pelos passos, na cor do ambiente da área.
  drawActorDust(motion, now, depth) {
    const dust = motion?.sampleDust?.(now);
    if (!dust?.length) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(198,214,232,.5)';
    for (const particle of dust) {
      ctx.globalAlpha = particle.alpha * 0.7;
      ctx.beginPath();
      ctx.ellipse(
        particle.x * depth * 0.6, particle.y * depth * 0.4,
        particle.size * depth * 0.7, particle.size * depth * 0.45,
        0, 0, Math.PI * 2
      );
      ctx.fill();
    }
    ctx.restore();
  }

  drawActor(actor, placement, time) {
    const tile = placement.tile;
    const sx = placement.x + placement.width / 2 + (actor.x - this.regionCenter.x) * tile + tile / 2;
    const sy = placement.y + placement.height / 2 + (actor.y - this.regionCenter.y) * tile + tile;

    if (sx < placement.x - tile || sx > placement.x + placement.width + tile) return;
    if (sy < placement.y - tile || sy > placement.y + placement.height + tile) return;

    // Reserva de sprite: uma forma cuja spritesheet veio vazia usa a arte da
    // forma anterior da cadeia em vez de sumir do mapa.
    const resolved = actor.outfitId
      ? resolveOutfit(actor.outfitId, this.outfits, src => this.outfitImage(src))
      : null;
    const outfit = resolved?.outfit || null;
    const image = resolved?.image || null;
    const ctx = this.ctx;

    // Perspectiva aérea: quem está mais ao fundo encolhe e desbota um
    // pouco. São 5% de variação — o bastante para o olho ler profundidade
    // sem mexer em nada da grade nem do pathfinding.
    const rows = (actor.y - this.regionCenter.y);
    const depth = 1 + Math.max(-1, Math.min(1, rows / 11)) * 0.05;
    const haze = Math.max(0, Math.min(0.22, -rows / 11 * 0.22));

    const uid = actor.npc ? `npc:${actor.id}`
      : actor.local ? 'player'
      : `remote:${actor.profileId || actor.name || '?'}`;
    const motion = this.motion.get(uid, time);
    motion.observe(time, actor.x * 10, actor.y * 10, NaN, 0);
    const m = motion.sample(time);

    ctx.save();
    ctx.translate(sx, sy - 2);
    this.castShadow(Math.max(9, tile * 0.42) * depth, actor.local ? 0.54 : 0.44);
    this.drawActorDust(motion, time, depth);
    this.groundRing(
      Math.max(7, tile * 0.34) * depth,
      actor.npc ? 'rgba(242,202,89,.5)' : (actor.local ? 'rgba(96,190,255,.55)' : 'rgba(242,202,89,.34)'),
      actor.local ? (Math.sin(time / 520) + 1) / 2 : 0
    );
    ctx.translate(0, 2);

    if (actor.npc) {
      ctx.save();
      ctx.globalAlpha = .55 + Math.sin(time / 260) * .2;
      ctx.fillStyle = '#ffe488';
      ctx.beginPath();
      ctx.arc(0, -40 * placement.scale, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    let spriteHeight = 40 * placement.scale;
    if (actor.icon) {
      // Static prop marker (a depot, a sign, etc.) — a single image, not
      // a directional walking spritesheet like character outfits.
      const iconImage = this.outfitImage(actor.icon);
      if (iconImage?.complete && iconImage.naturalWidth) {
        const scale = placement.scale * 1.4;
        const drawWidth = iconImage.naturalWidth * scale;
        const drawHeight = iconImage.naturalHeight * scale;
        spriteHeight = drawHeight;
        ctx.drawImage(iconImage, -drawWidth / 2, -drawHeight, drawWidth, drawHeight);
      }
    } else if (image?.complete && image.naturalWidth && outfit) {
      const gameDirection = Math.max(0, Math.min((outfit.directions || 4) - 1, actor.direction ?? 2));
      const direction = outfit.directionRows?.[gameDirection] ?? gameDirection;
      const moving = actor.local ? this.player.moving : Boolean(actor.moving);
      const walkFrames = outfit.walkFrames?.length ? outfit.walkFrames : [0];
      const frame = moving
        ? walkFrames[Math.floor(time / (outfit.frameMs || 150)) % walkFrames.length]
        : (outfit.idleFrame ?? 0);
      const scale = placement.scale * depth;
      const drawWidth = outfit.frameWidth * scale;
      const drawHeight = outfit.frameHeight * scale;
      spriteHeight = drawHeight;

      const sxFrame = frame * outfit.frameWidth;
      const syFrame = direction * outfit.frameHeight;
      const inBounds =
        sxFrame + outfit.frameWidth <= image.naturalWidth &&
        syFrame + outfit.frameHeight <= image.naturalHeight;
      const forged = inBounds
        ? forgeFrame(image, sxFrame, syFrame, outfit.frameWidth, outfit.frameHeight, 'earth')
        : null;

      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.translate(m.offsetX * scale, m.offsetY * scale);
      if (m.rotation) ctx.rotate(m.rotation);
      if (m.scaleX !== 1 || m.scaleY !== 1) ctx.scale(m.scaleX, m.scaleY);
      if (forged) {
        const pad = forged.pad;
        const w = (outfit.frameWidth + pad * 2) * scale;
        const h = (outfit.frameHeight + pad * 2) * scale;
        ctx.drawImage(forged.canvas, -w / 2, -h + pad * scale, w, h);
      } else {
        ctx.drawImage(
          image, sxFrame, syFrame, outfit.frameWidth, outfit.frameHeight,
          -drawWidth / 2, -drawHeight, drawWidth, drawHeight
        );
      }
      ctx.restore();

      // Névoa de distância: os atores do fundo se afastam de verdade.
      if (haze > 0.01) {
        ctx.save();
        ctx.globalAlpha = haze;
        ctx.fillStyle = '#8fb2cf';
        ctx.globalCompositeOperation = 'source-atop';
        ctx.fillRect(-drawWidth / 2, -drawHeight, drawWidth, drawHeight);
        ctx.restore();
      }
    }

    if (actor.npc) {
      this.npcHitboxes.push({
        id:actor.id,
        x:sx - Math.max(24, tile * .6),
        y:sy - spriteHeight - 14,
        width:Math.max(48, tile * 1.2),
        height:spriteHeight + 24
      });
    }
    if(!actor.local&&!actor.npc&&actor.profileId){
      this.playerHitboxes.push({
        profileId:String(actor.profileId),name:actor.name||'Jogador',
        x:sx-Math.max(24,tile*.6),y:sy-spriteHeight-14,
        width:Math.max(48,tile*1.2),height:spriteHeight+24
      });
    }

    ctx.font = `${Math.max(9, 11 * placement.scale)}px Tahoma`;
    ctx.textAlign = 'center';
    const labelY = -spriteHeight - 4;
    const name = actor.name || 'Jogador';
    const metrics = ctx.measureText(name);
    ctx.fillStyle = actor.npc ? '#3a2c05dd' : '#050a10dd';
    ctx.fillRect(-metrics.width / 2 - 4, labelY - 11, metrics.width + 8, 14);
    ctx.fillStyle = '#fff';
    ctx.fillText(name, 0, labelY);
    ctx.restore();
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    window.removeEventListener('resize', this.resize);
    window.removeEventListener('keydown', this.down);
    window.removeEventListener('keyup', this.up);
    this.canvas.removeEventListener('click', this.click);
    this.canvas.removeEventListener('mousemove', this.move);
  }
}
