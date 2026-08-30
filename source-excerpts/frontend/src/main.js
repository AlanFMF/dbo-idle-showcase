import { createApp } from './app/app.js?v=22.4.4';
import {
  addCharacterToAccount,
  accountLimits,
  createAccount,
  currentAccount,
  flushCharacterSave,
  flushCharacterSaveOnUnload,
  discardCharacterSave,
  loginAccount,
  logoutAccount,
  removeCharacterFromAccount,
  requestRegistrationCode,
  requestPasswordResetCode,
  resetAccountPassword,
  selectAccountCharacter,
  updateAccountCharacter,
  validateNickname
} from './core/accounts/server-accounts.js?v=22.4.4';
import {
  createCharacterState,
  loadLegacyCharacter
} from './core/storage.js?v=22.4.4';
import { characters } from './data/game-content.js?v=22.4.4';
import { currentTransformationForm } from './core/transformations/transformation-engine.js?v=21.26.4';

const CLIENT_VERSION = '21.26.4';
const EMBEDDED_CLIENT_BUILD = '22.4.4';
const CLIENT_BUILD = new URL(location.href).searchParams.get('build') || EMBEDDED_CLIENT_BUILD;
const root = document.querySelector('#app');
let updateReloadStarted=false;
function normalizedBuild(value=''){
  return String(value||'').trim();
}
function triggerClientRefresh(nextBuild='', reason='update'){
  const build=normalizedBuild(nextBuild);
  if(updateReloadStarted)return;
  if(reason==='client-build' && (!build || build===CLIENT_BUILD))return;
  updateReloadStarted=true;
  const notice=document.createElement('div');
  notice.className='server-update-notice';
  notice.textContent='Nova atualização disponível. Atualizando o jogo...';
  document.body.appendChild(notice);
  // V21.25.8: navegar para uma URL inédita força um novo documento mesmo que
  // o navegador ainda tenha /play/ em cache. O build também vira a chave dos
  // assets principais no index.html publicado.
  const nextUrl=new URL(location.href);
  nextUrl.searchParams.set('build',build || `server-${Date.now()}`);
  nextUrl.searchParams.set('_refresh',String(Date.now()));
  setTimeout(()=>location.replace(nextUrl.href),450);
}
async function checkForServerUpdate(){
  if(updateReloadStarted)return;
  try{
    const response=await fetch(`/api/version?t=${Date.now()}`,{cache:'no-store'});
    if(!response.ok)return;
    const data=await response.json();
    const serverVersion=normalizedBuild(data?.version);
    const serverBuild=normalizedBuild(data?.clientBuild);
    if(serverVersion && serverVersion!==CLIENT_VERSION){
      triggerClientRefresh(serverBuild || serverVersion,'server-version');
      return;
    }
    if(serverBuild && serverBuild!==CLIENT_BUILD){
      triggerClientRefresh(serverBuild,'client-build');
    }
  }catch{}
}
window.addEventListener('dbo-client-update',event=>{
  const build=normalizedBuild(event?.detail?.clientBuild || event?.detail?.buildVersion);
  if(build && build!==CLIENT_BUILD)triggerClientRefresh(build,'client-build');
});
setInterval(checkForServerUpdate,15000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)checkForServerUpdate();});
window.addEventListener('online',()=>checkForServerUpdate());
setTimeout(checkForServerUpdate,1200);
let account = null;
let activeApp = null;
let authMode = 'login';
let accountMessage = '';
let pendingDeleteCharacterId = null;
let registrationStep = 'email';
let pendingRegistrationEmail = '';
let passwordResetStep = 'email';
let pendingPasswordResetEmail = '';


function selectedCharacterForm(characterState) {
  const vocation = characters[characterState.profile.characterId];
  return currentTransformationForm(characterState,vocation);
}

function selectedCharacterPortrait(characterState) {
  const vocation = characters[characterState.profile.characterId];
  return (
    selectedCharacterForm(characterState)?.portrait ||
    vocation?.sprite ||
    ''
  );
}

function selectedCharacterVocationName(characterState) {
  return characters[characterState.profile.characterId]?.name || 'Vocation';
}

function escapeHtml(value='') {
  return String(value).replace(/[&<>"']/g, character => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;',
    '"':'&quot;', "'":'&#039;'
  })[character]);
}

function renderAuth() {
  const creating = authMode === 'create';
  const resetting = authMode === 'reset';
  const verifying = creating && registrationStep === 'code';
  const resetVerifying = resetting && passwordResetStep === 'code';
  const heading = authMode === 'login'
    ? 'Entrar'
    : creating
      ? (verifying ? 'Verificar e-mail' : 'Criar conta')
      : (resetVerifying ? 'Redefinir senha' : 'Recuperar senha');
  const warning = verifying
    ? `Enviamos um codigo de 6 digitos para <strong>${escapeHtml(pendingRegistrationEmail)}</strong>. Ele expira em 10 minutos.`
    : resetVerifying
      ? `Enviamos um codigo de recuperacao para <strong>${escapeHtml(pendingPasswordResetEmail)}</strong>. Ele expira em 10 minutos.`
      : resetting
        ? 'Informe o e-mail da conta. Se ela existir, enviaremos um codigo de recuperacao.'
        : '';

  let formHtml='';
  if(authMode==='login'){
    formHtml=`
      <form id="account-form">
        <label>E-mail<input name="email" type="email" required autocomplete="email"></label>
        <label>Senha<input name="password" type="password" required minlength="8" autocomplete="current-password"></label>
        <button type="submit">Entrar</button>
      </form>
      <button class="account-link account-forgot-link" id="forgot-password">Esqueci minha senha</button>`;
  }else if(creating && !verifying){
    formHtml=`
      <form id="account-form">
        <label>E-mail<input name="email" type="email" required autocomplete="email"></label>
        <button type="submit">Enviar codigo de verificacao</button>
      </form>`;
  }else if(creating){
    formHtml=`
      <form id="account-form">
        <label>Codigo de verificacao
          <input name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" minlength="6" required autocomplete="one-time-code" placeholder="000000">
        </label>
        <label>Senha<input name="password" type="password" required minlength="8" maxlength="128" autocomplete="new-password"></label>
        <button type="submit">Verificar e criar conta</button>
      </form>
      <button class="account-link" id="resend-code">Reenviar codigo</button>
      <button class="account-link" id="change-email">Alterar e-mail</button>`;
  }else if(resetting && !resetVerifying){
    formHtml=`
      <form id="account-form">
        <label>E-mail<input name="email" type="email" required autocomplete="email"></label>
        <button type="submit">Enviar codigo de recuperacao</button>
      </form>`;
  }else{
    formHtml=`
      <form id="account-form">
        <label>Codigo de recuperacao
          <input name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" minlength="6" required autocomplete="one-time-code" placeholder="000000">
        </label>
        <label>Nova senha<input name="password" type="password" required minlength="8" maxlength="128" autocomplete="new-password"></label>
        <label>Confirmar nova senha<input name="passwordConfirm" type="password" required minlength="8" maxlength="128" autocomplete="new-password"></label>
        <button type="submit">Alterar senha</button>
      </form>
      <button class="account-link" id="resend-reset-code">Reenviar codigo</button>
      <button class="account-link" id="change-reset-email">Alterar e-mail</button>`;
  }

  root.innerHTML = `
    <main class="account-shell">
      <section class="account-panel">
        <div class="account-logo">DBO IDLE</div>
        <h1>${heading}</h1>
        ${warning ? `<p class="mock-warning">${warning}</p>` : ''}
        ${accountMessage ? `<div class="account-message">${escapeHtml(accountMessage)}</div>` : ''}
        ${formHtml}
        <button class="account-link" id="toggle-auth">
          ${authMode === 'login' ? 'Criar uma conta' : 'Voltar para entrar'}
        </button>
      </section>
    </main>
  `;

  root.querySelector('#toggle-auth').addEventListener('click', () => {
    authMode = authMode === 'login' ? 'create' : 'login';
    registrationStep = 'email';
    pendingRegistrationEmail = '';
    passwordResetStep = 'email';
    pendingPasswordResetEmail = '';
    accountMessage = '';
    renderAuth();
  });

  root.querySelector('#forgot-password')?.addEventListener('click',()=>{
    authMode='reset';
    passwordResetStep='email';
    pendingPasswordResetEmail='';
    accountMessage='';
    renderAuth();
  });

  root.querySelector('#change-email')?.addEventListener('click', () => {
    registrationStep='email';
    pendingRegistrationEmail='';
    accountMessage='';
    renderAuth();
  });
  root.querySelector('#change-reset-email')?.addEventListener('click',()=>{
    passwordResetStep='email';
    pendingPasswordResetEmail='';
    accountMessage='';
    renderAuth();
  });

  root.querySelector('#resend-code')?.addEventListener('click', async () => {
    const button=root.querySelector('#resend-code');
    button.disabled=true;
    const result=await requestRegistrationCode(pendingRegistrationEmail);
    accountMessage=result.ok
      ? 'Novo codigo enviado. Verifique tambem a caixa de spam.'
      : result.message;
    renderAuth();
  });
  root.querySelector('#resend-reset-code')?.addEventListener('click',async()=>{
    const button=root.querySelector('#resend-reset-code');
    button.disabled=true;
    const result=await requestPasswordResetCode(pendingPasswordResetEmail);
    accountMessage=result.ok
      ? 'Se a conta existir, um novo codigo foi enviado. Verifique tambem a caixa de spam.'
      : result.message;
    renderAuth();
  });

  root.querySelector('#account-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form=event.currentTarget;
    const submit=form.querySelector('button[type="submit"]');
    submit.disabled=true;
    const data = new FormData(form);

    if(authMode === 'create' && registrationStep === 'email'){
      const result=await requestRegistrationCode(data.get('email'));
      if(!result.ok){accountMessage=result.message;renderAuth();return;}
      pendingRegistrationEmail=result.email;
      registrationStep='code';
      accountMessage='Codigo enviado. Verifique sua caixa de entrada e spam.';
      renderAuth();
      return;
    }

    if(authMode==='reset' && passwordResetStep==='email'){
      const result=await requestPasswordResetCode(data.get('email'));
      if(!result.ok){accountMessage=result.message;renderAuth();return;}
      pendingPasswordResetEmail=result.email;
      passwordResetStep='code';
      accountMessage=result.message || 'Se a conta existir, enviamos um codigo de recuperacao.';
      renderAuth();
      return;
    }

    if(authMode==='reset'){
      const password=String(data.get('password')||'');
      const confirm=String(data.get('passwordConfirm')||'');
      if(password!==confirm){accountMessage='As senhas nao conferem.';renderAuth();return;}
      const result=await resetAccountPassword(pendingPasswordResetEmail,password,data.get('code'));
      if(!result.ok){accountMessage=result.message;renderAuth();return;}
      authMode='login';passwordResetStep='email';pendingPasswordResetEmail='';
      accountMessage=result.message;
      renderAuth();
      return;
    }

    const result = authMode === 'login'
      ? await loginAccount(data.get('email'), data.get('password'))
      : await createAccount(pendingRegistrationEmail, data.get('password'), data.get('code'));

    if (!result.ok) {accountMessage = result.message;renderAuth();return;}
    account = result.account;
    registrationStep='email';
    pendingRegistrationEmail='';
    if (result.migration?.migrated) {
      accountMessage = `${result.migration.migrated} personagem(ns) do save local foram importados para o PostgreSQL.`;
    } else {
      accountMessage = '';
    }
    renderCharacters();
  });
}

function renderCharacters() {
  if (!account) {
    renderAuth();
    return;
  }

  root.innerHTML = `
    <main class="character-shell">
      <section class="character-panel">
        <header>
          <div>
            <h1>Personagens</h1>
            <span>${escapeHtml(account.email)}</span>
          </div>
          <button id="logout-account">Sair</button>
        </header>

        ${accountMessage ? `<div class="account-message">${escapeHtml(accountMessage)}</div>` : ''}
        <div class="character-grid">
          ${account.characters.map(character => {
            const vocation = characters[character.profile.characterId];
            return `<article class="character-card-wrap">
              <button class="character-card" data-character="${character.profile.id}">
                <img class="sprite-pending" src="${selectedCharacterPortrait(character)}?v=2058"
                  onload="this.classList.remove('sprite-pending')" alt="${escapeHtml(character.profile.name)}">
                <strong>${escapeHtml(character.profile.name)}</strong>
                <span>${selectedCharacterVocationName(character)}</span>
                <b>Level ${character.profile.level}</b>
                <small>Banco: ${character.profile.bank || 0}</small>
              </button>
              <button class="delete-character-button"
                data-delete-character="${character.profile.id}">
                Excluir
              </button>
            </article>`;
          }).join('')}
          ${account.characters.length < accountLimits.maxCharacters
            ? `<button class="character-card create" id="open-character-create">
                <span>＋</span><strong>Criar personagem</strong>
              </button>`
            : ''}
        </div>
        <p>${account.characters.length}/${accountLimits.maxCharacters} personagens</p>
      </section>
      ${pendingDeleteCharacterId ? (() => {
        const character = account.characters.find(entry =>
          entry.profile.id === pendingDeleteCharacterId
        );
        return `<div class="delete-character-backdrop">
          <section class="delete-character-confirm" role="dialog" aria-modal="true">
            <h2>Excluir personagem?</h2>
            <p>
              <strong>${escapeHtml(character?.profile.name || 'Personagem')}</strong>
              será apagado permanentemente. Nível, skills, equipamentos,
              banco e itens não poderão ser recuperados.
            </p>
            <b>Esta ação não tem volta. Deseja realmente confirmar?</b>
            <div>
              <button id="cancel-character-delete">Cancelar</button>
              <button class="danger" id="confirm-character-delete">
                Sim, excluir definitivamente
              </button>
            </div>
          </section>
        </div>`;
      })() : ''}
    </main>
  `;

  root.querySelector('#logout-account').addEventListener('click', () => {
    logoutAccount().finally(() => { account = null; renderAuth(); });
  });

  root.querySelectorAll('[data-character]').forEach(element =>
    element.addEventListener('click', () => {
      const state = selectAccountCharacter(
        account,
        element.dataset.character
      );
      if (state) launchCharacter(state);
    })
  );

  root.querySelectorAll('[data-delete-character]').forEach(button =>
    button.addEventListener('click', event => {
      event.stopPropagation();
      pendingDeleteCharacterId = button.dataset.deleteCharacter;
      renderCharacters();
    })
  );

  root.querySelector('#cancel-character-delete')
    ?.addEventListener('click', () => {
      pendingDeleteCharacterId = null;
      renderCharacters();
    });

  root.querySelector('#confirm-character-delete')
    ?.addEventListener('click', async () => {
      const character = account.characters.find(entry =>
        entry.profile.id === pendingDeleteCharacterId
      );
      if (!character) {
        accountMessage = 'O personagem não foi encontrado.';
        pendingDeleteCharacterId = null;
        renderCharacters();
        return;
      }

      const result = await removeCharacterFromAccount(
        account,
        character.profile.id
      );
      if (!result.ok) {
        accountMessage = result.message;
        pendingDeleteCharacterId = null;
        renderCharacters();
        return;
      }

      accountMessage =
        `${character.profile.name} foi excluído permanentemente.`;
      pendingDeleteCharacterId = null;
      renderCharacters();
    });

  root.querySelector('#open-character-create')
    ?.addEventListener('click', renderCharacterCreation);
}

function vocationScalingInfo(character) {
  const formula =
    character?.serverFormula ||
    character?.forms?.[0]?.formula ||
    {};
  const melee = Math.max(0, Number(formula.meleeDamage || 0));
  const distance = Math.max(0, Number(formula.distanceDamage || 0));

  if (distance > melee) {
    return {
      label:'Distance',
      css:'distance',
      detail:`Distance x${Number(distance.toFixed(2))} · Melee x${Number(melee.toFixed(2))}`
    };
  }
  if (melee > distance) {
    return {
      label:'Melee',
      css:'melee',
      detail:`Melee x${Number(melee.toFixed(2))} · Distance x${Number(distance.toFixed(2))}`
    };
  }
  return {
    label:'Híbrido',
    css:'hybrid',
    detail:`Melee x${Number(melee.toFixed(2))} · Distance x${Number(distance.toFixed(2))}`
  };
}

function renderCharacterCreation() {
  root.innerHTML = `
    <main class="character-shell">
      <section class="character-panel creation">
        <header>
          <h1>Novo personagem</h1>
          <button id="cancel-character-create">Voltar</button>
        </header>
        <form id="character-create-form">
          <label>
            Nickname
            <input name="nickname" maxlength="16"
              placeholder="Somente letras e espaços" required>
          </label>
          <div class="vocation-choice vocation-scroll">
            ${Object.values(characters).map((character, index) => {
              const scaling = vocationScalingInfo(character);
              const lockedPremiumVocation=Boolean(character.vipVocation||character.questVocation)&&!(account?.unlockedVocations||[]).includes(character.id);
              const vocationLockLabel=character.questVocation?'QUEST':'VIP';
              return `
              <label>
                <input type="radio" name="vocation"
                  value="${character.id}" ${index === 0 ? 'checked' : ''} ${lockedPremiumVocation?'disabled':''}>
                <span>
                  <img src="${character.sprite}" alt="${character.name}">
                  <b>${character.name}${lockedPremiumVocation?` 🔒 ${vocationLockLabel}`:''}</b>
                  <small class="vocation-scaling ${scaling.css}">Escala principal: ${scaling.label}</small>
                  <small class="vocation-scaling-detail">${scaling.detail}</small>
                </span>
              </label>
            `;
            }).join('')}
          </div>
          <div id="nickname-error" class="account-message"></div>
          <button type="submit">Criar personagem</button>
        </form>
      </section>
    </main>
  `;

  root.querySelector('#cancel-character-create')
    .addEventListener('click', renderCharacters);

  root.querySelector('#character-create-form')
    .addEventListener('submit', async event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const validation = validateNickname(data.get('nickname'), account);
      if (!validation.ok) {
        root.querySelector('#nickname-error').textContent =
          validation.message;
        return;
      }

      const state = createCharacterState({
        name:validation.nickname,
        characterId:data.get('vocation')
      });
      const result = await addCharacterToAccount(account, state);
      if (!result.ok) {
        root.querySelector('#nickname-error').textContent =
          result.message;
        return;
      }
      launchCharacter(result.character);
    });
}

function launchCharacter(state) {
  root.innerHTML = '';
  const characterId = state.profile.id;
  activeApp = createApp(root, {
    state,
    onSaveCharacter(updated) {
      updateAccountCharacter(account, updated);
    },
    onSwitchCharacter({serverConfirmed=false}={}) {
      const finishSwitch=async()=>{
        if(serverConfirmed){
          // O WebSocket já confirmou o snapshot autoritativo no PostgreSQL.
          // Descarta qualquer PUT /state atrasado do navegador para que um
          // estado local antigo nunca seja reenviado depois do ACK do servidor.
          discardCharacterSave(characterId);
        }else{
          await flushCharacterSave(characterId).catch(()=>{});
        }
        const freshAccount=await currentAccount().catch(()=>null);
        if(freshAccount)account=freshAccount;
        activeApp=null;
        renderCharacters();
      };
      void finishSwitch();
    }
  });
  window.addEventListener(
    'pagehide',
    () => {
      // V21.25.7: o fechamento da pagina nao envia um snapshot local atrasado.
      // O WebSocket autoritativo entra em farming de protecao e continua sendo
      // a unica fonte de progresso durante a queda/fechamento.
      discardCharacterSave(characterId);
    },
    {once:true}
  );
}

async function bootstrap() {
  account = await currentAccount();
  if (!account) {
    const legacy = loadLegacyCharacter();
    if (legacy) {
      accountMessage =
        'Um save antigo foi encontrado. Entre ou crie sua conta online para importa-lo.';
    }
    renderAuth();
    return;
  }
  renderCharacters();
}

bootstrap();
