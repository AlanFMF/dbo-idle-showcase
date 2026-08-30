export class SocketClient {
  constructor({
    onPresence,
    onChat,
    onStatus,
    onPosition,
    onGroundLoot,
    onGroundPickup,
    onGroundDrop,
    onAuthoritativeState,
    onAuthorityEvent,
    onActionResult,
    onServerLog,
    onAdminMessage,
    onPartyState,
    onPartyInvite,
    onPartyEvent,
    onPartyResult,
    onGuildBossInvite,
    onGuildBossEvent,
    onCharacterProfile,
    onTradeInvite,
    onTradeState,
    onTradeEvent,
    onPvpInvite,
    onPvpState,
    onPvpEvent,
    onPvpResult
  }) {
    this.socket = null;
    this.connected = false;
    this.characterExitRequest = null;
    this.lastProfile = null;
    this.manualClose = false;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.onPresence = onPresence;
    this.onChat = onChat;
    this.onStatus = onStatus;
    this.onPosition = onPosition;
    this.onGroundLoot = onGroundLoot;
    this.onGroundPickup = onGroundPickup;
    this.onGroundDrop = onGroundDrop;
    this.onAuthoritativeState = onAuthoritativeState;
    this.onAuthorityEvent = onAuthorityEvent;
    this.onActionResult = onActionResult;
    this.onServerLog = onServerLog;
    this.onAdminMessage = onAdminMessage;
    this.onPartyState = onPartyState;
    this.onPartyInvite = onPartyInvite;
    this.onPartyEvent = onPartyEvent;
    this.onPartyResult = onPartyResult;
    this.onGuildBossInvite = onGuildBossInvite;
    this.onGuildBossEvent = onGuildBossEvent;
    this.onCharacterProfile = onCharacterProfile;
    this.onTradeInvite = onTradeInvite;
    this.onTradeState = onTradeState;
    this.onTradeEvent = onTradeEvent;
    this.onPvpInvite = onPvpInvite;
    this.onPvpState = onPvpState;
    this.onPvpEvent = onPvpEvent;
    this.onPvpResult = onPvpResult;
  }

  connect(profile) {
    this.lastProfile = profile ? structuredClone(profile) : this.lastProfile;
    this.manualClose = false;
    if(this.reconnectTimer){clearTimeout(this.reconnectTimer);this.reconnectTimer=null;}
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/ws`;
    try {
      this.socket = new WebSocket(url);
      this.socket.addEventListener('open', () => {
        this.connected = true;
        this.reconnectAttempt = 0;
        this.onStatus?.('online');
        this.send({type:'join', profile});
      });
      this.socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.type === 'presence') {
          this.onPresence?.(message.players || []);
        }
        if (message.type === 'position') {
          this.onPosition?.(message.position);
        }
        if (message.type === 'chat') {
          this.onChat?.(message.message);
        }
        if (message.type === 'ground-loot') {
          this.onGroundLoot?.(message.items || []);
        }
        if (message.type === 'ground-pickup-result') {
          this.onGroundPickup?.(message);
        }
        if (message.type === 'ground-drop-result') {
          this.onGroundDrop?.(message);
        }
        if (message.type === 'authoritative-state') {
          this.onAuthoritativeState?.(message.state || {});
        }
        if (message.type === 'hunt-frame') {
          this.onAuthoritativeState?.(message.frame || {});
        }
        if (message.type === 'authority-event') {
          this.onAuthorityEvent?.(message);
        }
        if (message.type === 'action-result') {
          this.onActionResult?.(message);
        }
        if(message.type==='character-exit-result'){
          const pending=this.characterExitRequest;
          if(pending && String(pending.requestId)===String(message.requestId||'')){
            clearTimeout(pending.timer);
            this.characterExitRequest=null;
            pending.resolve(message);
          }
        }
        if (message.type === 'server-log') {
          this.onServerLog?.(message);
        }
        if (message.type === 'admin-message') {
          this.onAdminMessage?.(message.message || {});
        }
        if (message.type === 'party-state') {
          this.onPartyState?.(message.party || null);
        }
        if (message.type === 'party-invite') {
          this.onPartyInvite?.(message);
        }
        if (message.type === 'party-event') {
          this.onPartyEvent?.(message);
        }
        if (message.type === 'party-result') {
          this.onPartyResult?.(message);
        }
        if (message.type === 'guild-boss-invite') {
          this.onGuildBossInvite?.(message);
        }
        if (message.type === 'guild-boss-event') {
          this.onGuildBossEvent?.(message);
        }
        if (message.type === 'character-profile') {
          this.onCharacterProfile?.(message);
        }
        if (message.type === 'trade-invite') {
          this.onTradeInvite?.(message);
        }
        if (message.type === 'trade-state') {
          this.onTradeState?.(message.trade || null);
        }
        if (message.type === 'trade-event') {
          this.onTradeEvent?.(message);
        }
        if (message.type === 'pvp-invite') {
          this.onPvpInvite?.(message);
        }
        if (message.type === 'pvp-state') {
          this.onPvpState?.(message.duel || null, message.serverTime || message.duel?.serverTime || Date.now());
        }
        if (message.type === 'pvp-event') {
          this.onPvpEvent?.(message);
        }
        if (message.type === 'pvp-result') {
          this.onPvpResult?.(message);
        }
        if (message.type === 'client-update') {
          try {
            window.dispatchEvent(new CustomEvent('dbo-client-update',{detail:message}));
          } catch {}
        }
      });
      this.socket.addEventListener('close', event => {
        this.connected = false;
        if(this.characterExitRequest){
          const pending=this.characterExitRequest;
          clearTimeout(pending.timer);
          this.characterExitRequest=null;
          pending.resolve({ok:false,message:'Conexao encerrada antes da confirmacao do save.'});
        }
        const fatalCodes=new Set([4401,4403,4408,4409]);
        if(this.manualClose || fatalCodes.has(Number(event?.code||0))){
          this.onStatus?.('offline');
          return;
        }
        this.onStatus?.('reconnecting');
        this.scheduleReconnect();
      });
      this.socket.addEventListener('error', () => {
        if(!this.manualClose)this.onStatus?.('reconnecting');
      });
    } catch {
      this.onStatus?.('offline');
    }
  }

  scheduleReconnect() {
    if(this.manualClose || this.reconnectTimer || !this.lastProfile)return;
    const delay=Math.min(15000,1500*Math.max(1,2**Math.min(3,this.reconnectAttempt++)));
    this.reconnectTimer=setTimeout(()=>{
      this.reconnectTimer=null;
      if(this.manualClose)return;
      this.connect(this.lastProfile);
    },delay);
  }

  disconnect() {
    this.manualClose = true;
    if(this.reconnectTimer){clearTimeout(this.reconnectTimer);this.reconnectTimer=null;}
    this.socket?.close();
  }

  send(payload) {
    if (this.connected && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  sendPosition(x, y, z = 7) {
    this.send({type:'move', x, y, z});
  }

  sendAppearance(appearance = {}) {
    this.send({type:'appearance', appearance});
  }

  sendChat(text) {
    this.send({type:'chat', text});
  }

  dropGround(item) {
    this.send({type:'ground-drop', item});
  }

  pickupGround(id,targetContainerId=null,quantity=null) {
    this.send({type:'ground-pickup', id, targetContainerId, quantity});
  }

  sendGameAction(action, payload = {}) {
    this.send({type:'game-action', action, payload});
  }

  requestCharacterExit(timeoutMs=12000) {
    if(!this.connected || this.socket?.readyState!==WebSocket.OPEN){
      return Promise.resolve({ok:false,message:'Servidor desconectado.'});
    }
    if(this.characterExitRequest)return this.characterExitRequest.promise;
    const requestId=globalThis.crypto?.randomUUID?.() || `exit-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let resolveRequest;
    const promise=new Promise(resolve=>{resolveRequest=resolve;});
    const timer=setTimeout(()=>{
      const pending=this.characterExitRequest;
      if(!pending || pending.requestId!==requestId)return;
      this.characterExitRequest=null;
      pending.resolve({ok:false,message:'O servidor nao confirmou o save dentro do tempo limite.'});
    },Math.max(3000,Number(timeoutMs)||12000));
    this.characterExitRequest={requestId,resolve:resolveRequest,timer,promise};
    this.send({type:'character-exit',requestId});
    return promise;
  }

  sendPartyAction(action, payload = {}) {
    this.send({type:'party-action', action, payload});
  }

  requestCharacterProfile(characterId) {
    this.send({type:'profile-request',characterId});
  }

  sendTradeAction(action,payload={}) {
    this.send({type:'trade-action',action,payload});
  }

  sendPvpAction(action,payload={}) {
    this.send({type:'pvp-action',action,payload});
  }

  sendGuildBossTaunt() {
    this.send({type:'guild-boss-taunt'});
  }

  sendClientLayout(layout = {}) {
    this.send({type:'client-layout', layout});
  }

  sendClientPreferences(preferences = {}) {
    this.send({type:'client-preferences', preferences});
  }
}
