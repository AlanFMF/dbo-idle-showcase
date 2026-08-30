import {
  accountFromRequest, accountPayload, cancelRegistrationCode, createAccount, createCharacter,
  deleteCharacter, importLocalCharacters, loginAccount, logoutRequest,
  requestRegistrationCode, requestPasswordResetCode, cancelPasswordResetCode, resetAccountPassword, saveCharacter, sessionCookie,
  marketOverview, createMarketListing, buyMarketListing, cancelMarketListing,
  createMarketRequest, sellToMarketRequest, cancelMarketRequest,
  purchaseVipProduct, claimDailyReward, purchaseGamePassLevel, rankingOverview,
  guildOverview, guildRankingOverview, createGuild, joinGuild, leaveGuild, donateGuild,
  convertGuildPremiumToXp, decideGuildApplication, setGuildMemberRole,
  upgradeGuildTechnology, upgradeGuildBossBestiary, updateGuildSettings, kickGuildMember,
  summonGuildBoss, acceptGuildBoss
} from './database.js';
import { sendVerificationCode, sendPasswordResetCode } from './email.js';
import { paymentConfig, createPayment, paymentStatus, paymentHistory, verifyWebhook, fetchPayment, fetchOrder, reconcilePayment, reconcileOrder } from './payments.js';


const authAttempts=new Map();
const AUTH_WINDOW_MS=10*60*1000;
const AUTH_MAX_ATTEMPTS=12;
function authAllowed(ip){
  const now=Date.now();
  const key=String(ip||'desconhecido');
  let entry=authAttempts.get(key);
  if(!entry || now-entry.startedAt>AUTH_WINDOW_MS)entry={startedAt:now,count:0};
  entry.count+=1; authAttempts.set(key,entry);
  return entry.count<=AUTH_MAX_ATTEMPTS;
}
function clearAuthAttempts(ip){authAttempts.delete(String(ip||'desconhecido'))}

const verificationAttempts=new Map();
const VERIFICATION_WINDOW_MS=60*60*1000;
const VERIFICATION_MAX_PER_IP=12;
function verificationAllowed(ip){
  const now=Date.now(); const key=String(ip||'desconhecido');
  let entry=verificationAttempts.get(key);
  if(!entry || now-entry.startedAt>VERIFICATION_WINDOW_MS)entry={startedAt:now,count:0};
  entry.count+=1; verificationAttempts.set(key,entry);
  return entry.count<=VERIFICATION_MAX_PER_IP;
}

function sendJson(res,status,payload,headers={}){
  const body=JSON.stringify(payload);
  res.writeHead(status,{
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff',
    ...headers
  });
  res.end(body);
}
async function readJson(req,maxBytes=2_000_000){
  let total=0; const chunks=[];
  for await (const chunk of req){
    total+=chunk.length;
    if(total>maxBytes){const e=new Error('Payload muito grande.');e.status=413;throw e}
    chunks.push(chunk);
  }
  if(!chunks.length)return {};
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{const e=new Error('JSON invalido.');e.status=400;throw e}
}
function routePath(req){try{return new URL(req.url||'/','http://localhost').pathname}catch{return '/'}}
function requestIp(req){
  let remote=String(req.socket?.remoteAddress||'').replace(/^::ffff:/,'');
  if(remote==='::1')remote='127.0.0.1';
  if(remote==='127.0.0.1'){
    const forwarded=String(req.headers?.['x-forwarded-for']||'').split(',')[0].trim();
    if(forwarded)remote=forwarded.replace(/^::ffff:/,'');
  }
  return remote;
}

export async function handleApi(req,res,hooks={}){
  const pathname=routePath(req);
  if(!pathname.startsWith('/api/'))return false;
  try{
    if(pathname==='/api/health' && req.method==='GET'){
      sendJson(res,200,{ok:true,database:'postgresql'});return true;
    }
    if(pathname==='/api/auth/register/request-code' && req.method==='POST'){
      const ip=requestIp(req);
      if(!verificationAllowed(ip)){sendJson(res,429,{ok:false,message:'Muitos codigos solicitados deste IP. Tente novamente mais tarde.'});return true}
      const body=await readJson(req);
      const prepared=await requestRegistrationCode({email:body.email,ip});
      if(!prepared.ok){sendJson(res,prepared.status,prepared);return true}
      try{
        await sendVerificationCode(prepared.email,prepared.code);
      }catch(error){
        await cancelRegistrationCode(prepared.email).catch(()=>{});
        console.error('[EMAIL] Falha ao enviar codigo:',error.message);
        sendJson(res,503,{ok:false,message:'Nao foi possivel enviar o codigo agora. Verifique a configuracao SMTP do servidor.'});return true;
      }
      sendJson(res,200,{ok:true,email:prepared.email,expiresInSeconds:prepared.expiresInSeconds,message:'Codigo enviado para o seu e-mail.'});return true;
    }
    if(pathname==='/api/auth/password/request-code' && req.method==='POST'){
      const ip=requestIp(req);
      if(!verificationAllowed(ip)){sendJson(res,429,{ok:false,message:'Muitas solicitacoes deste IP. Tente novamente mais tarde.'});return true}
      const body=await readJson(req);
      const prepared=await requestPasswordResetCode({email:body.email,ip});
      if(!prepared.ok){sendJson(res,prepared.status,prepared);return true}
      if(prepared.send){
        try{await sendPasswordResetCode(prepared.email,prepared.code)}
        catch(error){
          await cancelPasswordResetCode(prepared.email).catch(()=>{});
          console.error('[EMAIL] Falha ao enviar recuperacao de senha:',error.message);
          sendJson(res,503,{ok:false,message:'Nao foi possivel enviar o codigo agora. Tente novamente em alguns minutos.'});return true;
        }
      }
      sendJson(res,200,{ok:true,email:prepared.email,expiresInSeconds:prepared.expiresInSeconds,message:'Se existir uma conta com este e-mail, enviamos um codigo de recuperacao.'});return true;
    }
    if(pathname==='/api/auth/password/reset' && req.method==='POST'){
      const ip=requestIp(req);
      if(!authAllowed(ip)){sendJson(res,429,{ok:false,message:'Muitas tentativas. Aguarde alguns minutos.'});return true}
      const body=await readJson(req);
      const result=await resetAccountPassword({email:body.email,password:body.password,code:body.code});
      if(!result.ok){sendJson(res,result.status,result);return true}
      clearAuthAttempts(ip);
      sendJson(res,200,result,{'Set-Cookie':sessionCookie('',req,{clear:true})});return true;
    }
    if(pathname==='/api/auth/register' && req.method==='POST'){
      const ip=requestIp(req);
      if(!authAllowed(ip)){sendJson(res,429,{ok:false,message:'Muitas tentativas. Aguarde alguns minutos.'});return true}
      const body=await readJson(req);
      const result=await createAccount({
        email:body.email,password:body.password,code:body.code,ip,userAgent:req.headers['user-agent']||''
      });
      if(!result.ok){sendJson(res,result.status,result);return true}
      clearAuthAttempts(ip);
      const account=await accountPayload(result.accountId);
      sendJson(res,201,{ok:true,account},{'Set-Cookie':sessionCookie(result.session.token,req)});return true;
    }
    if(pathname==='/api/auth/login' && req.method==='POST'){
      const ip=requestIp(req);
      if(!authAllowed(ip)){sendJson(res,429,{ok:false,message:'Muitas tentativas. Aguarde alguns minutos.'});return true}
      const body=await readJson(req);
      const result=await loginAccount({
        email:body.email,password:body.password,ip,userAgent:req.headers['user-agent']||''
      });
      if(!result.ok){sendJson(res,result.status,result);return true}
      clearAuthAttempts(ip);
      const account=await accountPayload(result.accountId);
      sendJson(res,200,{ok:true,account},{'Set-Cookie':sessionCookie(result.session.token,req)});return true;
    }
    if(pathname==='/api/auth/logout' && req.method==='POST'){
      await logoutRequest(req);
      sendJson(res,200,{ok:true},{'Set-Cookie':sessionCookie('',req,{clear:true})});return true;
    }
    // V21: webhook Mercado Pago precisa ser público; a autenticidade é validada por HMAC.
    if(pathname==='/api/payments/mercadopago/webhook' && req.method==='POST'){
      const body=await readJson(req,500_000);
      const url=new URL(req.url||'/','http://localhost');
      const dataId=String(url.searchParams.get('data.id')||body?.data?.id||'');
      const requireSignature=String(process.env.MERCADOPAGO_VERIFY_WEBHOOK_SIGNATURE||'true').toLowerCase()!=='false';
      if(requireSignature && !verifyWebhook(req,dataId)){sendJson(res,401,{ok:false,message:'Assinatura webhook inválida.'});return true}
      // V21.0.2: aceita notificações da Orders API atual e também eventos legacy
      // de payment durante a transição. O provedor sempre é consultado antes do crédito.
      if(dataId){try{
        const isOrder=/^ORD/i.test(dataId)||String(body?.type||body?.action||'').toLowerCase().includes('order');
        const provider=isOrder?await fetchOrder(dataId):await fetchPayment(dataId);
        const result=isOrder?await reconcileOrder(provider):await reconcilePayment(provider);
        if(result.credited&&result.accountId)await hooks.applyAccountPremiumPoints?.(result.accountId,result.premiumPoints);
      }catch(error){console.error('[MERCADO PAGO] Falha ao reconciliar webhook:',error.message)}}
      sendJson(res,200,{ok:true});return true;
    }
    const auth=await accountFromRequest(req);
    if(!auth){sendJson(res,401,{ok:false,message:'Sessao expirada. Entre novamente.'});return true}

    if(pathname==='/api/rankings' && req.method==='GET'){
      const url=new URL(req.url||'/','http://localhost');
      const limit=Math.max(1,Math.min(250,Math.trunc(Number(url.searchParams.get('limit')||100))));
      sendJson(res,200,await rankingOverview(limit));return true;
    }
    if(pathname==='/api/guild/ranking' && req.method==='GET'){
      const url=new URL(req.url||'/','http://localhost');
      const limit=Math.max(1,Math.min(250,Math.trunc(Number(url.searchParams.get('limit')||100))));
      sendJson(res,200,await guildRankingOverview(limit));return true;
    }

    if(pathname==='/api/payments/config' && req.method==='GET'){sendJson(res,200,{ok:true,...paymentConfig()});return true;}
    if(pathname==='/api/payments/mercadopago/create' && req.method==='POST'){
      const body=await readJson(req,500_000);
      try{const result=await createPayment(auth,String(body.characterId||''),Number(body.ppAmount),body.paymentData||{});if(result.credited)await hooks.applyAccountPremiumPoints?.(auth.id,result.premiumPoints);sendJson(res,201,result);}catch(error){sendJson(res,error.status||400,{ok:false,message:error.message,details:process.env.MERCADOPAGO_MODE==='test'?error.details:undefined});}return true;
    }
    const paymentMatch=pathname.match(/^\/api\/payments\/([0-9a-f-]{36})$/i);
    if(paymentMatch && req.method==='GET'){const result=await paymentStatus(auth.id,paymentMatch[1]);sendJson(res,result.ok?200:(result.statusCode||404),result);return true;}
    if(pathname==='/api/payments/history' && req.method==='GET'){sendJson(res,200,await paymentHistory(auth.id));return true;}


    // V20.66 - Mercado Global. Antes de uma mutacao, o runtime online e
    // descarregado no banco; depois os states alterados voltam aos runtimes.
    if(pathname==='/api/market' && req.method==='GET'){
      const url=new URL(req.url||'/','http://localhost');const characterId=String(url.searchParams.get('characterId')||'');
      if(!/^[0-9a-f-]{36}$/i.test(characterId)){sendJson(res,400,{ok:false,message:'Personagem invalido.'});return true}
      await hooks.beforeMarketChange?.(characterId);
      const result=await marketOverview(auth.id,characterId);
      if(result.changedStates)await hooks.applyMarketStates?.(result.changedStates);
      sendJson(res,result.ok?200:(result.status||400),result);return true;
    }
    if(pathname==='/api/market/listings' && req.method==='POST'){
      const body=await readJson(req);const characterId=String(body.characterId||'');await hooks.beforeMarketChange?.(characterId);
      const result=await createMarketListing(auth.id,characterId,body);if(result.changedStates)await hooks.applyMarketStates?.(result.changedStates);sendJson(res,result.ok?201:(result.status||400),result);return true;
    }
    let marketMatch=pathname.match(/^\/api\/market\/listings\/([0-9a-f-]{36})\/(buy|cancel)$/i);
    if(marketMatch && req.method==='POST'){
      const body=await readJson(req);const characterId=String(body.characterId||'');await hooks.beforeMarketChange?.(characterId);
      const result=marketMatch[2]==='buy'?await buyMarketListing(auth.id,characterId,marketMatch[1]):await cancelMarketListing(auth.id,characterId,marketMatch[1]);
      if(result.changedStates)await hooks.applyMarketStates?.(result.changedStates);sendJson(res,result.ok?200:(result.status||400),result);return true;
    }
    if(pathname==='/api/market/requests' && req.method==='POST'){
      const body=await readJson(req);const characterId=String(body.characterId||'');await hooks.beforeMarketChange?.(characterId);
      const result=await createMarketRequest(auth.id,characterId,body);if(result.changedStates)await hooks.applyMarketStates?.(result.changedStates);sendJson(res,result.ok?201:(result.status||400),result);return true;
    }
    marketMatch=pathname.match(/^\/api\/market\/requests\/([0-9a-f-]{36})\/(sell|cancel)$/i);
    if(marketMatch && req.method==='POST'){
      const body=await readJson(req);const characterId=String(body.characterId||'');await hooks.beforeMarketChange?.(characterId);
      const result=marketMatch[2]==='sell'?await sellToMarketRequest(auth.id,characterId,marketMatch[1],body):await cancelMarketRequest(auth.id,characterId,marketMatch[1]);
      if(result.changedStates)await hooks.applyMarketStates?.(result.changedStates);sendJson(res,result.ok?200:(result.status||400),result);return true;
    }

    // V21.8.0 - Guilds. Assim como no Market, toda mutacao descarrega o
    // runtime online antes de mexer em Gold/PP e reaplica os states alterados
    // depois da transacao para evitar sobrescrita por um snapshot antigo.
    if(pathname==='/api/guild' && req.method==='GET'){
      const url=new URL(req.url||'/','http://localhost');const characterId=String(url.searchParams.get('characterId')||'');
      if(!/^[0-9a-f-]{36}$/i.test(characterId)){sendJson(res,400,{ok:false,message:'Personagem invalido.'});return true}
      await hooks.beforeMarketChange?.(characterId);const result=await guildOverview(auth.id,characterId);if(result.changedStates)await hooks.applyMarketStates?.(result.changedStates);sendJson(res,result.ok?200:(result.status||400),result);return true;
    }
    if(pathname==='/api/guild/create' && req.method==='POST'){
      const body=await readJson(req);const characterId=String(body.characterId||'');await hooks.beforeMarketChange?.(characterId);const result=await createGuild(auth.id,characterId,body);if(result.changedStates)await hooks.applyMarketStates?.(result.changedStates);if(result.ok&&result.accountId)await hooks.applyAccountPremiumPoints?.(result.accountId,result.premiumPoints);sendJson(res,result.ok?201:(result.status||400),result);return true;
    }
    if(pathname==='/api/guild/join' && req.method==='POST'){
      const body=await readJson(req);const characterId=String(body.characterId||'');await hooks.beforeMarketChange?.(characterId);const result=await joinGuild(auth.id,characterId,String(body.guildId||''));if(result.changedStates)await hooks.applyMarketStates?.(result.changedStates);sendJson(res,result.ok?200:(result.status||400),result);return true;
    }
    if(pathname==='/api/guild/application' && req.method==='POST'){
      const body=await readJson(req);const characterId=String(body.characterId||'');await hooks.beforeMarketChange?.(characterId);const result=await decideGuildApplication(auth.id,characterId,String(body.targetCharacterId||''),String(body.decision||'approve'));if(result.changedStates)await hooks.applyMarketStates?.(result.changedStates);sendJson(res,result.ok?200:(result.status||400),result);return true;
    }
    if(pathname==='/api/guild/role' && req.method==='POST'){
      const body=await readJson(req);const characterId=String(body.characterId||'');await hooks.beforeMarketChange?.(characterId);const result=await setGuildMemberRole(auth.id,characterId,String(body.targetCharacterId||''),String(body.role||''));sendJson(res,result.ok?200:(result.status||400),result);return true;
    }
    if(pathname==='/api/guild/leave' && req.method==='POST'){
      const body=await readJson(req);const characterId=String(body.characterId||'');await hooks.beforeMarketChange?.(characterId);const result=await leaveGuild(auth.id,characterId);if(result.changedStates)await hooks.applyMarketStates?.(result.changedStates);sendJson(res,result.ok?200:(result.status||400),result);return true;
    }
    if(pathname==='/api/guild/donate' && req.method==='POST'){
      const body=await readJson(req);const characterId=String(body.characterId||'');await hooks.beforeMarketChange?.(characterId);const result=await donateGuild(auth.id,characterId,body);if(result.changedStates)await hooks.applyMarketStates?.(result.changedStates);if(result.ok&&body.currency==='premium'&&result.accountId)await hooks.applyAccountPremiumPoints?.(result.accountId,result.premiumPoints);sendJson(res,result.ok?200:(result.status||400),result);return true;
    }
    if(pathname==='/api/guild/convert-pp' && req.method==='POST'){
      const body=await readJson(req);const characterId=String(body.characterId||'');await hooks.beforeMarketChange?.(characterId);const result=await convertGuildPremiumToXp(auth.id,characterId,body);if(result.changedStates)await hooks.applyMarketStates?.(result.changedStates);sendJson(res,result.ok?200:(result.status||400),result);return true;
    }
    if(pathname==='/api/guild/technology' && req.method==='POST'){
      const body=await readJson(req);const characterId=String(body.characterId||'');await hooks.beforeMarketChange?.(characterId);const result=await upgradeGuildTechnology(auth.id,characterId,String(body.technologyId||''));if(result.changedStates)await hooks.applyMarketStates?.(result.changedStates);sendJson(res,result.ok?200:(result.status||400),result);return true;
    }
    if(pathname==='/api/guild/boss-bestiary/upgrade' && req.method==='POST'){
      const body=await readJson(req);const characterId=String(body.characterId||'');await hooks.beforeMarketChange?.(characterId);const result=await upgradeGuildBossBestiary(auth.id,characterId,String(body.key||''));if(result.changedStates)await hooks.applyMarketStates?.(result.changedStates);sendJson(res,result.ok?200:(result.status||400),result);return true;
    }
    if(pathname==='/api/guild/boss/summon' && req.method==='POST'){
      const body=await readJson(req);const characterId=String(body.characterId||'');await hooks.beforeMarketChange?.(characterId);const result=await summonGuildBoss(auth.id,characterId,body);if(result.changedStates)await hooks.applyMarketStates?.(result.changedStates);if(result.ok)await hooks.onGuildBossSummoned?.(result);sendJson(res,result.ok?200:(result.status||400),result);return true;
    }
    if(pathname==='/api/guild/boss/accept' && req.method==='POST'){
      const body=await readJson(req);const characterId=String(body.characterId||'');const result=await acceptGuildBoss(auth.id,characterId,String(body.runId||''));if(result.ok)await hooks.onGuildBossAccepted?.(result);sendJson(res,result.ok?200:(result.status||400),result);return true;
    }
    if(pathname==='/api/guild/settings' && req.method==='POST'){
      const body=await readJson(req);const characterId=String(body.characterId||'');await hooks.beforeMarketChange?.(characterId);const result=await updateGuildSettings(auth.id,characterId,body);sendJson(res,result.ok?200:(result.status||400),result);return true;
    }
    if(pathname==='/api/guild/kick' && req.method==='POST'){
      const body=await readJson(req);const characterId=String(body.characterId||'');await hooks.beforeMarketChange?.(characterId);const result=await kickGuildMember(auth.id,characterId,String(body.targetCharacterId||''));if(result.changedStates)await hooks.applyMarketStates?.(result.changedStates);sendJson(res,result.ok?200:(result.status||400),result);return true;
    }

    if(pathname==='/api/vip/purchase' && req.method==='POST'){
      const body=await readJson(req);const characterId=String(body.characterId||'');await hooks.beforeMarketChange?.(characterId);
      const result=await purchaseVipProduct(auth.id,characterId,{productId:body.productId,newName:body.newName||''});
      if(result.state)await hooks.applyMarketStates?.({[characterId]:result.state});sendJson(res,result.ok?200:(result.status||400),result);return true;
    }
    if(pathname==='/api/vip/daily-claim' && req.method==='POST'){
      const body=await readJson(req);const characterId=String(body.characterId||'');await hooks.beforeMarketChange?.(characterId);
      const result=await claimDailyReward(auth.id,characterId);if(result.state)await hooks.applyMarketStates?.({[characterId]:result.state});sendJson(res,result.ok?200:(result.status||400),result);return true;
    }
    if(pathname==='/api/vip/game-pass-level' && req.method==='POST'){
      const body=await readJson(req);const characterId=String(body.characterId||'');await hooks.beforeMarketChange?.(characterId);
      const result=await purchaseGamePassLevel(auth.id,characterId);if(result.state)await hooks.applyMarketStates?.({[characterId]:result.state});sendJson(res,result.ok?200:(result.status||400),result);return true;
    }

    if(pathname==='/api/account' && req.method==='GET'){
      sendJson(res,200,{ok:true,account:await accountPayload(auth.id)});return true;
    }
    if(pathname==='/api/characters' && req.method==='POST'){
      const body=await readJson(req);
      const result=await createCharacter(auth.id,{name:body.name,characterId:body.characterId,state:body.state});
      sendJson(res,result.ok?201:result.status,result);return true;
    }
    if(pathname==='/api/account/import-local' && req.method==='POST'){
      // V20.47: importacao de save antigo so pode ser iniciada localmente no PC do servidor.
      // Jogadores remotos nao podem usar esse endpoint para injetar progressao arbitraria.
      const ip=requestIp(req);
      if(ip!=='127.0.0.1' && ip!=='::1'){
        sendJson(res,403,{ok:false,message:'Importacao de save legado so e permitida localmente no servidor.'});return true;
      }
      const body=await readJson(req,5_000_000);
      const result=await importLocalCharacters(auth.id,body.characters);
      sendJson(res,200,{ok:true,...result,account:await accountPayload(auth.id)});return true;
    }
    const match=pathname.match(/^\/api\/characters\/([0-9a-f-]{36})(?:\/state)?$/i);
    if(match && req.method==='DELETE'){
      const ok=await deleteCharacter(auth.id,match[1]);
      sendJson(res,ok?200:404,{ok,message:ok?'Personagem excluido.':'Personagem nao encontrado.'});return true;
    }
    if(match && pathname.endsWith('/state') && req.method==='PUT'){
      const body=await readJson(req,5_000_000);
      const result=await saveCharacter(auth.id,match[1],body.state);
      sendJson(res,result.ok?200:result.status,result);return true;
    }
    sendJson(res,404,{ok:false,message:'API nao encontrada.'});return true;
  }catch(error){
    console.error('[API]',error);
    sendJson(res,error.status||500,{ok:false,message:error.status?error.message:'Erro interno do servidor.'});
    return true;
  }
}
