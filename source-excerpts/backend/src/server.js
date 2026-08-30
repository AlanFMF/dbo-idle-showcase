import './env.js';
import { WebSocketServer } from 'ws';
import { handleApi } from './api.js';
import { paymentStartupDiagnostics } from './payments.js';
import { accountFromRequest, adminModifyCharacterByName, adminAppendMailToAllAccounts, characterAccessVocation, characterFriendTargetByName, characterForAccount, initDatabase, normalizeAdminSkill, recordConnectionLog, recordSecurityEvent, unlockAccountVocation, markGuildBossStarted, completeGuildBossRun, guildBossAcceptedCharacterIds, transferTradePremiumPoints, reservePvpDuel, settlePvpDuel, refundPvpDuel } from './database.js';
import { createAuthoritativeRuntime } from './server-authority.js';
import { createPvpManager } from './pvp.js';
import { externalConfigDir } from './config-paths.js';
import { characters, itemCatalog, zones, rebornQuest, progressionQuestsV212, GUILD_BOSS_ZONE_ID, GUILD_CHAMPA_BOSS_ZONE_ID } from '../../src/data/game-content.js';
import { rarityName } from '../../src/core/items/item-rarity.js';
import { currentTransformationForm } from '../../src/core/transformations/transformation-engine.js';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const worldRoot=path.resolve(here,'../..');
const logDir=path.join(externalConfigDir,'logs');
const connectionLogPath=path.join(logDir,'connections.log');
fs.mkdirSync(logDir,{recursive:true});
function normalizeIp(value=''){
  const raw=String(value||'').trim();
  if(raw.startsWith('::ffff:'))return raw.slice(7);
  if(raw==='::1')return '127.0.0.1';
  return raw||'desconhecido';
}
function connectionIp(request){
  // So confia no X-Forwarded-For quando a conexao TCP veio do Caddy local.
  // Isso preserva o IP real no log sem permitir que um cliente remoto forje o cabecalho.
  const remote=normalizeIp(request?.socket?.remoteAddress||'');
  if(remote==='127.0.0.1'){
    const forwarded=String(request?.headers?.['x-forwarded-for']||'').split(',')[0].trim();
    if(forwarded)return normalizeIp(forwarded);
  }
  return remote;
}
function auditConnection(event,{connectionId='',ip='',name='',profileId='',characterId='',level='',userAgent='',accountId=null}={}){
  const line=[
    new Date().toISOString(),
    event,
    `ip=${ip||'desconhecido'}`,
    `connection=${connectionId||'-'}`,
    `name=${String(name||'-').replace(/[\r\n|]/g,' ')}`,
    `profile=${String(profileId||'-').replace(/[\r\n|]/g,' ')}`,
    `character=${String(characterId||'-').replace(/[\r\n|]/g,' ')}`,
    `level=${level||'-'}`,
    `ua=${String(userAgent||'-').replace(/[\r\n|]/g,' ').slice(0,180)}`
  ].join(' | ');
  console.log(`[MULTIPLAYER] ${line}`);
  try{fs.appendFileSync(connectionLogPath,line+'\n','utf8')}catch(error){console.error('Falha ao gravar log de conexoes:',error.message)}
  recordConnectionLog({event,connectionId,ip,name,profileId,characterId,level,userAgent,accountId}).catch(()=>{});
}
const worldIndex=JSON.parse(fs.readFileSync(path.resolve(worldRoot,'generated/world-map/index.json'),'utf8'));
const itemAssets=JSON.parse(fs.readFileSync(path.resolve(worldRoot,'generated/asset-registry/items.json'),'utf8'));
const groundIds=new Set(),blockingIds=new Set(),worldChunkCache=new Map();
for(const asset of itemAssets)for(const sid of asset.serverIds||[]){
  if(asset.isGround)groundIds.add(Number(sid));
  if(asset.isBlocking)blockingIds.add(Number(sid));
}
function worldChunkKey(x,y,z){const s=Number(worldIndex.chunkSize||32);return`${z}:${Math.floor(x/s)}:${Math.floor(y/s)}`}
function loadWorldChunk(key){
  if(worldChunkCache.has(key))return worldChunkCache.get(key);
  const m=worldIndex.chunks[key];
  if(!m){const e={v:1,c:key.split(':').map(Number),s:worldIndex.chunkSize,t:[]};worldChunkCache.set(key,e);return e}
  const c=JSON.parse(fs.readFileSync(path.resolve(worldRoot,m.src),'utf8'));worldChunkCache.set(key,c);return c
}
function worldTileWalkable(x,y,z){
  const s=Number(worldIndex.chunkSize||32),c=loadWorldChunk(worldChunkKey(x,y,z));
  const lx=((x%s)+s)%s,ly=((y%s)+s)%s,row=c.t.find(v=>v[0]===ly*s+lx);
  if(!row||!Array.isArray(row[3])||!row[3].length)return false;
  let ground=false;
  for(const raw of row[3]){const sid=Number(raw[0]||0);if(groundIds.has(sid))ground=true;if(blockingIds.has(sid))return false}
  return ground;
}
function worldDropLineClear(x0,y0,x1,y1,z){
  x0=Math.trunc(Number(x0));y0=Math.trunc(Number(y0));x1=Math.trunc(Number(x1));y1=Math.trunc(Number(y1));z=Math.trunc(Number(z));
  if(Math.max(Math.abs(x1-x0),Math.abs(y1-y0))>14)return false;
  let x=x0,y=y0;const dx=Math.abs(x1-x0),sx=x0<x1?1:-1,dy=-Math.abs(y1-y0),sy=y0<y1?1:-1;let err=dx+dy;
  while(!(x===x1&&y===y1)){
    const e2=2*err;if(e2>=dy){err+=dy;x+=sx}if(e2<=dx){err+=dx;y+=sy}
    if(!worldTileWalkable(x,y,z))return false;
  }
  return true;
}

const APP_VERSION = '21.26.4';
const DEFAULT_CLIENT_BUILD = '22.4.4';
const clientBuildPath=path.join(worldRoot,'client-build.json');
function readClientBuild(){
  try{
    const parsed=JSON.parse(fs.readFileSync(clientBuildPath,'utf8'));
    return String(parsed?.version||parsed?.build||'').trim() || DEFAULT_CLIENT_BUILD;
  }catch{return DEFAULT_CLIENT_BUILD}
}
let announcedClientBuild=readClientBuild();
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || '0.0.0.0';
const HOME = Object.freeze({ x:99, y:189, z:7, direction:2 });
// Exact room-entry destinations from the original tpmonster.lua chain.
// Index 0 is rbtravel.lua's DESTINO; indexes 1-9 are each boss teleport's toPos.
const REBORN_STAGES = Object.freeze([
  Object.freeze({ x:377, y:250, z:15, direction:2 }),
  Object.freeze({ x:400, y:250, z:15, direction:2 }),
  Object.freeze({ x:426, y:250, z:15, direction:2 }),
  Object.freeze({ x:449, y:250, z:15, direction:2 }),
  Object.freeze({ x:377, y:271, z:15, direction:2 }),
  Object.freeze({ x:400, y:271, z:15, direction:2 }),
  Object.freeze({ x:426, y:271, z:15, direction:2 }),
  Object.freeze({ x:449, y:271, z:15, direction:2 }),
  Object.freeze({ x:419, y:232, z:15, direction:2 }),
  Object.freeze({ x:419, y:316, z:15, direction:2 })
]);
const REBORN_FINAL = Object.freeze({ x:419, y:400, z:13, direction:0 });

const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif',
  '.webp':'image/webp', '.svg':'image/svg+xml', '.ico':'image/x-icon',
  '.woff':'font/woff', '.woff2':'font/woff2', '.mp3':'audio/mpeg', '.ogg':'audio/ogg'
};
function staticFileFor(requestUrl){
  let pathname='/';
  try{pathname=decodeURIComponent(new URL(requestUrl||'/','http://localhost').pathname)}catch{}
  if(pathname==='/')pathname='/index.html';
  // Nunca exponha arquivos internos do servidor/configuracao pela hospedagem estatica.
  if(pathname==='/server' || pathname.startsWith('/server/') || pathname==='/package.json' || /\.(bat|cmd|ps1)$/i.test(pathname))return null;
  const candidate=path.resolve(worldRoot,'.'+pathname);
  if(candidate!==worldRoot && !candidate.startsWith(worldRoot+path.sep))return null;
  return candidate;
}
const httpServer=http.createServer(async (req,res)=>{
  let requestPath='';
  try{requestPath=new URL(req.url||'/','http://localhost').pathname}catch{}
  if(requestPath==='/api/version'){
    res.writeHead(200,{
      'Content-Type':'application/json; charset=utf-8',
      'Cache-Control':'no-store, no-cache, must-revalidate'
    });
    res.end(JSON.stringify({version:APP_VERSION,clientBuild:readClientBuild(),updatedAt:Date.now()}));
    return;
  }
  if(requestPath==='/api/internal/prepare-restart'){
    // Endpoint deliberadamente local: Nginx acrescenta X-Forwarded-For, logo
    // uma requisicao externa nunca e aceita mesmo chegando via 127.0.0.1.
    const remote=normalizeIp(req?.socket?.remoteAddress||'');
    const forwarded=String(req?.headers?.['x-forwarded-for']||'').trim();
    if(req.method!=='POST'||remote!=='127.0.0.1'||forwarded){
      res.writeHead(403,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
      res.end(JSON.stringify({ok:false,message:'Somente manutencao local.'}));
      return;
    }
    try{
      const summary=await prepareForRestart('update');
      res.writeHead(summary.ok?200:500,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
      res.end(JSON.stringify(summary));
    }catch(error){
      res.writeHead(500,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
      res.end(JSON.stringify({ok:false,message:String(error?.message||error)}));
    }
    return;
  }
  if(await handleApi(req,res,{
    async beforeMarketChange(characterId){const runtime=activeAuthorityRuntimes.get(String(characterId||''));if(runtime)await runtime.flush(true);},
    async applyMarketStates(states={}){for(const [characterId,nextState] of Object.entries(states||{})){const runtime=activeAuthorityRuntimes.get(String(characterId));if(runtime)runtime.replaceState(nextState);}},
    async applyAccountPremiumPoints(accountId,value){for(const pl of players.values()){if(String(pl.accountId||'')!==String(accountId))continue;activeAuthorityRuntimes.get(String(pl.profileId||''))?.syncAccountPremiumPoints?.(value);}},
    async onGuildBossSummoned(result){scheduleGuildBoss(result);},
    async onGuildBossAccepted(result){registerGuildBossAcceptance(result);}
  }))return;
  if(!['GET','HEAD'].includes(req.method||'GET')){res.writeHead(405);res.end('Method Not Allowed');return}
  let file=staticFileFor(req.url);
  if(!file){res.writeHead(403);res.end('Forbidden');return}
  try{
    if(fs.statSync(file).isDirectory())file=path.join(file,'index.html');
    const ext=path.extname(file).toLowerCase();
    const data=fs.readFileSync(file);
    res.writeHead(200,{
      'Content-Type':MIME[ext]||'application/octet-stream',
      'Cache-Control':'no-cache',
      'X-Content-Type-Options':'nosniff'
    });
    if(req.method==='HEAD')res.end(); else res.end(data);
  }catch{
    res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});res.end('404 - Arquivo nao encontrado');
  }
});
const wss = new WebSocketServer({ server:httpServer, path:'/ws', maxPayload:512*1024 });
// V21.25.7: detecta perda real de internet rapidamente. Browsers respondem
// pong automaticamente; duas janelas de heartbeat sem resposta encerram o
// socket e acionam o farming de protecao no handler de close.
const websocketHeartbeat=setInterval(()=>{
  for(const client of wss.clients){
    if(client.isAlive===false){try{client.terminate();}catch{};continue;}
    client.isAlive=false;
    try{client.ping();}catch{}
  }
},15000);
websocketHeartbeat.unref?.();
const players = new Map();
const activeCharacterSessions = new Map();
const activeAuthorityRuntimes = new Map();
// V21.25.7 — quando a conexao cai durante Hunt/Training normal, o runtime
// continua autoritativamente no servidor por ate 1 hora. Isso evita que o
// browser avance localmente e depois seja corrigido para um snapshot antigo.
const protectedFarmingSessions = new Map();
const PROTECTION_FARMING_MAX_MS = 60 * 60 * 1000;
const PROTECTION_FARMING_CHECK_MS = 5000;
let serverDraining=false;
let restartPreparationPromise=null;
let gracefulShutdownPromise=null;
const ADMIN_ACCESS_VOCATION = 'dbo_admin_owner';
const groundItems = new Map();
const GROUND_ITEM_LIFETIME_MS = 60_000;
const parties = new Map();
const partyByCharacter = new Map();
const partyInvites = new Map();
const PARTY_MAX_MEMBERS = 5;
// V21.13 direct player trade. Sessions are intentionally ephemeral; item and
// Zeni settlement is performed against the two authoritative runtimes in one
// server turn, then both states are persisted.
const tradeInvites = new Map();
const tradeSessions = new Map();
const tradeByCharacter = new Map();

function protectionFarmingActivity(runtime,characterId=''){
  const state=runtime?.state||{};
  if(state.hunt?.offlineMode?.active)return null;
  if(partyForCharacter(characterId))return null;
  if(state.training?.running)return 'training';
  if(state.hunt?.running){
    const zone=zones.find(row=>String(row.id)===String(state.hunt?.zoneId||''));
    // Protecao automatica vale para Hunt normal. Boss, Quest, Guild Boss e
    // conteudo de Party continuam seguindo as regras de abandono existentes.
    if(!zone||zone.contentType==='boss'||zone.questType||zone.guildBoss)return null;
    return 'hunt';
  }
  return null;
}

async function expireProtectionFarming(characterId,reason='timeout'){
  const id=String(characterId||'');
  const entry=protectedFarmingSessions.get(id);
  if(!entry)return {ok:true,missing:true};
  protectedFarmingSessions.delete(id);
  if(entry.timer)clearTimeout(entry.timer);
  const runtime=entry.runtime;
  try{
    runtime?.finishProtectionFarming?.(reason);
    await runtime?.flushWithRetry?.(5);
  }catch(error){
    console.error(`[PROTECTION] Falha ao finalizar ${id}:`,error.message);
  }
  try{await runtime?.destroy?.();}catch(error){console.error(`[PROTECTION] destroy ${id}:`,error.message);}
  if(activeAuthorityRuntimes.get(id)===runtime)activeAuthorityRuntimes.delete(id);
  activeCharacterSessions.delete(id);
  recordSecurityEvent({accountId:entry.accountId||null,characterId:id,event:'PROTECTION_FARMING_END',details:{reason,startedAt:entry.startedAt,expiresAt:entry.expiresAt}}).catch(()=>{});
  console.log(`[PROTECTION] ${id} encerrado (${reason}).`);
  return {ok:true};
}

async function startProtectionFarming({characterId,accountId,runtime}={}){
  const id=String(characterId||'');
  const activity=protectionFarmingActivity(runtime,id);
  if(!id||!runtime||!activity)return {ok:false};
  const startedAt=Date.now();
  const expiresAt=startedAt+PROTECTION_FARMING_MAX_MS;
  runtime.detachConnection?.();
  const begun=runtime.beginProtectionFarming?.(activity,PROTECTION_FARMING_MAX_MS);
  if(begun?.ok===false)return {ok:false};
  try{await runtime.flushWithRetry?.(5);}catch(error){
    console.error(`[PROTECTION] Nao foi possivel salvar o inicio de ${id}:`,error.message);
    return {ok:false};
  }
  const old=protectedFarmingSessions.get(id);if(old?.timer)clearTimeout(old.timer);
  const timer=setTimeout(()=>{void expireProtectionFarming(id,'timeout-1h');},PROTECTION_FARMING_MAX_MS);
  timer.unref?.();
  protectedFarmingSessions.set(id,{characterId:id,accountId,runtime,activity,startedAt,expiresAt,timer});
  activeAuthorityRuntimes.set(id,runtime);
  activeCharacterSessions.delete(id);
  recordSecurityEvent({accountId:accountId||null,characterId:id,event:'PROTECTION_FARMING_START',details:{activity,startedAt,expiresAt}}).catch(()=>{});
  console.log(`[PROTECTION] ${id} entrou em ${activity} protegido por ate 1h.`);
  return {ok:true,activity,startedAt,expiresAt};
}

const protectionFarmingMonitor=setInterval(()=>{
  const now=Date.now();
  for(const [id,entry] of protectedFarmingSessions){
    const state=entry.runtime?.state||{};
    const stillRunning=entry.activity==='hunt'?Boolean(state.hunt?.running):Boolean(state.training?.running);
    if(now>=entry.expiresAt)void expireProtectionFarming(id,'timeout-1h');
    else if(!stillRunning)void expireProtectionFarming(id,'activity-ended');
  }
},PROTECTION_FARMING_CHECK_MS);
protectionFarmingMonitor.unref?.();

// V21.8.0 — uma run de Boss da Guild possui HP compartilhado entre todos os
// membros que aceitaram o convite. O PostgreSQL guarda custo/status/participantes;
// o mapa abaixo guarda apenas o estado efemero do combate autoritativo.
const guildBossRuns = new Map();
const guildBossByCharacter = new Map();
const GUILD_BOSS_DEFINITIONS=Object.freeze({
  daishinkan:Object.freeze({
    type:'daishinkan',
    zoneId:GUILD_BOSS_ZONE_ID,
    name:'Daishinkan · Guardião da Guild',
    costPp:100,
    warning:'100 PP do Cofre ja foram queimados e nao geram XP. Se todos os participantes morrerem, a tentativa e os PP serao perdidos.',
    rewards:'20% por Ticket de Boss · 5% por Esfera do Dragao · Majora Amulet e Blue Potara Ring (5% base cada) · 10–100 Super Senzu Red · 60.000.000 XP base.'
  }),
  champa:Object.freeze({
    type:'champa',
    zoneId:GUILD_CHAMPA_BOSS_ZONE_ID,
    name:'Champa · Desafio da Guild',
    costPp:0,
    warning:'1 Champa Doll do invocador ja foi consumida. Se todos os participantes morrerem, a tentativa e a Doll serao perdidas.',
    rewards:'5% por Ticket de Boss · 1% por Esfera do Dragao · 5–50 Rola Bean · 18.000.000 XP base.'
  })
});
function guildBossDefinition(value='daishinkan'){
  const type=typeof value==='object'?String(value?.bossType||'daishinkan'):String(value||'daishinkan');
  return GUILD_BOSS_DEFINITIONS[type]||GUILD_BOSS_DEFINITIONS.daishinkan;
}

function onlinePlayerByProfileId(profileId=''){
  return [...players.values()].find(p=>String(p.profileId||'')===String(profileId||''))||null;
}
function socketByConnectionId(id=''){
  return [...wss.clients].find(c=>String(c.connectionId||'')===String(id||''))||null;
}
function tradeSocket(characterId=''){
  const pl=onlinePlayerByProfileId(characterId);return pl?socketByConnectionId(pl.id):null;
}
function sendTrade(characterId,payload){const sock=tradeSocket(characterId);if(sock?.readyState===1)sock.send(JSON.stringify(payload));}
function tradeSessionFor(characterId=''){
  const id=tradeByCharacter.get(String(characterId||''));return id?tradeSessions.get(id)||null:null;
}
function tradePublicOffer(runtime,offer={}){
  const inventory=runtime?.tradeInventorySnapshot?.()||[];
  const byKey=new Map(inventory.map(row=>[row.key,row]));
  const items=[];
  for(const raw of Array.isArray(offer.items)?offer.items:[]){
    const row=byKey.get(String(raw?.key||''));if(!row)continue;
    const quantity=Math.max(1,Math.min(Number(row.quantity||1),Math.trunc(Number(raw.quantity)||1)));
    items.push({key:row.key,itemId:row.itemId,quantity,rarity:row.rarity||null});
  }
  return {items,zeni:Math.max(0,Math.trunc(Number(offer.zeni)||0)),pp:Math.max(0,Math.trunc(Number(offer.pp)||0))};
}
function sendTradeState(session){
  if(!session)return;
  for(const id of session.members){
    const other=session.members.find(x=>x!==id);
    const ownRuntime=activeAuthorityRuntimes.get(id),otherPlayer=onlinePlayerByProfileId(other);
    sendTrade(id,{type:'trade-state',trade:{
      id:session.id,partnerId:other,partnerName:otherPlayer?.name||'Jogador',
      ownInventory:ownRuntime?.tradeInventorySnapshot?.()||[],
      ownOffer:session.offers[id]||{items:[],zeni:0,pp:0},
      partnerOffer:session.offers[other]||{items:[],zeni:0,pp:0},
      ownConfirmed:session.confirmed.has(id),partnerConfirmed:session.confirmed.has(other)
    }});
  }
}
function closeTrade(session,message='Trade encerrado.',event='cancelled'){
  if(!session)return;
  tradeSessions.delete(session.id);
  for(const id of session.members){tradeByCharacter.delete(id);sendTrade(id,{type:'trade-event',event,message});}
}
async function settleTrade(session){
  const [a,b]=session.members;
  const ra=activeAuthorityRuntimes.get(a),rb=activeAuthorityRuntimes.get(b);
  if(!ra||!rb){closeTrade(session,'Trade cancelado porque um jogador ficou offline.');return false;}
  const pa=ra.tradePrepare(session.offers[a]||{}),pb=rb.tradePrepare(session.offers[b]||{});
  if(!pa.ok||!pb.ok){session.confirmed.clear();sendTrade(a,{type:'trade-event',event:'error',message:pa.message||pb.message||'O Trade mudou e precisa ser confirmado novamente.'});sendTrade(b,{type:'trade-event',event:'error',message:pa.message||pb.message||'O Trade mudou e precisa ser confirmado novamente.'});sendTradeState(session);return false;}
  const fa=ra.tradeReceive(pa.state,pb.outgoing,pb.zeni,pb.pp),fb=rb.tradeReceive(pb.state,pa.outgoing,pa.zeni,pa.pp);
  if(!fa.ok||!fb.ok){session.confirmed.clear();sendTrade(a,{type:'trade-event',event:'error',message:fa.message||fb.message||'Sem espaço para concluir o Trade.'});sendTrade(b,{type:'trade-event',event:'error',message:fa.message||fb.message||'Sem espaço para concluir o Trade.'});sendTradeState(session);return false;}
  const playerA=onlinePlayerByProfileId(a),playerB=onlinePlayerByProfileId(b);
  const ppTransfer=await transferTradePremiumPoints(playerA?.accountId,playerB?.accountId,pa.pp,pb.pp);
  if(!ppTransfer.ok){session.confirmed.clear();sendTrade(a,{type:'trade-event',event:'error',message:ppTransfer.message||'Não foi possível transferir os PP.'});sendTrade(b,{type:'trade-event',event:'error',message:ppTransfer.message||'Não foi possível transferir os PP.'});sendTradeState(session);return false;}
  if(ppTransfer.balances){fa.state.profile.premiumPoints=Number(ppTransfer.balances[String(playerA.accountId)]||0);fa.state.profile.vipCredits=fa.state.profile.premiumPoints;fb.state.profile.premiumPoints=Number(ppTransfer.balances[String(playerB.accountId)]||0);fb.state.profile.vipCredits=fb.state.profile.premiumPoints;}
  ra.commitExternalState(fa.state);rb.commitExternalState(fb.state);
  await Promise.allSettled([ra.flush(true),rb.flush(true)]);
  if(ppTransfer.balances){for(const pl of players.values()){const balance=ppTransfer.balances[String(pl.accountId||'')];if(balance==null)continue;activeAuthorityRuntimes.get(String(pl.profileId||''))?.syncAccountPremiumPoints?.(balance);}}
  closeTrade(session,'Trade concluído com sucesso.','completed');
  return true;
}
function partyForCharacter(characterId=''){
  const id=partyByCharacter.get(String(characterId||''));
  return id?parties.get(id)||null:null;
}
function partyPayload(party,viewerId=''){
  if(!party)return {party:null};
  const members=[...party.members].map(id=>{
    const pl=onlinePlayerByProfileId(id);
    return {id,name:pl?.name||'Offline',level:Number(pl?.level||0),online:Boolean(pl),leader:id===party.leaderId};
  });
  return {party:{id:party.id,leaderId:party.leaderId,isLeader:String(viewerId)===String(party.leaderId),members,maxMembers:PARTY_MAX_MEMBERS,activeContent:party.activeContent||null}};
}
function sendPartyState(party){
  if(!party)return;
  for(const memberId of party.members){
    const pl=onlinePlayerByProfileId(memberId);const sock=pl?socketByConnectionId(pl.id):null;
    if(sock?.readyState===1)sock.send(JSON.stringify({type:'party-state',...partyPayload(party,memberId)}));
  }
}
function clearPartyForMember(memberId){
  partyByCharacter.delete(String(memberId||''));
  const pl=onlinePlayerByProfileId(memberId);const sock=pl?socketByConnectionId(pl.id):null;
  if(sock?.readyState===1)sock.send(JSON.stringify({type:'party-state',party:null}));
}
function disbandParty(party,message='Party encerrada.'){
  if(!party)return;
  for(const id of [...party.members]){
    clearPartyForMember(id);
    const pl=onlinePlayerByProfileId(id);const sock=pl?socketByConnectionId(pl.id):null;
    if(sock?.readyState===1)sock.send(JSON.stringify({type:'party-event',event:'disbanded',message}));
  }
  parties.delete(party.id);
}
async function unlockQuestVocationForCharacter(profileId,vocationId){
  if(!vocationId)return null;
  const player=onlinePlayerByProfileId(profileId);if(!player?.accountId)return null;
  const result=await unlockAccountVocation(player.accountId,vocationId);
  if(result?.ok)for(const pl of players.values())if(String(pl.accountId||'')===String(player.accountId))activeAuthorityRuntimes.get(String(pl.profileId||''))?.syncUnlockedVocation?.(vocationId);
  return result;
}
function handlePartyProgress(sourceCharacterId,event={}){
  const party=partyForCharacter(sourceCharacterId);
  if(!party||!party.activeContent)return;
  if(String(party.activeContent.zoneId)!==String(event.zoneId||''))return;
  if(event.type==='reborn-stage'||event.type==='reborn-ready'){
    for(const id of party.members){
      if(String(id)===String(sourceCharacterId)||party.activeContent?.exitedMembers?.includes(String(id)))continue;
      const runtime=activeAuthorityRuntimes.get(String(id));
      runtime?.syncPartyReborn(Number(event.stage||0),event.type==='reborn-ready');
    }
    const nextZone=event.type==='reborn-ready'?null:zones.find(z=>z.questType==='reborn'&&Number(z.questStage||0)===Number(event.stage||0));
    party.activeContent={...party.activeContent,zoneId:nextZone?.id||party.activeContent.zoneId,stage:Number(event.stage||0),ready:event.type==='reborn-ready',sharedHp:null,sharedMaxHp:null,sharedDefeated:false};
    sendPartyState(party);
    return;
  }
  if(event.type==='progression-guard-cleared'){
    for(const id of party.members){
      if(String(id)===String(sourceCharacterId))continue;
      activeAuthorityRuntimes.get(String(id))?.syncProgressionGuardCleared?.(event.questId,Number(event.guardIndex||0));
    }
    for(const id of party.members)activeAuthorityRuntimes.get(String(id))?.stopPartyContent();
    party.activeContent={type:'expedition',questId:String(event.questId||''),zoneId:null,startedAt:party.activeContent.startedAt||Date.now(),sharedHp:null,sharedMaxHp:null,sharedDefeated:false,exitedMembers:[],tankId:String(party.leaderId)};
    sendPartyState(party);
    for(const id of party.members){
      const pl=onlinePlayerByProfileId(id);const sock=pl?socketByConnectionId(pl.id):null;
      if(sock?.readyState===1)sock.send(JSON.stringify({type:'party-event',event:'progression-guard-cleared',message:`${event.monsterName||'Guardião'} derrotado. A expedição pode continuar.`}));
    }
    return;
  }
  if(event.type==='boss-timeout'){
    for(const id of party.members){const rt=activeAuthorityRuntimes.get(String(id));rt?.stopPartyContent?.();rt?.setPosition?.(HOME);const pl=onlinePlayerByProfileId(id),sock=pl?socketByConnectionId(pl.id):null;if(sock?.readyState===1)sock.send(JSON.stringify({type:'party-event',event:'boss-timeout',message:'O tempo de 5 minutos do Boss acabou. A Party voltou ao PZ.'}));}
    party.activeContent=null;sendPartyState(party);return;
  }
  if(event.type==='boss-defeated'){
    for(const id of party.members)activeAuthorityRuntimes.get(String(id))?.stopPartyContent();
    party.activeContent=null;
    sendPartyState(party);
    for(const id of party.members){
      const pl=onlinePlayerByProfileId(id);const sock=pl?socketByConnectionId(pl.id):null;
      if(sock?.readyState===1)sock.send(JSON.stringify({type:'party-event',event:'boss-complete',message:`Boss ${event.monsterName||''} derrotado pela Party.`}));
    }
  }
}


function handlePartyDamage(sourceCharacterId,event={}){
  const party=partyForCharacter(sourceCharacterId);
  if(!party?.activeContent)return false;
  if(String(party.activeContent.zoneId)!==String(event.zoneId||''))return false;
  if(party.activeContent?.exitedMembers?.includes(String(sourceCharacterId)))return false;
  if(party.activeContent.sharedDefeated)return true;
  const maxHp=Math.max(1,Number(party.activeContent.sharedMaxHp||event.enemy?.maxHp||event.enemy?.hp||1));
  if(!Number.isFinite(Number(party.activeContent.sharedHp)))party.activeContent.sharedHp=maxHp;
  party.activeContent.sharedMaxHp=maxHp;
  party.activeContent.sharedHp=Math.max(0,Number(party.activeContent.sharedHp)-Math.max(0,Number(event.damage||0)));
  const defeated=party.activeContent.sharedHp<=0;
  if(defeated)party.activeContent.sharedDefeated=true;
  const shared={hp:party.activeContent.sharedHp,maxHp,x:Number(event.enemy?.x||0),y:Number(event.enemy?.y||0),defeated};
  // Members receive personal reward/corpse, but only the leader notifies the
  // Party progression coordinator. This prevents duplicate stage advances.
  for(const id of party.members){
    if(String(id)===String(party.leaderId))continue;
    if(party.activeContent?.exitedMembers?.includes(String(id)))continue;
    activeAuthorityRuntimes.get(String(id))?.syncPartyBossState?.(shared,{notifyProgress:false,reward:true});
  }
  activeAuthorityRuntimes.get(String(party.leaderId))?.syncPartyBossState?.(shared,{notifyProgress:true,reward:true});
  return true;
}

function partyMemberMayBeTank(characterId=''){
  const party=partyForCharacter(characterId);
  if(!party?.activeContent)return true;
  const tankId=String(party.activeContent.tankId||party.leaderId||'');
  return tankId===String(characterId);
}
function partyTaunt(characterId=''){
  const id=String(characterId||''),party=partyForCharacter(id);
  if(!party?.activeContent||party.activeContent?.exitedMembers?.includes(id))return {ok:false,message:'A provocação exige um Boss/Quest compartilhado ativo.'};
  party.activeContent.tankId=id;sendPartyState(party);
  for(const member of party.members){const pl=onlinePlayerByProfileId(member),sock=pl?socketByConnectionId(pl.id):null;if(sock?.readyState===1)sock.send(JSON.stringify({type:'party-event',event:'tank-change',tankId:id,tankName:onlinePlayerByProfileId(id)?.name||'Membro',message:`${onlinePlayerByProfileId(id)?.name||'Um membro'} assumiu o agro.`}));}
  return {ok:true};
}
function publishPartyTank(party){
  if(!party?.activeContent)return;
  const exited=new Set((party.activeContent.exitedMembers||[]).map(String));
  let tankId=String(party.activeContent.tankId||party.leaderId||'');
  if(!tankId||exited.has(tankId)||!party.members.has(tankId)){
    tankId=[...party.members].map(String).find(id=>!exited.has(id))||'';
    party.activeContent.tankId=tankId;
  }
  if(!tankId)return;
  const runtime=activeAuthorityRuntimes.get(tankId),pl=onlinePlayerByProfileId(tankId),st=runtime?.state||{};
  const hp=Math.max(0,Number(st.hunt?.playerHp??st.profile?.hp??0));
  const maxHp=Math.max(1,Number(st.hunt?.playerMaxHp??st.profile?.maxHp??hp??1));
  const payload={type:'party-event',event:'tank-status',tankId,tankName:pl?.name||st.profile?.name||'Tank',hp,maxHp,hpPercent:Math.max(0,Math.min(100,hp/maxHp*100)),updatedAt:Date.now()};
  for(const member of party.members){
    if(exited.has(String(member)))continue;
    const memberPlayer=onlinePlayerByProfileId(member),sock=memberPlayer?socketByConnectionId(memberPlayer.id):null;
    if(sock?.readyState===1)sock.send(JSON.stringify(payload));
  }
}

function guildBossRunForCharacter(characterId=''){
  const runId=guildBossByCharacter.get(String(characterId||''));
  return runId?guildBossRuns.get(runId)||null:null;
}
function guildBossSocket(characterId=''){
  const pl=onlinePlayerByProfileId(characterId);return pl?socketByConnectionId(pl.id):null;
}
function sendGuildBoss(characterId,payload){
  const sock=guildBossSocket(characterId);if(sock?.readyState===1)sock.send(JSON.stringify(payload));
}
function guildBossInvitePayload(run){
  const def=guildBossDefinition(run);
  return {
    type:'guild-boss-invite',runId:run.id,guildId:run.guildId,startsAt:run.startsAt,
    bossType:def.type,bossName:def.name,costPp:def.costPp,
    warning:def.warning,rewards:def.rewards
  };
}
function scheduleGuildBoss(result={}){
  const boss=result?.bossRun;if(!boss?.id)return null;
  const id=String(boss.id),startsAt=new Date(boss.startsAt||Date.now()+60_000).getTime();
  let run=guildBossRuns.get(id);
  if(!run){
    run={id,guildId:String(boss.guildId||''),bossType:String(boss.bossType||'daishinkan'),startsAt,deadlineAt:0,memberIds:new Set((result.memberIds||[]).map(String)),accepted:new Set(),alive:new Set(),dead:new Set(),status:'pending',sharedHp:null,sharedMaxHp:null,sharedDefeated:false,tankId:null,tauntCooldowns:new Map(),timer:null,finishing:false};
    guildBossRuns.set(id,run);
  }else{
    run.startsAt=startsAt;run.bossType=String(boss.bossType||run.bossType||'daishinkan');for(const memberId of result.memberIds||[])run.memberIds.add(String(memberId));
  }
  for(const memberId of run.memberIds)sendGuildBoss(memberId,guildBossInvitePayload(run));
  if(run.timer)clearTimeout(run.timer);
  run.timer=setTimeout(()=>startGuildBossRun(run.id).catch(error=>console.error('[GUILD BOSS] start:',error)),Math.max(0,startsAt-Date.now()));
  return run;
}
function registerGuildBossAcceptance(result={}){
  const boss=result?.run;if(!boss?.id||!result.characterId)return null;
  let run=guildBossRuns.get(String(boss.id));
  if(!run){
    run=scheduleGuildBoss({bossRun:boss,memberIds:[result.characterId]});
  }
  const characterId=String(result.characterId);run?.accepted.add(characterId);
  if(run)run.memberIds.add(characterId);
  const def=run?guildBossDefinition(run):guildBossDefinition({bossType:String(boss.bossType||'daishinkan')});
  sendGuildBoss(characterId,{type:'guild-boss-event',event:'accepted',runId:String(boss.id),startsAt:new Date(boss.startsAt).getTime(),bossType:def.type,bossName:def.name,message:'Convite aceito. A batalha inicia automaticamente no horario indicado.'});
  return run;
}
function sendPendingGuildBossInvite(characterId=''){
  const id=String(characterId||'');
  for(const run of guildBossRuns.values()){
    if(run.status!=='pending'||Date.now()>=run.startsAt||!run.memberIds.has(id)||run.accepted.has(id))continue;
    sendGuildBoss(id,guildBossInvitePayload(run));
  }
}
async function startGuildBossRun(runId){
  const run=guildBossRuns.get(String(runId));if(!run||run.status!=='pending'||run.finishing)return;
  if(run.timer){clearTimeout(run.timer);run.timer=null;}
  const started=await markGuildBossStarted(run.id);
  if(!started){
    run.status='cancelled';return;
  }
  run.status='active';
  run.deadlineAt=Date.now()+5*60*1000;
  const bossDef=guildBossDefinition(run);
  // DB e a fonte de verdade para aceite, inclusive se o HTTP terminou antes do hook.
  const acceptedIds=await guildBossAcceptedCharacterIds(run.id);
  run.accepted=new Set(acceptedIds.map(String));run.alive.clear();run.dead.clear();
  for(const id of run.accepted){
    const runtime=activeAuthorityRuntimes.get(id);if(!runtime)continue;
    const party=partyForCharacter(id);
    if(party?.activeContent){
      const exited=new Set(party.activeContent.exitedMembers||[]);exited.add(id);party.activeContent.exitedMembers=[...exited];sendPartyState(party);
    }
    runtime.handleAction('training-stop');runtime.handleAction('hunt-stop');
    const zoneOk=runtime.handleAction('hunt-zone',{zoneId:bossDef.zoneId,lureCount:1});
    const startOk=zoneOk===false?false:runtime.handleAction('hunt-start',{skipBossTicket:true});
    if(zoneOk===false||startOk===false){
      sendGuildBoss(id,{type:'guild-boss-event',event:'entry-failed',runId:run.id,message:'Nao foi possivel entrar no Boss da Guild.'});
      continue;
    }
    run.alive.add(id);guildBossByCharacter.set(id,run.id);
  }
  if(!run.alive.size){
    await finishGuildBossRun(run,'lost',`Nenhum membro que aceitou estava online no inicio. ${bossDef.type==='champa'?'A Champa Doll foi perdida.':'Os 100 PP foram perdidos.'}`);
    return;
  }
  const tankId=[...run.alive][0];run.tankId=tankId;
  const snapshot=activeAuthorityRuntimes.get(tankId)?.partyBossSnapshot?.();
  if(snapshot){
    run.sharedHp=Number(snapshot.hp||snapshot.maxHp||1);run.sharedMaxHp=Number(snapshot.maxHp||snapshot.hp||1);
    const shared={...snapshot,hp:run.sharedHp,maxHp:run.sharedMaxHp};
    for(const id of run.alive)activeAuthorityRuntimes.get(id)?.syncPartyBossState?.(shared,{notifyProgress:false,reward:false,silent:true});
  }
  const participantProfiles=[...run.alive].map(id=>{
    const pl=onlinePlayerByProfileId(id);
    return pl?{profileId:String(pl.profileId||id),name:pl.name||'Membro',level:Number(pl.level||1),characterId:pl.characterId||'goku',formId:pl.formId||'',vocationSourceId:Number(pl.vocationSourceId||0),sprite:pl.sprite||'',outfitId:pl.outfitId||pl.characterId||'goku'}:{profileId:id,name:'Membro',level:1,characterId:'goku',formId:'',vocationSourceId:0,sprite:'',outfitId:'goku'};
  });
  for(const id of run.accepted){
    if(run.alive.has(id))sendGuildBoss(id,{type:'guild-boss-event',event:'started',runId:run.id,zoneId:bossDef.zoneId,bossType:bossDef.type,bossName:bossDef.name,deadlineAt:run.deadlineAt,participants:run.alive.size,participantProfiles,message:`${bossDef.name} apareceu. ${run.alive.size} membro(s) entraram na mesma arena compartilhada. Vocês têm 5 minutos.`});
    else sendGuildBoss(id,{type:'guild-boss-event',event:'missed',runId:run.id,message:'Voce aceitou, mas estava offline ou nao conseguiu entrar quando a batalha iniciou.'});
  }
}
function handleGuildBossDamage(sourceCharacterId,event={}){
  const source=String(sourceCharacterId||''),run=guildBossRunForCharacter(source);
  if(!run||run.status!=='active'||run.sharedDefeated||!run.alive.has(source))return false;
  if(String(event.zoneId||'')!==String(guildBossDefinition(run).zoneId))return false;
  const maxHp=Math.max(1,Number(run.sharedMaxHp||event.enemy?.maxHp||event.enemy?.hp||1));
  if(!Number.isFinite(Number(run.sharedHp)))run.sharedHp=maxHp;
  run.sharedMaxHp=maxHp;run.sharedHp=Math.max(0,Number(run.sharedHp)-Math.max(0,Number(event.damage||0)));
  const defeated=run.sharedHp<=0;if(defeated)run.sharedDefeated=true;
  const shared={hp:run.sharedHp,maxHp,x:Number(event.enemy?.x||0),y:Number(event.enemy?.y||0),defeated};
  const alive=[...run.alive];
  const coordinator=alive[0]||source;
  // Primeiro recompensa/sincroniza todos sem disparar progressao; o coordenador
  // e sincronizado por ultimo e conclui a run uma unica vez.
  for(const id of alive){
    if(id===coordinator)continue;
    activeAuthorityRuntimes.get(id)?.syncPartyBossState?.(shared,{notifyProgress:false,reward:true});
  }
  activeAuthorityRuntimes.get(coordinator)?.syncPartyBossState?.(shared,{notifyProgress:true,reward:true});
  return true;
}
function guildBossMemberMayBeTank(characterId=''){
  const id=String(characterId||''),run=guildBossRunForCharacter(id);
  if(!run||run.status!=='active')return null;
  if(!run.tankId||!run.alive.has(run.tankId))run.tankId=[...run.alive][0]||null;
  return String(run.tankId||'')===id;
}
function publishGuildBossTank(run){
  if(!run||run.status!=='active'||!run.alive.size)return;
  if(!run.tankId||!run.alive.has(run.tankId))run.tankId=[...run.alive][0]||null;
  const id=String(run.tankId||'');if(!id)return;
  const runtime=activeAuthorityRuntimes.get(id),pl=onlinePlayerByProfileId(id),st=runtime?.state||{};
  const hp=Math.max(0,Number(st.hunt?.playerHp??st.profile?.hp??0));
  const maxHp=Math.max(1,Number(st.hunt?.playerMaxHp ?? st.profile?.maxHp ?? hp ?? 1));
  const payload={type:'guild-boss-event',event:'tank',runId:run.id,tankId:id,tankName:pl?.name||st.profile?.name||'Tank',hp,maxHp,hpPercent:Math.max(0,Math.min(100,hp/maxHp*100)),updatedAt:Date.now()};
  for(const member of run.alive)sendGuildBoss(member,payload);
}
function guildBossTaunt(characterId=''){
  const id=String(characterId||''),run=guildBossRunForCharacter(id);if(!run||run.status!=='active'||!run.alive.has(id))return {ok:false,message:'A provocação só funciona dentro do Boss da Guild.'};
  const now=Date.now(),next=Number(run.tauntCooldowns?.get(id)||0);if(next>now)return {ok:false,message:`Provocação em cooldown por ${Math.ceil((next-now)/1000)}s.`,cooldownEndsAt:next};
  run.tauntCooldowns ||= new Map();run.tauntCooldowns.set(id,now+10000);run.tankId=id;publishGuildBossTank(run);
  for(const member of run.alive)sendGuildBoss(member,{type:'guild-boss-event',event:'taunt',runId:run.id,tankId:id,tankName:onlinePlayerByProfileId(id)?.name||'Membro',cooldownEndsAt:now+10000,message:`${onlinePlayerByProfileId(id)?.name||'Um membro'} puxou o agro do Boss.`});
  return {ok:true,cooldownEndsAt:now+10000};
}
function handleGuildBossProgress(sourceCharacterId,event={}){
  const id=String(sourceCharacterId||''),run=guildBossRunForCharacter(id);
  if(!run||run.status!=='active'||String(event.zoneId||'')!==String(guildBossDefinition(run).zoneId))return false;
  if(event.type==='guild-boss-member-death'){
    eliminateGuildBossParticipant(id,'derrotado');return true;
  }
  if(event.type==='guild-boss-defeated'){
    const def=guildBossDefinition(run);finishGuildBossRun(run,'won',`${def.name} foi derrotado! Sobreviventes receberam suas recompensas.`).catch(error=>console.error('[GUILD BOSS] finish:',error));
    return true;
  }
  return false;
}
function eliminateGuildBossParticipant(characterId,reason='eliminado'){
  const id=String(characterId||''),run=guildBossRunForCharacter(id);if(!run||run.status!=='active'||!run.alive.has(id))return false;
  run.alive.delete(id);run.dead.add(id);guildBossByCharacter.delete(id);if(String(run.tankId||'')===id)run.tankId=[...run.alive][0]||null;
  sendGuildBoss(id,{type:'guild-boss-event',event:'eliminated',runId:run.id,message:`Voce foi ${reason} do Boss da Guild. Se ainda houver sobreviventes, eles podem continuar.`});
  for(const other of run.alive)sendGuildBoss(other,{type:'guild-boss-event',event:'member-down',runId:run.id,downCharacterId:id,message:`Um membro caiu. Restam ${run.alive.size} sobrevivente(s).`});
  if(!run.alive.size){const def=guildBossDefinition(run);finishGuildBossRun(run,'lost',`Todos os participantes foram derrotados. ${def.type==='champa'?'A tentativa e a Champa Doll foram perdidas.':'A tentativa e os 100 PP foram perdidos.'}`).catch(error=>console.error('[GUILD BOSS] loss:',error));}
  return true;
}
async function finishGuildBossRun(run,outcome,message){
  if(!run||run.finishing||!['pending','active'].includes(run.status))return;
  run.finishing=true;run.status=outcome==='won'?'won':'lost';if(run.timer){clearTimeout(run.timer);run.timer=null;}
  const participantOutcomes={};
  for(const id of run.accepted){
    participantOutcomes[id]=outcome==='won'&&run.alive.has(id)?'rewarded':(run.dead.has(id)?'dead':'accepted');
    activeAuthorityRuntimes.get(id)?.stopPartyContent?.();guildBossByCharacter.delete(id);
  }
  await completeGuildBossRun(run.id,run.status,participantOutcomes).catch(error=>console.error('[GUILD BOSS] database finish:',error));
  for(const id of run.memberIds){
    sendGuildBoss(id,{type:'guild-boss-event',event:run.status,runId:run.id,message});
  }
  setTimeout(()=>guildBossRuns.delete(run.id),120_000);
}
function handleGuildBossDeparture(characterId=''){
  const run=guildBossRunForCharacter(characterId);if(!run||run.status!=='active')return false;
  return eliminateGuildBossParticipant(characterId,'desconectado e eliminado');
}


function sanitize(value, max = 40) {
  return String(value ?? '').replace(/[<>]/g, '').trim().slice(0, max);
}

function normalizeAdminRarity(value=''){
  const key=String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[ -]+/g,'_');
  const aliases={comum:'common',common:'common',raro:'rare',rare:'rare',super_raro:'super_rare',superrare:'super_rare',super_rare:'super_rare',epico:'epic',epic:'epic',lendario:'legendary',legendary:'legendary',super_lendario:'super_legendary',superlegendary:'super_legendary',super_legendary:'super_legendary',mitico:'mythic',mythic:'mythic',divino:'divine',divine:'divine'};
  return aliases[key]||null;
}

function parseCommandArgs(text=''){
  const args=[];
  String(text).match(/"[^"]*"|\S+/g)?.forEach(token=>{
    args.push(token.startsWith('"')&&token.endsWith('"')?token.slice(1,-1):token);
  });
  return args;
}
function resolveAdminItem(query=''){
  const raw=String(query||'').trim();
  if(!raw)return null;
  if(itemCatalog[raw])return itemCatalog[raw];
  const numeric=Number(raw);
  const lowered=raw.toLowerCase();
  for(const item of Object.values(itemCatalog)){
    if(!item)continue;
    if(Number.isFinite(numeric)){
      if(Number(item.serverId)===numeric || (item.serverIds||[]).some(id=>Number(id)===numeric))return item;
      if(String(item.id||'')===`server_${numeric}`)return item;
    }
    if(String(item.name||'').trim().toLowerCase()===lowered)return item;
  }
  return null;
}
function findOnlinePlayerByName(name=''){
  const key=String(name||'').trim().toLowerCase();
  return [...players.values()].find(p=>String(p.name||'').trim().toLowerCase()===key)||null;
}

function authoritativeAppearance(state={}) {
  const profile=state.profile||{};
  const char=characters[profile.characterId]||characters.goku;
  const form=currentTransformationForm(state,char);
  return {
    sprite:sanitize(form?.portrait||char?.sprite||'./assets/generated/outfits/goku.webp',240),
    outfitId:sanitize(form?.outfitId||char?.outfitId||profile.characterId||'goku',120)
  };
}

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

// V21.25.8: mudanças visuais podem publicar apenas client-build.json. O
// backend detecta a nova build sem restart e avisa imediatamente os clientes
// conectados; login/seleção continuam cobertos pelo polling de /api/version.
const clientBuildWatchTimer=setInterval(()=>{
  const current=readClientBuild();
  if(!current || current===announcedClientBuild)return;
  announcedClientBuild=current;
  console.log(`[CLIENT-BUILD] Nova build publicada: ${current}`);
  broadcast({
    type:'client-update',
    clientBuild:current,
    appVersion:APP_VERSION,
    message:'Nova atualização disponível. Atualizando o jogo...'
  });
},3000);
clientBuildWatchTimer.unref?.();

async function checkpointAllOnline(reason='checkpoint'){
  const entries=[...activeAuthorityRuntimes.entries()];
  if(!entries.length)return {ok:true,reason,total:0,saved:0,failed:[]};
  console.log(`[SAVE-ALL] Iniciando checkpoint de ${entries.length} personagem(ns): ${reason}`);
  const results=await Promise.all(entries.map(async([characterId,runtime])=>{
    try{
      await runtime.flushWithRetry?.(5);
      return {characterId,ok:true};
    }catch(error){
      console.error(`[SAVE-ALL] Falha em ${characterId}:`,error.message);
      return {characterId,ok:false,error:String(error?.message||error)};
    }
  }));
  const failed=results.filter(row=>!row.ok);
  const summary={ok:failed.length===0,reason,total:entries.length,saved:results.length-failed.length,failed};
  console.log(`[SAVE-ALL] Finalizado: ${summary.saved}/${summary.total} salvo(s).`);
  return summary;
}

async function prepareForRestart(reason='restart'){
  if(restartPreparationPromise)return restartPreparationPromise;
  serverDraining=true;
  broadcast({type:'server-maintenance',event:'saving',message:'Servidor reiniciando. Salvando o progresso de todos os jogadores...'});
  restartPreparationPromise=(async()=>{
    // Duas passagens forçadas fecham a janela entre um snapshot em voo e as
    // ultimas mutacoes que chegaram imediatamente antes do modo de manutencao.
    const first=await checkpointAllOnline(`${reason}:pass-1`);
    const second=await checkpointAllOnline(`${reason}:pass-2`);
    return {ok:first.ok&&second.ok,reason,total:second.total,saved:second.saved,failed:[...(first.failed||[]),...(second.failed||[])]};
  })();
  return restartPreparationPromise;
}

async function gracefulShutdown(signal='shutdown'){
  if(gracefulShutdownPromise)return gracefulShutdownPromise;
  gracefulShutdownPromise=(async()=>{
    serverDraining=true;
    console.log(`[SHUTDOWN] ${signal}: salvando personagens antes de encerrar...`);
    broadcast({type:'server-maintenance',event:'saving',message:'Servidor reiniciando. Salvando seu progresso...'});
    // Primeiro checkpointa. Depois destroy() para os engines de Hunt/Training
    // e executa um ultimo flush com retry, congelando novas mutacoes.
    await checkpointAllOnline(`${signal}:pre-stop`).catch(()=>null);
    const entries=[...activeAuthorityRuntimes.entries()];
    const results=await Promise.allSettled(entries.map(([,runtime])=>runtime.destroy?.()));
    const failures=results.filter(row=>row.status==='rejected');
    if(failures.length)console.error(`[SHUTDOWN] ${failures.length} runtime(s) falharam no save final.`);
    else console.log(`[SHUTDOWN] Save final confirmado para ${entries.length} personagem(ns).`);
    try{httpServer.close();}catch{}
    process.exit(failures.length?1:0);
  })();
  return gracefulShutdownPromise;
}

function publicGroundItem(item={}){
  const {containerTree,...publicItem}=item||{};
  return publicItem;
}
function publishGroundLoot() {
  broadcast({
    type:'ground-loot',
    items:[...groundItems.values()].map(publicGroundItem)
  });
}

function publishPresence() {
  broadcast({
    type:'presence',
    players:[...players.values()].map(({
      id,profileId,name,x,y,z,sprite,outfitId,direction,characterId,formId,
      vocationSourceId,level,activity
    })=>({
      id,profileId,name,x,y,z,sprite,outfitId,direction,characterId,formId,
      vocationSourceId,level,activity:activity||'world'
    }))
  });
}

// V21.25.4 — PvP com target explícito, ataque básico automático por target, apostas e histórico. HP/KI/cooldowns do duelo ficam
// em um estado efemero separado e nunca substituem o snapshot persistente.
const pvpManager=createPvpManager({
  players,
  activeAuthorityRuntimes,
  onlinePlayerByProfileId,
  socketByConnectionId,
  publishPresence,
  partyForCharacter,
  tradeSessionFor,
  reservePvpDuel,
  settlePvpDuel,
  refundPvpDuel
});

wss.on('connection', async (socket, request) => {
  const earlyMessages=[];
  const earlyMessageHandler=raw=>earlyMessages.push(raw);
  socket.on('message',earlyMessageHandler);
  const connectionId = crypto.randomUUID();
  const ip = connectionIp(request);
  const userAgent = sanitize(request?.headers?.['user-agent'] || '', 180);
  let authAccount = null;
  let authorityRuntime = null;
  try { authAccount = await accountFromRequest(request); } catch (error) {
    console.error('[MULTIPLAYER] Falha ao validar sessao:', error.message);
  }
  if (!authAccount) {
    socket.send(JSON.stringify({type:'auth-error',message:'Entre na sua conta antes de conectar ao multiplayer.'}));
    socket.close(4401,'Sessao obrigatoria');
    return;
  }
  socket.connectionId = connectionId;
  socket.isAlive=true;
  socket.on('pong',()=>{socket.isAlive=true;});
  socket.clientIp = ip;
  socket.userAgent = userAgent;
  socket.accountId = authAccount.id;
  socket.messageRate={startedAt:Date.now(),count:0};
  auditConnection('CONNECT',{connectionId,ip,userAgent,accountId:authAccount.id});
  socket.send(JSON.stringify({
    type:'client-update',
    clientBuild:readClientBuild(),
    appVersion:APP_VERSION
  }));

  const handleMessage = async raw => {
    const rateNow=Date.now();
    if(rateNow-socket.messageRate.startedAt>=1000){socket.messageRate={startedAt:rateNow,count:0};}
    socket.messageRate.count+=1;
    if(socket.messageRate.count>120){
      recordSecurityEvent({accountId:authAccount.id,characterId:authorityRuntime?.state?.profile?.id||null,event:'WS_RATE_LIMIT',ip,details:{count:socket.messageRate.count}}).catch(()=>{});
      socket.close(4429,'Muitas mensagens');
      return;
    }
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if(serverDraining){
      if(socket.readyState===1)socket.send(JSON.stringify({type:'server-maintenance',event:'saving',message:'Servidor reiniciando. Seu progresso esta sendo salvo.'}));
      return;
    }

    if (message.type === 'join') {
      const profile = message.profile || {};
      const requestedProfileId = sanitize(profile.id || '', 120);
      let storedState = await characterForAccount(authAccount.id, requestedProfileId);
      if (!storedState) {
        socket.send(JSON.stringify({type:'auth-error',message:'Este personagem nao pertence a conta autenticada.'}));
        socket.close(4403,'Personagem invalido');
        return;
      }
      let storedProfile = storedState.profile || {};
      const characterSessionId=String(storedProfile.id||requestedProfileId);
      let protectedEntry=protectedFarmingSessions.get(characterSessionId)||null;
      if(protectedEntry && String(protectedEntry.accountId||'')!==String(authAccount.id||'')){
        socket.send(JSON.stringify({type:'auth-error',message:'Este personagem esta protegido em outra sessao.'}));
        socket.close(4409,'Personagem protegido');
        return;
      }
      if(protectedEntry && Date.now()>=Number(protectedEntry.expiresAt||0)){
        await expireProtectionFarming(characterSessionId,'timeout-before-reconnect');
        protectedEntry=null;
        storedState=await characterForAccount(authAccount.id,requestedProfileId);
        storedProfile=storedState?.profile||storedProfile;
      }
      const accessVocation=await characterAccessVocation(authAccount.id,storedProfile.id||requestedProfileId);
      socket.accessVocation=accessVocation;
      if(authorityRuntime){
        socket.send(JSON.stringify({type:'auth-error',message:'Esta conexao ja selecionou um personagem.'}));
        socket.close(4408,'Personagem ja selecionado');
        return;
      }
      const activeConnection=activeCharacterSessions.get(characterSessionId);
      if(activeConnection && activeConnection!==connectionId){
        const oldSocket=socketByConnectionId(activeConnection);
        if(oldSocket?.readyState===1){
          socket.send(JSON.stringify({type:'auth-error',message:'Este personagem ja esta online em outra sessao.'}));
          socket.close(4409,'Personagem ja online');
        }else{
          // A conexao anterior ja caiu, mas o handler ainda pode estar
          // confirmando o checkpoint que inicia o farming de protecao.
          socket.close(4410,'Sessao anterior finalizando');
        }
        return;
      }
      activeCharacterSessions.set(characterSessionId,connectionId);
      socket.characterSessionId=characterSessionId;
      const sessionState=protectedEntry?.runtime?.state||storedState;
      const sessionProfile=sessionState?.profile||storedProfile;
      const sessionAppearance=authoritativeAppearance(sessionState);
      players.set(connectionId, {
        id:connectionId,
        accountId:authAccount.id,
        profileId:sanitize(sessionProfile.id || requestedProfileId, 120),
        name:sanitize(sessionProfile.name || 'Guerreiro'),
        x:Number(sessionState?.temple?.x??HOME.x),
        y:Number(sessionState?.temple?.y??HOME.y),
        z:Number(sessionState?.temple?.z??HOME.z),
        characterId:sanitize(sessionProfile.characterId || 'goku', 80),
        formId:sanitize(sessionProfile.formId || '', 120),
        vocationSourceId:Math.trunc(Number(sessionProfile.vocationSourceId || 0)),
        level:Math.max(1, Math.trunc(Number(sessionProfile.level || 1))),
        sprite:sessionAppearance.sprite,
        outfitId:sessionAppearance.outfitId,
        direction:Number(sessionState?.temple?.direction??2),
        activity:sessionState?.hunt?.running?'hunt':sessionState?.training?.running?'training':'world',
        lastMoveAt:0
      });
      const runtimeHooks={
        send(payload){if(socket.readyState===1)socket.send(JSON.stringify(payload));},
        onPosition(position){
          const p=players.get(connectionId);if(!p)return;
          p.x=Number(position.x);p.y=Number(position.y);p.z=Number(position.z);p.direction=Number(position.direction??2);
          publishPresence();
          if(socket.readyState===1)socket.send(JSON.stringify({type:'position',position:{x:p.x,y:p.y,z:p.z,direction:p.direction}}));
        },
        onAppearance(authorityState){
          const p=players.get(connectionId);if(!p)return;
          const sp=authorityState.profile||{};
          p.characterId=sanitize(sp.characterId||p.characterId,80);
          p.formId=sanitize(sp.formId||'',120);
          p.vocationSourceId=Math.trunc(Number(sp.vocationSourceId||0));
          p.level=Math.max(1,Math.trunc(Number(sp.level||1)));
          const visual=authoritativeAppearance(authorityState);
          p.sprite=visual.sprite;p.outfitId=visual.outfitId;
          publishPresence();
        },
        onActivity(activity){
          const p=players.get(connectionId);if(!p)return;
          const next=['world','hunt','training'].includes(String(activity))?String(activity):'world';
          if(p.activity===next)return;
          p.activity=next;
          publishPresence();
        },
        onPartyProgress(event){if(!handleGuildBossProgress(characterSessionId,event))handlePartyProgress(characterSessionId,event);},
        onPartyDamage(event){return handleGuildBossDamage(characterSessionId,event)||handlePartyDamage(characterSessionId,event);},
        onPartyTankCheck(){const guildTank=guildBossMemberMayBeTank(characterSessionId);return guildTank==null?partyMemberMayBeTank(characterSessionId):guildTank;}
      };
      try {
        if(protectedEntry){
          if(protectedEntry.timer)clearTimeout(protectedEntry.timer);
          protectedFarmingSessions.delete(characterSessionId);
          authorityRuntime=protectedEntry.runtime;
          authorityRuntime.attachConnection?.(runtimeHooks);
          const resumed=authorityRuntime.resumeProtectionFarming?.()||{ok:true,activity:protectedEntry.activity,elapsedMs:Date.now()-protectedEntry.startedAt};
          activeAuthorityRuntimes.set(characterSessionId,authorityRuntime);
          await authorityRuntime.flushWithRetry?.(5);
          authorityRuntime.sendSnapshot();
          if(socket.readyState===1)socket.send(JSON.stringify({type:'authority-event',event:'protection-farming-resumed',activity:resumed.activity||protectedEntry.activity,elapsedMs:Number(resumed.elapsedMs||0),message:`Conexao restaurada. Farming de protecao encerrado apos ${Math.max(1,Math.floor(Number(resumed.elapsedMs||0)/1000))}s; seu progresso foi mantido.`}));
          recordSecurityEvent({accountId:authAccount.id,characterId:characterSessionId,event:'PROTECTION_FARMING_RESUME',ip,details:{activity:resumed.activity||protectedEntry.activity,elapsedMs:Number(resumed.elapsedMs||0)}}).catch(()=>{});
        }else{
          authorityRuntime=createAuthoritativeRuntime({
            accountId:authAccount.id,
            characterId:storedProfile.id || requestedProfileId,
            state:storedState,
            ...runtimeHooks
          });
          activeAuthorityRuntimes.set(characterSessionId,authorityRuntime);
          // Sessao normal nova nunca reaproveita flags running gravadas por um
          // browser antigo. Somente um runtime protegido vivo pode continuar.
          authorityRuntime.handleAction('hunt-stop');
          authorityRuntime.handleAction('training-stop');
          authorityRuntime.setPosition(HOME);
          authorityRuntime.sendSnapshot();
        }
      } catch (error) {
        activeCharacterSessions.delete(characterSessionId);
        socket.characterSessionId=null;
        players.delete(connectionId);
        recordSecurityEvent({accountId:authAccount.id,characterId:characterSessionId,event:'AUTHORITY_INIT_FAILED',ip,details:{message:String(error?.message||error).slice(0,300)}}).catch(()=>{});
        console.error('[AUTHORITY] Falha ao iniciar personagem:',error);
        socket.close(1011,'Falha ao iniciar personagem');
        return;
      }
      const joinedPlayer=players.get(connectionId);
      auditConnection('JOIN',{
        connectionId,
        ip,
        userAgent,
        name:joinedPlayer?.name,
        profileId:joinedPlayer?.profileId,
        characterId:joinedPlayer?.characterId,
        level:joinedPlayer?.level,
        accountId:authAccount.id
      });
      publishPresence();
      socket.send(JSON.stringify({
        type:'position',
        position:{x:Number(joinedPlayer?.x??HOME.x),y:Number(joinedPlayer?.y??HOME.y),z:Number(joinedPlayer?.z??HOME.z),direction:Number(joinedPlayer?.direction??HOME.direction)}
      }));
      socket.send(JSON.stringify({
        type:'ground-loot',
        items:[...groundItems.values()].map(publicGroundItem)
      }));
      socket.send(JSON.stringify({type:'party-state',...partyPayload(partyForCharacter(characterSessionId),characterSessionId)}));
      sendPendingGuildBossInvite(characterSessionId);
      return;
    }

    if (message.type === 'client-layout') {
      if (!authorityRuntime) return;
      const result=authorityRuntime.applyLayout(message.layout||{});
      if (!result.ok && result.reason !== 'activity-running') {
        recordSecurityEvent({
          accountId:authAccount.id,
          characterId:authorityRuntime.state?.profile?.id,
          event:'REJECTED_CLIENT_LAYOUT',
          ip,
          details:{reason:result.reason||'invalid'}
        }).catch(()=>{});
      }
      return;
    }
    if (message.type === 'client-preferences') {
      authorityRuntime?.updatePreferences(message.preferences||{});
      return;
    }
    if(message.type==='profile-request'){
      if(!authorityRuntime||!socket.characterSessionId)return;
      const targetId=String(message.characterId||'');
      const target=onlinePlayerByProfileId(targetId),runtime=activeAuthorityRuntimes.get(targetId);
      if(!target||!runtime){socket.send(JSON.stringify({type:'character-profile',ok:false,message:'Jogador não encontrado online.'}));return;}
      socket.send(JSON.stringify({type:'character-profile',ok:true,profile:runtime.publicCharacterProfile()}));
      return;
    }
    if(message.type==='trade-action'){
      if(!authorityRuntime||!socket.characterSessionId)return;
      const selfId=String(socket.characterSessionId),action=sanitize(message.action||'',40),payload=message.payload||{};
      if(action==='invite'){
        const targetId=String(payload.characterId||''),target=onlinePlayerByProfileId(targetId),self=onlinePlayerByProfileId(selfId);
        if(!target||targetId===selfId){sendTrade(selfId,{type:'trade-event',event:'error',message:'Jogador inválido para Trade.'});return;}
        if(self?.activity!=='world'||target.activity!=='world'){sendTrade(selfId,{type:'trade-event',event:'error',message:'O Trade só pode ser iniciado enquanto os dois jogadores estão fora de Hunt, Training, Quest e Boss.'});return;}
        if(tradeSessionFor(selfId)||tradeSessionFor(targetId)){sendTrade(selfId,{type:'trade-event',event:'error',message:'Um dos jogadores já está em Trade.'});return;}
        tradeInvites.set(targetId,{fromId:selfId,fromName:self?.name||'Jogador',expiresAt:Date.now()+60000});
        sendTrade(targetId,{type:'trade-invite',fromId:selfId,fromName:self?.name||'Jogador',expiresAt:Date.now()+60000});
        sendTrade(selfId,{type:'trade-event',event:'invite-sent',message:`Convite de Trade enviado para ${target.name}.`});
        return;
      }
      if(action==='decline'){
        const inv=tradeInvites.get(selfId);tradeInvites.delete(selfId);
        if(inv?.fromId)sendTrade(inv.fromId,{type:'trade-event',event:'declined',message:`${players.get(connectionId)?.name||'Jogador'} recusou o Trade.`});
        sendTrade(selfId,{type:'trade-event',event:'declined',message:'Trade recusado.'});return;
      }
      if(action==='accept'){
        const inv=tradeInvites.get(selfId);tradeInvites.delete(selfId);
        if(!inv||Number(inv.expiresAt||0)<Date.now()){sendTrade(selfId,{type:'trade-event',event:'error',message:'Convite de Trade expirado.'});return;}
        const fromId=String(inv.fromId||''),from=onlinePlayerByProfileId(fromId),self=onlinePlayerByProfileId(selfId);
        if(!from||tradeSessionFor(fromId)||tradeSessionFor(selfId)||from.activity!=='world'||self?.activity!=='world'){sendTrade(selfId,{type:'trade-event',event:'error',message:'O Trade não está mais disponível.'});return;}
        const id=crypto.randomUUID(),session={id,members:[fromId,selfId],offers:{[fromId]:{items:[],zeni:0,pp:0},[selfId]:{items:[],zeni:0,pp:0}},confirmed:new Set(),createdAt:Date.now()};
        tradeSessions.set(id,session);tradeByCharacter.set(fromId,id);tradeByCharacter.set(selfId,id);sendTradeState(session);return;
      }
      const session=tradeSessionFor(selfId);
      if(!session){sendTrade(selfId,{type:'trade-event',event:'error',message:'Nenhum Trade ativo.'});return;}
      if(action==='cancel'){closeTrade(session,'Trade cancelado.');return;}
      if(action==='offer'){
        session.offers[selfId]=tradePublicOffer(authorityRuntime,payload.offer||{});
        session.confirmed.clear();sendTradeState(session);return;
      }
      if(action==='confirm'){
        session.confirmed.add(selfId);sendTradeState(session);
        if(session.members.every(id=>session.confirmed.has(id)))await settleTrade(session);
        return;
      }
      return;
    }
    if(message.type==='pvp-action'){
      if(!authorityRuntime||!socket.characterSessionId)return;
      const action=sanitize(message.action||'',40);
      await pvpManager.handleAction(String(socket.characterSessionId),action,message.payload||{});
      return;
    }

    if (message.type === 'party-action') {
      if(!authorityRuntime||!socket.characterSessionId)return;
      const selfId=String(socket.characterSessionId), action=sanitize(message.action||'',40), payload=message.payload||{};
      if(pvpManager.hasDuel(selfId)){
        socket.send(JSON.stringify({type:'party-result',action,ok:false,message:'Finalize o duelo PvP antes de alterar sua Party.'}));
        return;
      }
      let party=partyForCharacter(selfId), result={ok:false,message:'Ação de Party inválida.'};
      if(action==='create'){
        if(party)result={ok:false,message:'Você já está em uma Party.'};
        else{const id=crypto.randomUUID();party={id,leaderId:selfId,members:new Set([selfId]),createdAt:Date.now(),activeContent:null};parties.set(id,party);partyByCharacter.set(selfId,id);result={ok:true,message:'Party criada. Você é o líder.'};sendPartyState(party);}
      }else if(action==='invite'){
        if(!party||party.leaderId!==selfId)result={ok:false,message:'Somente o líder pode convidar.'};
        else if(party.members.size>=PARTY_MAX_MEMBERS)result={ok:false,message:'A Party está cheia.'};
        else{const target=findOnlinePlayerByName(payload.name||'');if(!target)result={ok:false,message:'Jogador não encontrado online.'};else if(partyForCharacter(target.profileId))result={ok:false,message:'Esse jogador já está em uma Party.'};else if(String(target.profileId)===selfId)result={ok:false,message:'Você já está na Party.'};else{partyInvites.set(String(target.profileId),{partyId:party.id,fromId:selfId,expiresAt:Date.now()+60000});const ts=socketByConnectionId(target.id);ts?.send(JSON.stringify({type:'party-invite',partyId:party.id,fromId:selfId,fromName:players.get(connectionId)?.name||'Líder',expiresAt:Date.now()+60000}));result={ok:true,message:`Convite enviado para ${target.name}.`};}}
      }else if(action==='accept'){
        const inv=partyInvites.get(selfId);party=inv?parties.get(inv.partyId):null;
        if(!inv||!party||inv.expiresAt<Date.now())result={ok:false,message:'Convite expirado ou inválido.'};
        else if(party.members.size>=PARTY_MAX_MEMBERS)result={ok:false,message:'A Party está cheia.'};
        else{partyInvites.delete(selfId);authorityRuntime.handleAction('hunt-stop');authorityRuntime.handleAction('training-stop');party.members.add(selfId);partyByCharacter.set(selfId,party.id);result={ok:true,message:'Você entrou na Party.'};sendPartyState(party);}
      }else if(action==='decline'){
        partyInvites.delete(selfId);result={ok:true,message:'Convite recusado.'};
      }else if(action==='leave'){
        if(!party)result={ok:false,message:'Você não está em uma Party.'};
        else if(party.leaderId===selfId){disbandParty(party,'O líder encerrou a Party.');result={ok:true,message:'Party encerrada.'};}
        else{party.members.delete(selfId);clearPartyForMember(selfId);sendPartyState(party);result={ok:true,message:'Você saiu da Party.'};}
      }else if(action==='kick'){
        const targetId=String(payload.characterId||'');
        if(!party||party.leaderId!==selfId)result={ok:false,message:'Somente o líder pode remover membros.'};
        else if(!party.members.has(targetId)||targetId===selfId)result={ok:false,message:'Membro inválido.'};
        else{party.members.delete(targetId);clearPartyForMember(targetId);sendPartyState(party);result={ok:true,message:'Membro removido da Party.'};}
      }else if(action==='transfer-leader'){
        const targetId=String(payload.characterId||'');
        if(!party||party.leaderId!==selfId)result={ok:false,message:'Somente o líder atual pode transferir a liderança.'};
        else if(party.activeContent)result={ok:false,message:'Não é possível transferir a liderança durante uma Quest ou Boss em andamento.'};
        else if(!party.members.has(targetId)||targetId===selfId)result={ok:false,message:'Escolha outro membro da Party para receber a liderança.'};
        else{
          const target=onlinePlayerByProfileId(targetId);
          if(!target)result={ok:false,message:'O novo líder precisa estar online.'};
          else{
            party.leaderId=targetId;
            sendPartyState(party);
            for(const id of party.members){
              const pl=onlinePlayerByProfileId(id);const sock=pl?socketByConnectionId(pl.id):null;
              if(sock?.readyState===1)sock.send(JSON.stringify({type:'party-event',event:'leader-transferred',message:`${target.name} agora é o líder da Party.`}));
            }
            result={ok:true,message:`Liderança transferida para ${target.name}.`};
          }
        }
      }else if(action==='start-expedition'){
        const quest=progressionQuestsV212.find(q=>String(q.id)===String(payload.questId||''));
        if(!party||party.leaderId!==selfId)result={ok:false,message:'Somente o líder da Party pode iniciar a Quest.'};
        else if(!quest)result={ok:false,message:'Quest de progressão inválida.'};
        else{
          const failures=[];
          for(const id of party.members){
            const rt=activeAuthorityRuntimes.get(String(id));const st=rt?.state;
            if(!rt||!st){failures.push('membro offline');continue;}
            if(Number(st.profile?.level||1)<Number(quest.level||1)||(quest.vipOnly&&Number(st.profile?.vipUntil||0)<=Date.now())||(st.progressionQuest?.completed||[]).includes(quest.id))failures.push(st.profile?.name||id);
          }
          if(failures.length)result={ok:false,message:`Nem todos os membros podem entrar: ${failures.join(', ')}.`};
          else{
            for(const id of party.members){const rt=activeAuthorityRuntimes.get(String(id));rt.handleAction('training-stop');rt.handleAction('hunt-stop');rt.startProgressionQuestRuntime?.(quest.id);}
            party.activeContent={type:'expedition',questId:quest.id,zoneId:null,startedAt:Date.now(),deadlineAt:Date.now()+5*60*1000,sharedHp:null,sharedMaxHp:null,sharedDefeated:false,exitedMembers:[],tankId:String(party.leaderId)};
            sendPartyState(party);result={ok:true,message:`${quest.name} iniciada. O líder controla o avanço da expedição. A Party tem 5 minutos para concluir; ao expirar, todos voltam ao PZ e a Quest reinicia do começo.`};
          }
        }
      }else if(action==='stop-expedition'){
        if(!party||party.leaderId!==selfId||!['expedition','quest-guard'].includes(String(party.activeContent?.type||'')))result={ok:false,message:'Somente o líder pode encerrar a expedição.'};
        else{for(const id of party.members)activeAuthorityRuntimes.get(String(id))?.abandonProgressionQuestRuntime?.();party.activeContent=null;sendPartyState(party);result={ok:true,message:'Expedição encerrada para toda a Party.'};}
      }else if(action==='expedition-move'){
        if(!party||party.leaderId!==selfId||party.activeContent?.type!=='expedition')result={ok:false,message:'Somente o líder pode mover a Party durante a expedição.'};
        else{
          const leader=activeAuthorityRuntimes.get(String(party.leaderId));
          const quest=progressionQuestsV212.find(q=>String(q.id)===String(party.activeContent.questId||''));
          if(!leader||!quest)result={ok:false,message:'Expedição inválida.'};
          else{
            const moved=leader.moveProgressionQuestRuntime?.(payload.dx,payload.dy)||{ok:false};
            if(moved.guard){
              const zone=zones.find(z=>z.id===String(moved.zoneId||''));
              if(!zone)result={ok:false,message:'Guardião da Quest não encontrado.'};
              else{
                for(const id of party.members){const rt=activeAuthorityRuntimes.get(String(id));rt.handleAction('training-stop');rt.handleAction('hunt-stop');rt.handleAction('hunt-zone',{zoneId:zone.id,lureCount:1});rt.handleAction('hunt-start',{skipBossTicket:true});}
                const leaderBoss=leader.partyBossSnapshot?.();
                party.activeContent={type:'quest-guard',questId:quest.id,guardIndex:Number(moved.guardIndex||0),zoneId:zone.id,startedAt:party.activeContent.startedAt||Date.now(),deadlineAt:party.activeContent.deadlineAt||Date.now()+5*60*1000,sharedHp:leaderBoss?.hp??null,sharedMaxHp:leaderBoss?.maxHp??null,sharedDefeated:false,exitedMembers:[],tankId:String(party.leaderId)};
                if(leaderBoss)for(const id of party.members)activeAuthorityRuntimes.get(String(id))?.syncPartyBossState?.(leaderBoss,{notifyProgress:false,reward:false});
                sendPartyState(party);result={ok:true,message:`${zone.name}: derrote o guardião para continuar.`};
              }
            }else if(moved.ok){
              const shared=leader.state.progressionQuest;
              for(const id of party.members){if(String(id)===String(party.leaderId))continue;activeAuthorityRuntimes.get(String(id))?.syncProgressionQuestPosition?.({questId:quest.id,x:shared.x,y:shared.y,clearedGuards:shared.clearedGuards});}
              if(moved.complete){
                const failures=[];
                for(const id of party.members){const r=activeAuthorityRuntimes.get(String(id))?.finishProgressionQuestRuntime?.(quest.id);if(!r?.ok)failures.push(activeAuthorityRuntimes.get(String(id))?.state?.profile?.name||id);else if(r.unlockVocationId)await unlockQuestVocationForCharacter(id,r.unlockVocationId);}
                if(failures.length)result={ok:false,message:`Sem espaço para recompensa: ${failures.join(', ')}.`};
                else{party.activeContent=null;sendPartyState(party);for(const id of party.members){const pl=onlinePlayerByProfileId(id),sock=pl?socketByConnectionId(pl.id):null;if(sock?.readyState===1)sock.send(JSON.stringify({type:'party-event',event:'progression-complete',message:`${quest.name} concluída. Recompensa: ${quest.rewardName}.`}));}result={ok:true,message:`${quest.name} concluída para toda a Party.`};}
              }else{sendPartyState(party);result={ok:true,message:''};}
            }else result=moved;
          }
        }
      }else if(action==='start-content'){
        const zoneId=String(payload.zoneId||''), zone=zones.find(z=>z.id===zoneId);
        if(!party||party.leaderId!==selfId)result={ok:false,message:'Somente o líder da Party pode iniciar Quest ou Boss.'};
        else if(!zone||(zone.questType!=='reborn'&&zone.contentType!=='boss'))result={ok:false,message:'Party só pode iniciar Quests e Bosses.'};
        else if(zone.guildBoss)result={ok:false,message:'O Boss da Guild so pode ser iniciado pela aba Boss da Guild e pelo convite oficial.'};
        else if(zone.questType==='progression')result={ok:false,message:'Os guardiões de Expedição só podem ser iniciados ao caminhar pela Quest.'};
        else{
          const failures=[];
          for(const id of party.members){const rt=activeAuthorityRuntimes.get(String(id));if(!rt){failures.push('membro offline');continue;}const st=rt.state;const lvl=Number(st.profile?.level||1);if(zone.questType==='reborn'){const q=st.rebornQuest||{};if(lvl<rebornQuest.minimumLevel||lvl>rebornQuest.maximumLevel||Number(q.stage||0)!==Number(zone.questStage||0))failures.push(st.profile?.name||id);}else if(lvl<Number(zone.level||1)||(zone.vipOnly&&Number(st.profile?.vipUntil||0)<=Date.now()))failures.push(st.profile?.name||id);}if(zone.contentType==='boss'&&zone.bossTicketItemId){const leaderRt=activeAuthorityRuntimes.get(String(party.leaderId));if(Number(leaderRt?.bossTicketQuantity?.(zone.id)||0)<1)failures.push(`líder sem ${itemCatalog[zone.bossTicketItemId]?.name||'ticket'}`);}
          if(failures.length)result={ok:false,message:`Nem todos os membros podem entrar: ${failures.join(', ')}.`};
          else{if(zone.contentType==='boss'&&zone.bossTicketItemId){activeAuthorityRuntimes.get(String(party.leaderId))?.consumeBossTicket?.(zone.id);}party.activeContent={zoneId,type:zone.questType==='reborn'?'quest':'boss',startedAt:Date.now(),deadlineAt:zone.contentType==='boss'?Date.now()+5*60*1000:0,stage:Number(zone.questStage||0),exitedMembers:[],sharedHp:null,sharedMaxHp:null,sharedDefeated:false,tankId:String(party.leaderId)};for(const id of party.members){const rt=activeAuthorityRuntimes.get(String(id));rt.handleAction('training-stop');rt.handleAction('hunt-stop');rt.handleAction('hunt-zone',{zoneId,lureCount:1});rt.handleAction('hunt-start',{skipBossTicket:true});}const leaderBoss=activeAuthorityRuntimes.get(String(party.leaderId))?.partyBossSnapshot?.();if(leaderBoss){party.activeContent.sharedHp=leaderBoss.hp;party.activeContent.sharedMaxHp=leaderBoss.maxHp;for(const id of party.members)activeAuthorityRuntimes.get(String(id))?.syncPartyBossState?.(leaderBoss,{notifyProgress:false,reward:false});}sendPartyState(party);result={ok:true,message:`${zone.name} iniciado para toda a Party. ${zone.bossTicketItemId?'1 ticket foi consumido somente do líder.':''}`};}
        }
      }
      socket.send(JSON.stringify({type:'party-result',action,ok:Boolean(result.ok),message:result.message||''}));
      return;
    }

    // V21.25.3: troca de personagem e atomica. Se o jogador pedir troca
    // durante Hunt ou Training, o servidor encerra a atividade primeiro e
    // grava esse MESMO estado autoritativo antes de liberar o navegador.
    if(message.type==='character-exit'){
      const requestId=sanitize(message.requestId||'',120);
      pvpManager.forfeit(String(socket.characterSessionId||''),'O jogador saiu do personagem e perdeu o duelo PvP.');
      if(!authorityRuntime){
        socket.send(JSON.stringify({type:'character-exit-result',requestId,ok:false,message:'Personagem autoritativo nao esta ativo.'}));
        return;
      }
      try{
        if(authorityRuntime.state?.hunt?.running){
          authorityRuntime.handleAction('hunt-stop');
        }
        if(authorityRuntime.state?.training?.running){
          authorityRuntime.handleAction('training-stop');
        }
        const saved=await authorityRuntime.flushWithRetry?.(5) || await authorityRuntime.flush(true);
        socket.send(JSON.stringify({type:'character-exit-result',requestId,ok:true,serverRevision:Number(saved?.serverRevision||0),message:'Hunt/Treino encerrado e progresso salvo no PostgreSQL.'}));
      }catch(error){
        console.error('[AUTHORITY] checkpoint de troca falhou:',error.message);
        recordSecurityEvent({accountId:authAccount.id,characterId:socket.characterSessionId||null,event:'CHARACTER_EXIT_SAVE_FAILED',ip,details:{message:String(error?.message||error).slice(0,300)}}).catch(()=>{});
        socket.send(JSON.stringify({type:'character-exit-result',requestId,ok:false,message:'Falha ao salvar o personagem. Aguarde alguns segundos e tente novamente.'}));
      }
      return;
    }

    if (message.type === 'game-action') {
      if (!authorityRuntime) return;
      const action=sanitize(message.action||'',60);
      if(pvpManager.hasDuel(String(socket.characterSessionId||''))){
        socket.send(JSON.stringify({type:'action-result',action,ok:false,message:'Finalize ou abandone o duelo PvP antes de usar ações do modo Idle.'}));
        return;
      }
      if(action==='friend-add'){
        const requestedName=String(message.payload?.name||'').trim();
        const target=await characterFriendTargetByName(requestedName);
        if(!target){
          socket.send(JSON.stringify({type:'action-result',action,ok:false,message:'Personagem não encontrado no servidor.'}));
          return;
        }
        if(String(target.id)===String(socket.characterSessionId||'')){
          socket.send(JSON.stringify({type:'action-result',action,ok:false,message:'Você não pode adicionar o próprio personagem aos amigos.'}));
          return;
        }
        message.payload={...(message.payload||{}),name:target.name};
      }
      const party=partyForCharacter(socket.characterSessionId||'');
      if(['progression-quest-start','progression-quest-move','progression-quest-finish','progression-quest-stop'].includes(action)){
        if(party){socket.send(JSON.stringify({type:'action-result',action,ok:false,message:'Você está em Party. O líder deve controlar a Expedição pelo modo Party.'}));return;}
        let result;
        if(action==='progression-quest-start')result=authorityRuntime.startProgressionQuestRuntime?.(String(message.payload?.questId||''));
        else if(action==='progression-quest-stop')result=authorityRuntime.abandonProgressionQuestRuntime?.();
        else if(action==='progression-quest-finish')result=authorityRuntime.finishProgressionQuestRuntime?.(String(message.payload?.questId||''));
        else{
          result=authorityRuntime.moveProgressionQuestRuntime?.(message.payload?.dx,message.payload?.dy);
          if(result?.guard){
            const guardZone=zones.find(z=>z.id===String(result.zoneId||''));
            if(!guardZone)result={ok:false,message:'Guardião da Quest não encontrado.'};
            else{
              authorityRuntime.handleAction('hunt-zone',{zoneId:guardZone.id,lureCount:1});
              authorityRuntime.handleAction('hunt-start',{skipBossTicket:true});
              result={ok:true,phase:'guard',zoneId:guardZone.id,message:`${guardZone.name}: derrote o guardião para continuar.`};
            }
          }else if(result?.ok&&result?.complete){result=authorityRuntime.finishProgressionQuestRuntime?.(authorityRuntime.state?.progressionQuest?.activeQuestId||'');}
        }
        if(result?.ok&&result?.unlockVocationId)await unlockQuestVocationForCharacter(socket.characterSessionId,result.unlockVocationId);
        socket.send(JSON.stringify({type:'action-result',action,ok:Boolean(result?.ok),phase:result?.phase||null,zoneId:result?.zoneId||null,message:result?.message||''}));
        return;
      }
      const activeGuildBoss=guildBossRunForCharacter(socket.characterSessionId||'');
      if(!activeGuildBoss&&['hunt-start','hunt-switch'].includes(action)){
        const selected=zones.find(z=>z.id===String(authorityRuntime.state?.hunt?.zoneId||''));
        if(selected?.guildBoss){
          socket.send(JSON.stringify({type:'action-result',action,ok:false,message:'Este Boss da Guild só pode ser iniciado por um convite ativo.'}));
          return;
        }
      }
      if(activeGuildBoss?.status==='active'){
        if(action==='hunt-stop'){
          authorityRuntime.stopPartyContent?.();eliminateGuildBossParticipant(socket.characterSessionId,'retirado da batalha');
          socket.send(JSON.stringify({type:'action-result',action,ok:true,message:'Voce saiu do Boss da Guild e foi eliminado desta tentativa.'}));
          return;
        }
        if(['hunt-zone','hunt-start','hunt-switch'].includes(action)){
          socket.send(JSON.stringify({type:'action-result',action,ok:false,message:'Conclua ou abandone o Boss da Guild antes de iniciar outro conteudo.'}));
          return;
        }
      }
      if(!party && action==='hunt-zone'){
        const requestedZone=zones.find(z=>z.id===String(message.payload?.zoneId||''));
        if(requestedZone?.guildBoss){
          socket.send(JSON.stringify({type:'action-result',action,ok:false,message:'O Boss da Guild so pode ser acessado pelo convite oficial da Guild.'}));
          return;
        }
        if(requestedZone?.questType==='progression'){
          socket.send(JSON.stringify({type:'action-result',action,ok:false,message:'Os guardioes de Expedicao so podem ser acessados caminhando pela Quest.'}));
          return;
        }
      }
      if(party?.activeContent && action==='hunt-stop'){
        if(String(party.leaderId)===String(socket.characterSessionId||'')){
          for(const id of party.members)activeAuthorityRuntimes.get(String(id))?.stopPartyContent?.();
          party.activeContent=null;sendPartyState(party);
          socket.send(JSON.stringify({type:'action-result',action,ok:true,message:'O líder encerrou a Quest/Boss para toda a Party.'}));
        }else{
          authorityRuntime.stopPartyContent?.();
          const exited=new Set(party.activeContent.exitedMembers||[]);exited.add(String(socket.characterSessionId||''));party.activeContent.exitedMembers=[...exited];sendPartyState(party);
          socket.send(JSON.stringify({type:'action-result',action,ok:true,message:'Você saiu do conteúdo da Party.'}));
        }
        return;
      }
      if(party && ['hunt-zone','hunt-start','hunt-switch'].includes(action)){
        socket.send(JSON.stringify({type:'action-result',action,ok:false,message:'Enquanto estiver em Party, Hunts comuns não podem ser iniciadas. Somente o líder pode iniciar Quests ou Bosses pelo modo Party.'}));
        return;
      }
      if(action==='cast-spell' && String(message.payload?.spellId||'')==='guardian-taunt'){
        const spellResult=authorityRuntime.handleAction(action,message.payload||{});
        if(spellResult?.ok===false||spellResult===false){socket.send(JSON.stringify({type:'action-result',action,ok:false,message:spellResult?.message||'Provocação indisponível.'}));return;}
        const guildRun=guildBossRunForCharacter(socket.characterSessionId||'');
        const tauntResult=guildRun?.status==='active'?guildBossTaunt(socket.characterSessionId):partyTaunt(socket.characterSessionId);
        socket.send(JSON.stringify({type:'action-result',action,ok:Boolean(tauntResult?.ok),message:tauntResult?.message||'Provocação Guardiã utilizada.'}));
        return;
      }
      const result=authorityRuntime.handleAction(action,message.payload||{});
      // Parar conteudo e um limite transacional importante: confirma o save
      // antes de responder ao cliente, reduzindo a janela de perda a zero.
      if(result!==false&&result?.ok!==false&&['hunt-stop','training-stop','offline-stop','reborn'].includes(action)){
        try{await authorityRuntime.flushWithRetry?.(3) || await authorityRuntime.flush(true);}
        catch(error){
          console.error(`[AUTHORITY] checkpoint apos ${action} falhou:`,error.message);
          socket.send(JSON.stringify({type:'action-result',action,ok:false,message:'A acao foi concluida, mas o servidor nao conseguiu confirmar o save. Nao troque de personagem ainda; tente novamente em alguns segundos.'}));
          return;
        }
      }
      if (result?.ok===false || result===false) {
        socket.send(JSON.stringify({
          type:'action-result',action,ok:false,
          message:result?.message||'Acao recusada pelo servidor.'
        }));
      } else {
        socket.send(JSON.stringify({
          type:'action-result',action,ok:true,
          message:result?.message||''
        }));
      }
      return;
    }

    const player = players.get(connectionId);
    if (!player) return;

    // Aparencia e progressao sao derivadas exclusivamente do estado autoritativo.
    if (message.type === 'appearance') {
      const sp=authorityRuntime?.state?.profile||{};
      player.characterId=sanitize(sp.characterId||player.characterId,80);
      player.formId=sanitize(sp.formId||'',120);
      player.vocationSourceId=Math.trunc(Number(sp.vocationSourceId||0));
      player.level=Math.max(1,Math.trunc(Number(sp.level||1)));
      const visual=authoritativeAppearance(authorityRuntime?.state||{});
      player.sprite=visual.sprite;player.outfitId=visual.outfitId;
      publishPresence();
      return;
    }

    if (message.type === 'teleport-home') {
      if(pvpManager.hasDuel(player.profileId)){
        pvpManager.forfeit(player.profileId,`${player.name} abandonou o duelo PvP.`);
      }
      if(guildBossRunForCharacter(player.profileId)?.status==='active')eliminateGuildBossParticipant(player.profileId,'retirado da batalha');
      player.x = HOME.x; player.y = HOME.y; player.z = HOME.z; player.direction = HOME.direction;
      authorityRuntime?.stopPartyContent?.();
      authorityRuntime?.restorePzResources?.();
      authorityRuntime?.setPosition({x:player.x,y:player.y,z:player.z,direction:player.direction});
      const party=partyForCharacter(player.profileId);
      if(party?.activeContent){
        if(String(party.leaderId)===String(player.profileId)){
          for(const id of party.members)activeAuthorityRuntimes.get(String(id))?.stopPartyContent?.();
          party.activeContent=null;
        }else{
          const exited=new Set(party.activeContent.exitedMembers||[]);exited.add(String(player.profileId));party.activeContent.exitedMembers=[...exited];
        }
        sendPartyState(party);
      }
      publishPresence();
      socket.send(JSON.stringify({type:'position',position:{x:player.x,y:player.y,z:player.z,direction:player.direction}}));
      return;
    }

    // Quest Reborn stage travel. The client may request only one of the
    // ten original room-entry coordinates; arbitrary coordinates are never accepted.
    if (message.type === 'teleport-reborn-stage') {
      const stage = Math.trunc(Number(message.stage));
      const target = REBORN_STAGES[stage];
      if (!target || !authorityRuntime?.canTeleportRebornStage(stage)) return;
      player.x = target.x;
      player.y = target.y;
      player.z = target.z;
      player.direction = target.direction;
      authorityRuntime?.setPosition({x:player.x,y:player.y,z:player.z,direction:player.direction});
      publishPresence();
      socket.send(JSON.stringify({
        type:'position',
        position:{x:player.x,y:player.y,z:player.z,direction:player.direction}
      }));
      return;
    }

    // Quest Reborn: this is a server-approved teleport, not a normal step.
    // Normal movement remains adjacency-validated below.
    if (message.type === 'teleport-reborn-final') {
      if (!authorityRuntime?.isRebornReady()) return;
      player.x = REBORN_FINAL.x;
      player.y = REBORN_FINAL.y;
      player.z = REBORN_FINAL.z;
      player.direction = REBORN_FINAL.direction;
      authorityRuntime?.setPosition({x:player.x,y:player.y,z:player.z,direction:player.direction});
      publishPresence();
      socket.send(JSON.stringify({type:'position',position:{x:player.x,y:player.y,z:player.z,direction:player.direction}}));
      return;
    }

    if (message.type === 'move') {
      const moveSeq=Math.max(0,Math.min(2147483647,Math.trunc(Number(message.moveSeq||0))));
      const sendMovePosition=(moveAccepted)=>socket.send(JSON.stringify({
        type:'position',
        position:{x:player.x,y:player.y,z:player.z,direction:player.direction??2,moveSeq,moveAccepted:Boolean(moveAccepted)}
      }));
      if(pvpManager.hasDuel(player.profileId)){
        sendMovePosition(false);
        return;
      }
      const now=Date.now();
      if(now-Number(player.lastMoveAt||0)<90){
        sendMovePosition(false);
        return;
      }
      const x=Math.trunc(Number(message.x)),y=Math.trunc(Number(message.y)),z=Math.trunc(Number(message.z||7));
      const adjacent=Math.abs(x-player.x)+Math.abs(y-player.y)===1 && z===player.z;
      let accepted=false;
      if(adjacent && worldTileWalkable(x,y,z)){
        player.lastMoveAt=now;player.x=x;player.y=y;player.z=z;
        player.direction=Math.trunc(Number(message.direction??player.direction??2));
        authorityRuntime?.setPosition({x:player.x,y:player.y,z:player.z,direction:player.direction});
        publishPresence();
        accepted=true;
      }
      sendMovePosition(accepted);
    }


    if (message.type === 'guild-boss-taunt') {
      const result=guildBossTaunt(player.profileId);
      socket.send(JSON.stringify({type:'guild-boss-event',event:'taunt-result',...result}));
      return;
    }

    if (message.type === 'ground-drop') {
      const item = message.item || {};
      const itemId = sanitize(item.itemId, 80);
      const quantity = Math.max(1, Math.min(100000,Math.trunc(Number(item.quantity || 1))));
      const targetX=Math.trunc(Number(item.x??player.x)),targetY=Math.trunc(Number(item.y??player.y)),targetZ=Math.trunc(Number(item.z??player.z));
      if (!itemId || !authorityRuntime) return;
      if(targetZ!==player.z || !worldDropLineClear(player.x,player.y,targetX,targetY,targetZ)){
        socket.send(JSON.stringify({type:'ground-drop-result',ok:false,reason:'blocked',message:'Não existe uma linha livre até esse SQM.'}));
        return;
      }
      const removed=authorityRuntime.removeWorldItem(itemId,quantity,item.instanceId||null,item.containerId||null,item.sourceContainerId||null,item.sourceIndex??null);
      if(!removed.ok){authorityRuntime.sendSnapshot();socket.send(JSON.stringify({type:'ground-drop-result',ok:false,reason:'item'}));return;}
      const catalogItem=removed.item||{};

      const id = crypto.randomUUID();
      groundItems.set(id, {
        id,
        itemId,
        name:sanitize(removed.meta?.instanceId ? `${catalogItem.name||itemId} [${rarityName(removed.meta.rarity)}]` : (catalogItem.name||itemId),80),
        serverId:Number(catalogItem.serverId||catalogItem.serverIds?.[0]) || null,
        icon:sanitize(catalogItem.icon || 'IT', 240),
        quantity:Number(removed.quantity||quantity),
        x:targetX,
        y:targetY,
        z:targetZ,
        droppedBy:player.name,
        droppedAt:Date.now(),
        expiresAt:Date.now() + GROUND_ITEM_LIFETIME_MS,
        ...(removed.meta?.containerTree?{containerTree:removed.meta.containerTree}:{}),
        ...(removed.meta?.instanceId?{instanceId:removed.meta.instanceId,rarity:removed.meta.rarity||'common',rarityTier:Number(removed.meta.rarityTier||0),rarityMultiplier:Number(removed.meta.rarityMultiplier||1),source:removed.meta.source||'ground-drop'}:{})
      });
      socket.send(JSON.stringify({type:'ground-drop-result',ok:true,id}));
      publishGroundLoot();
      return;
    }

    if (message.type === 'ground-pickup') {
      const id = sanitize(message.id, 80);
      const item = groundItems.get(id);
      if (!item) {
        socket.send(JSON.stringify({
          type:'ground-pickup-result',
          ok:false,
          id,
          reason:'missing'
        }));
        return;
      }

      const distance =
        Math.abs(item.x - player.x) + Math.abs(item.y - player.y);
      if (item.z !== player.z || distance > 2) {
        socket.send(JSON.stringify({
          type:'ground-pickup-result',
          ok:false,
          id,
          reason:'distance'
        }));
        return;
      }

      const requested=Math.max(1,Math.min(Number(item.quantity||1),Math.trunc(Number(message.quantity)||Number(item.quantity||1))));
      if(item.containerTree && requested!==Number(item.quantity||1)){
        socket.send(JSON.stringify({type:'ground-pickup-result',ok:false,id,reason:'container-quantity'}));
        return;
      }
      const added=authorityRuntime?.addWorldItem(item.itemId,requested,item, sanitize(message.targetContainerId||'',120)||null);
      if(!added?.ok){
        socket.send(JSON.stringify({type:'ground-pickup-result',ok:false,id,reason:added?.reason||'full'}));
        return;
      }
      const before={...item};
      if(requested>=Number(item.quantity||1))groundItems.delete(id);
      else item.quantity=Number(item.quantity||1)-requested;
      socket.send(JSON.stringify({
        type:'ground-pickup-result',
        ok:true,
        id,
        quantity:requested,
        item:publicGroundItem({...before,quantity:requested}),
        authoritative:true
      }));
      publishGroundLoot();
      return;
    }

    if (message.type === 'chat') {
      const text = sanitize(message.text, 300);
      if (!text) return;
      const lower=text.toLowerCase();
      const isAdminCommand=/^\/(i|iall|msg|add|mailall|mailmsg|mailicon|mailborder)(?:\s|$)/i.test(text);
      if(isAdminCommand){
        const allowed=socket.accessVocation===ADMIN_ACCESS_VOCATION;
        if(!allowed){
          recordSecurityEvent({accountId:authAccount.id,characterId:player.profileId,event:'ADMIN_COMMAND_DENIED',ip,details:{command:text.slice(0,120)}}).catch(()=>{});
          socket.send(JSON.stringify({type:'server-log',channel:'server',text:'Comando administrativo nao autorizado.',at:Date.now()}));
          return;
        }
        const args=parseCommandArgs(text);
        const cmd=String(args.shift()||'').toLowerCase();
        let result={ok:false,message:'Comando invalido.'};
        if(cmd==='/i'){
          const item=resolveAdminItem(args[0]);
          const quantity=Math.max(1,Math.min(100000,Math.trunc(Number(args[1]||1))));
          const rarity=args[2]?normalizeAdminRarity(args[2]):null;
          if(args[2]&&!rarity)result={ok:false,message:'Raridade invalida. Use comum, raro, super_raro, epico, lendario, super_lendario, mitico ou divino.'};
          else result=item?authorityRuntime?.adminGrantItem(item.id,quantity,rarity):{ok:false,message:'Item nao encontrado.'};
        }else if(cmd==='/iall'){
          const item=resolveAdminItem(args[0]);const quantity=Math.max(1,Math.min(100000,Math.trunc(Number(args[1]||1))));const rarity=args[2]?normalizeAdminRarity(args[2]):null;
          if(!item)result={ok:false,message:'Item nao encontrado.'};
          else if(args[2]&&!rarity)result={ok:false,message:'Raridade invalida.'};
          else {let delivered=0;for(const runtime of activeAuthorityRuntimes.values()){const r=runtime?.adminGrantItem(item.id,quantity,rarity);if(r?.ok)delivered+=1;}result={ok:true,message:`${quantity}x ${item.name} entregue a ${delivered} personagem(ns) online.`};}
        }else if(cmd==='/mailall'){
          const item=resolveAdminItem(args[0]);const quantity=Math.max(1,Math.min(100000,Math.trunc(Number(args[1]||1))));const days=Math.max(1,Math.min(365,Math.trunc(Number(args[2]||5))));
          if(!item)result={ok:false,message:'Item nao encontrado. Use /mailall <item> [qtd] [dias].'};
          else {const expiresAt=Date.now()+days*86400000;const mail={kind:'gift',title:'Presente do Servidor',body:`Presente especial do servidor. Resgate em ate ${days} dia(s).`,expiresAt,attachment:{kind:'item',itemId:item.id,qty:quantity}};const sent=await adminAppendMailToAllAccounts(mail);for(const runtime of activeAuthorityRuntimes.values())runtime?.syncMailboxEntry?.(sent.mail);result={ok:true,message:`Dragon Mail enviado para ${sent.count} conta(s): ${quantity}x ${item.name}, validade ${days} dia(s).`};}
        }else if(cmd==='/mailicon'||cmd==='/mailborder'){
          const value=String(args[0]||'').replace(/[^a-z0-9_-]/gi,'').toLowerCase();const days=Math.max(1,Math.min(365,Math.trunc(Number(args[1]||5))));
          if(!value)result={ok:false,message:`Use ${cmd} <cosmeticoId> [dias].`};
          else {const icon=cmd==='/mailicon';const mail={kind:'gift',title:icon?'Ícone de Perfil do Servidor':'Borda de Perfil do Servidor',body:`Cosmético especial do servidor. Resgate em até ${days} dia(s).`,expiresAt:Date.now()+days*86400000,attachment:{kind:icon?'profile-icon':'profile-border',value}};const sent=await adminAppendMailToAllAccounts(mail);for(const runtime of activeAuthorityRuntimes.values())runtime?.syncMailboxEntry?.(sent.mail);result={ok:true,message:`Cosmético ${value} enviado pelo Dragon Mail para ${sent.count} conta(s), validade ${days} dia(s).`};}
        }else if(cmd==='/mailmsg'){
          const days=Math.max(1,Math.min(365,Math.trunc(Number(args.shift()||5))));const msg=args.join(' ').trim().slice(0,500);
          if(!msg)result={ok:false,message:'Use /mailmsg <dias> <comunicado>.'};
          else {const mail={kind:'announcement',title:'Comunicado do Servidor',body:msg,expiresAt:Date.now()+days*86400000};const sent=await adminAppendMailToAllAccounts(mail);for(const runtime of activeAuthorityRuntimes.values())runtime?.syncMailboxEntry?.(sent.mail);result={ok:true,message:`Comunicado enviado pelo Dragon Mail para ${sent.count} conta(s).`};}
        }else if(cmd==='/msg'){
          const msg=args.join(' ').trim().slice(0,220);
          if(msg){
            broadcast({type:'admin-message',message:{author:player.name,text:msg,at:Date.now()}});
            result={ok:true,message:'Mensagem administrativa enviada.'};
          }else result={ok:false,message:'Use /msg <mensagem>.'};
        }else if(cmd==='/add'){
          const kind=String(args[0]||'').toLowerCase();
          const targetName=String(args[1]||'').trim();
          const onlineTarget=findOnlinePlayerByName(targetName);
          const targetRuntime=onlineTarget?activeAuthorityRuntimes.get(String(onlineTarget.profileId||'')):null;
          if(kind==='level'){
            const amount=Math.trunc(Number(args[2]||0));
            if(!targetName||!amount)result={ok:false,message:'Use /add level "Nome" <quantidade>.'};
            else if(targetRuntime)result=targetRuntime.adminGrantLevel(amount);
            else result=await adminModifyCharacterByName(targetName,{kind:'level',amount});
          }else if(kind==='skill'){
            const skillId=normalizeAdminSkill(args[2]);
            const amount=Math.trunc(Number(args[3]||0));
            if(!targetName||!skillId||!amount)result={ok:false,message:'Use /add skill "Nome" <skill> <quantidade>.'};
            else if(targetRuntime)result=targetRuntime.adminGrantSkill(skillId,amount);
            else result=await adminModifyCharacterByName(targetName,{kind:'skill',skill:skillId,amount});
          }else if(kind==='zeni'||kind==='gold'){
            const amount=Math.trunc(Number(args[2]||0));
            if(!targetName||!amount)result={ok:false,message:'Use /add zeni "Nome" <quantidade>.'};
            else if(targetRuntime)result=targetRuntime.adminGrantZeni(amount);
            else result=await adminModifyCharacterByName(targetName,{kind:'zeni',amount});
          }else if(kind==='pp'||kind==='premium'){
            const amount=Math.trunc(Number(args[2]||0));
            if(!targetName||!amount)result={ok:false,message:'Use /add pp "Nome" <quantidade>.'};
            else {result=await adminModifyCharacterByName(targetName,{kind:'pp',amount});
              if(result?.ok&&result.accountId){for(const pl of players.values()){if(String(pl.accountId||'')!==String(result.accountId))continue;activeAuthorityRuntimes.get(String(pl.profileId||''))?.syncAccountPremiumPoints?.(result.premiumPoints);}}
            }
          }else result={ok:false,message:'Use /add level, /add skill, /add zeni ou /add pp.'};
        }
        recordSecurityEvent({accountId:authAccount.id,characterId:player.profileId,event:'ADMIN_COMMAND',ip,details:{command:cmd,ok:Boolean(result?.ok),message:String(result?.message||'').slice(0,180)}}).catch(()=>{});
        socket.send(JSON.stringify({type:'server-log',channel:'server',text:`ADM: ${result?.message|| (result?.ok?'OK':'Falha')}`,at:Date.now()}));
        return;
      }
      if(lower.startsWith('/')){
        socket.send(JSON.stringify({type:'server-log',channel:'server',text:'Comando desconhecido.',at:Date.now()}));
        return;
      }
      broadcast({
        type: 'chat',
        message: { id: crypto.randomUUID(), author: player.name, text:text.slice(0,160), at: Date.now(), channel:'default', system:false }
      });
    }
  };
  // V21.25.3: WebSocket preserva ordem transacional. Antes, handlers async
  // podiam executar em paralelo (ex.: hunt-stop/training-stop e character-exit),
  // abrindo uma janela para um checkpoint antigo vencer a corrida.
  let messageQueue=Promise.resolve();
  const dispatchMessage=raw=>{
    messageQueue=messageQueue.then(()=>handleMessage(raw)).catch(error=>{
      console.error('[MULTIPLAYER] Mensagem rejeitada por erro interno:',error);
      recordSecurityEvent({accountId:authAccount?.id||null,characterId:authorityRuntime?.state?.profile?.id||null,event:'WS_HANDLER_ERROR',ip,details:{message:String(error?.message||error).slice(0,300)}}).catch(()=>{});
      if(socket.readyState===1)socket.send(JSON.stringify({type:'server-error',message:'O servidor recusou a operacao.'}));
    });
  };
  socket.off('message',earlyMessageHandler);
  socket.on('message',dispatchMessage);
  for (const queued of earlyMessages) dispatchMessage(queued);

  socket.on('close', async (code) => {
    const player=players.get(connectionId);
    auditConnection('DISCONNECT',{
      connectionId,
      ip,
      userAgent,
      name:player?.name,
      profileId:player?.profileId,
      characterId:player?.characterId,
      level:player?.level,
      accountId:authAccount?.id || null
    });
    pvpManager.handleDisconnect(String(socket.characterSessionId||''));
    handleGuildBossDeparture(String(socket.characterSessionId||''));
    await messageQueue.catch(()=>{});
    const departingId=String(socket.characterSessionId||'');
    let protectionStarted=false;
    if(authorityRuntime && !serverDraining){
      const protectedResult=await startProtectionFarming({characterId:departingId,accountId:authAccount?.id||null,runtime:authorityRuntime}).catch(error=>{
        console.error('[PROTECTION] Falha ao iniciar farming de protecao:',error.message);
        return {ok:false};
      });
      protectionStarted=Boolean(protectedResult?.ok);
    }
    if(!protectionStarted && authorityRuntime){
      await authorityRuntime.destroy().catch(error=>console.error('[AUTHORITY] disconnect save:',error.message));
      if(socket.characterSessionId && activeAuthorityRuntimes.get(socket.characterSessionId)===authorityRuntime){
        activeAuthorityRuntimes.delete(socket.characterSessionId);
      }
    }
    if(socket.characterSessionId && activeCharacterSessions.get(socket.characterSessionId)===connectionId){
      activeCharacterSessions.delete(socket.characterSessionId);
    }
    const departingTrade=tradeSessionFor(departingId);
    if(departingTrade)closeTrade(departingTrade,'Trade encerrado porque um jogador desconectou.');
    tradeInvites.delete(departingId);
    for(const [targetId,invite] of [...tradeInvites.entries()])if(String(invite?.fromId||'')===departingId)tradeInvites.delete(targetId);
    const departingParty=partyForCharacter(departingId);
    if(departingParty){
      if(departingParty.leaderId===departingId)disbandParty(departingParty,'O líder desconectou e a Party foi encerrada.');
      else{departingParty.members.delete(departingId);clearPartyForMember(departingId);sendPartyState(departingParty);}
    }
    partyInvites.delete(departingId);
    players.delete(connectionId);
    publishPresence();
  });
});

process.once('SIGTERM',()=>{void gracefulShutdown('SIGTERM');});
process.once('SIGINT',()=>{void gracefulShutdown('SIGINT');});

try {
  const database = await initDatabase();
  console.log(`[DB] PostgreSQL conectado: ${database.host}:${database.port}/${database.database}`);
} catch (error) {
  console.error('[DB] Nao foi possivel iniciar o PostgreSQL:');
  console.error(error.message);
  console.error('Execute CONFIGURAR-POSTGRESQL.bat na pasta do jogo.');
  process.exit(1);
}

await paymentStartupDiagnostics().catch(error=>console.error('[MERCADO PAGO] Diagnostico inicial falhou:',error.message));

httpServer.listen(port,host,()=>{
  console.log(`DBO Idle Multiplayer ativo em http://${host}:${port}`);
  console.log(`WebSocket: ws://${host}:${port}/ws`);
  console.log(`Spawn multiplayer: ${HOME.x}, ${HOME.y}, ${HOME.z}`);
  console.log(`Banco: PostgreSQL ${dbConfigLabel()}`);
  console.log(`Log de conexoes: ${connectionLogPath}`);
});

function dbConfigLabel(){
  return 'dbo_idle (persistencia de contas/personagens ativa)';
}

// Shared Party boss position/HP is mirrored from the leader so every member
// fights the same creature in the same arena instead of independent copies.
setInterval(()=>{
  for(const party of parties.values()){
    if(!party.activeContent||party.activeContent.sharedDefeated)continue;
    const leader=activeAuthorityRuntimes.get(String(party.leaderId));
    const snap=leader?.partyBossSnapshot?.();if(!snap)continue;
    const shared={...snap};
    if(Number.isFinite(Number(party.activeContent.sharedHp)))shared.hp=Number(party.activeContent.sharedHp);
    if(Number.isFinite(Number(party.activeContent.sharedMaxHp)))shared.maxHp=Number(party.activeContent.sharedMaxHp);
    for(const id of party.members){
      if(String(id)===String(party.leaderId)||party.activeContent?.exitedMembers?.includes(String(id)))continue;
      activeAuthorityRuntimes.get(String(id))?.syncPartyBossState?.(shared,{notifyProgress:false,reward:false,silent:true});
    }
  }
},120);

setInterval(()=>{
  const now=Date.now();
  for(const party of parties.values()){
    if(party.activeContent?.type==='boss'&&Number(party.activeContent.deadlineAt||0)>0&&now>=Number(party.activeContent.deadlineAt)){
      for(const id of party.members){const rt=activeAuthorityRuntimes.get(String(id));rt?.stopPartyContent?.();rt?.setPosition?.(HOME);const pl=onlinePlayerByProfileId(id),sock=pl?socketByConnectionId(pl.id):null;if(sock?.readyState===1)sock.send(JSON.stringify({type:'party-event',event:'boss-timeout',message:'O tempo de 5 minutos do Boss acabou. A Party voltou ao PZ.'}));}
      party.activeContent=null;sendPartyState(party);continue;
    }
    if(party.activeContent&&['expedition','quest-guard'].includes(String(party.activeContent.type||''))&&Number(party.activeContent.deadlineAt||0)>0&&now>=Number(party.activeContent.deadlineAt)){
      for(const id of party.members){
        activeAuthorityRuntimes.get(String(id))?.expireProgressionQuestRuntime?.();
        const pl=onlinePlayerByProfileId(id),sock=pl?socketByConnectionId(pl.id):null;
        if(sock?.readyState===1)sock.send(JSON.stringify({type:'party-event',event:'progression-timeout',message:'O tempo de 5 minutos da Quest acabou. A Party voltou ao PZ e deverá recomeçar do início.'}));
      }
      party.activeContent=null;sendPartyState(party);continue;
    }
    if(party.activeContent)publishPartyTank(party);
  }
  for(const run of guildBossRuns.values())if(run.status==='active'){
    if(Number(run.deadlineAt||0)>0&&now>=Number(run.deadlineAt)){const def=guildBossDefinition(run);finishGuildBossRun(run,'lost',`O tempo de 5 minutos para derrotar ${def.name} terminou. A tentativa foi perdida.`).catch(error=>console.error('[GUILD BOSS] timeout:',error));continue;}
    publishGuildBossTank(run);
  }
},500);

setInterval(() => {
  const now = Date.now();
  let changed = false;

  for (const [id, item] of groundItems) {
    if ((item.expiresAt || item.droppedAt + GROUND_ITEM_LIFETIME_MS) <= now) {
      groundItems.delete(id);
      changed = true;
    }
  }
  if (changed) publishGroundLoot();
}, 1000);
