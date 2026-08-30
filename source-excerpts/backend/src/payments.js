import crypto from 'node:crypto';
import { pool } from './database.js';
import { envRuntimeDiagnostics } from './env.js';
import { paymentTypeFromForm } from './payment-method.js';
import { DONATION_MIN_BRL, DONATION_STEP_BRL, PREMIUM_POINTS_PER_BRL, DONATION_BONUS_TIERS, donationQuote } from '../../src/core/payments/pp-purchase.js';

const API='https://api.mercadopago.com';
const token=()=>String(process.env.MERCADOPAGO_ACCESS_TOKEN||'').trim();
const mode=()=>String(process.env.MERCADOPAGO_MODE||'test').trim().toLowerCase();
const money=v=>Number(Number(v||0).toFixed(2));

export function ppPricingTiers(){
  return [{minBrl:DONATION_MIN_BRL,rateBrlPer10Pp:1,bonusPercent:0},...DONATION_BONUS_TIERS.slice().reverse().map(tier=>({minBrl:tier.minBrl,rateBrlPer10Pp:1,bonusPercent:tier.percent}))];
}

export function paymentConfig(){
  return {
    enabled:Boolean(token()&&process.env.MERCADOPAGO_PUBLIC_KEY),
    publicKey:String(process.env.MERCADOPAGO_PUBLIC_KEY||''),
    mode:mode(),
    pricingMode:'fixed-brl',
    minBrl:DONATION_MIN_BRL,
    stepBrl:DONATION_STEP_BRL,
    premiumPointsPerBrl:PREMIUM_POINTS_PER_BRL,
    bonusTiers:DONATION_BONUS_TIERS,
    providerFlow:'orders-api+payments-api-prepaid+device-id',
    production:mode()==='production'
  };
}

export function ppPrice(basePp){
  const pp=Math.trunc(Number(basePp));
  if(!Number.isSafeInteger(pp)||pp<DONATION_MIN_BRL*PREMIUM_POINTS_PER_BRL||pp%PREMIUM_POINTS_PER_BRL){
    throw Object.assign(new Error('Valor da doação inválido. Use valores inteiros a partir de R$ 10,00.'),{status:400});
  }
  return donationQuote(pp/PREMIUM_POINTS_PER_BRL).amountBrl;
}

function quoteFromBasePp(basePp){
  const amount=ppPrice(basePp);
  return donationQuote(amount);
}

export async function paymentStartupDiagnostics(){
  const env=envRuntimeDiagnostics();
  console.log('[MERCADO PAGO] Diagnostico de configuracao:');
  console.log(`[MERCADO PAGO] .env: ${env.envFileFound?env.envFile:'NAO ENCONTRADO'}`);
  console.log(`[MERCADO PAGO] modo=${env.paymentMode} publicKey=${env.publicKey.configured?'OK':'AUSENTE'}(${env.publicKey.source},sha256:${env.publicKey.fingerprint},len:${env.publicKey.length}) accessToken=${env.accessToken.configured?'OK':'AUSENTE'}(${env.accessToken.source},sha256:${env.accessToken.fingerprint},len:${env.accessToken.length}) webhook=${env.webhookSecret.configured?'OK':'AUSENTE'}(${env.webhookSecret.source},sha256:${env.webhookSecret.fingerprint},len:${env.webhookSecret.length})`);
  if(!env.accessToken.configured){console.warn('[MERCADO PAGO] API: NAO TESTADA - Access Token ausente.');return {ok:false,reason:'missing-token',env};}
  try{
    const methods=await mpFetch('/v1/payment_methods',{method:'GET'});
    const list=Array.isArray(methods)?methods:[];
    console.log(`[MERCADO PAGO] API autenticada: OK (${list.length} meios retornados).`);
    console.log('[MERCADO PAGO] Observacao: este teste valida autenticacao do token sem criar cobranca.');
    return {ok:true,env,paymentMethods:list.length};
  }catch(error){
    console.error(`[MERCADO PAGO] API autenticada: FALHOU - ${error.message}`);
    if(error.providerStatus===401)console.error('[MERCADO PAGO] O Access Token carregado foi recusado antes de qualquer PIX/cartao. Confira o fingerprint acima com a instalacao esperada.');
    return {ok:false,env,status:error.providerStatus||error.status||0,message:error.message};
  }
}

function providerErrorMessage(status,data){
  const bits=[];
  if(data?.message)bits.push(String(data.message));
  else if(data?.error)bits.push(String(data.error));
  const causes=Array.isArray(data?.cause)?data.cause:[];
  for(const c of causes.slice(0,3)){
    const code=String(c?.code??'').trim();
    const desc=String(c?.description||c?.message||'').trim();
    const part=[code,desc].filter(Boolean).join(' - ');
    if(part&&!bits.includes(part))bits.push(part);
  }
  return bits.length?`Mercado Pago (${status}): ${bits.join(' | ')}`:`Mercado Pago HTTP ${status}`;
}

function safeEventMetadata(value={}){
  const out={};
  for(const [k,v] of Object.entries(value||{})){
    if(/token|secret|authorization|card|qr_code/i.test(k))continue;
    if(v==null||['string','number','boolean'].includes(typeof v))out[k]=typeof v==='string'?v.slice(0,250):v;
  }
  return out;
}

async function auditPaymentEvent({paymentId=null,accountId=null,eventType,providerStatus='',providerStatusDetail='',providerOrderId='',providerPaymentId='',amount=null,metadata={}}){
  try{
    await pool.query(`INSERT INTO premium_point_payment_events(payment_id,account_id,event_type,provider_status,provider_status_detail,provider_order_id,provider_payment_id,amount_brl,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,[paymentId,accountId,String(eventType||'unknown').slice(0,80),String(providerStatus||'').slice(0,60),String(providerStatusDetail||'').slice(0,120),String(providerOrderId||'').slice(0,100),String(providerPaymentId||'').slice(0,100),amount==null?null:money(amount),JSON.stringify(safeEventMetadata(metadata))]);
  }catch(error){console.warn('[MERCADO PAGO] Auditoria:',error.message)}
}

function uiStatus(status,detail,credited=false){
  if(credited)return 'approved';
  const s=String(status||'').toLowerCase(),d=String(detail||'').toLowerCase();
  if(s==='processed'&&(d==='accredited'||!d))return 'approved';
  if(['failed','rejected'].includes(s)||/reject|denied|failure|failed/.test(d))return 'rejected';
  if(['cancelled','canceled'].includes(s)||/cancel/.test(d))return 'cancelled';
  if(['expired'].includes(s)||/expir/.test(d))return 'expired';
  if(['refunded','charged_back'].includes(s)||/refund|chargeback/.test(d))return 'reversed';
  return 'pending';
}

async function mpFetch(path,options={}){
  if(!token())throw Object.assign(new Error('Mercado Pago não configurado.'),{status:503});
  const r=await fetch(API+path,{...options,headers:{Authorization:`Bearer ${token()}`,'Content-Type':'application/json',Accept:'application/json',...(options.headers||{})}});
  const text=await r.text();let data={};try{data=text?JSON.parse(text):{}}catch{data={raw:text}}
  if(!r.ok){
    const requestId=String(r.headers.get('x-request-id')||r.headers.get('x-correlation-id')||'').trim();
    const baseMessage=providerErrorMessage(r.status,data);
    const err=new Error(requestId?`${baseMessage} [request ${requestId}]`:baseMessage);
    err.status=502;err.providerStatus=r.status;err.details=data;err.providerRequestId=requestId;
    const safeRaw=(!data?.message&&!data?.error&&!data?.cause&&text)?String(text).slice(0,500):'';
    console.error('[MERCADO PAGO]',r.status,JSON.stringify({message:data?.message,error:data?.error,cause:data?.cause,status:data?.status,requestId,raw:safeRaw||undefined}));
    throw err;
  }
  return data;
}

function validEmail(value){return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value||'').trim())}
function paymentMethodFromForm(formData={}){return String(formData.payment_method_id||formData.paymentMethodId||formData.payment_method?.id||'').trim()}
function deviceSessionIdFromForm(formData={}){
  const raw=String(formData._deviceSessionId||formData.deviceSessionId||'').trim();
  if(!raw||raw.length>2048||/[\r\n]/.test(raw))return '';
  return raw;
}
function deviceSessionSourceFromForm(formData={}){
  return String(formData._deviceSessionSource||'').trim().replace(/[^A-Za-z0-9_.-]/g,'').slice(0,60);
}
function cardholderNameFromForm(formData={}){
  return String(formData._cardholderName||'').trim().replace(/\s+/g,' ').slice(0,120);
}
function cleanPayer(formData,account){
  const source=(formData&&typeof formData.payer==='object'&&formData.payer)||{};
  const submittedEmail=String(source.email||'').trim();
  const fallback=String(account.email||'').trim();
  const email=validEmail(submittedEmail)?submittedEmail:fallback;
  if(!validEmail(email))throw Object.assign(new Error('Informe um e-mail válido para o pagador.'),{status:400});
  const payer={email};
  if(source.identification?.type&&source.identification?.number){
    payer.identification={type:String(source.identification.type),number:String(source.identification.number).replace(/\D/g,'')};
  }
  if(source.first_name)payer.first_name=String(source.first_name).slice(0,60);
  if(source.last_name)payer.last_name=String(source.last_name).slice(0,60);
  if(!payer.first_name&&!payer.last_name){
    const cardholderName=cardholderNameFromForm(formData);
    if(cardholderName){
      const parts=cardholderName.split(' ').filter(Boolean);
      payer.first_name=String(parts.shift()||'').slice(0,60);
      if(parts.length)payer.last_name=parts.join(' ').slice(0,60);
    }
  }
  return payer;
}

async function createPrepaidPayment({external,idem,amount,quote,method,payer,formData,accountId,deviceSessionSource}){
  const installments=Math.max(1,Math.min(Number(process.env.PAYMENTS_MAX_INSTALLMENTS||1)||1,Number(formData.installments)||1));
  const deviceSessionId=deviceSessionIdFromForm(formData);
  const body={
    transaction_amount:amount,
    token:String(formData.token||''),
    description:`DBO IDLE - ${quote.totalPp} Premium Points`,
    installments,
    payment_method_id:method,
    external_reference:external,
    payer
  };
  if(!body.token)throw Object.assign(new Error('Token do cartão ausente. Preencha o cartão novamente.'),{status:400});
  console.log(`[MERCADO PAGO] Payments API: criando cartao pre-pago | external=${external} | valor=${amount.toFixed(2)}`);
  const prepaidHeaders={'X-Idempotency-Key':idem};
  if(deviceSessionId)prepaidHeaders['X-meli-session-id']=deviceSessionId;
  const payment=await mpFetch('/v1/payments',{method:'POST',headers:prepaidHeaders,body:JSON.stringify(body)});
  await pool.query(`UPDATE premium_point_payments SET mercadopago_payment_id=$2,payment_method=$3,status=$4,status_detail=$5,updated_at=now() WHERE id=$1`,[
    external,String(payment.id||''),method,String(payment.status||'processing'),String(payment.status_detail||'')
  ]);
  await auditPaymentEvent({paymentId:external,accountId,eventType:'payment_created',providerStatus:String(payment.status||''),providerStatusDetail:String(payment.status_detail||''),providerPaymentId:String(payment.id||''),amount,metadata:{method,paymentType:'prepaid_card',providerFlow:'payments-api',deviceIdPresent:Boolean(deviceSessionId),deviceIdSource:deviceSessionSource,mode:mode()}});
  const credited=await reconcilePayment(payment);
  console.log(`[MERCADO PAGO] Pagamento pre-pago criado: ${String(payment.id||'SEM_ID')} | status=${String(payment.status||'')} | detail=${String(payment.status_detail||'')}`);
  return {
    ok:true,id:external,providerOrderId:'',providerPaymentId:String(payment.id||''),
    status:uiStatus(payment.status,payment.status_detail,credited.credited),providerStatus:String(payment.status||'processing'),statusDetail:String(payment.status_detail||''),
    ppAmount:quote.totalPp,basePp:quote.basePp,bonusPp:quote.bonusPp,bonusPercent:quote.bonusPercent,amount,
    qrCode:null,qrCodeBase64:null,ticketUrl:null,credited:credited.credited,premiumPoints:credited.premiumPoints
  };
}

export async function createPayment(account,characterId,ppAmount,formData={}){
  if(!token())throw Object.assign(new Error('Mercado Pago não configurado.'),{status:503});
  const quote=quoteFromBasePp(ppAmount);
  const amount=quote.amountBrl, amountText=amount.toFixed(2), external=crypto.randomUUID(), idem=crypto.randomUUID();
  const char=(await pool.query('SELECT id FROM characters WHERE id=$1 AND account_id=$2',[characterId,account.id])).rows[0];
  if(!char)throw Object.assign(new Error('Personagem inválido.'),{status:404});

  const method=paymentMethodFromForm(formData);
  if(!method)throw Object.assign(new Error('Método de pagamento inválido.'),{status:400});
  const payer=cleanPayer(formData,account);
  const isPix=method==='pix';
  const submittedType=paymentTypeFromForm(formData);
  const paymentType=isPix?'bank_transfer':(['credit_card','prepaid_card','debit_card'].includes(submittedType)?submittedType:'credit_card');
  const isPrepaid=paymentType==='prepaid_card';
  const deviceSessionId=deviceSessionIdFromForm(formData);
  const deviceSessionSource=deviceSessionSourceFromForm(formData);
  if(!isPix&&!deviceSessionId){
    console.warn(`[MERCADO PAGO] Cartao bloqueado antes do provedor: Device ID ausente | method=${method} | type=${paymentType}`);
    throw Object.assign(new Error('Validação de segurança do Mercado Pago indisponível. Reabra o checkout e tente novamente. Se usar bloqueador de conteúdo, permita scripts do Mercado Pago.'),{status:400,code:'mercadopago_device_id_missing'});
  }

  // Checkout Transparente V21.0.5: uma única integração via Orders API.
  // No ambiente de teste usamos exatamente os pagadores reservados pelo sandbox
  // documentados pelo Mercado Pago para cada fluxo.
  if(mode()==='test'){
    if(isPix){payer.email='test_user_br@testuser.com';payer.first_name='APRO';}
    else payer.email='test@testuser.com';
  }

  const paymentMethod={
    id:method,
    type:paymentType
  };
  if(!isPix){
    if(!formData.token)throw Object.assign(new Error('Token do cartão ausente. Preencha o cartão novamente.'),{status:400});
    paymentMethod.token=String(formData.token);
    paymentMethod.installments=Math.max(1,Math.min(Number(process.env.PAYMENTS_MAX_INSTALLMENTS||1)||1,Number(formData.installments)||1));
  }

  const body={
    type:'online',
    processing_mode:'automatic',
    total_amount:amountText,
    external_reference:external,
    payer,
    transactions:{payments:[{amount:amountText,payment_method:paymentMethod}]}
  };
  if(isPix){
    const minutes=Math.max(30,Math.min(60*24*30,Number(process.env.PIX_EXPIRATION_MINUTES||30)||30));
    body.transactions.payments[0].expiration_time=`PT${minutes}M`;
  }

  await pool.query(`INSERT INTO premium_point_payments(id,account_id,character_id,external_reference,premium_points,amount_brl,payment_method,status) VALUES($1,$2,$3,$4,$5,$6,$7,'created')`,[external,account.id,characterId,external,quote.totalPp,amount,method]);
  await auditPaymentEvent({paymentId:external,accountId:account.id,eventType:'checkout_created',providerStatus:'created',amount,metadata:{method,paymentType,basePp:quote.basePp,bonusPp:quote.bonusPp,bonusPercent:quote.bonusPercent,totalPp:quote.totalPp,deviceIdPresent:Boolean(deviceSessionId),deviceIdSource:deviceSessionSource,mode:mode()}});

  // V21.25.12: o Payment Brick identifica cartoes pre-pagos como prepaid_card,
  // mas a referencia atual da Orders API nao documenta esse valor no campo
  // transactions.payments[].payment_method.type. Para pre-pagos usamos a Payments API,
  // fluxo documentado pelo proprio Payment Brick e que nao exige enviar payment_type_id.
  if(isPrepaid){
    try{
      return await createPrepaidPayment({external,idem,amount,quote,method,payer,formData,accountId:account.id,deviceSessionSource});
    }catch(error){
      await pool.query(`UPDATE premium_point_payments SET status='error',status_detail=$2,updated_at=now() WHERE id=$1`,[external,String(error.message||'').slice(0,1000)]).catch(()=>{});
      await auditPaymentEvent({paymentId:external,accountId:account.id,eventType:'provider_error',providerStatus:String(error.providerStatus||error.status||''),providerStatusDetail:String(error.message||''),amount,metadata:{method,paymentType,providerFlow:'payments-api',providerRequestId:error.providerRequestId||'',mode:mode()}});
      throw error;
    }
  }

  let order;
  try{
    console.log(`[MERCADO PAGO] Orders API: criando ${isPix?'PIX':'cartao'} | external=${external} | valor=${amountText}`);
    const orderHeaders={'X-Idempotency-Key':idem};
    if(deviceSessionId)orderHeaders['X-meli-session-id']=deviceSessionId;
    order=await mpFetch('/v1/orders',{method:'POST',headers:orderHeaders,body:JSON.stringify(body)});
  }catch(error){
    await pool.query(`UPDATE premium_point_payments SET status='error',status_detail=$2,updated_at=now() WHERE id=$1`,[external,String(error.message||'').slice(0,1000)]).catch(()=>{});
    await auditPaymentEvent({paymentId:external,accountId:account.id,eventType:'provider_error',providerStatus:String(error.providerStatus||error.status||''),providerStatusDetail:String(error.message||''),amount,metadata:{method,paymentType,providerFlow:'orders-api',providerRequestId:error.providerRequestId||'',mode:mode()}});
    throw error;
  }

  const tx=order?.transactions?.payments?.[0]||{};
  await pool.query(`UPDATE premium_point_payments SET mercadopago_order_id=$2,mercadopago_payment_id=$3,payment_method=$4,status=$5,status_detail=$6,updated_at=now() WHERE id=$1`,[
    external,String(order.id||''),String(tx.id||''),method,String(tx.status||order.status||'processing'),String(tx.status_detail||order.status_detail||'')
  ]);
  await auditPaymentEvent({paymentId:external,accountId:account.id,eventType:'order_created',providerStatus:String(tx.status||order.status||''),providerStatusDetail:String(tx.status_detail||order.status_detail||''),providerOrderId:String(order.id||''),providerPaymentId:String(tx.id||''),amount,metadata:{method,paymentType,deviceIdPresent:Boolean(deviceSessionId),deviceIdSource:deviceSessionSource,mode:mode()}});
  const credited=await reconcileOrder(order);
  const pm=tx?.payment_method||{};
  console.log(`[MERCADO PAGO] Order criada: ${String(order.id||'SEM_ID')} | status=${String(tx.status||order.status||'')} | detail=${String(tx.status_detail||order.status_detail||'')}`);
  return {
    ok:true,id:external,providerOrderId:String(order.id||''),providerPaymentId:String(tx.id||''),
    status:uiStatus(tx.status||order.status,tx.status_detail||order.status_detail,credited.credited),providerStatus:String(tx.status||order.status||'processing'),statusDetail:String(tx.status_detail||order.status_detail||''),
    ppAmount:quote.totalPp,basePp:quote.basePp,bonusPp:quote.bonusPp,bonusPercent:quote.bonusPercent,amount,qrCode:pm.qr_code||null,qrCodeBase64:pm.qr_code_base64||null,ticketUrl:pm.ticket_url||null,
    credited:credited.credited,premiumPoints:credited.premiumPoints
  };
}

export async function fetchPayment(id){return mpFetch('/v1/payments/'+encodeURIComponent(String(id)))}
// Mantido apenas para compatibilidade com ordens eventualmente criadas pela V21.0.1.
export async function fetchOrder(id){return mpFetch('/v1/orders/'+encodeURIComponent(String(id)))}

export async function reconcileOrder(order){
  const ext=String(order?.external_reference||'');if(!ext)return {credited:false};
  const tx=order?.transactions?.payments?.[0]||{};
  const status=String(tx.status||order.status||'').toLowerCase();
  const detail=String(tx.status_detail||order.status_detail||'').toLowerCase();
  const approved=(status==='processed'&&(detail==='accredited'||!detail));
  const amount=money(tx.amount??order.total_amount);
  return reconcileRecord({externalReference:ext,orderId:String(order.id||''),paymentId:String(tx.id||''),status:String(tx.status||order.status||''),statusDetail:String(tx.status_detail||order.status_detail||''),amount,approved});
}

export async function reconcilePayment(payment){
  const ext=String(payment?.external_reference||'');if(!ext)return {credited:false};
  return reconcileRecord({externalReference:ext,paymentId:String(payment.id||''),status:String(payment.status||''),statusDetail:String(payment.status_detail||''),amount:money(payment.transaction_amount),approved:String(payment.status||'').toLowerCase()==='approved'});
}

async function reconcileRecord(info){
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const row=(await client.query('SELECT * FROM premium_point_payments WHERE external_reference=$1 FOR UPDATE',[info.externalReference])).rows[0];
    if(!row){await client.query('ROLLBACK');return {credited:false}}
    const amountMatches=Math.abs(Number(row.amount_brl)-Number(info.amount))<0.001;
    await client.query(`UPDATE premium_point_payments SET mercadopago_order_id=COALESCE(NULLIF($2,''),mercadopago_order_id),mercadopago_payment_id=COALESCE(NULLIF($3,''),mercadopago_payment_id),status=$4,status_detail=$5,updated_at=now(),approved_at=CASE WHEN $6 THEN COALESCE(approved_at,now()) ELSE approved_at END WHERE id=$1`,[row.id,info.orderId||'',info.paymentId||'',info.status||'',info.statusDetail||'',Boolean(info.approved)]);
    let credited=false,points=null;
    if(info.approved&&amountMatches&&!row.credited_at){
      const acc=(await client.query('UPDATE accounts SET premium_points=premium_points+$2 WHERE id=$1 RETURNING premium_points',[row.account_id,Number(row.premium_points)])).rows[0];
      points=Number(acc.premium_points);
      await client.query(`UPDATE characters SET premium_points=$2,state=jsonb_set(jsonb_set(state,'{profile,premiumPoints}',to_jsonb($2::bigint),true),'{profile,vipCredits}',to_jsonb($2::bigint),true) WHERE account_id=$1`,[row.account_id,points]);
      await client.query('UPDATE premium_point_payments SET credited_at=now() WHERE id=$1',[row.id]);credited=true;
    }
    await client.query('COMMIT');
    await auditPaymentEvent({paymentId:row.id,accountId:row.account_id,eventType:credited?'pp_credited':'provider_reconciled',providerStatus:info.status,providerStatusDetail:info.statusDetail,providerOrderId:info.orderId,providerPaymentId:info.paymentId,amount:info.amount,metadata:{approved:Boolean(info.approved),amountMatches}});
    return {credited,premiumPoints:points,accountId:row.account_id};
  }catch(e){try{await client.query('ROLLBACK')}catch{}throw e}finally{client.release()}
}

export async function paymentStatus(accountId,id){
  let row=(await pool.query('SELECT p.*,a.premium_points AS account_premium_points FROM premium_point_payments p JOIN accounts a ON a.id=p.account_id WHERE p.id=$1 AND p.account_id=$2',[id,accountId])).rows[0];
  if(!row)return {ok:false,statusCode:404,message:'Pagamento não encontrado.'};
  if(!row.credited_at&&row.mercadopago_order_id){
    try{const order=await fetchOrder(row.mercadopago_order_id);await reconcileOrder(order);row=(await pool.query('SELECT p.*,a.premium_points AS account_premium_points FROM premium_point_payments p JOIN accounts a ON a.id=p.account_id WHERE p.id=$1 AND p.account_id=$2',[id,accountId])).rows[0]}catch(e){console.warn('[MERCADO PAGO] Poll da order:',e.message)}
  }else if(!row.credited_at&&row.mercadopago_payment_id){
    // Fallback apenas para pagamentos legacy criados antes da V21.0.4.
    try{const payment=await fetchPayment(row.mercadopago_payment_id);await reconcilePayment(payment);row=(await pool.query('SELECT p.*,a.premium_points AS account_premium_points FROM premium_point_payments p JOIN accounts a ON a.id=p.account_id WHERE p.id=$1 AND p.account_id=$2',[id,accountId])).rows[0]}catch(e){console.warn('[MERCADO PAGO] Poll legacy:',e.message)}
  }
  return {ok:true,premiumPoints:Number(row.account_premium_points||0),payment:{id:row.id,providerOrderId:row.mercadopago_order_id,providerPaymentId:row.mercadopago_payment_id,ppAmount:Number(row.premium_points),amount:Number(row.amount_brl),status:uiStatus(row.status,row.status_detail,Boolean(row.credited_at)),providerStatus:row.status,statusDetail:row.status_detail,createdAt:row.created_at,approvedAt:row.approved_at,credited:Boolean(row.credited_at)}};
}

export async function paymentHistory(accountId){const {rows}=await pool.query('SELECT id,premium_points,amount_brl,payment_method,status,status_detail,created_at,approved_at,credited_at FROM premium_point_payments WHERE account_id=$1 ORDER BY created_at DESC LIMIT 50',[accountId]);return {ok:true,payments:rows.map(row=>({...row,ui_status:uiStatus(row.status,row.status_detail,Boolean(row.credited_at))}))};}

export function verifyWebhook(req,dataId){
  const secret=String(process.env.MERCADOPAGO_WEBHOOK_SECRET||'');if(!secret)return false;
  const sig=String(req.headers['x-signature']||''),requestId=String(req.headers['x-request-id']||'');let ts='',v1='';
  for(const p of sig.split(',')){const [k,v]=p.split('=',2);if(k?.trim()==='ts')ts=v?.trim()||'';if(k?.trim()==='v1')v1=v?.trim()||''}
  if(!ts||!v1)return false;const id=String(dataId||'').toLowerCase();let manifest='';if(id)manifest+=`id:${id};`;if(requestId)manifest+=`request-id:${requestId};`;manifest+=`ts:${ts};`;
  const hash=crypto.createHmac('sha256',secret).update(manifest).digest('hex');try{return crypto.timingSafeEqual(Buffer.from(hash),Buffer.from(v1))}catch{return false}
}
