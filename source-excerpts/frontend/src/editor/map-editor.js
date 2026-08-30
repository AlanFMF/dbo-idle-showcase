const root=document.querySelector('#editor');
const baseCatalog=await fetch('./generated/map-editor-catalog.json').then(r=>r.json());
const originalIndex=await fetch('./generated/original-map/index.json').then(r=>r.json());
const worldIndex=await fetch('./generated/world-map/index.json').then(r=>r.json());
const fullItemRegistry=await fetch('./generated/asset-registry/items.json').then(r=>r.json());
const originalItems=fullItemRegistry.map(entry=>({
  id:`client-${entry.clientId}`,
  serverId:entry.serverIds[0]||null,
  clientId:entry.clientId,
  name:entry.serverIds.length
    ? `Server ${entry.serverIds[0]} · Client ${entry.clientId}`
    : `Client ${entry.clientId}`,
  src:entry.preview,
  blocking:entry.isBlocking,
  isGround:entry.isGround,
  width:entry.width,
  height:entry.height,
  registryEntry:entry
}));
const catalog={
  ...baseCatalog,
  floors:[
    ...originalItems.filter(item=>item.isGround),
    ...(baseCatalog.floors||[])
  ],
  objects:[
    ...originalItems,
    ...(baseCatalog.objects||[])
  ]
};
const itemById=new Map(
  [...catalog.floors,...catalog.objects].map(item=>[item.id,item])
);
for(const item of originalItems){
  for(const serverId of item.registryEntry.serverIds||[]){
    itemById.set(`server-${serverId}`,item);
  }
}
const TILE=32;
let tool='ground',selected=catalog.floors[0],width=24,height=16,zoom=.75;
let map=createMap(width,height),history=[],future=[],spawnType=catalog.monsters[0]?.id||'';
let selectedRegionId=originalIndex.regions[0]?.id||'';
let navigatorX=99,navigatorY=189,navigatorZ=7;
let navigationTarget=null;
const worldChunkCache=new Map();
const images=new Map();

function img(src){
  if(!src)return null;
  if(!images.has(src)){
    const image=new Image();
    image.src=src;
    images.set(src,image);
  }
  return images.get(src);
}
function createMap(w,h){
  return {
    version:2,id:'nova-hunt',name:'Nova Hunt',sourceType:'manual',
    width:w,height:h,tileSize:TILE,floor:7,
    ground:Array.from({length:h},()=>Array(w).fill('earth')),
    objects:[],spawns:[],npcs:[],
    playerSpawn:{x:Math.floor(w/2),y:Math.floor(h/2)},
    metadata:{minLevel:1,theme:'earth'}
  };
}
function snapshot(){
  history.push(JSON.stringify(map));
  if(history.length>80)history.shift();
  future=[];
}
function restore(raw){
  map=JSON.parse(raw);
  normalizeMap();
  render();
}
function normalizeMap(){
  width=Number(map.width)||24;
  height=Number(map.height)||16;
  map.ground||=Array.from({length:height},()=>Array(width).fill('empty'));
  map.objects||=[];
  map.spawns||=[];
  map.npcs||=[];
  map.playerSpawn||={x:Math.floor(width/2),y:Math.floor(height/2)};
  map.metadata||={minLevel:1,theme:'original'};
}
function download(name,data){
  const anchor=document.createElement('a');
  anchor.href=URL.createObjectURL(new Blob([data],{type:'application/json'}));
  anchor.download=name;
  anchor.click();
  setTimeout(()=>URL.revokeObjectURL(anchor.href),1000);
}
function tileAt(x,y){return map.ground[y]?.[x]}
function paint(x,y){
  if(x<0||y<0||x>=width||y>=height)return;
  snapshot();
  if(tool==='ground'){
    map.ground[y][x]=selected.id;
  }else if(tool==='object'){
    map.objects.push({
      x,y,tileId:selected.id,serverId:selected.serverId,
      stackIndex:Math.max(
        1,
        ...map.objects.filter(o=>o.x===x&&o.y===y)
          .map(o=>Number(o.stackIndex)||1)
      )+1,
      blocking:selected.blocking
    });
  }else if(tool==='erase'){
    const same=map.objects.filter(o=>o.x===x&&o.y===y);
    if(same.length){
      const maxStack=Math.max(...same.map(o=>Number(o.stackIndex)||0));
      map.objects=map.objects.filter(
        o=>o.x!==x||o.y!==y||Number(o.stackIndex)!==maxStack
      );
    }else{
      map.spawns=map.spawns.filter(o=>o.x!==x||o.y!==y);
      map.npcs=map.npcs.filter(o=>o.x!==x||o.y!==y);
    }
  }else if(tool==='spawn'){
    map.spawns.push({
      id:`spawn-${Date.now()}`,monsterId:spawnType,
      name:catalog.monsters.find(m=>m.id===spawnType)?.name||spawnType,
      x,y,respawnMs:10000,radius:2
    });
  }else if(tool==='player'){
    map.playerSpawn={x,y};
  }
  renderCanvas();
}
function resizeMap(nw,nh){
  snapshot();
  const old=map.ground;
  map.width=nw;map.height=nh;
  map.ground=Array.from({length:nh},(_,y)=>
    Array.from({length:nw},(_,x)=>old[y]?.[x]||'empty')
  );
  map.objects=map.objects.filter(o=>o.x<nw&&o.y<nh);
  map.spawns=map.spawns.filter(o=>o.x<nw&&o.y<nh);
  map.npcs=map.npcs.filter(o=>o.x<nw&&o.y<nh);
  width=nw;height=nh;render();
}
function worldChunkKey(x,y,z){
  const size=Number(worldIndex.chunkSize)||32;
  return `${z}:${Math.floor(x/size)}:${Math.floor(y/size)}`;
}
async function loadWorldChunk(key){
  if(worldChunkCache.has(key))return worldChunkCache.get(key);
  const entry=worldIndex.chunks?.[key];
  if(!entry){
    const [z,cx,cy]=key.split(':').map(Number);
    const empty={v:1,c:[cx,cy,z],s:Number(worldIndex.chunkSize)||32,t:[]};
    worldChunkCache.set(key,empty);
    return empty;
  }
  const promise=fetch(entry.src).then(response=>{
    if(!response.ok)throw new Error(`Falha ao carregar chunk ${key}`);
    return response.json();
  });
  worldChunkCache.set(key,promise);
  try{
    const chunk=await promise;
    worldChunkCache.set(key,chunk);
    return chunk;
  }catch(error){
    worldChunkCache.delete(key);
    throw error;
  }
}
function regionContainsWorldCoordinate(x,y,z){
  const bounds=map.worldBounds;
  return Boolean(bounds&&Number(bounds.z)===Number(z)&&
    x>=bounds.minX&&x<=bounds.maxX&&y>=bounds.minY&&y<=bounds.maxY);
}
function localFromWorld(x,y){
  const bounds=map.worldBounds;
  if(!bounds)return{x,y};
  return{x:x-bounds.minX,y:y-bounds.minY};
}
function worldFromLocal(x,y){
  const bounds=map.worldBounds;
  if(!bounds)return{x,y,z:Number(map.floor??7)};
  return{x:bounds.minX+x,y:bounds.minY+y,z:Number(bounds.z)};
}
function scrollToNavigationTarget(){
  if(!navigationTarget)return;
  const local=localFromWorld(navigationTarget.x,navigationTarget.y);
  const wrap=root.querySelector('.canvas-wrap');
  if(!wrap)return;
  const px=(local.x+.5)*TILE*zoom;
  const py=(local.y+.5)*TILE*zoom;
  wrap.scrollLeft=Math.max(0,px-wrap.clientWidth/2);
  wrap.scrollTop=Math.max(0,py-wrap.clientHeight/2);
}
async function loadCoordinateRegion(x,y,z){
  x=Math.trunc(Number(x));
  y=Math.trunc(Number(y));
  z=Math.trunc(Number(z));
  if(!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(z)){
    throw new Error('Coordenadas inválidas. Informe X, Y e Z.');
  }
  if(z<0||z>15)throw new Error('O andar Z deve ficar entre 0 e 15.');
  navigatorX=x;navigatorY=y;navigatorZ=z;
  navigationTarget={x,y,z};
  if(regionContainsWorldCoordinate(x,y,z)){
    render();
    requestAnimationFrame(scrollToNavigationTarget);
    return;
  }
  const viewWidth=64;
  const viewHeight=48;
  const minX=x-Math.floor(viewWidth/2);
  const minY=y-Math.floor(viewHeight/2);
  const maxX=minX+viewWidth-1;
  const maxY=minY+viewHeight-1;
  const size=Number(worldIndex.chunkSize)||32;
  const keys=[];
  for(let cy=Math.floor(minY/size);cy<=Math.floor(maxY/size);cy++){
    for(let cx=Math.floor(minX/size);cx<=Math.floor(maxX/size);cx++){
      keys.push(`${z}:${cx}:${cy}`);
    }
  }
  const chunks=await Promise.all(keys.map(loadWorldChunk));
  const next={
    version:2,
    id:`world-${x}-${y}-${z}`,
    name:`Região ${x}, ${y}, ${z}`,
    sourceType:'world-coordinate-region',
    width:viewWidth,height:viewHeight,tileSize:TILE,floor:z,
    ground:Array.from({length:viewHeight},()=>Array(viewWidth).fill('empty')),
    objects:[],spawns:[],npcs:[],
    playerSpawn:{x:x-minX,y:y-minY,worldX:x,worldY:y},
    worldBounds:{minX,minY,maxX,maxY,z},
    metadata:{minLevel:1,theme:'original',navigationCenter:{x,y,z}}
  };
  for(const chunk of chunks){
    const [cx,cy,cz]=chunk.c||[];
    if(Number(cz)!==z)continue;
    const chunkSize=Number(chunk.s)||size;
    for(const row of chunk.t||[]){
      const index=Number(row[0]);
      const lx=index%chunkSize;
      const ly=Math.floor(index/chunkSize);
      const worldX=Number(cx)*chunkSize+lx;
      const worldY=Number(cy)*chunkSize+ly;
      if(worldX<minX||worldX>maxX||worldY<minY||worldY>maxY)continue;
      const localX=worldX-minX;
      const localY=worldY-minY;
      const rawItems=Array.isArray(row[3])?row[3]:[];
      let groundPosition=-1;
      for(let i=0;i<rawItems.length;i++){
        const serverId=Number(rawItems[i]?.[0]);
        const entry=itemById.get(`server-${serverId}`);
        if(entry?.isGround){groundPosition=i;break;}
      }
      if(groundPosition>=0){
        const groundServerId=Number(rawItems[groundPosition][0]);
        next.ground[localY][localX]=`server-${groundServerId}`;
      }
      let stackIndex=1;
      rawItems.forEach((rawItem,itemIndex)=>{
        if(itemIndex===groundPosition)return;
        const serverId=Number(rawItem?.[0]);
        if(!Number.isFinite(serverId))return;
        const entry=itemById.get(`server-${serverId}`);
        next.objects.push({
          x:localX,y:localY,tileId:`server-${serverId}`,serverId,
          stackIndex:stackIndex++,blocking:Boolean(entry?.blocking)
        });
      });
    }
  }
  map=next;
  selectedRegionId='';
  history=[];future=[];
  normalizeMap();
  render();
  requestAnimationFrame(scrollToNavigationTarget);
}
async function goToCoordinates(){
  const x=Number(root.querySelector('#goto-x')?.value);
  const y=Number(root.querySelector('#goto-y')?.value);
  const z=Number(root.querySelector('#goto-z')?.value);
  const status=root.querySelector('#goto-status');
  try{
    if(status){status.textContent='Carregando coordenadas…';status.dataset.state='loading';}
    await loadCoordinateRegion(x,y,z);
    const refreshed=root.querySelector('#goto-status');
    if(refreshed){refreshed.textContent=`Posição aberta: ${Math.trunc(x)}, ${Math.trunc(y)}, ${Math.trunc(z)}`;refreshed.dataset.state='ok';}
  }catch(error){
    console.error(error);
    if(status){status.textContent=error.message||'Não foi possível abrir as coordenadas.';status.dataset.state='error';}
  }
}
async function loadOriginalRegion(id){
  const entry=originalIndex.regions.find(region=>region.id===id);
  if(!entry)return;
  map=await fetch(entry.src).then(response=>{
    if(!response.ok)throw new Error(`Falha ao abrir ${entry.src}`);
    return response.json();
  });
  selectedRegionId=id;
  navigatorX=Number(entry.x);navigatorY=Number(entry.y);navigatorZ=Number(entry.z);
  navigationTarget={x:navigatorX,y:navigatorY,z:navigatorZ};
  history=[];future=[];
  normalizeMap();
  render();
  requestAnimationFrame(scrollToNavigationTarget);
}
function palette(){
  const list=tool==='ground'?catalog.floors:tool==='object'?catalog.objects:[];
  return `<div class="palette-search">
    <input id="search" placeholder="Buscar por item ou server ID...">
  </div>
  <div class="palette-list">
    ${list.slice(0,1200).map(entry=>`
      <button class="palette-item ${selected?.id===entry.id?'active':''}"
        data-pick="${entry.id}">
        <img src="${entry.src}">
        <span>${entry.name}</span>
        <small>${entry.serverId||entry.id}</small>
      </button>`).join('')}
  </div>`;
}
function render(){
  const bounds=map.worldBounds;
  root.innerHTML=`<header>
    <div>
      <h1>DBO Idle — Editor do Mapa Original</h1>
      <p>Abra o templo original, edite pisos, objetos, NPCs e spawns.</p>
    </div>
    <div class="header-actions">
      <button id="new">Novo</button>
      <label class="file">Importar JSON
        <input id="import" type="file" accept="application/json">
      </label>
      <button id="export">Exportar JSON</button>
      <a href="./index.html">Voltar ao jogo</a>
    </div>
  </header>
  <main>
    <aside class="left">
      <section class="original-map-loader">
        <h2>Mapa original Absolute</h2>
        <label>Templo / cidade
          <select id="original-region">
            ${originalIndex.regions.map(region=>`
              <option value="${region.id}"
                ${region.id===selectedRegionId?'selected':''}>
                ${region.name} — ${region.x}, ${region.y}, ${region.z}
              </option>`).join('')}
          </select>
        </label>
        <button id="load-original">Abrir região original</button>
        <small>
          ${originalIndex.totalTiles.toLocaleString('pt-BR')} tiles no OTBM ·
          ${originalIndex.totalTowns} cidades encontradas
        </small>
      </section>
      <section class="coordinate-jump">
        <h2>Ir para coordenadas</h2>
        <div class="coordinate-grid">
          <label>X<input id="goto-x" type="number" step="1" value="${navigatorX}"></label>
          <label>Y<input id="goto-y" type="number" step="1" value="${navigatorY}"></label>
          <label>Z<input id="goto-z" type="number" min="0" max="15" step="1" value="${navigatorZ}"></label>
        </div>
        <button id="goto-coordinates">Ir para X/Y/Z</button>
        <small id="goto-status">Abre uma janela de 64×48 tiles centralizada no ponto.</small>
      </section>
      <section>
        <h2>Ferramentas</h2>
        <div class="tools">
          ${[
            ['ground','Piso'],['object','Objeto'],['spawn','Spawn'],
            ['player','Entrada'],['erase','Apagar']
          ].map(([id,name])=>`
            <button data-tool="${id}" class="${tool===id?'active':''}">
              ${name}
            </button>`).join('')}
        </div>
      </section>
      <section>
        <h2>Região</h2>
        <label>Nome<input id="map-name" value="${map.name}"></label>
        <div class="two">
          <label>Largura<input id="w" type="number" min="8" max="160" value="${width}"></label>
          <label>Altura<input id="h" type="number" min="8" max="160" value="${height}"></label>
        </div>
        <label>Andar Z<input id="floor-z" type="number" min="0" max="15" value="${map.floor??7}"></label>
        <label>Level mínimo<input id="level" type="number" min="1" value="${map.metadata.minLevel||1}"></label>
        <button id="resize">Aplicar tamanho</button>
        ${bounds?`<div class="world-coordinates">
          <b>Coordenadas originais</b>
          <span>X ${bounds.minX}–${bounds.maxX}</span>
          <span>Y ${bounds.minY}–${bounds.maxY}</span>
          <span>Z ${bounds.z}</span>
        </div>`:''}
      </section>
      ${tool==='spawn'?`<section>
        <h2>Monstro</h2>
        <select id="monster">
          ${catalog.monsters.map(monster=>`
            <option value="${monster.id}" ${monster.id===spawnType?'selected':''}>
              ${monster.name}
            </option>`).join('')}
        </select>
      </section>`:''}
      <section class="palette"><h2>Paleta</h2>${palette()}</section>
    </aside>
    <section class="workspace">
      <div class="workspace-toolbar">
        <button id="undo" ${!history.length?'disabled':''}>Desfazer</button>
        <button id="redo" ${!future.length?'disabled':''}>Refazer</button>
        <label>Zoom
          <input id="zoom" type="range" min=".25" max="2" step=".25" value="${zoom}">
        </label>
        <span>${width}×${height} tiles · andar ${map.floor??7}</span>
        <span id="cursor-world" class="cursor-world">Passe o mouse no mapa para ver X/Y/Z</span>
      </div>
      <div class="canvas-wrap">
        <canvas id="map" width="${width*TILE}" height="${height*TILE}"></canvas>
      </div>
    </section>
    <aside class="right">
      <h2>Região aberta</h2>
      <p><b>${map.name}</b></p>
      <p>${map.sourceType==='otbm-region'
        ? 'Extraída diretamente do DBZO.otbm.'
        : map.sourceType==='world-coordinate-region'
          ? 'Janela editável carregada pelas coordenadas do mapa mundial.'
          : 'Mapa criado manualmente.'}</p>
      <h2>Legenda</h2>
      <p><b>Piso:</b> substitui o chão da célula.</p>
      <p><b>Objeto:</b> adiciona uma nova camada ao stack.</p>
      <p><b>Apagar:</b> remove primeiro o objeto superior.</p>
      <p><b>Entrada:</b> define onde o jogador entra.</p>
      <h2>Conteúdo</h2>
      <p>${map.objects.length.toLocaleString('pt-BR')} objetos</p>
      <p>${map.spawns.length} spawns de monstros</p>
      <p>${map.npcs.length} NPCs originais</p>
      <h2>Spawns</h2>
      <div class="spawn-list">
        ${map.spawns.map(spawn=>`<article>
          <strong>${spawn.name||spawn.monsterId}</strong>
          <span>${spawn.x}, ${spawn.y}</span>
          <label>Respawn
            <input data-respawn="${spawn.id}" type="number"
              value="${spawn.respawnMs/1000}" min="1">s
          </label>
          <button data-remove-spawn="${spawn.id}">Remover</button>
        </article>`).join('')||'<p>Nenhum spawn nesta região.</p>'}
      </div>
    </aside>
  </main>`;
  bind();
  renderCanvas();
}
function drawItem(ctx,entry,x,y){
  const image=img(entry?.src);
  if(image?.complete&&image.naturalWidth){
    const drawWidth=Math.max(TILE,Number(entry.width||1)*TILE);
    const drawHeight=Math.max(TILE,Number(entry.height||1)*TILE);
    ctx.drawImage(
      image,
      x*TILE-(drawWidth-TILE),
      y*TILE-(drawHeight-TILE),
      drawWidth,
      drawHeight
    );
  }
}
function renderCanvas(){
  const canvas=root.querySelector('#map');
  if(!canvas)return;
  const ctx=canvas.getContext('2d');
  canvas.style.width=`${canvas.width*zoom}px`;
  canvas.style.height=`${canvas.height*zoom}px`;
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle='#05080b';
  ctx.fillRect(0,0,canvas.width,canvas.height);

  for(let y=0;y<height;y++){
    for(let x=0;x<width;x++){
      const groundEntry=itemById.get(tileAt(x,y));
      if(groundEntry)drawItem(ctx,groundEntry,x,y);
      ctx.strokeStyle='#ffffff0b';
      ctx.strokeRect(x*TILE,y*TILE,TILE,TILE);
    }
  }

  const sortedObjects=[...map.objects].sort(
    (a,b)=>a.y-b.y||a.x-b.x||
      Number(a.stackIndex||0)-Number(b.stackIndex||0)
  );
  for(const object of sortedObjects){
    drawItem(ctx,itemById.get(object.tileId),object.x,object.y);
  }

  for(const npc of map.npcs){
    ctx.fillStyle='#8e44adcc';
    ctx.beginPath();
    ctx.arc(npc.x*TILE+16,npc.y*TILE+16,11,0,Math.PI*2);
    ctx.fill();
    ctx.fillStyle='white';
    ctx.font='bold 9px sans-serif';
    ctx.textAlign='center';
    ctx.fillText('NPC',npc.x*TILE+16,npc.y*TILE+19);
  }
  for(const spawn of map.spawns){
    ctx.fillStyle='#d32f2fcc';
    ctx.beginPath();
    ctx.arc(spawn.x*TILE+16,spawn.y*TILE+16,11,0,Math.PI*2);
    ctx.fill();
    ctx.fillStyle='white';
    ctx.font='bold 10px sans-serif';
    ctx.textAlign='center';
    ctx.fillText('S',spawn.x*TILE+16,spawn.y*TILE+20);
  }

  if(navigationTarget&&regionContainsWorldCoordinate(
    navigationTarget.x,navigationTarget.y,navigationTarget.z
  )){
    const local=localFromWorld(navigationTarget.x,navigationTarget.y);
    ctx.save();
    ctx.strokeStyle='#ffd54a';
    ctx.lineWidth=3;
    ctx.strokeRect(local.x*TILE+2,local.y*TILE+2,TILE-4,TILE-4);
    ctx.beginPath();
    ctx.moveTo(local.x*TILE+TILE/2,local.y*TILE+3);
    ctx.lineTo(local.x*TILE+TILE/2,local.y*TILE+TILE-3);
    ctx.moveTo(local.x*TILE+3,local.y*TILE+TILE/2);
    ctx.lineTo(local.x*TILE+TILE-3,local.y*TILE+TILE/2);
    ctx.stroke();
    ctx.restore();
  }

  ctx.fillStyle='#1976d2dd';
  ctx.fillRect(map.playerSpawn.x*TILE+6,map.playerSpawn.y*TILE+6,20,20);
  ctx.fillStyle='white';
  ctx.fillText('P',map.playerSpawn.x*TILE+16,map.playerSpawn.y*TILE+21);
}
function bind(){
  root.querySelectorAll('[data-tool]').forEach(button=>{
    button.onclick=()=>{
      tool=button.dataset.tool;
      if(tool==='ground')selected=catalog.floors[0];
      if(tool==='object')selected=catalog.objects[0];
      render();
    };
  });
  root.querySelectorAll('[data-pick]').forEach(button=>{
    button.onclick=()=>{
      selected=itemById.get(button.dataset.pick);
      render();
    };
  });
  const canvas=root.querySelector('#map');
  let drawing=false;
  canvas.onmousedown=event=>{
    drawing=true;
    const rect=canvas.getBoundingClientRect();
    paint(
      Math.floor((event.clientX-rect.left)/(TILE*zoom)),
      Math.floor((event.clientY-rect.top)/(TILE*zoom))
    );
  };
  canvas.onmousemove=event=>{
    const rect=canvas.getBoundingClientRect();
    const localX=Math.floor((event.clientX-rect.left)/(TILE*zoom));
    const localY=Math.floor((event.clientY-rect.top)/(TILE*zoom));
    if(localX>=0&&localY>=0&&localX<width&&localY<height){
      const world=worldFromLocal(localX,localY);
      const readout=root.querySelector('#cursor-world');
      if(readout)readout.textContent=`Tile: X ${world.x} · Y ${world.y} · Z ${world.z}`;
    }
    if(!drawing||!['ground','erase'].includes(tool))return;
    paint(localX,localY);
  };
  canvas.onmouseleave=()=>{
    const readout=root.querySelector('#cursor-world');
    if(readout)readout.textContent='Passe o mouse no mapa para ver X/Y/Z';
  };
  window.onmouseup=()=>drawing=false;
  root.querySelector('#map-name').onchange=event=>map.name=event.target.value;
  root.querySelector('#level').onchange=event=>map.metadata.minLevel=+event.target.value;
  root.querySelector('#floor-z').onchange=event=>map.floor=+event.target.value;
  root.querySelector('#resize').onclick=()=>resizeMap(
    +root.querySelector('#w').value,
    +root.querySelector('#h').value
  );
  root.querySelector('#zoom').oninput=event=>{
    zoom=+event.target.value;
    renderCanvas();
  };
  root.querySelector('#undo').onclick=()=>{
    if(!history.length)return;
    future.push(JSON.stringify(map));
    restore(history.pop());
  };
  root.querySelector('#redo').onclick=()=>{
    if(!future.length)return;
    history.push(JSON.stringify(map));
    restore(future.pop());
  };
  root.querySelector('#export').onclick=()=>download(
    `${map.id||'hunt-map'}.json`,
    JSON.stringify(map,null,2)
  );
  root.querySelector('#new').onclick=()=>{
    if(confirm('Criar um mapa novo?')){
      map=createMap(24,16);history=[];future=[];
      normalizeMap();render();
    }
  };
  root.querySelector('#import').onchange=async event=>{
    const file=event.target.files[0];
    if(!file)return;
    map=JSON.parse(await file.text());
    history=[];future=[];normalizeMap();render();
  };
  root.querySelector('#original-region').onchange=event=>{
    selectedRegionId=event.target.value;
  };
  root.querySelector('#load-original').onclick=()=>loadOriginalRegion(selectedRegionId);
  root.querySelector('#goto-coordinates').onclick=goToCoordinates;
  ['#goto-x','#goto-y','#goto-z'].forEach(selector=>{
    root.querySelector(selector)?.addEventListener('keydown',event=>{
      if(event.key==='Enter')goToCoordinates();
    });
  });
  root.querySelector('#monster')?.addEventListener(
    'change',event=>spawnType=event.target.value
  );
  root.querySelectorAll('[data-remove-spawn]').forEach(button=>{
    button.onclick=()=>{
      snapshot();
      map.spawns=map.spawns.filter(
        spawn=>spawn.id!==button.dataset.removeSpawn
      );
      render();
    };
  });
  root.querySelectorAll('[data-respawn]').forEach(input=>{
    input.onchange=()=>{
      const spawn=map.spawns.find(
        entry=>entry.id===input.dataset.respawn
      );
      if(spawn)spawn.respawnMs=Math.max(1000,+input.value*1000);
    };
  });
  const search=root.querySelector('#search');
  if(search){
    search.oninput=()=>{
      const query=search.value.toLowerCase();
      root.querySelectorAll('.palette-item').forEach(button=>{
        button.hidden=!button.textContent.toLowerCase().includes(query);
      });
    };
  }
}
window.addEventListener('resize',renderCanvas);
for(const entry of [...catalog.floors,...catalog.objects]){
  const image=img(entry.src);
  image.onload=renderCanvas;
}
await loadOriginalRegion(selectedRegionId);
