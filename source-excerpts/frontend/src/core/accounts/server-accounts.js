const LEGACY_ACCOUNTS_KEY = 'dbo-idle-mock-accounts-v1';
const LEGACY_CHARACTER_KEY = 'dbo-idle-v12-12-save';
const MAX_CHARACTERS = 10;
const NICKNAME_PATTERN = /^[A-Za-z ]+$/;
const saveTimers = new Map();
const pendingStates = new Map();
let lastSaveError = '';

async function api(path, options={}) {
  const response = await fetch(path, {
    credentials:'same-origin',
    headers:{'Content-Type':'application/json', ...(options.headers||{})},
    cache:'no-store',
    ...options
  });
  let body={};
  try { body=await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(body.message || `Erro HTTP ${response.status}`);
    error.status=response.status;
    error.payload=body;
    throw error;
  }
  return body;
}

function readLegacyAccounts() {
  try {
    const value=JSON.parse(localStorage.getItem(LEGACY_ACCOUNTS_KEY));
    return Array.isArray(value)?value:[];
  } catch { return []; }
}

async function migrateLegacyIfPossible(account) {
  if (!account || account.characters?.length) return {account,migrated:0,skipped:[]};
  const local = readLegacyAccounts().find(entry =>
    String(entry.email||'').trim().toLowerCase() === String(account.email||'').trim().toLowerCase()
  );
  let characters = local?.characters || [];
  if (!characters.length) {
    try {
      const legacy=JSON.parse(localStorage.getItem(LEGACY_CHARACTER_KEY));
      if (legacy?.profile) characters=[legacy];
    } catch {}
  }
  if (!characters.length) return {account,migrated:0,skipped:[]};
  try {
    const result = await api('/api/account/import-local',{
      method:'POST',body:JSON.stringify({characters})
    });
    return {
      account:result.account || account,
      migrated:result.imported?.length || 0,
      skipped:result.skipped || []
    };
  } catch (error) {
    console.warn('[DB] Nao foi possivel importar o save local:',error.message);
    return {account,migrated:0,skipped:[],migrationError:error.message};
  }
}

export function validateNickname(value, account=null) {
  const nickname=String(value||'').trim().replace(/\s+/g,' ');
  if(nickname.length<3 || nickname.length>16){
    return {ok:false,message:'O nickname deve ter entre 3 e 16 caracteres.'};
  }
  if(!NICKNAME_PATTERN.test(nickname)){
    return {ok:false,message:'Use somente letras sem acentos e espacos.'};
  }
  if(account?.characters?.some(character =>
    character.profile.name.toLowerCase()===nickname.toLowerCase())){
    return {ok:false,message:'Ja existe um personagem com esse nickname nesta conta.'};
  }
  return {ok:true,nickname};
}

export async function requestRegistrationCode(email) {
  try {
    const result=await api('/api/auth/register/request-code',{
      method:'POST',body:JSON.stringify({email})
    });
    return {ok:true,email:result.email,expiresInSeconds:result.expiresInSeconds,message:result.message};
  } catch(error){return {ok:false,message:error.message,status:error.status}}
}

export async function createAccount(email,password,code) {
  try {
    const result=await api('/api/auth/register',{
      method:'POST',body:JSON.stringify({email,password,code})
    });
    const migration=await migrateLegacyIfPossible(result.account);
    return {ok:true,account:migration.account,migration};
  } catch(error){return {ok:false,message:error.message,status:error.status}}
}

export async function loginAccount(email,password) {
  try {
    const result=await api('/api/auth/login',{
      method:'POST',body:JSON.stringify({email,password})
    });
    const migration=await migrateLegacyIfPossible(result.account);
    return {ok:true,account:migration.account,migration};
  } catch(error){return {ok:false,message:error.message}}
}

export async function requestPasswordResetCode(email) {
  try {
    const result=await api('/api/auth/password/request-code',{
      method:'POST',body:JSON.stringify({email})
    });
    return {ok:true,email:result.email,expiresInSeconds:result.expiresInSeconds,message:result.message};
  } catch(error){return {ok:false,message:error.message,status:error.status}}
}

export async function resetAccountPassword(email,password,code) {
  try {
    const result=await api('/api/auth/password/reset',{
      method:'POST',body:JSON.stringify({email,password,code})
    });
    return {ok:true,message:result.message};
  } catch(error){return {ok:false,message:error.message,status:error.status}}
}

export async function logoutAccount() {
  try { await api('/api/auth/logout',{method:'POST',body:'{}'}); } catch {}
}

export async function currentAccount() {
  try { return (await api('/api/account')).account || null; }
  catch(error){ if(error.status!==401) console.warn('[DB] Sessao:',error.message); return null; }
}

export async function addCharacterToAccount(account, characterState) {
  if((account.characters||[]).length>=MAX_CHARACTERS){
    return {ok:false,message:'A conta ja possui 10 personagens.'};
  }
  const validation=validateNickname(characterState.profile.name,account);
  if(!validation.ok)return validation;
  try{
    const result=await api('/api/characters',{
      method:'POST',
      body:JSON.stringify({
        name:validation.nickname,
        characterId:characterState.profile.characterId,
        state:characterState
      })
    });
    account.characters ||= [];
    account.characters.push(result.state);
    account.activeCharacterId=result.state.profile.id;
    return {ok:true,character:result.state};
  }catch(error){return {ok:false,message:error.message}}
}

export async function removeCharacterFromAccount(account,characterId){
  try{
    await flushCharacterSave(characterId);
    await api(`/api/characters/${encodeURIComponent(characterId)}`,{method:'DELETE',body:'{}'});
    account.characters=(account.characters||[]).filter(c=>c.profile.id!==characterId);
    if(account.activeCharacterId===characterId)account.activeCharacterId=account.characters[0]?.profile.id||null;
    return {ok:true};
  }catch(error){return {ok:false,message:error.message}}
}

export function selectAccountCharacter(account,characterId){
  const character=(account.characters||[]).find(entry=>entry.profile.id===characterId);
  if(!character)return null;
  account.activeCharacterId=characterId;
  return character;
}

async function sendCharacterSave(characterId,state){
  try{
    const result=await api(`/api/characters/${encodeURIComponent(characterId)}/state`,{
      method:'PUT',body:JSON.stringify({state})
    });
    lastSaveError='';
    return result.state || state;
  }catch(error){
    lastSaveError=error.message;
    console.error('[DB] Falha ao salvar personagem:',error.message);
    throw error;
  }
}

export function updateAccountCharacter(account,state){
  const index=(account.characters||[]).findIndex(character=>character.profile.id===state.profile.id);
  if(index<0)(account.characters ||= []).push(state); else account.characters[index]=state;
  account.activeCharacterId=state.profile.id;
  pendingStates.set(state.profile.id,structuredClone(state));
  clearTimeout(saveTimers.get(state.profile.id));
  saveTimers.set(state.profile.id,setTimeout(()=>{
    const pending=pendingStates.get(state.profile.id);
    if(!pending)return;
    pendingStates.delete(state.profile.id);
    saveTimers.delete(state.profile.id);
    sendCharacterSave(state.profile.id,pending).catch(()=>{});
  },900));
}

export async function flushCharacterSave(characterId){
  clearTimeout(saveTimers.get(characterId));
  saveTimers.delete(characterId);
  const state=pendingStates.get(characterId);
  if(!state)return;
  pendingStates.delete(characterId);
  await sendCharacterSave(characterId,state);
}

export function discardCharacterSave(characterId){
  clearTimeout(saveTimers.get(characterId));
  saveTimers.delete(characterId);
  pendingStates.delete(characterId);
}

export function flushCharacterSaveOnUnload(characterId){
  clearTimeout(saveTimers.get(characterId));
  const state=pendingStates.get(characterId);
  if(!state)return;
  pendingStates.delete(characterId);
  fetch(`/api/characters/${encodeURIComponent(characterId)}/state`,{
    method:'PUT',credentials:'same-origin',keepalive:true,
    headers:{'Content-Type':'application/json'},body:JSON.stringify({state})
  }).catch(()=>{});
}

export function databaseSaveStatus(){return lastSaveError?{ok:false,message:lastSaveError}:{ok:true}}

export const accountLimits={maxCharacters:MAX_CHARACTERS,nicknameMaxLength:16};
