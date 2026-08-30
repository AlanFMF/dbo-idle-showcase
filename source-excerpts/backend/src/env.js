import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const candidates=[path.resolve(here,'../../.env'),path.resolve(here,'../.env')];
const fileKeys=new Set();
let loadedPath='';

function parseEnv(text=''){
  const result={};
  for(const raw of String(text).replace(/^\uFEFF/,'').split(/\r?\n/)){
    const line=raw.trim();
    if(!line||line.startsWith('#'))continue;
    const i=line.indexOf('=');if(i<1)continue;
    const key=line.slice(0,i).trim();let value=line.slice(i+1).trim();
    if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);
    result[key]=value;
  }
  return result;
}

// Para configuracao de pagamento, o .env da instalacao deve vencer variaveis
// antigas herdadas do Windows/terminal. Isso evita usar credenciais live em cache
// quando o administrador acabou de colocar credenciais de teste no arquivo.
const filePriorityKey=key=>/^(MERCADOPAGO_|PP_|PAYMENTS_|PIX_|PUBLIC_BASE_URL$)/.test(key);

for(const file of candidates){
  if(!fs.existsSync(file))continue;
  const parsed=parseEnv(fs.readFileSync(file,'utf8'));
  for(const [key,value] of Object.entries(parsed)){
    if(process.env[key]===undefined||filePriorityKey(key))process.env[key]=value;
    fileKeys.add(key);
  }
  loadedPath=file;
  break;
}

export function envFingerprint(value=''){
  const text=String(value||'');
  if(!text)return 'ausente';
  return crypto.createHash('sha256').update(text).digest('hex').slice(0,12);
}

export function envRuntimeDiagnostics(){
  const publicKey=String(process.env.MERCADOPAGO_PUBLIC_KEY||'').trim();
  const accessToken=String(process.env.MERCADOPAGO_ACCESS_TOKEN||'').trim();
  const secret=String(process.env.MERCADOPAGO_WEBHOOK_SECRET||'').trim();
  return {
    envFile:loadedPath||null,
    envFileFound:Boolean(loadedPath),
    paymentMode:String(process.env.MERCADOPAGO_MODE||'test').trim().toLowerCase(),
    publicKey:{configured:Boolean(publicKey),source:fileKeys.has('MERCADOPAGO_PUBLIC_KEY')?'file':(publicKey?'process':'missing'),length:publicKey.length,fingerprint:envFingerprint(publicKey)},
    accessToken:{configured:Boolean(accessToken),source:fileKeys.has('MERCADOPAGO_ACCESS_TOKEN')?'file':(accessToken?'process':'missing'),length:accessToken.length,fingerprint:envFingerprint(accessToken)},
    webhookSecret:{configured:Boolean(secret),source:fileKeys.has('MERCADOPAGO_WEBHOOK_SECRET')?'file':(secret?'process':'missing'),length:secret.length,fingerprint:envFingerprint(secret)}
  };
}
