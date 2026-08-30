import { Pool } from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { createCharacterState } from '../../src/core/storage.js';
import { characters as gameCharacters, itemCatalog } from '../../src/data/game-content.js';
import { addItemToInventory, normalizeInventoryState, itemQuantity, removeItemFromInventory } from '../../src/core/inventory/containers.js';
import { ensureItemInstancesInState, isRarityEligibleItem, rarityDefinition } from '../../src/core/items/item-rarity.js';
import { sanitizeClientSettings, sanitizeIgnoredLoot, sanitizeFavoriteZones, sanitizeChat } from './client-preferences.js';
import { resolvePrivateConfig } from './config-paths.js';
import { skillDefinitions } from '../../src/core/skills/skills.js';
import { DAILY_VIP_BONUS_DAYS, dailyLoginReward, gamePassRewardLabel, GAME_PASS_XP_PER_LEVEL, GAME_PASS_BASE_LEVELS, gamePassLevelFromXp } from '../../src/data/game-pass.js';
import { addMail, createMail, normalizeMailbox } from '../../src/core/mail/mailbox.js';
import { bestiaryEarnedPoints, bossBestiaryEarnedPoints } from '../../src/core/bestiary/bestiary.js';

const scryptAsync = promisify(crypto.scrypt);
const configPath = resolvePrivateConfig('database.local.json');
export const SESSION_COOKIE = 'dbo_session';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
const EMAIL_RESEND_COOLDOWN_MS = 60 * 1000;
const EMAIL_SEND_WINDOW_MS = 60 * 60 * 1000;
const EMAIL_MAX_SENDS_PER_WINDOW = 5;
const EMAIL_MAX_ATTEMPTS = 5;

function loadConfig() {
  let fileConfig = {};
  if (fs.existsSync(configPath)) {
    try { fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/,'')); }
    catch (error) { throw new Error(`Config PostgreSQL invalida em ${configPath}: ${error.message}`); }
  }
  return {
    host: process.env.DB_HOST || fileConfig.host || '127.0.0.1',
    port: Number(process.env.DB_PORT || fileConfig.port || 5432),
    database: process.env.DB_NAME || fileConfig.database || 'dbo_idle',
    user: process.env.DB_USER || fileConfig.user || 'dbo_idle_app',
    password: process.env.DB_PASSWORD || fileConfig.password || '',
    max: Number(process.env.DB_POOL_MAX || fileConfig.max || 10)
  };
}

export const dbConfig = loadConfig();
export const pool = new Pool({
  ...dbConfig,
  application_name: 'dbo_idle_server',
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000
});

function nowIso() { return new Date().toISOString(); }
function hashToken(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }
function normalizeEmail(value='') { return String(value).trim().toLowerCase(); }
function sanitizeNickname(value='') { return String(value).trim().replace(/\s+/g,' '); }
function validEmail(email) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email); }
function validNickname(name) { return /^[A-Za-z ]+$/.test(name) && name.length >= 3 && name.length <= 16; }

async function passwordRecord(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = Buffer.from(await scryptAsync(String(password), salt, 64)).toString('hex');
  return { salt, hash };
}
async function verifyPassword(password, salt, expectedHex) {
  const actual = Buffer.from(await scryptAsync(String(password), salt, 64));
  const expected = Buffer.from(String(expectedHex), 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function verificationCodeRecord(code) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = Buffer.from(await scryptAsync(String(code), salt, 32)).toString('hex');
  return { salt, hash };
}
async function verifyVerificationCode(code, salt, expectedHex) {
  const actual = Buffer.from(await scryptAsync(String(code), salt, 32));
  const expected = Buffer.from(String(expectedHex), 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export async function requestRegistrationCode({email,ip=''}) {
  email = normalizeEmail(email);
  if (!validEmail(email)) return {ok:false,status:400,message:'Informe um e-mail valido.'};
  const existing = await pool.query('SELECT 1 FROM accounts WHERE email=$1',[email]);
  if (existing.rowCount) return {ok:false,status:409,message:'Esta conta ja existe.'};

  const previous = (await pool.query(`
    SELECT send_count,send_window_started_at,last_sent_at
    FROM email_verification_requests WHERE email=$1
  `,[email])).rows[0];
  const now=Date.now();
  if(previous){
    const lastSent=new Date(previous.last_sent_at).getTime();
    if(now-lastSent<EMAIL_RESEND_COOLDOWN_MS){
      const wait=Math.max(1,Math.ceil((EMAIL_RESEND_COOLDOWN_MS-(now-lastSent))/1000));
      return {ok:false,status:429,message:`Aguarde ${wait}s para reenviar o codigo.`};
    }
    const windowStart=new Date(previous.send_window_started_at).getTime();
    if(now-windowStart<EMAIL_SEND_WINDOW_MS && Number(previous.send_count)>=EMAIL_MAX_SENDS_PER_WINDOW){
      return {ok:false,status:429,message:'Limite de codigos atingido para este e-mail. Tente novamente mais tarde.'};
    }
  }

  const code=String(crypto.randomInt(0,1_000_000)).padStart(6,'0');
  const {salt,hash}=await verificationCodeRecord(code);
  const expiresAt=new Date(now+EMAIL_CODE_TTL_MS);
  const resetWindow=!previous || now-new Date(previous.send_window_started_at).getTime()>=EMAIL_SEND_WINDOW_MS;
  const sendCount=resetWindow?1:Number(previous.send_count)+1;
  const windowStartedAt=resetWindow?new Date(now):new Date(previous.send_window_started_at);
  await pool.query(`
    INSERT INTO email_verification_requests(
      email,code_hash,code_salt,attempts,send_count,send_window_started_at,last_sent_at,expires_at,requested_ip
    ) VALUES($1,$2,$3,0,$4,$5,now(),$6,$7)
    ON CONFLICT(email) DO UPDATE SET
      code_hash=EXCLUDED.code_hash,code_salt=EXCLUDED.code_salt,attempts=0,
      send_count=EXCLUDED.send_count,send_window_started_at=EXCLUDED.send_window_started_at,
      last_sent_at=now(),expires_at=EXCLUDED.expires_at,requested_ip=EXCLUDED.requested_ip
  `,[email,hash,salt,sendCount,windowStartedAt,expiresAt,String(ip||'')]);
  return {ok:true,email,code,expiresInSeconds:Math.floor(EMAIL_CODE_TTL_MS/1000)};
}

export async function cancelRegistrationCode(email){
  email=normalizeEmail(email);
  if(email) await pool.query('DELETE FROM email_verification_requests WHERE email=$1',[email]);
}

export async function requestPasswordResetCode({email,ip=''}) {
  email=normalizeEmail(email);
  if (!validEmail(email)) return {ok:false,status:400,message:'Informe um e-mail valido.'};

  // Nao revela se a conta existe: a resposta publica e sempre generica.
  const account=(await pool.query(`SELECT id FROM accounts WHERE email=$1 AND status='active' LIMIT 1`,[email])).rows[0];
  if(!account)return {ok:true,email,send:false,expiresInSeconds:Math.floor(EMAIL_CODE_TTL_MS/1000)};

  const previous=(await pool.query(`
    SELECT send_count,send_window_started_at,last_sent_at
    FROM password_reset_requests WHERE email=$1
  `,[email])).rows[0];
  const now=Date.now();
  if(previous){
    const lastSent=new Date(previous.last_sent_at).getTime();
    if(now-lastSent<EMAIL_RESEND_COOLDOWN_MS){
      const wait=Math.max(1,Math.ceil((EMAIL_RESEND_COOLDOWN_MS-(now-lastSent))/1000));
      return {ok:false,status:429,message:`Aguarde ${wait}s para reenviar o codigo.`};
    }
    const windowStart=new Date(previous.send_window_started_at).getTime();
    if(now-windowStart<EMAIL_SEND_WINDOW_MS && Number(previous.send_count)>=EMAIL_MAX_SENDS_PER_WINDOW){
      return {ok:false,status:429,message:'Limite de recuperacoes atingido para este e-mail. Tente novamente mais tarde.'};
    }
  }

  const code=String(crypto.randomInt(0,1_000_000)).padStart(6,'0');
  const {salt,hash}=await verificationCodeRecord(code);
  const expiresAt=new Date(now+EMAIL_CODE_TTL_MS);
  const resetWindow=!previous || now-new Date(previous.send_window_started_at).getTime()>=EMAIL_SEND_WINDOW_MS;
  const sendCount=resetWindow?1:Number(previous.send_count)+1;
  const windowStartedAt=resetWindow?new Date(now):new Date(previous.send_window_started_at);
  await pool.query(`
    INSERT INTO password_reset_requests(
      email,code_hash,code_salt,attempts,send_count,send_window_started_at,last_sent_at,expires_at,requested_ip
    ) VALUES($1,$2,$3,0,$4,$5,now(),$6,$7)
    ON CONFLICT(email) DO UPDATE SET
      code_hash=EXCLUDED.code_hash,code_salt=EXCLUDED.code_salt,attempts=0,
      send_count=EXCLUDED.send_count,send_window_started_at=EXCLUDED.send_window_started_at,
      last_sent_at=now(),expires_at=EXCLUDED.expires_at,requested_ip=EXCLUDED.requested_ip
  `,[email,hash,salt,sendCount,windowStartedAt,expiresAt,String(ip||'')]);
  return {ok:true,email,send:true,code,expiresInSeconds:Math.floor(EMAIL_CODE_TTL_MS/1000)};
}

export async function cancelPasswordResetCode(email){
  email=normalizeEmail(email);
  if(email)await pool.query('DELETE FROM password_reset_requests WHERE email=$1',[email]);
}

export async function resetAccountPassword({email,password,code}) {
  email=normalizeEmail(email);
  password=String(password||'');
  code=String(code||'').replace(/\D/g,'');
  if(!validEmail(email))return {ok:false,status:400,message:'Informe um e-mail valido.'};
  if(!/^\d{6}$/.test(code))return {ok:false,status:400,message:'Informe o codigo de 6 digitos enviado ao e-mail.'};
  if(password.length<8)return {ok:false,status:400,message:'A nova senha deve ter pelo menos 8 caracteres.'};
  if(password.length>128)return {ok:false,status:400,message:'Senha muito longa.'};

  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const account=(await client.query(`SELECT id FROM accounts WHERE email=$1 AND status='active' FOR UPDATE`,[email])).rows[0];
    const request=(await client.query(`SELECT * FROM password_reset_requests WHERE email=$1 FOR UPDATE`,[email])).rows[0];
    if(!account||!request){await client.query('ROLLBACK');return {ok:false,status:400,message:'Codigo invalido ou expirado.'};}
    if(new Date(request.expires_at).getTime()<=Date.now()){
      await client.query('DELETE FROM password_reset_requests WHERE email=$1',[email]);
      await client.query('COMMIT');
      return {ok:false,status:400,message:'O codigo expirou. Solicite um novo codigo.'};
    }
    if(Number(request.attempts)>=EMAIL_MAX_ATTEMPTS){await client.query('ROLLBACK');return {ok:false,status:429,message:'Muitas tentativas. Solicite um novo codigo.'};}
    const valid=await verifyVerificationCode(code,request.code_salt,request.code_hash);
    if(!valid){
      await client.query('UPDATE password_reset_requests SET attempts=attempts+1 WHERE email=$1',[email]);
      await client.query('COMMIT');
      const remaining=Math.max(0,EMAIL_MAX_ATTEMPTS-Number(request.attempts)-1);
      return {ok:false,status:400,message:remaining?`Codigo incorreto. Restam ${remaining} tentativa(s).`:'Codigo bloqueado. Solicite um novo codigo.'};
    }
    const {salt,hash}=await passwordRecord(password);
    await client.query('UPDATE accounts SET password_hash=$2,password_salt=$3 WHERE id=$1',[account.id,hash,salt]);
    await client.query('DELETE FROM sessions WHERE account_id=$1',[account.id]);
    await client.query('DELETE FROM password_reset_requests WHERE email=$1',[email]);
    await client.query('COMMIT');
    return {ok:true,message:'Senha alterada com sucesso. Entre novamente com a nova senha.'};
  }catch(error){try{await client.query('ROLLBACK')}catch{};throw error}finally{client.release()}
}

export async function initDatabase() {
  if (!dbConfig.password) {
    throw new Error(`PostgreSQL ainda nao foi configurado. Execute CONFIGURAR-POSTGRESQL.bat antes de iniciar o multiplayer.`);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id uuid PRIMARY KEY,
        email text NOT NULL UNIQUE,
        password_hash text NOT NULL,
        password_salt text NOT NULL,
        status text NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL DEFAULT now(),
        last_login_at timestamptz
      )
    `);
    await client.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS email_verified_at timestamptz`);
    // V20.67: beneficios VIP e desbloqueios pertencem a conta.
    await client.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS vip_until timestamptz`);
    await client.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS game_pass boolean NOT NULL DEFAULT false`);
    await client.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS unlocked_vocations jsonb NOT NULL DEFAULT '[]'::jsonb`);
    await client.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS supply_last_bought_at timestamptz`);
    await client.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS daily_last_claim_at timestamptz`);
    await client.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS daily_login_streak integer NOT NULL DEFAULT 0`);
    // V21.17: progressão do Passe e Depot pertencem à conta, não ao personagem.
    await client.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS game_pass_state jsonb NOT NULL DEFAULT '{}'::jsonb`);
    await client.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS shared_depot jsonb NOT NULL DEFAULT '{}'::jsonb`);
    // Contas anteriores a V20.45 sao preservadas como verificadas para nao bloquear jogadores existentes.
    await client.query(`UPDATE accounts SET email_verified_at=created_at WHERE email_verified_at IS NULL`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_verification_requests (
        email text PRIMARY KEY,
        code_hash text NOT NULL,
        code_salt text NOT NULL,
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        send_count integer NOT NULL DEFAULT 1 CHECK (send_count >= 1),
        send_window_started_at timestamptz NOT NULL DEFAULT now(),
        last_sent_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        requested_ip text,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_email_verification_expiry
      ON email_verification_requests(expires_at)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS password_reset_requests (
        email text PRIMARY KEY,
        code_hash text NOT NULL,
        code_salt text NOT NULL,
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        send_count integer NOT NULL DEFAULT 1 CHECK (send_count >= 1),
        send_window_started_at timestamptz NOT NULL DEFAULT now(),
        last_sent_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        requested_ip text,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_password_reset_expiry
      ON password_reset_requests(expires_at)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS characters (
        id uuid PRIMARY KEY,
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        name varchar(16) NOT NULL,
        name_key varchar(16) NOT NULL UNIQUE,
        vocation_id varchar(80) NOT NULL,
        level integer NOT NULL DEFAULT 1 CHECK (level >= 1),
        bank bigint NOT NULL DEFAULT 0,
        reborn_completed boolean NOT NULL DEFAULT false,
        reborn_completed_at timestamptz,
        state jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_characters_account
      ON characters(account_id, created_at)
    `);
    await client.query(`ALTER TABLE characters ADD COLUMN IF NOT EXISTS server_revision bigint NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE characters ADD COLUMN IF NOT EXISTS last_authoritative_at timestamptz`);
    // V20.59: cargo de acesso separado da vocacao jogavel. Somente alteracao direta no banco concede ADM.
    await client.query(`ALTER TABLE characters ADD COLUMN IF NOT EXISTS access_vocation varchar(80)`);
    // V20.66: moeda premium autoritativa, usada pelo Market e pela futura Loja VIP.
    await client.query(`ALTER TABLE characters ADD COLUMN IF NOT EXISTS premium_points bigint NOT NULL DEFAULT 0`);
    await client.query(`UPDATE characters SET premium_points=GREATEST(0,COALESCE(premium_points,0),CASE WHEN COALESCE(state->'profile'->>'premiumPoints',state->'profile'->>'vipCredits','') ~ '^[0-9]+$' THEN COALESCE(state->'profile'->>'premiumPoints',state->'profile'->>'vipCredits')::bigint ELSE 0 END)`);
    await client.query(`DO $$ BEGIN ALTER TABLE characters ADD CONSTRAINT characters_premium_points_nonnegative CHECK (premium_points >= 0); EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    // V21.25.1: historico PvP persistente por personagem.
    await client.query(`ALTER TABLE characters ADD COLUMN IF NOT EXISTS pvp_wins bigint NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE characters ADD COLUMN IF NOT EXISTS pvp_losses bigint NOT NULL DEFAULT 0`);
    await client.query(`UPDATE characters SET pvp_wins=GREATEST(0,COALESCE(pvp_wins,0)),pvp_losses=GREATEST(0,COALESCE(pvp_losses,0))`);
    await client.query(`DO $$ BEGIN ALTER TABLE characters ADD CONSTRAINT characters_pvp_wins_nonnegative CHECK (pvp_wins >= 0); EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    await client.query(`DO $$ BEGIN ALTER TABLE characters ADD CONSTRAINT characters_pvp_losses_nonnegative CHECK (pvp_losses >= 0); EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    // V20.70.1: Premium Points pertencem à conta. A coluna antiga de characters
    // continua como espelho de compatibilidade para versões anteriores.
    await client.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS premium_points bigint NOT NULL DEFAULT 0`);
    await client.query(`UPDATE accounts a SET premium_points=GREATEST(COALESCE(a.premium_points,0),COALESCE((SELECT MAX(c.premium_points) FROM characters c WHERE c.account_id=a.id),0))`);
    await client.query(`UPDATE characters c SET premium_points=a.premium_points FROM accounts a WHERE c.account_id=a.id`);
    await client.query(`DO $$ BEGIN ALTER TABLE accounts ADD CONSTRAINT accounts_premium_points_nonnegative CHECK (premium_points >= 0); EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    // V21: compras de Premium Points via Mercado Pago.
    await client.query(`
      CREATE TABLE IF NOT EXISTS premium_point_payments (
        id uuid PRIMARY KEY,
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        character_id uuid REFERENCES characters(id) ON DELETE SET NULL,
        external_reference varchar(100) NOT NULL UNIQUE,
        mercadopago_payment_id varchar(100) UNIQUE,
        premium_points integer NOT NULL CHECK (premium_points BETWEEN 50 AND 5000),
        amount_brl numeric(10,2) NOT NULL CHECK (amount_brl > 0),
        payment_method varchar(40),
        status varchar(40) NOT NULL DEFAULT 'created',
        status_detail varchar(100),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        approved_at timestamptz,
        credited_at timestamptz
      )
    `);
    await client.query(`ALTER TABLE premium_point_payments ADD COLUMN IF NOT EXISTS mercadopago_order_id varchar(100)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pp_payments_order ON premium_point_payments(mercadopago_order_id) WHERE mercadopago_order_id IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pp_payments_account ON premium_point_payments(account_id,created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pp_payments_provider ON premium_point_payments(mercadopago_payment_id)`);
    // V21.0.5: trilha de auditoria dos eventos do gateway. Nunca armazena tokens/cartao/segredos.
    await client.query(`
      CREATE TABLE IF NOT EXISTS premium_point_payment_events (
        id bigserial PRIMARY KEY,
        payment_id uuid REFERENCES premium_point_payments(id) ON DELETE CASCADE,
        account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
        provider varchar(30) NOT NULL DEFAULT 'mercadopago',
        event_type varchar(80) NOT NULL,
        provider_status varchar(60),
        provider_status_detail varchar(120),
        provider_order_id varchar(100),
        provider_payment_id varchar(100),
        amount_brl numeric(10,2),
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pp_payment_events_payment ON premium_point_payment_events(payment_id,created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pp_payment_events_account ON premium_point_payment_events(account_id,created_at DESC)`);
    // V20.60: cada equipamento elegivel passa a ter identidade propria para
    // raridade e para o futuro Market. O state JSONB continua carregando a
    // localizacao instantanea; esta tabela e o indice relacional das instancias.
    await client.query(`
      CREATE TABLE IF NOT EXISTS item_instances (
        id uuid PRIMARY KEY,
        owner_character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        base_item_id varchar(100) NOT NULL,
        rarity varchar(32) NOT NULL DEFAULT 'common',
        rarity_tier smallint NOT NULL DEFAULT 0 CHECK (rarity_tier BETWEEN 0 AND 7),
        rarity_multiplier numeric(5,2) NOT NULL DEFAULT 1.00 CHECK (rarity_multiplier >= 1.00),
        location varchar(24) NOT NULL DEFAULT 'inventory',
        source varchar(40) NOT NULL DEFAULT 'unknown',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`DO $$ BEGIN ALTER TABLE item_instances ADD CONSTRAINT item_instances_rarity_valid CHECK (rarity IN ('common','rare','super_rare','epic','legendary','super_legendary','mythic','divine')); EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_item_instances_owner ON item_instances(owner_character_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_item_instances_market_lookup ON item_instances(base_item_id,rarity_tier)`);
    // V20.66: Market global. Itens e valores ficam em custodia no PostgreSQL.
    await client.query(`
      CREATE TABLE IF NOT EXISTS market_listings (
        id uuid PRIMARY KEY,
        seller_character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        item_id varchar(100) NOT NULL,
        item_payload jsonb NOT NULL,
        quantity integer NOT NULL CHECK (quantity > 0),
        rarity varchar(32) NOT NULL DEFAULT 'common',
        rarity_tier smallint NOT NULL DEFAULT 0,
        price bigint NOT NULL CHECK (price > 0),
        currency varchar(16) NOT NULL CHECK (currency IN ('zeni','premium')),
        fee bigint NOT NULL DEFAULT 0 CHECK (fee >= 0),
        status varchar(16) NOT NULL DEFAULT 'active',
        buyer_character_id uuid REFERENCES characters(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
        completed_at timestamptz
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_market_listings_active ON market_listings(status,expires_at,created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_market_listings_match ON market_listings(item_id,rarity,currency,price) WHERE status='active'`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS market_requests (
        id uuid PRIMARY KEY,
        buyer_character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        item_id varchar(100) NOT NULL,
        rarity varchar(32) NOT NULL DEFAULT 'common',
        quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
        remaining_quantity integer NOT NULL DEFAULT 1 CHECK (remaining_quantity >= 0),
        unit_price bigint NOT NULL CHECK (unit_price > 0),
        currency varchar(16) NOT NULL CHECK (currency IN ('zeni','premium')),
        escrow bigint NOT NULL CHECK (escrow >= 0),
        status varchar(16) NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_market_requests_match ON market_requests(item_id,rarity,currency,unit_price DESC) WHERE status='active'`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS market_history (
        id bigserial PRIMARY KEY,
        listing_id uuid,
        request_id uuid,
        seller_character_id uuid REFERENCES characters(id) ON DELETE SET NULL,
        buyer_character_id uuid REFERENCES characters(id) ON DELETE SET NULL,
        item_id varchar(100) NOT NULL,
        item_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        quantity integer NOT NULL,
        rarity varchar(32) NOT NULL DEFAULT 'common',
        unit_price bigint NOT NULL,
        currency varchar(16) NOT NULL,
        source varchar(20) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_market_history_chars ON market_history(seller_character_id,buyer_character_id,created_at DESC)`);

    // V21.8.0: Guilds persistentes. Gold/Zeni doado continua sendo queimado
    // imediatamente para gerar XP. Premium Points passam primeiro pelo Cofre da
    // Guild e so sao queimados ao converter em XP ou ao invocar o Boss da Guild.
    // Cargos, solicitacoes de entrada e runs do Boss tambem ficam persistentes.
    await client.query(`
      CREATE TABLE IF NOT EXISTS guilds (
        id uuid PRIMARY KEY,
        name varchar(32) NOT NULL,
        name_key varchar(32) NOT NULL UNIQUE,
        tag varchar(6) NOT NULL,
        tag_key varchar(6) NOT NULL UNIQUE,
        leader_character_id uuid REFERENCES characters(id) ON DELETE SET NULL,
        level integer NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 50),
        xp bigint NOT NULL DEFAULT 0 CHECK (xp >= 0),
        lifetime_xp bigint NOT NULL DEFAULT 0 CHECK (lifetime_xp >= 0),
        guild_points integer NOT NULL DEFAULT 0 CHECK (guild_points >= 0),
        gold_burned bigint NOT NULL DEFAULT 0 CHECK (gold_burned >= 0),
        pp_burned bigint NOT NULL DEFAULT 0 CHECK (pp_burned >= 0),
        pp_vault bigint NOT NULL DEFAULT 0 CHECK (pp_vault >= 0),
        technologies jsonb NOT NULL DEFAULT '{}'::jsonb,
        message_of_day varchar(180) NOT NULL DEFAULT 'Bem-vindos! Contribuam para fortalecer a guilda.',
        join_open boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`ALTER TABLE guilds ADD COLUMN IF NOT EXISTS pp_vault bigint NOT NULL DEFAULT 0 CHECK (pp_vault >= 0)`);
    await client.query(`ALTER TABLE guilds ADD COLUMN IF NOT EXISTS guild_boss_bestiary jsonb NOT NULL DEFAULT '{}'::jsonb`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_guilds_ranking ON guilds(level DESC,lifetime_xp DESC,created_at)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS guild_members (
        guild_id uuid NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        character_id uuid NOT NULL UNIQUE REFERENCES characters(id) ON DELETE CASCADE,
        role varchar(16) NOT NULL DEFAULT 'recruit',
        contributed_gold bigint NOT NULL DEFAULT 0 CHECK (contributed_gold >= 0),
        contributed_pp bigint NOT NULL DEFAULT 0 CHECK (contributed_pp >= 0),
        contributed_xp bigint NOT NULL DEFAULT 0 CHECK (contributed_xp >= 0),
        joined_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(guild_id,character_id)
      )
    `);
    await client.query(`ALTER TABLE guild_members DROP CONSTRAINT IF EXISTS guild_members_role_check`);
    await client.query(`DO $$ BEGIN ALTER TABLE guild_members ADD CONSTRAINT guild_members_role_check CHECK (role IN ('leader','vice','member','recruit')); EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_guild_members_guild ON guild_members(guild_id,contributed_xp DESC,joined_at)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS guild_join_requests (
        id uuid PRIMARY KEY,
        guild_id uuid NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        status varchar(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','cancelled')),
        requested_at timestamptz NOT NULL DEFAULT now(),
        decided_by uuid REFERENCES characters(id) ON DELETE SET NULL,
        decided_at timestamptz
      )
    `);
    await client.query(`ALTER TABLE guild_join_requests DROP CONSTRAINT IF EXISTS guild_join_requests_guild_id_character_id_status_key`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_guild_join_requests_pending ON guild_join_requests(guild_id,requested_at) WHERE status='pending'`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_guild_join_requests_unique_pending ON guild_join_requests(guild_id,character_id) WHERE status='pending'`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS guild_boss_runs (
        id uuid PRIMARY KEY,
        guild_id uuid NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        summoned_by uuid REFERENCES characters(id) ON DELETE SET NULL,
        status varchar(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','won','lost','cancelled')),
        summon_cost_pp integer NOT NULL DEFAULT 100 CHECK (summon_cost_pp >= 0),
        starts_at timestamptz NOT NULL,
        started_at timestamptz,
        ended_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`ALTER TABLE guild_boss_runs ADD COLUMN IF NOT EXISTS boss_type varchar(20) NOT NULL DEFAULT 'daishinkan'`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_guild_boss_runs_guild ON guild_boss_runs(guild_id,created_at DESC)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS guild_boss_participants (
        run_id uuid NOT NULL REFERENCES guild_boss_runs(id) ON DELETE CASCADE,
        character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        accepted_at timestamptz NOT NULL DEFAULT now(),
        outcome varchar(16) NOT NULL DEFAULT 'accepted' CHECK (outcome IN ('accepted','alive','dead','rewarded')),
        PRIMARY KEY(run_id,character_id)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS guild_history (
        id bigserial PRIMARY KEY,
        guild_id uuid NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        character_id uuid REFERENCES characters(id) ON DELETE SET NULL,
        event varchar(40) NOT NULL,
        details jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_guild_history_guild ON guild_history(guild_id,created_at DESC)`);

    // V21.25.1: cada duelo fica registrado para que apostas sejam atomicas e
    // idempotentes. Se o processo reiniciar no meio da luta, o startup devolve
    // qualquer valor que ainda estivesse em custodia.
    await client.query(`
      CREATE TABLE IF NOT EXISTS pvp_duels (
        id uuid PRIMARY KEY,
        challenger_character_id uuid REFERENCES characters(id) ON DELETE SET NULL,
        challenged_character_id uuid REFERENCES characters(id) ON DELETE SET NULL,
        challenger_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
        challenged_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
        wager_currency varchar(16) NOT NULL DEFAULT 'none' CHECK (wager_currency IN ('none','zeni','premium')),
        wager_amount bigint NOT NULL DEFAULT 0 CHECK (wager_amount >= 0),
        status varchar(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','settled','refunded')),
        winner_character_id uuid REFERENCES characters(id) ON DELETE SET NULL,
        loser_character_id uuid REFERENCES characters(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pvp_duels_created ON pvp_duels(created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pvp_duels_characters ON pvp_duels(challenger_character_id,challenged_character_id,created_at DESC)`);

    // Reembolso automatico de duelos interrompidos por restart/crash.
    const stalePvp=(await client.query(`SELECT * FROM pvp_duels WHERE status='active' FOR UPDATE`)).rows;
    for(const duel of stalePvp){
      const amount=Math.max(0,Math.trunc(Number(duel.wager_amount)||0));
      const currency=String(duel.wager_currency||'none');
      if(amount>0&&currency==='zeni'){
        for(const characterId of [duel.challenger_character_id,duel.challenged_character_id]){
          if(!characterId)continue;
          await client.query(`UPDATE characters SET bank=bank+$2,state=jsonb_set(state,'{profile,bank}',to_jsonb((bank+$2)::bigint),true),server_revision=server_revision+1,last_authoritative_at=now(),updated_at=now() WHERE id=$1`,[characterId,amount]);
        }
      }else if(amount>0&&currency==='premium'){
        const accountAmounts=new Map();
        for(const accountId of [duel.challenger_account_id,duel.challenged_account_id]){if(accountId)accountAmounts.set(String(accountId),(accountAmounts.get(String(accountId))||0)+amount);}
        for(const [accountId,refund] of accountAmounts){
          await client.query(`UPDATE accounts SET premium_points=premium_points+$2 WHERE id=$1`,[accountId,refund]);
          await client.query(`UPDATE characters SET premium_points=premium_points+$2,state=jsonb_set(jsonb_set(state,'{profile,premiumPoints}',to_jsonb((premium_points+$2)::bigint),true),'{profile,vipCredits}',to_jsonb((premium_points+$2)::bigint),true),server_revision=server_revision+1,last_authoritative_at=now(),updated_at=now() WHERE account_id=$1`,[accountId,refund]);
        }
      }
      await client.query(`UPDATE pvp_duels SET status='refunded',finished_at=now() WHERE id=$1`,[duel.id]);
    }

    // V20.47: invariantes economicas e Reborn tambem protegidas no PostgreSQL.
    await client.query(`UPDATE characters SET bank=0 WHERE bank<0`);
    await client.query(`DO $$ BEGIN ALTER TABLE characters ADD CONSTRAINT characters_bank_nonnegative CHECK (bank >= 0); EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    await client.query(`
      CREATE OR REPLACE FUNCTION dbo_idle_guard_reborn_once() RETURNS trigger AS $$
      BEGIN
        IF OLD.reborn_completed = true AND NEW.reborn_completed = false THEN
          RAISE EXCEPTION 'Reborn concluido nao pode ser revertido';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`DROP TRIGGER IF EXISTS trg_dbo_idle_reborn_once ON characters`);
    await client.query(`
      CREATE TRIGGER trg_dbo_idle_reborn_once
      BEFORE UPDATE OF reborn_completed ON characters
      FOR EACH ROW EXECUTE FUNCTION dbo_idle_guard_reborn_once()
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS security_events (
        id bigserial PRIMARY KEY,
        occurred_at timestamptz NOT NULL DEFAULT now(),
        account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
        character_id uuid REFERENCES characters(id) ON DELETE SET NULL,
        event varchar(60) NOT NULL,
        ip text,
        details jsonb NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_security_events_time ON security_events(occurred_at DESC)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id uuid PRIMARY KEY,
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        token_hash char(64) NOT NULL UNIQUE,
        ip text,
        user_agent text,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS connection_logs (
        id bigserial PRIMARY KEY,
        occurred_at timestamptz NOT NULL DEFAULT now(),
        event varchar(20) NOT NULL,
        ip text,
        connection_id text,
        account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
        profile_id text,
        character_id text,
        character_name text,
        level integer,
        user_agent text
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_connection_logs_time
      ON connection_logs(occurred_at DESC)
    `);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return dbConfig;
}

function cookieMap(request) {
  const raw = String(request?.headers?.cookie || '');
  const result = {};
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    result[part.slice(0,index).trim()] = decodeURIComponent(part.slice(index+1).trim());
  }
  return result;
}

export function sessionCookie(token, request, {clear=false}={}) {
  const forwardedProto = String(request?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  const secure = Boolean(request?.socket?.encrypted) || forwardedProto === 'https';
  const parts = [
    `${SESSION_COOKIE}=${clear ? '' : encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (secure) parts.push('Secure');
  if (clear) parts.push('Max-Age=0');
  else parts.push(`Max-Age=${Math.floor(SESSION_MAX_AGE_MS/1000)}`);
  return parts.join('; ');
}

export async function accountFromRequest(request) {
  const token = cookieMap(request)[SESSION_COOKIE];
  if (!token) return null;
  const tokenHash = hashToken(token);
  const { rows } = await pool.query(`
    SELECT a.id, a.email, a.status, a.created_at, s.id AS session_id
    FROM sessions s
    JOIN accounts a ON a.id=s.account_id
    WHERE s.token_hash=$1 AND s.expires_at > now() AND a.status='active'
    LIMIT 1
  `,[tokenHash]);
  const account = rows[0] || null;
  if (account) {
    pool.query('UPDATE sessions SET last_seen_at=now() WHERE id=$1',[account.session_id]).catch(()=>{});
  }
  return account;
}

export async function createAccount({email,password,code,ip='',userAgent=''}) {
  email = normalizeEmail(email);
  password = String(password || '');
  code = String(code || '').replace(/\D/g,'');
  if (!validEmail(email)) return {ok:false,status:400,message:'Informe um e-mail valido.'};
  if (!/^\d{6}$/.test(code)) return {ok:false,status:400,message:'Informe o codigo de 6 digitos enviado ao e-mail.'};
  if (password.length < 8) return {ok:false,status:400,message:'A senha deve ter pelo menos 8 caracteres.'};
  if (password.length > 128) return {ok:false,status:400,message:'Senha muito longa.'};

  const {salt,hash} = await passwordRecord(password);
  const client=await pool.connect();
  let accountId='';
  try{
    await client.query('BEGIN');
    const existing=await client.query('SELECT 1 FROM accounts WHERE email=$1',[email]);
    if(existing.rowCount){await client.query('ROLLBACK');return {ok:false,status:409,message:'Esta conta ja existe.'}}
    const verification=(await client.query(`
      SELECT * FROM email_verification_requests WHERE email=$1 FOR UPDATE
    `,[email])).rows[0];
    if(!verification){await client.query('ROLLBACK');return {ok:false,status:400,message:'Solicite um codigo de verificacao para este e-mail.'}}
    if(new Date(verification.expires_at).getTime()<=Date.now()){
      await client.query('DELETE FROM email_verification_requests WHERE email=$1',[email]);
      await client.query('COMMIT');
      return {ok:false,status:400,message:'O codigo expirou. Solicite um novo codigo.'};
    }
    if(Number(verification.attempts)>=EMAIL_MAX_ATTEMPTS){
      await client.query('ROLLBACK');
      return {ok:false,status:429,message:'Muitas tentativas de codigo. Solicite um novo codigo.'};
    }
    const valid=await verifyVerificationCode(code,verification.code_salt,verification.code_hash);
    if(!valid){
      await client.query('UPDATE email_verification_requests SET attempts=attempts+1 WHERE email=$1',[email]);
      await client.query('COMMIT');
      const remaining=Math.max(0,EMAIL_MAX_ATTEMPTS-Number(verification.attempts)-1);
      return {ok:false,status:400,message:remaining?`Codigo incorreto. Restam ${remaining} tentativa(s).`:'Codigo bloqueado. Solicite um novo codigo.'};
    }
    accountId=crypto.randomUUID();
    await client.query(`
      INSERT INTO accounts(id,email,password_hash,password_salt,email_verified_at)
      VALUES($1,$2,$3,$4,now())
    `,[accountId,email,hash,salt]);
    await client.query('DELETE FROM email_verification_requests WHERE email=$1',[email]);
    await client.query('COMMIT');
  }catch(error){
    try{await client.query('ROLLBACK')}catch{}
    if(error.code==='23505') return {ok:false,status:409,message:'Esta conta ja existe.'};
    throw error;
  }finally{client.release()}
  const session = await createSession(accountId,{ip,userAgent});
  return {ok:true,accountId,session};
}

export async function loginAccount({email,password,ip='',userAgent=''}) {
  email = normalizeEmail(email);
  const {rows} = await pool.query(`SELECT * FROM accounts WHERE email=$1 AND status='active' LIMIT 1`,[email]);
  const account = rows[0];
  if (!account || !(await verifyPassword(String(password||''),account.password_salt,account.password_hash))) {
    return {ok:false,status:401,message:'E-mail ou senha invalidos.'};
  }
  await pool.query('UPDATE accounts SET last_login_at=now() WHERE id=$1',[account.id]);
  const session = await createSession(account.id,{ip,userAgent});
  return {ok:true,accountId:account.id,session};
}

async function createSession(accountId,{ip='',userAgent=''}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now()+SESSION_MAX_AGE_MS);
  await pool.query(`
    INSERT INTO sessions(id,account_id,token_hash,ip,user_agent,expires_at)
    VALUES($1,$2,$3,$4,$5,$6)
  `,[id,accountId,hashToken(token),String(ip||''),String(userAgent||'').slice(0,500),expiresAt]);
  return {id,token,expiresAt};
}

export async function logoutRequest(request) {
  const token = cookieMap(request)[SESSION_COOKIE];
  if (!token) return;
  await pool.query('DELETE FROM sessions WHERE token_hash=$1',[hashToken(token)]);
}

function stateSummary(state={}) {
  const profile = state.profile || {};
  return {
    level: Math.max(1,Math.trunc(Number(profile.level || 1))),
    bank: Math.max(0,Math.trunc(Number(profile.bank || 0))),
    premiumPoints: Math.max(0,Math.trunc(Number(profile.premiumPoints ?? profile.vipCredits ?? 0))),
    vocationId: String(profile.characterId || 'goku').slice(0,80),
    rebornCompleted: Boolean(state.rebornQuest?.completed || Number(state.questStorages?.['30023'] || 0) === 4)
  };
}

function enforceStoredReborn(state, storedCompleted) {
  if (!storedCompleted) return state;
  state.rebornQuest ||= {};
  state.rebornQuest.completed = true;
  state.rebornQuest.readyForReborn = false;
  state.questStorages ||= {};
  state.questStorages['30023'] = 4;
  state.completedQuests = Array.isArray(state.completedQuests) ? state.completedQuests : [];
  if (!state.completedQuests.includes('reborn-quest')) state.completedQuests.push('reborn-quest');
  return state;
}

const GAME_PASS_ACCOUNT_KEYS=Object.freeze(['gamePassXp','gamePassClaimedMissions','gamePassClaimedFree','gamePassClaimedPremium','gamePassStats','gamePassDailyStats','gamePassWeeklyStats','unlockedProfileIcons','unlockedProfileBorders','profileIcon','profileBorder','mailbox']);
function accountGamePassSnapshot(state={}){const p=state.profile||{},out={};for(const key of GAME_PASS_ACCOUNT_KEYS)if(p[key]!==undefined)out[key]=structuredClone(p[key]);return out;}
function mergeAccountGamePassStates(states=[]){
  const snapshots=states.map(accountGamePassSnapshot),out={};
  out.gamePassXp=Math.max(0,...snapshots.map(p=>Number(p.gamePassXp||0)));
  for(const key of ['gamePassClaimedMissions','gamePassClaimedFree','gamePassClaimedPremium','unlockedProfileIcons','unlockedProfileBorders'])out[key]=[...new Set(snapshots.flatMap(p=>Array.isArray(p[key])?p[key]:[]))];
  for(const key of ['gamePassStats','gamePassDailyStats','gamePassWeeklyStats']){
    const candidates=snapshots.map(p=>p[key]).filter(v=>v&&typeof v==='object');if(!candidates.length)continue;
    const newest=candidates[candidates.length-1],merged={...(newest.key?{key:newest.key}:{})};
    for(const stat of ['kills','bosses','xp','drops','supplies'])merged[stat]=Math.max(0,...candidates.filter(v=>!newest.key||v.key===newest.key).map(v=>Number(v[stat]||0)));
    out[key]=merged;
  }
  const preferred=snapshots.find(p=>p.profileIcon==='beta'||p.profileBorder==='beta')||snapshots.sort((a,b)=>Number(b.gamePassXp||0)-Number(a.gamePassXp||0))[0]||{};
  out.profileIcon=preferred.profileIcon||'default';out.profileBorder=preferred.profileBorder||'default';out.unlockedProfileIcons=[...new Set(['default',...(out.unlockedProfileIcons||[])])];out.unlockedProfileBorders=[...new Set(['default',...(out.unlockedProfileBorders||[])])];
  out.mailbox=normalizeMailbox(snapshots.flatMap(p=>Array.isArray(p.mailbox)?p.mailbox:[]));
  return out;
}
function applyAccountGamePassState(state,pass={}){state.profile||={};if(pass&&typeof pass==='object')for(const key of GAME_PASS_ACCOUNT_KEYS)if(pass[key]!==undefined)state.profile[key]=structuredClone(pass[key]);state.profile.mailbox=normalizeMailbox(state.profile.mailbox||[]);return state;}
function stripSharedInstances(value){if(Array.isArray(value))return value.map(stripSharedInstances);if(!value||typeof value!=='object')return value;const out={};for(const [k,v] of Object.entries(value)){if(k==='instanceId')continue;out[k]=stripSharedInstances(v);}return out;}
function depotTreeIds(state,rootIds){const ids=new Set(),visit=id=>{if(!id||ids.has(id)||!state.containers?.[id])return;ids.add(id);for(const entry of state.containers[id].items||[])if(entry?.containerId)visit(entry.containerId);};for(const id of rootIds)visit(id);return ids;}
function sharedDepotSnapshot(state={}){normalizeInventoryState(state);const roots=[state.depotContainerId,...(state.vipDepotContainerIds||[])],ids=depotTreeIds(state,roots),containers={};for(const id of ids)containers[id]=stripSharedInstances(structuredClone(state.containers[id]));return {depotContainerId:state.depotContainerId,vipDepotContainerIds:[...(state.vipDepotContainerIds||[])],containers};}
function mergeSharedDepotStates(states=[]){
  if(!states.length)return {};
  const snapshots=states.map(state=>sharedDepotSnapshot(structuredClone(state||{}))),base=structuredClone(snapshots[0]);
  const baseRoots=[base.depotContainerId,...(base.vipDepotContainerIds||[])];
  for(const source of snapshots.slice(1)){
    const sourceRoots=[source.depotContainerId,...(source.vipDepotContainerIds||[])];
    for(let ri=0;ri<Math.min(baseRoots.length,sourceRoots.length);ri++){
      const srcRoot=source.containers?.[sourceRoots[ri]],dstRoot=base.containers?.[baseRoots[ri]];if(!srcRoot||!dstRoot)continue;
      const childIds=depotTreeIds({containers:source.containers},[sourceRoots[ri]]);childIds.delete(sourceRoots[ri]);const idMap=new Map();for(const oldId of childIds)idMap.set(oldId,`shared-${crypto.randomUUID()}`);
      for(const oldId of childIds){const c=structuredClone(source.containers[oldId]);c.id=idMap.get(oldId);c.parentId=idMap.get(c.parentId)||baseRoots[ri];for(const e of c.items||[])if(e.containerId)e.containerId=idMap.get(e.containerId)||e.containerId;base.containers[c.id]=c;}
      const occupied=new Set((dstRoot.items||[]).map(e=>Number(e.uiSlot)).filter(Number.isFinite));
      for(const sourceEntry of srcRoot.items||[]){const e=structuredClone(sourceEntry);if(e.containerId)e.containerId=idMap.get(e.containerId)||e.containerId;let slot=0;while(occupied.has(slot))slot++;e.uiSlot=slot;occupied.add(slot);dstRoot.items.push(e);}
      dstRoot.capacity=Math.max(Number(dstRoot.capacity||400),dstRoot.items.length);
    }
  }
  return base;
}
function applySharedDepotState(state,shared={}){if(!shared?.depotContainerId||!shared?.containers?.[shared.depotContainerId])return state;normalizeInventoryState(state);const oldIds=depotTreeIds(state,[state.depotContainerId,...(state.vipDepotContainerIds||[])]);for(const id of oldIds)delete state.containers[id];for(const [id,container] of Object.entries(structuredClone(shared.containers||{})))state.containers[id]=stripSharedInstances(container);state.depotContainerId=shared.depotContainerId;state.vipDepotContainerIds=[...(shared.vipDepotContainerIds||[])];normalizeInventoryState(state);ensureItemInstancesInState(state,itemCatalog,'shared-depot');return state;}
function brasiliaDateParts(value=Date.now()){const d=new Date(Number(value instanceof Date?value.getTime():value)-3*3600000);return {year:d.getUTCFullYear(),month:d.getUTCMonth()+1,day:d.getUTCDate(),key:`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`};}

async function accountBenefits(accountId, client=pool) {
  const {rows}=await client.query(`SELECT vip_until,game_pass,unlocked_vocations,supply_last_bought_at,daily_last_claim_at,daily_login_streak,premium_points,game_pass_state,shared_depot FROM accounts WHERE id=$1 LIMIT 1`,[accountId]);
  const row=rows[0]||{};
  const dailyLastClaimAt=row.daily_last_claim_at?new Date(row.daily_last_claim_at).getTime():0;
  const currentBr=brasiliaDateParts(),lastBr=dailyLastClaimAt?brasiliaDateParts(dailyLastClaimAt):null;
  const dailyLoginStreak=lastBr&&lastBr.year===currentBr.year&&lastBr.month===currentBr.month?Math.max(0,Number(row.daily_login_streak)||0):0;
  return {vipUntil:row.vip_until?new Date(row.vip_until).getTime():0,gamePass:Boolean(row.game_pass),unlockedVocations:Array.isArray(row.unlocked_vocations)?row.unlocked_vocations:[],supplyLastBoughtAt:row.supply_last_bought_at?new Date(row.supply_last_bought_at).getTime():0,dailyLastClaimAt,dailyLoginStreak,premiumPoints:Math.max(0,Number(row.premium_points)||0),gamePassState:row.game_pass_state&&typeof row.game_pass_state==='object'?row.game_pass_state:{},sharedDepot:row.shared_depot&&typeof row.shared_depot==='object'?row.shared_depot:{}};
}
function applyAccountBenefits(state, benefits={}){
  state.profile||={};state.profile.vipUntil=Number(benefits.vipUntil||0);state.profile.gamePass=Boolean(benefits.gamePass);state.profile.unlockedVocations=[...(benefits.unlockedVocations||[])];state.profile.supplyLastBoughtAt=Number(benefits.supplyLastBoughtAt||0);state.profile.dailyLastClaimAt=Number(benefits.dailyLastClaimAt||0);state.profile.dailyLoginStreak=Math.max(0,Number(benefits.dailyLoginStreak)||0);state.profile.premiumPoints=Math.max(0,Number(benefits.premiumPoints)||0);state.profile.vipCredits=state.profile.premiumPoints;state.profile.profileIcon ||= 'default';state.profile.unlockedProfileIcons=[...new Set(['default',...(state.profile.unlockedProfileIcons||[])])];state.profile.unlockedProfileBorders=[...new Set(['default',...(state.profile.unlockedProfileBorders||[])])];applyAccountGamePassState(state,benefits.gamePassState||{});applySharedDepotState(state,benefits.sharedDepot||{});return state;
}

export async function purchaseVipProduct(accountId,characterId,{productId,newName=''}){
  const catalog={
    vip30:{price:100,kind:'vip',days:30},vip60:{price:190,kind:'vip',days:60},vip90:{price:270,kind:'vip',days:90},
    xp1h:{price:10,kind:'xp',ms:3600000},xp24h:{price:120,kind:'xp',ms:86400000},xp7d:{price:500,kind:'xp',ms:604800000},
    loot1h:{price:10,kind:'loot',ms:3600000},loot24h:{price:120,kind:'loot',ms:86400000},loot7d:{price:500,kind:'loot',ms:604800000},
    supplies:{price:70,kind:'supplies'},gamepass:{price:200,kind:'gamepass'},rename:{price:150,kind:'rename'},
    two_tones_band:{price:100,kind:'item',itemId:'training_gloves'},
    vocation_kyabe:{price:500,kind:'vocation',vocation:'kyabe'},vocation_vermouth:{price:500,kind:'vocation',vocation:'vermouth'},vocation_champa:{price:500,kind:'vocation',vocation:'champa'},vocation_paikuhan:{price:500,kind:'vocation',vocation:'paikuhan'},vocation_botamo:{price:500,kind:'vocation',vocation:'botamo'},vocation_monaka:{price:500,kind:'vocation',vocation:'monaka'}
  };
  const product=catalog[String(productId||'')]; if(!product)return {ok:false,status:400,message:'Produto VIP invalido.'};
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const account=(await client.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE',[accountId])).rows[0];
    const row=(await client.query('SELECT * FROM characters WHERE id=$1 AND account_id=$2 FOR UPDATE',[characterId,accountId])).rows[0];
    if(!account||!row){await client.query('ROLLBACK');return {ok:false,status:404,message:'Conta ou personagem nao encontrado.'}}
    const state=structuredClone(row.state||{});applyAccountBenefits(state,await accountBenefits(accountId,client));state.profile||={};
    let pp=Math.max(0,Number(account.premium_points)||0); if(pp<product.price){await client.query('ROLLBACK');return {ok:false,status:400,message:'Premium Points insuficientes.'}}
    const now=Date.now();
    if(product.kind==='supplies'){
      const last=account.supply_last_bought_at?new Date(account.supply_last_bought_at).getTime():0;
      if(now-last<7*86400000){await client.query('ROLLBACK');return {ok:false,status:409,message:`Pacote de suprimentos disponivel novamente em ${Math.ceil((7*86400000-(now-last))/86400000)} dia(s).`}}
      normalizeInventoryState(state);const add=addItemToInventory(state,'server_2151',2000,itemCatalog);if(!add?.ok){await client.query('ROLLBACK');return {ok:false,status:409,message:'Sem espaco suficiente para receber 2.000 Rose Senzu.'}}
      await client.query('UPDATE accounts SET supply_last_bought_at=now() WHERE id=$1',[accountId]);
    } else if(product.kind==='item'){
      normalizeInventoryState(state);
      const added=addItemToInventory(state,product.itemId,1,itemCatalog);
      if(!added?.ok){await client.query('ROLLBACK');return {ok:false,status:409,message:'Sem espaço suficiente para receber o item da Loja VIP.'}}
    } else if(product.kind==='vip'){
      const base=Math.max(now,account.vip_until?new Date(account.vip_until).getTime():0);await client.query('UPDATE accounts SET vip_until=$2 WHERE id=$1',[accountId,new Date(base+product.days*86400000)]);
    } else if(product.kind==='gamepass'){
      if(account.game_pass){await client.query('ROLLBACK');return {ok:false,status:409,message:'Game Pass ja desbloqueado nesta conta.'}} await client.query('UPDATE accounts SET game_pass=true WHERE id=$1',[accountId]);
    } else if(product.kind==='vocation'){
      const unlocked=Array.isArray(account.unlocked_vocations)?account.unlocked_vocations:[];if(unlocked.includes(product.vocation)){await client.query('ROLLBACK');return {ok:false,status:409,message:'Vocacao ja desbloqueada nesta conta.'}};unlocked.push(product.vocation);await client.query('UPDATE accounts SET unlocked_vocations=$2::jsonb WHERE id=$1',[accountId,JSON.stringify(unlocked)]);
    } else if(product.kind==='xp') state.profile.xpBoostUntil=Math.max(now,Number(state.profile.xpBoostUntil||0))+product.ms;
    else if(product.kind==='loot') state.profile.lootBoostUntil=Math.max(now,Number(state.profile.lootBoostUntil||0))+product.ms;
    else if(product.kind==='rename'){
      const clean=sanitizeNickname(newName);if(!validNickname(clean)){await client.query('ROLLBACK');return {ok:false,status:400,message:'Novo nick deve ter 3 a 16 letras/espacos sem acentos.'}};state.profile.name=clean;try{await client.query('UPDATE characters SET name=$2,name_key=$3 WHERE id=$1',[characterId,clean,clean.toLowerCase()])}catch(e){if(e.code==='23505'){await client.query('ROLLBACK');return {ok:false,status:409,message:'Este nickname ja esta em uso.'}}throw e}
    }
    pp-=product.price;state.profile.premiumPoints=pp;state.profile.vipCredits=pp;
    await client.query('UPDATE accounts SET premium_points=$2 WHERE id=$1',[accountId,pp]);
    await client.query('UPDATE characters SET premium_points=$2 WHERE account_id=$1',[accountId,pp]);
    await client.query('UPDATE characters SET state=$2::jsonb,updated_at=now(),server_revision=server_revision+1 WHERE id=$1',[characterId,JSON.stringify(state)]);
    await syncCharacterItemInstances(client,characterId,state);await client.query('COMMIT');
    const benefits=await accountBenefits(accountId);applyAccountBenefits(state,benefits);return {ok:true,message:'Compra realizada com sucesso.',state,accountBenefits:benefits};
  }catch(error){try{await client.query('ROLLBACK')}catch{};throw error}finally{client.release()}
}

export async function claimDailyReward(accountId,characterId){
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const account=(await client.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE',[accountId])).rows[0];
    const row=(await client.query('SELECT * FROM characters WHERE id=$1 AND account_id=$2 FOR UPDATE',[characterId,accountId])).rows[0];
    if(!account||!row){await client.query('ROLLBACK');return {ok:false,status:404,message:'Personagem nao encontrado.'}}
    const today=brasiliaDateParts(),last=account.daily_last_claim_at?brasiliaDateParts(new Date(account.daily_last_claim_at)):null;
    if(last?.key===today.key){await client.query('ROLLBACK');return {ok:false,status:409,message:'Recompensa diaria ja resgatada hoje.'}}
    const sameMonth=Boolean(last&&today.year===last.year&&today.month===last.month);
    const previousCount=sameMonth?Math.max(0,Math.min(31,Number(account.daily_login_streak)||0)):0;
    if(previousCount>=31){await client.query('ROLLBACK');return {ok:false,status:409,message:'Você já concluiu as 31 recompensas deste mês.'};}
    const day=previousCount+1,vip=Boolean(account.vip_until&&new Date(account.vip_until).getTime()>Date.now()),vipBonus=DAILY_VIP_BONUS_DAYS[day]||null;
    const state=structuredClone(row.state||{});applyAccountBenefits(state,await accountBenefits(accountId,client));normalizeInventoryState(state);state.profile||={};let rewardLabel='';
    if(vip&&vipBonus){addMail(state.profile,{kind:'boost',title:`Boost de ${vipBonus.kind==='loot'?'Loot':'XP'} VIP`,body:`Recompensa ${day} do Login Diário. Use quando quiser; este mail não expira.`,attachment:{kind:'boost',boostKind:vipBonus.kind,durationMs:Number(vipBonus.durationMs||3600000)}});rewardLabel=`Boost de ${vipBonus.kind==='loot'?'Loot':'XP'} VIP enviado ao Dragon Mail`; }
    else {const reward=dailyLoginReward(day),added=addItemToInventory(state,reward.item,reward.qty,itemCatalog);if(!added?.ok){await client.query('ROLLBACK');return {ok:false,status:409,message:'Sem espaco para a recompensa diaria.'}}rewardLabel=`${reward.qty}x ${itemCatalog[reward.item]?.name||reward.item}`;}
    const passSnapshot=accountGamePassSnapshot(state);await client.query('UPDATE accounts SET daily_last_claim_at=now(),daily_login_streak=$2,game_pass_state=$3::jsonb WHERE id=$1',[accountId,day,JSON.stringify(passSnapshot)]);
    await client.query('UPDATE characters SET state=$2::jsonb,server_revision=server_revision+1,updated_at=now() WHERE id=$1',[characterId,JSON.stringify(state)]);await syncCharacterItemInstances(client,characterId,state);await client.query('COMMIT');
    const benefits=await accountBenefits(accountId);applyAccountBenefits(state,benefits);return {ok:true,message:`Recompensa ${day}/31 do mês: ${rewardLabel}. A sequência reinicia no dia 1.`,state,streak:day,day};
  }catch(error){try{await client.query('ROLLBACK')}catch{}throw error}finally{client.release()}
}

export async function purchaseGamePassLevel(accountId,characterId){
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const account=(await client.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE',[accountId])).rows[0],row=(await client.query('SELECT * FROM characters WHERE id=$1 AND account_id=$2 FOR UPDATE',[characterId,accountId])).rows[0];
    if(!account||!row){await client.query('ROLLBACK');return {ok:false,status:404,message:'Conta ou personagem nao encontrado.'}}
    let pp=Math.max(0,Number(account.premium_points)||0);if(pp<10){await client.query('ROLLBACK');return {ok:false,status:400,message:'Voce precisa de 10 PP para comprar um nivel do Passe.'}}
    const state=structuredClone(row.state||{});applyAccountBenefits(state,await accountBenefits(accountId,client));state.profile||={};const level=gamePassLevelFromXp(state.profile.gamePassXp||0);
    if(level>=GAME_PASS_BASE_LEVELS){await client.query('ROLLBACK');return {ok:false,status:409,message:'Niveis do Passe so podem ser comprados ate atingir o nivel 45.'}}
    state.profile.gamePassXp=Math.max(Number(state.profile.gamePassXp||0),level*GAME_PASS_XP_PER_LEVEL);pp-=10;state.profile.premiumPoints=pp;state.profile.vipCredits=pp;
    const pass=accountGamePassSnapshot(state);await client.query('UPDATE accounts SET premium_points=$2,game_pass_state=$3::jsonb WHERE id=$1',[accountId,pp,JSON.stringify(pass)]);await client.query('UPDATE characters SET premium_points=$2 WHERE account_id=$1',[accountId,pp]);await client.query('UPDATE characters SET state=$2::jsonb,updated_at=now(),server_revision=server_revision+1 WHERE id=$1',[characterId,JSON.stringify(state)]);await syncCharacterItemInstances(client,characterId,state);await client.query('COMMIT');
    const benefits=await accountBenefits(accountId);applyAccountBenefits(state,benefits);return {ok:true,message:`Nivel ${level+1} do Passe comprado por 10 PP.`,state,accountBenefits:benefits};
  }catch(error){try{await client.query('ROLLBACK')}catch{}throw error}finally{client.release()}
}

export async function unlockAccountVocation(accountId,vocationId){
  vocationId=String(vocationId||'').slice(0,80);
  if(!vocationId)return {ok:false,unlockedVocations:[]};
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const row=(await client.query('SELECT unlocked_vocations FROM accounts WHERE id=$1 FOR UPDATE',[accountId])).rows[0];
    if(!row){await client.query('ROLLBACK');return {ok:false,unlockedVocations:[]};}
    const unlocked=Array.isArray(row.unlocked_vocations)?[...row.unlocked_vocations]:[];
    const newlyUnlocked=!unlocked.includes(vocationId);
    if(newlyUnlocked){unlocked.push(vocationId);await client.query('UPDATE accounts SET unlocked_vocations=$2::jsonb WHERE id=$1',[accountId,JSON.stringify(unlocked)]);}
    await client.query('COMMIT');
    return {ok:true,newlyUnlocked,unlockedVocations:unlocked};
  }catch(error){try{await client.query('ROLLBACK')}catch{}throw error}finally{client.release()}
}

export async function accountPayload(accountId) {
  const accountResult = await pool.query('SELECT id,email,email_verified_at,created_at,last_login_at,vip_until,game_pass,unlocked_vocations,supply_last_bought_at,daily_last_claim_at,daily_login_streak,game_pass_state,shared_depot FROM accounts WHERE id=$1',[accountId]);
  if (!accountResult.rowCount) return null;
  const {rows} = await pool.query(`
    SELECT id,state,premium_points,pvp_wins,pvp_losses,reborn_completed,created_at,updated_at FROM characters
    WHERE account_id=$1 ORDER BY created_at,id
  `,[accountId]);
  const benefits=await accountBenefits(accountId);
  if(rows.length && !Object.keys(benefits.sharedDepot||{}).length){benefits.sharedDepot=mergeSharedDepotStates(rows.map(row=>row.state||{}));await pool.query('UPDATE accounts SET shared_depot=$2::jsonb WHERE id=$1',[accountId,JSON.stringify(benefits.sharedDepot)]);}
  if(rows.length && !Object.keys(benefits.gamePassState||{}).length){benefits.gamePassState=mergeAccountGamePassStates(rows.map(row=>row.state||{}));await pool.query('UPDATE accounts SET game_pass_state=$2::jsonb WHERE id=$1',[accountId,JSON.stringify(benefits.gamePassState)]);}
  const characters = rows.map(row => { const state=enforceStoredReborn(structuredClone(row.state||{}), Boolean(row.reborn_completed)); state.profile ||= {}; state.profile.premiumPoints=Math.max(0,Number(row.premium_points)||Number(state.profile.premiumPoints)||Number(state.profile.vipCredits)||0); state.profile.vipCredits=state.profile.premiumPoints; state.profile.pvpWins=Math.max(0,Number(row.pvp_wins)||0); state.profile.pvpLosses=Math.max(0,Number(row.pvp_losses)||0); return applyAccountBenefits(state,benefits); });
  return {
    id:accountResult.rows[0].id,
    email:accountResult.rows[0].email,
    emailVerifiedAt:accountResult.rows[0].email_verified_at ? new Date(accountResult.rows[0].email_verified_at).getTime() : null,
    createdAt:new Date(accountResult.rows[0].created_at).getTime(),
    characters,
    activeCharacterId:characters[0]?.profile?.id || null,
    vipUntil:benefits.vipUntil,gamePass:benefits.gamePass,unlockedVocations:benefits.unlockedVocations,supplyLastBoughtAt:benefits.supplyLastBoughtAt,dailyLoginStreak:benefits.dailyLoginStreak,dailyLastClaimAt:benefits.dailyLastClaimAt
  };
}


function collectCharacterItemInstances(state){
  const rows=[];
  const add=(entry,itemId,location)=>{
    const item=itemCatalog[itemId];
    if(!isRarityEligibleItem(item)||!entry?.instanceId)return;
    const def=rarityDefinition(entry.rarity);
    rows.push({id:String(entry.instanceId),baseItemId:String(itemId),rarity:def.id,tier:def.tier,multiplier:def.multiplier,location,source:String(entry.source||'unknown').slice(0,40)});
  };
  for(const container of Object.values(state?.containers||{}))for(const entry of container.items||[])add(entry,String(entry.itemId||''),'inventory');
  for(const [slot,meta] of Object.entries(state?.equipmentMeta||{}))add(meta,String(state?.equipment?.[slot]||''),'equipped');
  for(const corpse of state?.hunt?.corpses||[])for(const entry of corpse.loot||[])add(entry,String(entry.itemId||''),'corpse');
  return rows;
}

async function syncCharacterItemInstances(client,characterId,state){
  ensureItemInstancesInState(state,itemCatalog,'legacy');
  const rows=collectCharacterItemInstances(state);
  for(const row of rows){
    await client.query(`
      INSERT INTO item_instances(id,owner_character_id,base_item_id,rarity,rarity_tier,rarity_multiplier,location,source)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(id) DO UPDATE SET
        base_item_id=EXCLUDED.base_item_id,rarity=EXCLUDED.rarity,rarity_tier=EXCLUDED.rarity_tier,
        rarity_multiplier=EXCLUDED.rarity_multiplier,location=EXCLUDED.location,source=EXCLUDED.source,updated_at=now()
      WHERE item_instances.owner_character_id=EXCLUDED.owner_character_id
    `,[row.id,characterId,row.baseItemId,row.rarity,row.tier,row.multiplier,row.location,row.source]);
  }
  const ids=rows.map(row=>row.id);
  if(ids.length)await client.query(`DELETE FROM item_instances WHERE owner_character_id=$1 AND NOT (id = ANY($2::uuid[]))`,[characterId,ids]);
  else await client.query(`DELETE FROM item_instances WHERE owner_character_id=$1`,[characterId]);
}

export async function createCharacter(accountId,{name,characterId}) {
  name = sanitizeNickname(name);
  characterId = String(characterId || 'goku').slice(0,80);
  if (!gameCharacters[characterId]) return {ok:false,status:400,message:'Personagem base invalido.'};
  if (gameCharacters[characterId]?.vipVocation || gameCharacters[characterId]?.questVocation) { const benefits=await accountBenefits(accountId); if(!benefits.unlockedVocations.includes(characterId)) return {ok:false,status:403,message:gameCharacters[characterId]?.questVocation?'Esta vocacao de Quest ainda nao foi desbloqueada nesta conta.':'Esta vocacao VIP ainda nao foi desbloqueada nesta conta.'}; }
  if (!validNickname(name)) return {ok:false,status:400,message:'O nickname deve ter 3 a 16 letras/espacos sem acentos.'};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[accountId]);
    const count = await client.query('SELECT count(*)::int AS count FROM characters WHERE account_id=$1',[accountId]);
    if (Number(count.rows[0].count) >= 10) {
      await client.query('ROLLBACK');
      return {ok:false,status:409,message:'A conta ja possui 10 personagens.'};
    }
    const id = crypto.randomUUID();
    // O estado inicial nasce no servidor: o navegador nao pode criar personagem
    // ja com level, dinheiro, itens ou Reborn adulterados.
    const safeState = createCharacterState({name,characterId});
    safeState.profile.id = id;
    safeState.profile.name = name;
    safeState.profile.characterId = characterId;
    safeState.profile.level = 1;
    safeState.profile.xp = 0;
    safeState.profile.bank = 0;
    safeState.profile.zenis = 0;
    safeState.profile.pvpWins = 0;
    safeState.profile.pvpLosses = 0;
    applyAccountBenefits(safeState,await accountBenefits(accountId,client));
    ensureItemInstancesInState(safeState,itemCatalog,'starter');
    const summary = stateSummary(safeState);
    await client.query(`
      INSERT INTO characters(id,account_id,name,name_key,vocation_id,level,bank,reborn_completed,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,false,$8::jsonb)
    `,[id,accountId,name,name.toLowerCase(),summary.vocationId,1,0,JSON.stringify(safeState)]);
    await syncCharacterItemInstances(client,id,safeState);
    await client.query('COMMIT');
    return {ok:true,state:safeState};
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return {ok:false,status:409,message:'Este nickname ja esta em uso.'};
    throw error;
  } finally { client.release(); }
}

export async function saveCharacter(accountId,characterId,state) {
  // V20.47: o PUT /state nao e mais autoridade de progressao. Ele aceita
  // apenas preferencias/UI. XP, level, Gold, itens, skills, quests,
  // transformacoes, Reborn e posicao sao mantidos pelo runtime do servidor.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(`
      SELECT name,vocation_id,level,bank,premium_points,pvp_wins,pvp_losses,reborn_completed,state,server_revision
      FROM characters WHERE id=$1 AND account_id=$2 FOR UPDATE
    `,[characterId,accountId]);
    if (!existing.rowCount) {
      await client.query('ROLLBACK');
      return {ok:false,status:404,message:'Personagem nao encontrado.'};
    }
    const stored=structuredClone(existing.rows[0].state || {});
    const proposed=state && typeof state==='object' ? state : {};

    // Preferencias nao economicas podem ser salvas pelo cliente.
    if (proposed.settings && typeof proposed.settings==='object') {
      stored.settings=sanitizeClientSettings(proposed.settings,stored.settings||{});
    }
    stored.hunt ||= {};
    if (Array.isArray(proposed.hunt?.favoriteZoneIds)) {
      stored.hunt.favoriteZoneIds=sanitizeFavoriteZones(proposed.hunt.favoriteZoneIds);
    }
    if (Array.isArray(proposed.hunt?.lootFilter?.ignored)) {
      stored.hunt.lootFilter={...(stored.hunt.lootFilter||{}),ignored:sanitizeIgnoredLoot(proposed.hunt.lootFilter.ignored)};
    }
    if (Array.isArray(proposed.chat)) {
      stored.chat=sanitizeChat(proposed.chat);
    }

    // Identidade e Reborn nunca podem ser reescritos pelo cliente.
    stored.profile ||= {};
    stored.profile.id=characterId;
    stored.profile.name=existing.rows[0].name;
    stored.profile.characterId=existing.rows[0].vocation_id;
    stored.profile.level=Math.max(1,Number(existing.rows[0].level)||1);
    stored.profile.bank=Math.max(0,Number(existing.rows[0].bank)||0);
    stored.profile.premiumPoints=Math.max(0,Number(existing.rows[0].premium_points)||0);
    stored.profile.vipCredits=stored.profile.premiumPoints;
    stored.profile.pvpWins=Math.max(0,Number(existing.rows[0].pvp_wins)||0);
    stored.profile.pvpLosses=Math.max(0,Number(existing.rows[0].pvp_losses)||0);
    enforceStoredReborn(stored,Boolean(existing.rows[0].reborn_completed));

    await client.query(`
      UPDATE characters SET state=$3::jsonb,updated_at=now()
      WHERE id=$1 AND account_id=$2
    `,[characterId,accountId,JSON.stringify(stored)]);
    await client.query('COMMIT');
    return {ok:true,state:stored,authoritative:true,serverRevision:Number(existing.rows[0].server_revision||0)};
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function saveAuthoritativeCharacter(accountId,characterId,state) {
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const accountRow=(await client.query('SELECT premium_points FROM accounts WHERE id=$1 FOR UPDATE',[accountId])).rows[0];
    const existing=await client.query(`
      SELECT name,vocation_id,level,reborn_completed,premium_points,pvp_wins,pvp_losses,state FROM characters
      WHERE id=$1 AND account_id=$2 FOR UPDATE
    `,[characterId,accountId]);
    if(!existing.rowCount){await client.query('ROLLBACK');return {ok:false,status:404}}
    let safe=structuredClone(state||{});
    delete safe.characterDefinition;
    safe.profile||={};
    safe.profile.id=characterId;
    safe.profile.name=existing.rows[0].name;
    safe.profile.characterId=existing.rows[0].vocation_id;
    safe.profile.premiumPoints=Math.max(0,Number(accountRow?.premium_points ?? existing.rows[0].premium_points)||0);
    safe.profile.vipCredits=safe.profile.premiumPoints;
    safe.profile.pvpWins=Math.max(0,Number(existing.rows[0].pvp_wins)||0);
    safe.profile.pvpLosses=Math.max(0,Number(existing.rows[0].pvp_losses)||0);
    const storedReborn=Boolean(existing.rows[0].reborn_completed);
    enforceStoredReborn(safe,storedReborn);
    ensureItemInstancesInState(safe,itemCatalog,'legacy');
    let summary=stateSummary(safe);
    const storedLevel=Math.max(1,Math.trunc(Number(existing.rows[0].level)||1));
    const legitimateReborn=!storedReborn && summary.rebornCompleted && summary.level===1;
    if(summary.level<storedLevel && !legitimateReborn){
      // V21.24.2: nunca persiste regressao inesperada de level. Se algum runtime
      // receber estado antigo/corrompido, preserva o ultimo snapshot autoritativo
      // inteiro em vez de transformar uma queda de conexao em rollback definitivo.
      console.error(`[DB] Rollback autoritativo bloqueado: ${existing.rows[0].name} Lv ${storedLevel} -> ${summary.level}`);
      await client.query(`INSERT INTO security_events(account_id,character_id,event,details) VALUES($1,$2,'LEVEL_ROLLBACK_BLOCKED',$3::jsonb)`,[accountId,characterId,JSON.stringify({storedLevel,incomingLevel:summary.level})]);
      safe=structuredClone(existing.rows[0].state||{});
      safe.profile||={};
      safe.profile.id=characterId;
      safe.profile.name=existing.rows[0].name;
      safe.profile.characterId=existing.rows[0].vocation_id;
      safe.profile.level=storedLevel;
      safe.profile.premiumPoints=Math.max(0,Number(accountRow?.premium_points ?? existing.rows[0].premium_points)||0);
      safe.profile.vipCredits=safe.profile.premiumPoints;
      safe.profile.pvpWins=Math.max(0,Number(existing.rows[0].pvp_wins)||0);
      safe.profile.pvpLosses=Math.max(0,Number(existing.rows[0].pvp_losses)||0);
      enforceStoredReborn(safe,storedReborn);
      ensureItemInstancesInState(safe,itemCatalog,'rollback-guard');
      summary=stateSummary(safe);
    }
    const rebornCompleted=storedReborn||summary.rebornCompleted;
    const passSnapshot=accountGamePassSnapshot(safe),depotSnapshot=sharedDepotSnapshot(safe);
    await client.query('UPDATE accounts SET game_pass_state=$2::jsonb,shared_depot=$3::jsonb WHERE id=$1',[accountId,JSON.stringify(passSnapshot),JSON.stringify(depotSnapshot)]);
    const result=await client.query(`
      UPDATE characters SET
        level=$3,bank=$4,premium_points=$5,reborn_completed=$6,
        reborn_completed_at=CASE WHEN $6 AND reborn_completed_at IS NULL THEN now() ELSE reborn_completed_at END,
        state=$7::jsonb,server_revision=server_revision+1,last_authoritative_at=now(),updated_at=now()
      WHERE id=$1 AND account_id=$2 RETURNING server_revision
    `,[characterId,accountId,summary.level,summary.bank,summary.premiumPoints,rebornCompleted,JSON.stringify(safe)]);
    // V21.24.7: item_instances e um indice auxiliar. Um item legado com
    // instanceId invalido nao pode abortar a transacao principal e apagar
    // minutos/horas de level, skills e loot do personagem.
    await client.query('SAVEPOINT item_instance_sync');
    try{
      await syncCharacterItemInstances(client,characterId,safe);
      await client.query('RELEASE SAVEPOINT item_instance_sync');
    }catch(indexError){
      await client.query('ROLLBACK TO SAVEPOINT item_instance_sync');
      console.error(`[DB] Indice de item_instances ignorado para preservar o save de ${existing.rows[0].name}:`,indexError.message);
    }
    await client.query('COMMIT');
    return {ok:true,serverRevision:Number(result.rows[0]?.server_revision||0)};
  }catch(error){try{await client.query('ROLLBACK')}catch{};throw error}finally{client.release()}
}

export async function recordSecurityEvent({accountId=null,characterId=null,event='UNKNOWN',ip='',details={}}={}){
  try{
    await pool.query(`INSERT INTO security_events(account_id,character_id,event,ip,details) VALUES($1,$2,$3,$4,$5::jsonb)`,[
      accountId,characterId,String(event).slice(0,60),String(ip||''),JSON.stringify(details||{})
    ]);
  }catch(error){console.error('[SECURITY] Falha ao gravar evento:',error.message)}
}

export async function deleteCharacter(accountId,characterId) {
  const result = await pool.query('DELETE FROM characters WHERE id=$1 AND account_id=$2',[characterId,accountId]);
  return result.rowCount > 0;
}

export async function importLocalCharacters(accountId,states=[]) {
  const imported=[]; const skipped=[];
  for (const raw of Array.isArray(states) ? states.slice(0,10) : []) {
    const name=sanitizeNickname(raw?.profile?.name || '');
    const vocation=String(raw?.profile?.characterId || 'goku').slice(0,80);
    if(!validNickname(name)){skipped.push({name,reason:'nickname invalido'});continue}
    const count=await pool.query('SELECT count(*)::int AS count FROM characters WHERE account_id=$1',[accountId]);
    if(Number(count.rows[0].count)>=10)break;
    const exists=await pool.query('SELECT 1 FROM characters WHERE name_key=$1',[name.toLowerCase()]);
    if(exists.rowCount){skipped.push({name,reason:'nickname ja existe'});continue}
    const id = crypto.randomUUID();
    const state=structuredClone(raw);
    state.profile ||= {};
    state.profile.id=id; state.profile.name=name; state.profile.characterId=vocation;
    ensureItemInstancesInState(state,itemCatalog,'legacy-import');
    const summary=stateSummary(state);
    await pool.query(`
      INSERT INTO characters(id,account_id,name,name_key,vocation_id,level,bank,reborn_completed,reborn_completed_at,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $8 THEN now() ELSE NULL END,$9::jsonb)
    `,[id,accountId,name,name.toLowerCase(),summary.vocationId,summary.level,summary.bank,summary.rebornCompleted,JSON.stringify(state)]);
    await syncCharacterItemInstances(pool,id,state);
    imported.push({oldId:raw?.profile?.id||null,newId:id,name});
  }
  return {imported,skipped};
}

export async function characterForAccount(accountId,characterId) {
  const {rows}=await pool.query(`
    SELECT id,state,level,bank,premium_points,pvp_wins,pvp_losses,reborn_completed FROM characters WHERE id=$1 AND account_id=$2 LIMIT 1
  `,[characterId,accountId]);
  if(!rows[0])return null;
  const state=structuredClone(rows[0].state||{});
  state.profile||={};
  state.profile.level=Math.max(1,Number(rows[0].level)||1);
  state.profile.bank=Math.max(0,Number(rows[0].bank)||0);
  state.profile.premiumPoints=Math.max(0,Number(rows[0].premium_points)||0);
  state.profile.vipCredits=state.profile.premiumPoints;
  state.profile.pvpWins=Math.max(0,Number(rows[0].pvp_wins)||0);
  state.profile.pvpLosses=Math.max(0,Number(rows[0].pvp_losses)||0);
  const benefits=await accountBenefits(accountId);
  return applyAccountBenefits(enforceStoredReborn(state,rows[0].reborn_completed),benefits);
}

export async function characterAccessVocation(accountId,characterId) {
  const {rows}=await pool.query(`
    SELECT access_vocation FROM characters WHERE id=$1 AND account_id=$2 LIMIT 1
  `,[characterId,accountId]);
  return String(rows[0]?.access_vocation||'');
}

export async function characterFriendTargetByName(name='') {
  const cleanName=sanitizeNickname(name);
  if(!cleanName)return null;
  const {rows}=await pool.query(`
    SELECT id,name FROM characters WHERE name_key=$1 LIMIT 1
  `,[cleanName.toLowerCase()]);
  if(!rows[0])return null;
  return {id:String(rows[0].id||''),name:String(rows[0].name||cleanName)};
}

const ADMIN_SKILL_ALIASES=Object.freeze({
  str:'gloves',strength:'gloves',gloves:'gloves',
  distance:'kiBlasting',dist:'kiBlasting',kiblasting:'kiBlasting',
  defense:'defense',def:'defense',barrier:'barrier',
  agility:'agility',agi:'agility',attackspeed:'attackSpeed',as:'attackSpeed',
  ki:'kiLevel',kilevel:'kiLevel',critical:'critical',crit:'critical'
});

export function normalizeAdminSkill(value=''){
  const key=String(value||'').toLowerCase().replace(/[^a-z]/g,'');
  return ADMIN_SKILL_ALIASES[key]||null;
}

export async function adminModifyCharacterByName(name,{kind,skill=null,amount=0}={}){
  const cleanName=sanitizeNickname(name);
  const delta=Math.trunc(Number(amount)||0);
  if(!cleanName||!delta)return {ok:false,message:'Nome/quantidade invalida.'};
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const found=await client.query(`
      SELECT id,account_id,name,state,level,bank,premium_points,reborn_completed
      FROM characters WHERE name_key=$1 FOR UPDATE
    `,[cleanName.toLowerCase()]);
    if(!found.rowCount){await client.query('ROLLBACK');return {ok:false,message:'Player nao encontrado.'};}
    const row=found.rows[0];
    const state=structuredClone(row.state||{});
    state.profile||={};state.skills||={};
    if(kind==='level'){
      state.profile.level=Math.max(1,Math.trunc(Number(row.level||state.profile.level||1))+delta);
      state.profile.xp=Math.max(0,Number(state.profile.xp||0));
    }else if(kind==='skill'){
      const skillId=normalizeAdminSkill(skill);
      if(!skillId){await client.query('ROLLBACK');return {ok:false,message:'Skill invalida.'};}
      state.skills[skillId]||={level:1,tries:0};
      state.skills[skillId].level=Math.max(1,Math.trunc(Number(state.skills[skillId].level||1))+delta);
      state.skills[skillId].tries=Math.max(0,Number(state.skills[skillId].tries||0));
    }else if(kind==='zeni'){
      state.profile.bank=Math.max(0,Number(row.bank||state.profile.bank||0)+delta);
    }else if(kind==='pp'){
      const account=(await client.query('SELECT premium_points FROM accounts WHERE id=$1 FOR UPDATE',[row.account_id])).rows[0];
      const pp=Math.max(0,Number(account?.premium_points||0)+delta);
      state.profile.premiumPoints=pp;state.profile.vipCredits=pp;
      await client.query('UPDATE accounts SET premium_points=$2 WHERE id=$1',[row.account_id,pp]);
      await client.query('UPDATE characters SET premium_points=$2 WHERE account_id=$1',[row.account_id,pp]);
    }else{
      await client.query('ROLLBACK');return {ok:false,message:'Operacao ADM invalida.'};
    }
    const summary=stateSummary(state);
    const result=await client.query(`
      UPDATE characters SET level=$2,bank=$3,state=$4::jsonb,server_revision=server_revision+1,
        last_authoritative_at=now(),updated_at=now() WHERE id=$1 RETURNING id,name,server_revision
    `,[row.id,summary.level,summary.bank,JSON.stringify(state)]);
    await client.query('COMMIT');
    return {ok:true,id:row.id,accountId:row.account_id,name:row.name,state,premiumPoints:Number(state.profile?.premiumPoints||0),serverRevision:Number(result.rows[0]?.server_revision||0)};
  }catch(error){try{await client.query('ROLLBACK')}catch{};throw error;}finally{client.release();}
}

export async function recordConnectionLog(data={}) {
  try {
    await pool.query(`
      INSERT INTO connection_logs(event,ip,connection_id,account_id,profile_id,character_id,character_name,level,user_agent)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `,[
      String(data.event||'UNKNOWN').slice(0,20), String(data.ip||''), String(data.connectionId||''),
      data.accountId || null, String(data.profileId||''), String(data.characterId||''),
      String(data.name||'').slice(0,80), Number(data.level)||null, String(data.userAgent||'').slice(0,500)
    ]);
  } catch (error) {
    console.error('[DB] Falha ao gravar connection_logs:',error.message);
  }
}

export async function transferTradePremiumPoints(accountAId,accountBId,ppFromA=0,ppFromB=0){
  const a=String(accountAId||''),b=String(accountBId||'');
  const giveA=Math.max(0,Math.trunc(Number(ppFromA)||0)),giveB=Math.max(0,Math.trunc(Number(ppFromB)||0));
  if(!giveA&&!giveB)return {ok:true,balances:null};
  if(!a||!b||a===b)return {ok:false,message:'Contas inválidas para transferir PP.'};
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const ids=[a,b].sort();
    const rows=(await client.query('SELECT id,premium_points FROM accounts WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[ids])).rows;
    const map=new Map(rows.map(row=>[String(row.id),Math.max(0,Number(row.premium_points)||0)]));
    if(!map.has(a)||!map.has(b)){await client.query('ROLLBACK');return {ok:false,message:'Conta do Trade não encontrada.'};}
    if(map.get(a)<giveA){await client.query('ROLLBACK');return {ok:false,message:'Premium Points insuficientes para concluir o Trade.'};}
    if(map.get(b)<giveB){await client.query('ROLLBACK');return {ok:false,message:'O outro jogador não possui PP suficientes.'};}
    const nextA=map.get(a)-giveA+giveB,nextB=map.get(b)-giveB+giveA;
    await client.query('UPDATE accounts SET premium_points=$2 WHERE id=$1',[a,nextA]);
    await client.query('UPDATE accounts SET premium_points=$2 WHERE id=$1',[b,nextB]);
    await client.query('UPDATE characters SET premium_points=$2,state=jsonb_set(jsonb_set(state,\'{profile,premiumPoints}\',to_jsonb($2::bigint),true),\'{profile,vipCredits}\',to_jsonb($2::bigint),true) WHERE account_id=$1',[a,nextA]);
    await client.query('UPDATE characters SET premium_points=$2,state=jsonb_set(jsonb_set(state,\'{profile,premiumPoints}\',to_jsonb($2::bigint),true),\'{profile,vipCredits}\',to_jsonb($2::bigint),true) WHERE account_id=$1',[b,nextB]);
    await client.query('COMMIT');return {ok:true,balances:{[a]:nextA,[b]:nextB}};
  }catch(error){try{await client.query('ROLLBACK')}catch{};throw error}finally{client.release()}
}


function normalizePvpCurrency(value='none'){
  const currency=String(value||'none').toLowerCase();
  return ['zeni','premium'].includes(currency)?currency:'none';
}
function normalizePvpAmount(currency,value=0){
  if(currency==='none')return 0;
  const amount=Math.trunc(Number(value)||0);
  return Number.isSafeInteger(amount)&&amount>0&&amount<=Math.floor(Number.MAX_SAFE_INTEGER/2)?amount:0;
}
async function pvpCharacterSnapshots(client,characterIds=[]){
  const ids=[...new Set(characterIds.filter(Boolean).map(String))];
  if(!ids.length)return {};
  const {rows}=await client.query(`
    SELECT c.id,c.account_id,c.bank,c.pvp_wins,c.pvp_losses,a.premium_points
    FROM characters c JOIN accounts a ON a.id=c.account_id
    WHERE c.id=ANY($1::uuid[])
  `,[ids]);
  return Object.fromEntries(rows.map(row=>[String(row.id),{
    characterId:String(row.id),accountId:String(row.account_id),bank:Math.max(0,Number(row.bank)||0),
    premiumPoints:Math.max(0,Number(row.premium_points)||0),pvpWins:Math.max(0,Number(row.pvp_wins)||0),pvpLosses:Math.max(0,Number(row.pvp_losses)||0)
  }]));
}

export async function reservePvpDuel({duelId,challengerAccountId,challengedAccountId,challengerCharacterId,challengedCharacterId,wagerCurrency='none',wagerAmount=0}={}){
  const id=String(duelId||''),challengerId=String(challengerCharacterId||''),challengedId=String(challengedCharacterId||'');
  const challengerAccount=String(challengerAccountId||''),challengedAccount=String(challengedAccountId||'');
  const currency=normalizePvpCurrency(wagerCurrency),amount=normalizePvpAmount(currency,wagerAmount);
  if(!id||!challengerId||!challengedId||!challengerAccount||!challengedAccount||challengerId===challengedId)return {ok:false,message:'Duelo PvP inválido.'};
  if(currency!=='none'&&amount<1)return {ok:false,message:'Informe uma aposta válida.'};
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const characterIds=[challengerId,challengedId].sort();
    const charactersResult=await client.query(`SELECT id,account_id,bank,state FROM characters WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`,[characterIds]);
    const byCharacter=new Map(charactersResult.rows.map(row=>[String(row.id),row]));
    const challenger=byCharacter.get(challengerId),challenged=byCharacter.get(challengedId);
    if(!challenger||!challenged||String(challenger.account_id)!==challengerAccount||String(challenged.account_id)!==challengedAccount){await client.query('ROLLBACK');return {ok:false,message:'Um dos personagens não está mais disponível.'};}
    if(currency==='zeni'){
      if(Math.max(0,Number(challenger.bank)||0)<amount){await client.query('ROLLBACK');return {ok:false,insufficient:'challenger',message:'Você não tem essa quantia para apostar.'};}
      if(Math.max(0,Number(challenged.bank)||0)<amount){await client.query('ROLLBACK');return {ok:false,insufficient:'challenged',message:'O jogador desafiado não possui essa quantia para apostar.'};}
      for(const row of [challenger,challenged]){
        const next=Math.max(0,Number(row.bank)||0)-amount;
        await client.query(`UPDATE characters SET bank=$2,state=jsonb_set(state,'{profile,bank}',to_jsonb($2::bigint),true),server_revision=server_revision+1,last_authoritative_at=now(),updated_at=now() WHERE id=$1`,[row.id,next]);
      }
    }else if(currency==='premium'){
      const accountIds=[...new Set([challengerAccount,challengedAccount])].sort();
      const accounts=(await client.query(`SELECT id,premium_points FROM accounts WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`,[accountIds])).rows;
      const balances=new Map(accounts.map(row=>[String(row.id),Math.max(0,Number(row.premium_points)||0)]));
      const requiredChallenger=challengerAccount===challengedAccount?amount*2:amount;
      if((balances.get(challengerAccount)??-1)<requiredChallenger){await client.query('ROLLBACK');return {ok:false,insufficient:'challenger',message:'Você não tem essa quantia para apostar.'};}
      if(challengerAccount!==challengedAccount&&(balances.get(challengedAccount)??-1)<amount){await client.query('ROLLBACK');return {ok:false,insufficient:'challenged',message:'O jogador desafiado não possui essa quantia para apostar.'};}
      const deductions=new Map();
      deductions.set(challengerAccount,(deductions.get(challengerAccount)||0)+amount);
      deductions.set(challengedAccount,(deductions.get(challengedAccount)||0)+amount);
      for(const [accountId,deduction] of deductions){
        const next=(balances.get(accountId)||0)-deduction;
        await client.query(`UPDATE accounts SET premium_points=$2 WHERE id=$1`,[accountId,next]);
        await client.query(`UPDATE characters SET premium_points=$2,state=jsonb_set(jsonb_set(state,'{profile,premiumPoints}',to_jsonb($2::bigint),true),'{profile,vipCredits}',to_jsonb($2::bigint),true),server_revision=server_revision+1,last_authoritative_at=now(),updated_at=now() WHERE account_id=$1`,[accountId,next]);
      }
    }
    await client.query(`INSERT INTO pvp_duels(id,challenger_character_id,challenged_character_id,challenger_account_id,challenged_account_id,wager_currency,wager_amount,status) VALUES($1,$2,$3,$4,$5,$6,$7,'active')`,[id,challengerId,challengedId,challengerAccount,challengedAccount,currency,amount]);
    const snapshots=await pvpCharacterSnapshots(client,[challengerId,challengedId]);
    await client.query('COMMIT');
    return {ok:true,duelId:id,wager:{currency,amount,pot:amount*2},snapshots};
  }catch(error){try{await client.query('ROLLBACK')}catch{};throw error}finally{client.release()}
}

export async function settlePvpDuel(duelId,{winnerCharacterId=null,loserCharacterId=null}={}){
  const id=String(duelId||''),winnerId=winnerCharacterId?String(winnerCharacterId):null,loserId=loserCharacterId?String(loserCharacterId):null;
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const duel=(await client.query(`SELECT * FROM pvp_duels WHERE id=$1 FOR UPDATE`,[id])).rows[0];
    if(!duel){await client.query('ROLLBACK');return {ok:false,message:'Registro do duelo PvP não encontrado.'};}
    const participantIds=[String(duel.challenger_character_id||''),String(duel.challenged_character_id||'')].filter(Boolean);
    if(duel.status!=='active'){
      const snapshots=await pvpCharacterSnapshots(client,participantIds);await client.query('COMMIT');
      return {ok:true,alreadySettled:true,status:duel.status,wager:{currency:String(duel.wager_currency||'none'),amount:Number(duel.wager_amount||0),pot:Number(duel.wager_amount||0)*2},snapshots};
    }
    const currency=normalizePvpCurrency(duel.wager_currency),amount=Math.max(0,Number(duel.wager_amount)||0),pot=amount*2;
    const validWinner=winnerId&&participantIds.includes(winnerId),validLoser=loserId&&participantIds.includes(loserId)&&loserId!==winnerId;
    if(validWinner&&validLoser){
      if(amount>0&&currency==='zeni'){
        await client.query(`UPDATE characters SET bank=bank+$2,state=jsonb_set(state,'{profile,bank}',to_jsonb((bank+$2)::bigint),true),server_revision=server_revision+1,last_authoritative_at=now(),updated_at=now() WHERE id=$1`,[winnerId,pot]);
      }else if(amount>0&&currency==='premium'){
        const winnerAccount=String(winnerId===String(duel.challenger_character_id)?duel.challenger_account_id:duel.challenged_account_id);
        const next=(await client.query(`UPDATE accounts SET premium_points=premium_points+$2 WHERE id=$1 RETURNING premium_points`,[winnerAccount,pot])).rows[0]?.premium_points;
        await client.query(`UPDATE characters SET premium_points=$2,state=jsonb_set(jsonb_set(state,'{profile,premiumPoints}',to_jsonb($2::bigint),true),'{profile,vipCredits}',to_jsonb($2::bigint),true),server_revision=server_revision+1,last_authoritative_at=now(),updated_at=now() WHERE account_id=$1`,[winnerAccount,Math.max(0,Number(next)||0)]);
      }
      await client.query(`UPDATE characters SET pvp_wins=pvp_wins+1,state=jsonb_set(state,'{profile,pvpWins}',to_jsonb((pvp_wins+1)::bigint),true),server_revision=server_revision+1,last_authoritative_at=now(),updated_at=now() WHERE id=$1`,[winnerId]);
      await client.query(`UPDATE characters SET pvp_losses=pvp_losses+1,state=jsonb_set(state,'{profile,pvpLosses}',to_jsonb((pvp_losses+1)::bigint),true),server_revision=server_revision+1,last_authoritative_at=now(),updated_at=now() WHERE id=$1`,[loserId]);
      await client.query(`UPDATE pvp_duels SET status='settled',winner_character_id=$2,loser_character_id=$3,finished_at=now() WHERE id=$1`,[id,winnerId,loserId]);
    }else{
      if(amount>0&&currency==='zeni'){
        for(const characterId of participantIds)await client.query(`UPDATE characters SET bank=bank+$2,state=jsonb_set(state,'{profile,bank}',to_jsonb((bank+$2)::bigint),true),server_revision=server_revision+1,last_authoritative_at=now(),updated_at=now() WHERE id=$1`,[characterId,amount]);
      }else if(amount>0&&currency==='premium'){
        const refunds=new Map();
        for(const accountId of [duel.challenger_account_id,duel.challenged_account_id])if(accountId)refunds.set(String(accountId),(refunds.get(String(accountId))||0)+amount);
        for(const [accountId,refund] of refunds){
          const next=(await client.query(`UPDATE accounts SET premium_points=premium_points+$2 WHERE id=$1 RETURNING premium_points`,[accountId,refund])).rows[0]?.premium_points;
          await client.query(`UPDATE characters SET premium_points=$2,state=jsonb_set(jsonb_set(state,'{profile,premiumPoints}',to_jsonb($2::bigint),true),'{profile,vipCredits}',to_jsonb($2::bigint),true),server_revision=server_revision+1,last_authoritative_at=now(),updated_at=now() WHERE account_id=$1`,[accountId,Math.max(0,Number(next)||0)]);
        }
      }
      await client.query(`UPDATE pvp_duels SET status='refunded',finished_at=now() WHERE id=$1`,[id]);
    }
    const snapshots=await pvpCharacterSnapshots(client,participantIds);
    await client.query('COMMIT');
    return {ok:true,status:validWinner&&validLoser?'settled':'refunded',wager:{currency,amount,pot},snapshots,winnerId:validWinner?winnerId:null,loserId:validLoser?loserId:null};
  }catch(error){try{await client.query('ROLLBACK')}catch{};throw error}finally{client.release()}
}

export async function refundPvpDuel(duelId){return settlePvpDuel(duelId,{winnerCharacterId:null,loserCharacterId:null});}

export async function closeDatabase(){ await pool.end(); }


// ---------------------------------------------------------------------------
// V20.66 - Mercado Global autoritativo
// ---------------------------------------------------------------------------
const MARKET_DURATION_MS=7*24*60*60*1000;
const MARKET_FEE_RATE=0.02;
const MARKET_CURRENCIES=new Set(['zeni','premium']);
const MARKET_RARITIES=new Set(['common','rare','super_rare','epic','legendary','super_legendary','mythic','divine']);

function marketCurrency(value){return MARKET_CURRENCIES.has(String(value))?String(value):'zeni'}
function marketRarity(value){return MARKET_RARITIES.has(String(value))?String(value):'common'}
function marketAmount(value){const n=Math.trunc(Number(value)||0);return Math.max(0,Math.min(Number.MAX_SAFE_INTEGER,n))}
function marketPriceAmount(value){return Math.min(900_000_000_000,marketAmount(value))}
function marketProfile(state,row){state.profile||={};state.profile.bank=Math.max(0,Number(row.bank)||0);state.profile.premiumPoints=Math.max(0,Number(row.account_premium_points??row.premium_points)||0);state.profile.vipCredits=state.profile.premiumPoints;return state}
function marketBalance(state,currency){return currency==='premium'?Math.max(0,Number(state.profile?.premiumPoints)||0):Math.max(0,Number(state.profile?.bank)||0)}
function setMarketBalance(state,currency,value){state.profile||={};if(currency==='premium'){state.profile.premiumPoints=Math.max(0,marketAmount(value));state.profile.vipCredits=state.profile.premiumPoints}else state.profile.bank=Math.max(0,marketAmount(value))}
async function marketRow(client,characterId,accountId=null){
  const params=accountId?[characterId,accountId]:[characterId];
  const q=accountId
    ? `SELECT c.id,c.account_id,c.name,c.state,c.bank,c.premium_points,a.premium_points AS account_premium_points FROM characters c JOIN accounts a ON a.id=c.account_id WHERE c.id=$1 AND c.account_id=$2 FOR UPDATE OF c,a`
    : `SELECT c.id,c.account_id,c.name,c.state,c.bank,c.premium_points,a.premium_points AS account_premium_points FROM characters c JOIN accounts a ON a.id=c.account_id WHERE c.id=$1 FOR UPDATE OF c,a`;
  const row=(await client.query(q,params)).rows[0];if(!row)return null;row.state=marketProfile(structuredClone(row.state||{}),row);normalizeInventoryState(row.state);return row;
}
async function saveMarketRow(client,row){
  row.state.profile||={};row.state.profile.bank=marketAmount(row.state.profile.bank);row.state.profile.premiumPoints=marketAmount(row.state.profile.premiumPoints);row.state.profile.vipCredits=row.state.profile.premiumPoints;
  await client.query(`UPDATE accounts SET premium_points=$2 WHERE id=$1`,[row.account_id,row.state.profile.premiumPoints]);
  await client.query(`UPDATE characters SET premium_points=$2 WHERE account_id=$1`,[row.account_id,row.state.profile.premiumPoints]);
  await client.query(`UPDATE characters SET bank=$2,state=$3::jsonb,server_revision=server_revision+1,last_authoritative_at=now(),updated_at=now() WHERE id=$1`,[row.id,row.state.profile.bank,JSON.stringify(row.state)]);
  await syncCharacterItemInstances(client,row.id,row.state);
}

export async function adminAppendMailToAllAccounts(mailInput={}){
  const mail=createMail(mailInput),client=await pool.connect();let count=0;
  try{await client.query('BEGIN');const rows=(await client.query(`SELECT id,game_pass_state FROM accounts WHERE status='active' FOR UPDATE`)).rows;
    for(const row of rows){const pass=row.game_pass_state&&typeof row.game_pass_state==='object'?structuredClone(row.game_pass_state):{};pass.mailbox=normalizeMailbox([mail,...(Array.isArray(pass.mailbox)?pass.mailbox:[])]);await client.query(`UPDATE accounts SET game_pass_state=$2::jsonb WHERE id=$1`,[row.id,JSON.stringify(pass)]);count+=1;}
    await client.query('COMMIT');return {ok:true,count,mail};
  }catch(e){try{await client.query('ROLLBACK')}catch{};throw e}finally{client.release()}
}

export function buildRankings(rows=[],limit=100){
  const cap=Math.max(1,Math.min(250,Math.trunc(Number(limit)||100)));
  const normalized=(rows||[])
    .filter(row=>String(row?.access_vocation||'')!=='dbo_admin_owner')
    .map(row=>{
    const state=row?.state&&typeof row.state==='object'?row.state:{};
    const level=Math.max(1,Math.trunc(Number(state.profile?.level ?? row?.level ?? 1)||1));
    const skills=Object.fromEntries(Object.keys(skillDefinitions).map(skillId=>[
      skillId,
      Math.max(1,Math.trunc(Number(state.skills?.[skillId]?.level||1)))
    ]));
    return {characterId:String(row?.id||''),name:String(row?.name||'Jogador'),level,skills,bestiary:bestiaryEarnedPoints(state),bossBestiary:bossBestiaryEarnedPoints(state)};
  });
  const rank=(valueFor)=>[...normalized]
    .sort((a,b)=>valueFor(b)-valueFor(a)||b.level-a.level||a.name.localeCompare(b.name,'pt-BR'))
    .slice(0,cap)
    .map((entry,index)=>({position:index+1,characterId:entry.characterId,name:entry.name,level:entry.level,value:valueFor(entry)}));
  return {
    level:rank(entry=>entry.level),
    bestiary:rank(entry=>entry.bestiary),
    bossBestiary:rank(entry=>entry.bossBestiary),
    skills:Object.fromEntries(Object.keys(skillDefinitions).map(skillId=>[
      skillId,rank(entry=>entry.skills[skillId])
    ]))
  };
}

export async function rankingOverview(limit=100){
  const result=await pool.query(`
    SELECT id,name,level,state,access_vocation
    FROM characters
    WHERE COALESCE(access_vocation,'') <> 'dbo_admin_owner'
  `);
  return {ok:true,...buildRankings(result.rows,limit)};
}

// ---------------------------------------------------------------------------
// V21.8.0 - Sistema de Guild
// ---------------------------------------------------------------------------
export const GUILD_MAX_LEVEL=50;
export const GUILD_GOLD_PER_XP=1000;
export const GUILD_GOLD_XP_PER_LOT=10;
export const GUILD_PP_XP=1000;
export const GUILD_CREATE_COST_PP=50;
export const GUILD_PP_LOT_SIZE=10;
export const GUILD_BOSS_SUMMON_COST_PP=100;
export const GUILD_BOSS_START_DELAY_MS=60_000;
export const GUILD_TECHNOLOGIES=Object.freeze({
  research_accelerated:Object.freeze({id:'research_accelerated',name:'Devoção Reconhecida',maxLevel:5,description:'+2% XP de Guild em toda conversão/doação que gera XP por nível.'}),
  efficient_vault:Object.freeze({id:'efficient_vault',name:'Dízimo da Prosperidade',maxLevel:5,description:'+2% XP de Guild nas doações de Gold por nível.'}),
  hunter_instinct:Object.freeze({id:'hunter_instinct',name:'Favorecimento dos Deuses',maxLevel:5,description:'+1% chance de Drop para todos os membros por nível.'}),
  more_members:Object.freeze({id:'more_members',name:'Chamado do Destino',maxLevel:4,description:'+5 vagas de membro por nível.'}),
  battle_training:Object.freeze({id:'battle_training',name:'Bênção do Conhecimento',maxLevel:5,description:'+1% XP de personagem para todos os membros por nível.'}),
  boss_slayer:Object.freeze({id:'boss_slayer',name:'Bênção do Abate',maxLevel:5,description:'+2% loot-base do Boss da Guild por nível.'})
});

export function guildXpRequired(level){
  const current=Math.max(1,Math.min(GUILD_MAX_LEVEL,Math.trunc(Number(level)||1)));
  return current>=GUILD_MAX_LEVEL?0:Math.round(8000*current*current);
}
function normalizeGuildTechnologies(value={}){
  const source=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
  return Object.fromEntries(Object.entries(GUILD_TECHNOLOGIES).map(([id,def])=>[
    id,Math.max(0,Math.min(def.maxLevel,Math.trunc(Number(source[id])||0)))
  ]));
}

export const GUILD_BOSS_BESTIARY_MILESTONES=Object.freeze([
  {kills:1,points:1},{kills:5,points:2},{kills:15,points:3},{kills:50,points:4}
]);
export const GUILD_BOSS_BESTIARY_UPGRADES=Object.freeze({
  attack:{name:'Poder de Extermínio',maxLevel:5,effectPerLevel:2,unit:'%',description:'+2% de dano contra Bosses da Guild por nível.'},
  defense:{name:'Muralha da Guild',maxLevel:5,effectPerLevel:2,unit:'%',description:'+2% de redução de dano contra Bosses da Guild por nível.'},
  dragonBall:{name:'Favor de Shenlong',maxLevel:5,effectPerLevel:.2,unit:' p.p.',description:'+0,2 ponto percentual de chance por Esfera nos Bosses da Guild por nível.'}
});
function normalizeGuildBossBestiary(value={}){
  const src=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
  return {kills:{daishinkan:Math.max(0,Math.trunc(Number(src.kills?.daishinkan||0))),champa:Math.max(0,Math.trunc(Number(src.kills?.champa||0)))},upgrades:Object.fromEntries(Object.entries(GUILD_BOSS_BESTIARY_UPGRADES).map(([k,d])=>[k,Math.max(0,Math.min(d.maxLevel,Math.trunc(Number(src.upgrades?.[k]||0))))]))};
}
function guildBossBestiaryPointsForKills(kills=0){const n=Math.max(0,Math.trunc(Number(kills)||0));return GUILD_BOSS_BESTIARY_MILESTONES.reduce((sum,m)=>sum+(n>=m.kills?m.points:0),0);}
export function guildBossBestiaryEarnedPoints(value={}){const b=normalizeGuildBossBestiary(value);return Object.values(b.kills).reduce((sum,n)=>sum+guildBossBestiaryPointsForKills(n),0);}
export function guildBossBestiarySpentPoints(value={}){const b=normalizeGuildBossBestiary(value);return Object.values(b.upgrades).reduce((sum,n)=>sum+Math.max(0,Number(n)||0),0);}
export function guildBossBestiaryAvailablePoints(value={}){return Math.max(0,guildBossBestiaryEarnedPoints(value)-guildBossBestiarySpentPoints(value));}
function guildBossBestiaryBonuses(value={}){const b=normalizeGuildBossBestiary(value);return {attackPercent:b.upgrades.attack*2,defensePercent:b.upgrades.defense*2,dragonBallBonus:b.upgrades.dragonBall*.2};}

export function guildBenefits(level=1,technologies={},guildBossBestiary={}){
  const lv=Math.max(1,Math.min(GUILD_MAX_LEVEL,Math.trunc(Number(level)||1)));
  const tech=normalizeGuildTechnologies(technologies);
  const levelBonus=Math.min(20,Math.floor(lv*0.4));
  const bossBestiary=guildBossBestiaryBonuses(guildBossBestiary);
  return Object.freeze({
    level:lv,
    memberLimit:10+(lv*2)+(tech.more_members*5),
    xpPercent:levelBonus+tech.battle_training,
    dropPercent:levelBonus+tech.hunter_instinct,
    donationXpPercent:(tech.research_accelerated*2),
    goldDonationXpPercent:(tech.efficient_vault*2),
    bossLootPercent:(tech.boss_slayer*2),
    guildBossAttackPercent:bossBestiary.attackPercent,
    guildBossDefensePercent:bossBestiary.defensePercent,
    guildBossDragonBallBonus:bossBestiary.dragonBallBonus,
    technologies:tech
  });
}
export function guildTechnologyCost(technologyId,currentLevel=0){
  const def=GUILD_TECHNOLOGIES[String(technologyId||'')];
  if(!def)return 0;
  const level=Math.max(0,Math.min(def.maxLevel,Math.trunc(Number(currentLevel)||0)));
  return level>=def.maxLevel?0:level+1;
}
export function applyGuildLevelProgress(guild,earnedXp){
  const next={...guild};
  next.level=Math.max(1,Math.min(GUILD_MAX_LEVEL,Math.trunc(Number(next.level)||1)));
  next.xp=Math.max(0,Math.trunc(Number(next.xp)||0));
  next.lifetime_xp=Math.max(0,Math.trunc(Number(next.lifetime_xp)||0));
  next.guild_points=Math.max(0,Math.trunc(Number(next.guild_points)||0));
  const gain=Math.max(0,Math.trunc(Number(earnedXp)||0));
  next.xp+=gain;next.lifetime_xp+=gain;
  let levelsGained=0;
  while(next.level<GUILD_MAX_LEVEL){
    const required=guildXpRequired(next.level);
    if(required<=0||next.xp<required)break;
    next.xp-=required;next.level+=1;next.guild_points+=1;levelsGained+=1;
  }
  if(next.level>=GUILD_MAX_LEVEL)next.xp=0;
  return {guild:next,levelsGained};
}
export function buildGuildRankings(rows=[],limit=100){
  const cap=Math.max(1,Math.min(250,Math.trunc(Number(limit)||100)));
  return [...(rows||[])].map(row=>({
    guildId:String(row.id||row.guild_id||''),name:String(row.name||'Guild'),tag:String(row.tag||''),
    level:Math.max(1,Math.trunc(Number(row.level)||1)),xp:Math.max(0,Math.trunc(Number(row.xp)||0)),
    lifetimeXp:Math.max(0,Math.trunc(Number(row.lifetime_xp)||0)),members:Math.max(0,Math.trunc(Number(row.members)||0)),
    goldBurned:Math.max(0,Math.trunc(Number(row.gold_burned)||0)),ppBurned:Math.max(0,Math.trunc(Number(row.pp_burned)||0)),
    bossBestiaryPoints:guildBossBestiaryEarnedPoints(row.guild_boss_bestiary||{}),
    bossWins:Object.values(normalizeGuildBossBestiary(row.guild_boss_bestiary||{}).kills).reduce((a,b)=>a+b,0),
    createdAt:row.created_at||null
  })).sort((a,b)=>b.level-a.level||b.lifetimeXp-a.lifetimeXp||b.goldBurned-a.goldBurned||a.name.localeCompare(b.name,'pt-BR'))
    .slice(0,cap).map((entry,index)=>({...entry,position:index+1}));
}
function sanitizeGuildName(value=''){return String(value||'').trim().replace(/\s+/g,' ').slice(0,32)}
function sanitizeGuildTag(value=''){return String(value||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6)}
function validGuildName(value){return value.length>=3&&value.length<=32&&/^[\p{L}\p{N} ]+$/u.test(value)}
function validGuildTag(value){return /^[A-Z0-9]{2,6}$/.test(value)}
function guildOfficer(role){return role==='leader'||role==='vice'}
function guildStateProfile(state,guild){
  state.profile||={};
  if(!guild){delete state.profile.guild;state.profile.guildBenefits={level:0,memberLimit:0,xpPercent:0,dropPercent:0,donationXpPercent:0,goldDonationXpPercent:0,bossLootPercent:0,technologies:{}};return state;}
  const benefits=guildBenefits(guild.level,guild.technologies,guild.guild_boss_bestiary);
  state.profile.guild={id:String(guild.id),name:String(guild.name),tag:String(guild.tag),level:Number(guild.level)||1};
  state.profile.guildBenefits=structuredClone(benefits);
  return state;
}
async function guildRow(client,guildId,{forUpdate=false}={}){
  const lock=forUpdate?' FOR UPDATE':'';
  const row=(await client.query(`SELECT * FROM guilds WHERE id=$1${lock}`,[guildId])).rows[0]||null;
  if(row){row.technologies=normalizeGuildTechnologies(row.technologies);row.guild_boss_bestiary=normalizeGuildBossBestiary(row.guild_boss_bestiary);}
  return row;
}
async function guildMemberRecord(client,characterId,{forUpdate=false}={}){
  const lock=forUpdate?' FOR UPDATE OF gm':'';
  return (await client.query(`SELECT gm.*,g.name guild_name,g.tag guild_tag,g.level guild_level,g.technologies guild_technologies,g.leader_character_id FROM guild_members gm JOIN guilds g ON g.id=gm.guild_id WHERE gm.character_id=$1${lock}`,[characterId])).rows[0]||null;
}
async function guildHistory(client,guildId,limit=100){
  return (await client.query(`SELECT h.id,h.event,h.details,h.created_at,c.name character_name FROM guild_history h LEFT JOIN characters c ON c.id=h.character_id WHERE h.guild_id=$1 ORDER BY h.created_at DESC LIMIT $2`,[guildId,Math.max(1,Math.min(250,Number(limit)||100))])).rows;
}
async function addGuildHistory(client,guildId,characterId,event,details={}){
  await client.query(`INSERT INTO guild_history(guild_id,character_id,event,details) VALUES($1,$2,$3,$4::jsonb)`,[guildId,characterId||null,String(event||'event'),JSON.stringify(details||{})]);
}
async function guildMembersPayload(client,guildId){
  return (await client.query(`
    SELECT gm.character_id,gm.role,gm.contributed_gold,gm.contributed_pp,gm.contributed_xp,gm.joined_at,c.name,c.level,c.state
    FROM guild_members gm JOIN characters c ON c.id=gm.character_id
    WHERE gm.guild_id=$1
    ORDER BY CASE gm.role WHEN 'leader' THEN 0 WHEN 'vice' THEN 1 WHEN 'member' THEN 2 ELSE 3 END,gm.contributed_xp DESC,c.name
  `,[guildId])).rows.map(row=>({
    characterId:row.character_id,name:row.name,role:row.role,level:Math.max(1,Number(row.state?.profile?.level??row.level??1)),
    contributedGold:Number(row.contributed_gold||0),contributedPp:Number(row.contributed_pp||0),contributedXp:Number(row.contributed_xp||0),joinedAt:row.joined_at
  }));
}
async function guildApplicationsPayload(client,guildId){
  return (await client.query(`
    SELECT r.id,r.character_id,r.requested_at,c.name,c.level,c.state
    FROM guild_join_requests r JOIN characters c ON c.id=r.character_id
    WHERE r.guild_id=$1 AND r.status='pending' ORDER BY r.requested_at ASC
  `,[guildId])).rows.map(row=>({requestId:row.id,characterId:row.character_id,name:row.name,level:Math.max(1,Number(row.state?.profile?.level??row.level??1)),requestedAt:row.requested_at}));
}
async function guildBossRunPayload(client,guildId){
  const run=(await client.query(`SELECT * FROM guild_boss_runs WHERE guild_id=$1 AND status IN ('pending','active') ORDER BY created_at DESC LIMIT 1`,[guildId])).rows[0]||null;
  if(!run)return null;
  const accepted=Number((await client.query(`SELECT COUNT(*)::int count FROM guild_boss_participants WHERE run_id=$1`,[run.id])).rows[0]?.count||0);
  return {id:run.id,guildId:run.guild_id,bossType:String(run.boss_type||'daishinkan'),status:run.status,summonCostPp:Number(run.summon_cost_pp||0),startsAt:run.starts_at,startedAt:run.started_at,acceptedCount:accepted};
}
async function guildRankingRows(client,limit=100){
  return (await client.query(`
    SELECT g.*,COUNT(gm.character_id)::int AS members
    FROM guilds g LEFT JOIN guild_members gm ON gm.guild_id=g.id
    LEFT JOIN characters leader ON leader.id=g.leader_character_id
    WHERE COALESCE(leader.access_vocation,'') <> 'dbo_admin_owner'
    GROUP BY g.id ORDER BY g.level DESC,g.lifetime_xp DESC,g.gold_burned DESC,g.created_at ASC LIMIT $1
  `,[Math.max(1,Math.min(250,Number(limit)||100))])).rows;
}
async function syncGuildBenefitsForCharacter(client,characterId,guild){
  const row=await marketRow(client,characterId);if(!row)return null;
  guildStateProfile(row.state,guild);await saveMarketRow(client,row);return row;
}
async function syncGuildBenefitsForMembers(client,guild){
  const ids=(await client.query(`SELECT character_id FROM guild_members WHERE guild_id=$1 ORDER BY joined_at`,[guild.id])).rows.map(row=>row.character_id);
  const changed={};
  for(const id of ids){const row=await syncGuildBenefitsForCharacter(client,id,guild);if(row)changed[row.id]=row.state;}
  return changed;
}
function guildPublicPayload(guild,members=[]){
  const benefits=guildBenefits(guild.level,guild.technologies,guild.guild_boss_bestiary);
  return {
    id:guild.id,name:guild.name,tag:guild.tag,level:Number(guild.level||1),xp:Number(guild.xp||0),xpRequired:guildXpRequired(guild.level),
    lifetimeXp:Number(guild.lifetime_xp||0),guildPoints:Number(guild.guild_points||0),goldBurned:Number(guild.gold_burned||0),ppBurned:Number(guild.pp_burned||0),ppVault:Number(guild.pp_vault||0),
    messageOfDay:guild.message_of_day||'',joinOpen:Boolean(guild.join_open),leaderCharacterId:guild.leader_character_id,
    technologies:normalizeGuildTechnologies(guild.technologies),bossBestiary:normalizeGuildBossBestiary(guild.guild_boss_bestiary),bossBestiaryPoints:guildBossBestiaryEarnedPoints(guild.guild_boss_bestiary),bossBestiaryAvailablePoints:guildBossBestiaryAvailablePoints(guild.guild_boss_bestiary),benefits,membersCount:members.length,createdAt:guild.created_at
  };
}
async function persistGuildProgress(client,guild){
  await client.query(`UPDATE guilds SET level=$2,xp=$3,lifetime_xp=$4,guild_points=$5,gold_burned=$6,pp_burned=$7,pp_vault=$8,technologies=$9::jsonb,updated_at=now() WHERE id=$1`,[
    guild.id,guild.level,guild.xp,guild.lifetime_xp,guild.guild_points,guild.gold_burned,guild.pp_burned,guild.pp_vault,JSON.stringify(normalizeGuildTechnologies(guild.technologies))
  ]);
}
export async function guildRankingOverview(limit=100){
  const client=await pool.connect();try{return {ok:true,ranking:buildGuildRankings(await guildRankingRows(client,limit),limit)}}finally{client.release()}
}
export async function guildOverview(accountId,characterId){
  const client=await pool.connect();try{await client.query('BEGIN');
    const own=await marketRow(client,characterId,accountId);if(!own){await client.query('ROLLBACK');return {ok:false,status:404,message:'Personagem nao encontrado.'}};
    const membership=await guildMemberRecord(client,characterId);
    const ranking=buildGuildRankings(await guildRankingRows(client,100),100);
    if(!membership){
      const pending=(await client.query(`SELECT guild_id FROM guild_join_requests WHERE character_id=$1 AND status='pending' ORDER BY requested_at DESC`,[characterId])).rows.map(r=>r.guild_id);
      guildStateProfile(own.state,null);await saveMarketRow(client,own);await client.query('COMMIT');return {ok:true,guild:null,role:null,ranking,pendingRequestGuildIds:pending,state:own.state,changedStates:{[own.id]:own.state}};
    }
    const guild=await guildRow(client,membership.guild_id);const members=await guildMembersPayload(client,guild.id);const history=await guildHistory(client,guild.id,100);
    const applications=guildOfficer(membership.role)?await guildApplicationsPayload(client,guild.id):[];
    const bossRun=await guildBossRunPayload(client,guild.id);
    guildStateProfile(own.state,guild);await saveMarketRow(client,own);await client.query('COMMIT');
    return {ok:true,guild:guildPublicPayload(guild,members),role:membership.role,members,applications,bossRun,history,ranking,state:own.state,changedStates:{[own.id]:own.state}};
  }catch(e){try{await client.query('ROLLBACK')}catch{};throw e}finally{client.release()}
}

export async function upgradeGuildBossBestiary(accountId,characterId,key=''){
  key=String(key||'');const def=GUILD_BOSS_BESTIARY_UPGRADES[key];if(!def)return {ok:false,status:400,message:'Upgrade do Bestiário de Bosses inválido.'};
  const client=await pool.connect();try{await client.query('BEGIN');const own=await marketRow(client,characterId,accountId);if(!own){await client.query('ROLLBACK');return {ok:false,status:404,message:'Personagem não encontrado.'}};const membership=await guildMemberRecord(client,characterId,{forUpdate:true});if(!membership||!guildOfficer(membership.role)){await client.query('ROLLBACK');return {ok:false,status:403,message:'Somente Líder e Vice podem gastar pontos do Bestiário de Bosses da Guild.'}};const guild=await guildRow(client,membership.guild_id,{forUpdate:true});const b=normalizeGuildBossBestiary(guild.guild_boss_bestiary),rank=Number(b.upgrades[key]||0);if(rank>=def.maxLevel){await client.query('ROLLBACK');return {ok:false,status:409,message:`${def.name} já está no máximo.`}};if(guildBossBestiaryAvailablePoints(b)<1){await client.query('ROLLBACK');return {ok:false,status:409,message:'A Guild não possui ponto disponível do Bestiário de Bosses.'}};b.upgrades[key]=rank+1;guild.guild_boss_bestiary=b;await client.query(`UPDATE guilds SET guild_boss_bestiary=$2::jsonb,updated_at=now() WHERE id=$1`,[guild.id,JSON.stringify(b)]);await addGuildHistory(client,guild.id,characterId,'guild-boss-bestiary-upgraded',{key,level:rank+1,name:def.name});const changedStates=await syncGuildBenefitsForMembers(client,guild);await client.query('COMMIT');return {ok:true,message:`${def.name} avançou para ${rank+1}.`,changedStates};}catch(e){try{await client.query('ROLLBACK')}catch{};throw e}finally{client.release()}
}

export async function createGuild(accountId,characterId,input={}){
  const name=sanitizeGuildName(input.name),tag=sanitizeGuildTag(input.tag);
  if(!validGuildName(name))return {ok:false,status:400,message:'Nome da guild deve ter 3 a 32 caracteres (letras, numeros e espacos).'};
  if(!validGuildTag(tag))return {ok:false,status:400,message:'Tag da guild deve ter 2 a 6 letras ou numeros.'};
  const client=await pool.connect();try{await client.query('BEGIN');const own=await marketRow(client,characterId,accountId);if(!own){await client.query('ROLLBACK');return {ok:false,status:404,message:'Personagem nao encontrado.'}};
    if(await guildMemberRecord(client,characterId)){await client.query('ROLLBACK');return {ok:false,status:409,message:'Este personagem ja pertence a uma guild.'}};
    const pp=Number(own.state.profile?.premiumPoints??own.state.profile?.vipCredits??0);if(pp<GUILD_CREATE_COST_PP){await client.query('ROLLBACK');return {ok:false,status:400,message:`Criar uma Guild custa ${GUILD_CREATE_COST_PP} PP.`}};
    own.state.profile.premiumPoints=pp-GUILD_CREATE_COST_PP;own.state.profile.vipCredits=own.state.profile.premiumPoints;
    const id=crypto.randomUUID();let guild;
    try{guild=(await client.query(`INSERT INTO guilds(id,name,name_key,tag,tag_key,leader_character_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[id,name,name.toLowerCase(),tag,tag.toLowerCase(),characterId])).rows[0];}
    catch(error){if(error.code==='23505'){await client.query('ROLLBACK');return {ok:false,status:409,message:'Nome ou tag de guild ja esta em uso.'}}throw error}
    guild.technologies=normalizeGuildTechnologies(guild.technologies);await client.query(`INSERT INTO guild_members(guild_id,character_id,role) VALUES($1,$2,'leader')`,[id,characterId]);
    await addGuildHistory(client,id,characterId,'guild-created',{name,tag,creationCostPp:GUILD_CREATE_COST_PP});guildStateProfile(own.state,guild);await saveMarketRow(client,own);await client.query('COMMIT');
    return {ok:true,message:`Guild ${name} [${tag}] criada por ${GUILD_CREATE_COST_PP} PP.`,state:own.state,changedStates:{[own.id]:own.state},guildId:id,accountId:own.account_id,premiumPoints:Number(own.state.profile.premiumPoints||0)};
  }catch(e){try{await client.query('ROLLBACK')}catch{};throw e}finally{client.release()}
}
export async function joinGuild(accountId,characterId,guildId){
  const client=await pool.connect();try{await client.query('BEGIN');const own=await marketRow(client,characterId,accountId);if(!own){await client.query('ROLLBACK');return {ok:false,status:404,message:'Personagem nao encontrado.'}};
    if(await guildMemberRecord(client,characterId)){await client.query('ROLLBACK');return {ok:false,status:409,message:'Este personagem ja pertence a uma guild.'}};
    const guild=await guildRow(client,guildId,{forUpdate:true});if(!guild){await client.query('ROLLBACK');return {ok:false,status:404,message:'Guild nao encontrada.'}};if(!guild.join_open){await client.query('ROLLBACK');return {ok:false,status:403,message:'Esta guild esta fechada para novas solicitacoes.'}};
    const existing=(await client.query(`SELECT id FROM guild_join_requests WHERE guild_id=$1 AND character_id=$2 AND status='pending'`,[guild.id,characterId])).rows[0];if(existing){await client.query('ROLLBACK');return {ok:false,status:409,message:'Voce ja solicitou entrada nesta Guild.'}};
    const id=crypto.randomUUID();await client.query(`INSERT INTO guild_join_requests(id,guild_id,character_id,status) VALUES($1,$2,$3,'pending')`,[id,guild.id,characterId]);await addGuildHistory(client,guild.id,characterId,'join-requested',{name:own.name});await client.query('COMMIT');
    return {ok:true,message:`Solicitacao enviada para ${guild.name} [${guild.tag}]. Lider ou Vice precisa aprovar.`};
  }catch(e){try{await client.query('ROLLBACK')}catch{};throw e}finally{client.release()}
}
export async function decideGuildApplication(accountId,characterId,targetCharacterId,decision='approve'){
  const action=String(decision||'approve')==='deny'?'deny':'approve';
  const client=await pool.connect();try{await client.query('BEGIN');const own=await marketRow(client,characterId,accountId);if(!own){await client.query('ROLLBACK');return {ok:false,status:404,message:'Personagem nao encontrado.'}};const membership=await guildMemberRecord(client,characterId,{forUpdate:true});if(!membership||!guildOfficer(membership.role)){await client.query('ROLLBACK');return {ok:false,status:403,message:'Somente Lider e Vice podem aprovar entradas.'}};
    const request=(await client.query(`SELECT r.*,c.name FROM guild_join_requests r JOIN characters c ON c.id=r.character_id WHERE r.guild_id=$1 AND r.character_id=$2 AND r.status='pending' FOR UPDATE OF r`,[membership.guild_id,targetCharacterId])).rows[0];if(!request){await client.query('ROLLBACK');return {ok:false,status:404,message:'Solicitacao pendente nao encontrada.'}};
    if(action==='deny'){await client.query(`UPDATE guild_join_requests SET status='denied',decided_by=$3,decided_at=now() WHERE guild_id=$1 AND character_id=$2 AND status='pending'`,[membership.guild_id,targetCharacterId,characterId]);await addGuildHistory(client,membership.guild_id,characterId,'join-denied',{targetCharacterId,name:request.name});await client.query('COMMIT');return {ok:true,message:`Solicitacao de ${request.name} recusada.`};}
    if(await guildMemberRecord(client,targetCharacterId)){await client.query(`UPDATE guild_join_requests SET status='cancelled',decided_by=$3,decided_at=now() WHERE guild_id=$1 AND character_id=$2 AND status='pending'`,[membership.guild_id,targetCharacterId,characterId]);await client.query('COMMIT');return {ok:false,status:409,message:'Este personagem ja entrou em outra Guild.'};}
    const guild=await guildRow(client,membership.guild_id,{forUpdate:true});const count=Number((await client.query(`SELECT COUNT(*)::int AS count FROM guild_members WHERE guild_id=$1`,[guild.id])).rows[0]?.count||0),limit=guildBenefits(guild.level,guild.technologies).memberLimit;if(count>=limit){await client.query('ROLLBACK');return {ok:false,status:409,message:'A Guild atingiu o limite de membros.'}};
    await client.query(`INSERT INTO guild_members(guild_id,character_id,role) VALUES($1,$2,'recruit')`,[guild.id,targetCharacterId]);await client.query(`UPDATE guild_join_requests SET status='approved',decided_by=$3,decided_at=now() WHERE guild_id=$1 AND character_id=$2 AND status='pending'`,[guild.id,targetCharacterId,characterId]);await addGuildHistory(client,guild.id,characterId,'join-approved',{targetCharacterId,name:request.name,role:'recruit'});const target=await syncGuildBenefitsForCharacter(client,targetCharacterId,guild);await client.query('COMMIT');return {ok:true,message:`${request.name} entrou como Recruta.`,changedStates:target?{[target.id]:target.state}:{}};
  }catch(e){try{await client.query('ROLLBACK')}catch{};throw e}finally{client.release()}
}
export async function setGuildMemberRole(accountId,characterId,targetCharacterId,role){
  const nextRole=['recruit','member','vice'].includes(String(role||''))?String(role):null;if(!nextRole)return {ok:false,status:400,message:'Cargo invalido.'};
  const client=await pool.connect();try{await client.query('BEGIN');const own=await marketRow(client,characterId,accountId);if(!own){await client.query('ROLLBACK');return {ok:false,status:404,message:'Personagem nao encontrado.'}};const membership=await guildMemberRecord(client,characterId,{forUpdate:true});if(!membership||membership.role!=='leader'){await client.query('ROLLBACK');return {ok:false,status:403,message:'Somente o Lider pode alterar cargos.'}};if(String(targetCharacterId)===String(characterId)){await client.query('ROLLBACK');return {ok:false,status:400,message:'O Lider nao pode alterar o proprio cargo.'}};
    const target=(await client.query(`SELECT gm.*,c.name FROM guild_members gm JOIN characters c ON c.id=gm.character_id WHERE gm.guild_id=$1 AND gm.character_id=$2 FOR UPDATE OF gm`,[membership.guild_id,targetCharacterId])).rows[0];if(!target||target.role==='leader'){await client.query('ROLLBACK');return {ok:false,status:404,message:'Membro nao encontrado.'}};
    if(nextRole==='vice'){const viceCount=Number((await client.query(`SELECT COUNT(*)::int count FROM guild_members WHERE guild_id=$1 AND role='vice' AND character_id<>$2`,[membership.guild_id,targetCharacterId])).rows[0]?.count||0);if(viceCount>=4){await client.query('ROLLBACK');return {ok:false,status:409,message:'A Guild pode ter no maximo 4 Vices.'}};}
    await client.query(`UPDATE guild_members SET role=$3 WHERE guild_id=$1 AND character_id=$2`,[membership.guild_id,targetCharacterId,nextRole]);await addGuildHistory(client,membership.guild_id,characterId,'role-changed',{targetCharacterId,name:target.name,fromRole:target.role,toRole:nextRole});await client.query('COMMIT');return {ok:true,message:`${target.name} agora e ${nextRole==='vice'?'Vice':nextRole==='member'?'Membro':'Recruta'}.`};
  }catch(e){try{await client.query('ROLLBACK')}catch{};throw e}finally{client.release()}
}
export async function leaveGuild(accountId,characterId){
  const client=await pool.connect();try{await client.query('BEGIN');const own=await marketRow(client,characterId,accountId);if(!own){await client.query('ROLLBACK');return {ok:false,status:404,message:'Personagem nao encontrado.'}};const membership=await guildMemberRecord(client,characterId,{forUpdate:true});if(!membership){await client.query('ROLLBACK');return {ok:false,status:404,message:'Este personagem nao pertence a uma guild.'}};
    const count=Number((await client.query(`SELECT COUNT(*)::int AS count FROM guild_members WHERE guild_id=$1`,[membership.guild_id])).rows[0]?.count||0);if(membership.role==='leader'&&count>1){await client.query('ROLLBACK');return {ok:false,status:409,message:'O lider nao pode sair enquanto houver outros membros. Remova os membros primeiro.'}};
    if(membership.role==='leader'){await client.query(`DELETE FROM guilds WHERE id=$1`,[membership.guild_id]);}else{await client.query(`DELETE FROM guild_members WHERE guild_id=$1 AND character_id=$2`,[membership.guild_id,characterId]);await addGuildHistory(client,membership.guild_id,characterId,'member-left',{name:own.name});}
    guildStateProfile(own.state,null);await saveMarketRow(client,own);await client.query('COMMIT');return {ok:true,message:membership.role==='leader'?'Guild encerrada.':'Voce saiu da guild.',state:own.state,changedStates:{[own.id]:own.state}};
  }catch(e){try{await client.query('ROLLBACK')}catch{};throw e}finally{client.release()}
}
export async function donateGuild(accountId,characterId,input={}){
  const currency=String(input.currency||'gold')==='premium'?'premium':'gold';const amount=marketAmount(input.amount);
  if(currency==='gold'&&amount<GUILD_GOLD_PER_XP)return {ok:false,status:400,message:`A doacao minima de Gold e ${GUILD_GOLD_PER_XP.toLocaleString('pt-BR')} Zeni.`};
  if(currency==='gold'&&amount%GUILD_GOLD_PER_XP!==0)return {ok:false,status:400,message:`Doe Gold em multiplos de ${GUILD_GOLD_PER_XP.toLocaleString('pt-BR')} para nao perder fracao de XP.`};
  if(currency==='premium'&&(amount<GUILD_PP_LOT_SIZE||amount%GUILD_PP_LOT_SIZE!==0))return {ok:false,status:400,message:`Premium Points so podem ser doados de ${GUILD_PP_LOT_SIZE} em ${GUILD_PP_LOT_SIZE}.`};
  const client=await pool.connect();try{await client.query('BEGIN');const own=await marketRow(client,characterId,accountId);if(!own){await client.query('ROLLBACK');return {ok:false,status:404,message:'Personagem nao encontrado.'}};const membership=await guildMemberRecord(client,characterId,{forUpdate:true});if(!membership){await client.query('ROLLBACK');return {ok:false,status:403,message:'Entre em uma guild antes de doar.'}};let guild=await guildRow(client,membership.guild_id,{forUpdate:true});
    if(currency==='premium'){
      const pp=Number(own.state.profile?.premiumPoints??own.state.profile?.vipCredits??0);if(pp<amount){await client.query('ROLLBACK');return {ok:false,status:400,message:'Premium Points insuficientes.'}};own.state.profile.premiumPoints=pp-amount;own.state.profile.vipCredits=own.state.profile.premiumPoints;guild.pp_vault=Number(guild.pp_vault||0)+amount;await persistGuildProgress(client,guild);await client.query(`UPDATE guild_members SET contributed_pp=contributed_pp+$3 WHERE guild_id=$1 AND character_id=$2`,[guild.id,characterId,amount]);await addGuildHistory(client,guild.id,characterId,'pp-deposited',{amount,vaultAfter:guild.pp_vault});guildStateProfile(own.state,guild);await saveMarketRow(client,own);await client.query('COMMIT');return {ok:true,message:`${amount.toLocaleString('pt-BR')} PP foram para o Cofre da Guild. Eles ainda nao viraram XP.`,state:own.state,changedStates:{[own.id]:own.state},accountId:own.account_id,premiumPoints:Number(own.state.profile.premiumPoints||0)};
    }
    if(Number(own.state.profile?.bank||0)<amount){await client.query('ROLLBACK');return {ok:false,status:400,message:'Gold/Zeni insuficiente.'}};own.state.profile.bank=Number(own.state.profile.bank||0)-amount;guild.gold_burned=Number(guild.gold_burned||0)+amount;
    const benefits=guildBenefits(guild.level,guild.technologies),baseXp=Math.floor(amount/GUILD_GOLD_PER_XP)*GUILD_GOLD_XP_PER_LOT,bonusPct=benefits.donationXpPercent+benefits.goldDonationXpPercent,earnedXp=Math.max(1,Math.floor(baseXp*(1+bonusPct/100))),beforeLevel=Number(guild.level||1),progress=applyGuildLevelProgress(guild,earnedXp);guild={...guild,...progress.guild};await persistGuildProgress(client,guild);
    await client.query(`UPDATE guild_members SET contributed_gold=contributed_gold+$3,contributed_xp=contributed_xp+$4 WHERE guild_id=$1 AND character_id=$2`,[guild.id,characterId,amount,earnedXp]);await addGuildHistory(client,guild.id,characterId,'donation',{currency:'gold',amount,guildXp:earnedXp,levelsGained:progress.levelsGained});guildStateProfile(own.state,guild);await saveMarketRow(client,own);let changedStates={[own.id]:own.state};if(guild.level!==beforeLevel)changedStates={...changedStates,...await syncGuildBenefitsForMembers(client,guild)};await client.query('COMMIT');return {ok:true,message:`Gold queimado: +${earnedXp.toLocaleString('pt-BR')} XP de Guild.${progress.levelsGained?` Guild subiu ${progress.levelsGained} nivel(is)!`:''}`,state:changedStates[own.id]||own.state,changedStates};
  }catch(e){try{await client.query('ROLLBACK')}catch{};throw e}finally{client.release()}
}
export async function convertGuildPremiumToXp(accountId,characterId,input={}){
  const amount=marketAmount(input.amount);if(amount<GUILD_PP_LOT_SIZE||amount%GUILD_PP_LOT_SIZE!==0)return {ok:false,status:400,message:`Converta PP em multiplos de ${GUILD_PP_LOT_SIZE}.`};
  const client=await pool.connect();try{await client.query('BEGIN');const own=await marketRow(client,characterId,accountId);if(!own){await client.query('ROLLBACK');return {ok:false,status:404,message:'Personagem nao encontrado.'}};const membership=await guildMemberRecord(client,characterId,{forUpdate:true});if(!membership||!guildOfficer(membership.role)){await client.query('ROLLBACK');return {ok:false,status:403,message:'Somente Lider e Vice podem converter PP do Cofre em XP.'}};let guild=await guildRow(client,membership.guild_id,{forUpdate:true});if(Number(guild.pp_vault||0)<amount){await client.query('ROLLBACK');return {ok:false,status:400,message:'PP insuficiente no Cofre da Guild.'}};
    guild.pp_vault=Number(guild.pp_vault||0)-amount;guild.pp_burned=Number(guild.pp_burned||0)+amount;const benefits=guildBenefits(guild.level,guild.technologies),baseXp=amount*GUILD_PP_XP,earnedXp=Math.max(1,Math.floor(baseXp*(1+benefits.donationXpPercent/100))),beforeLevel=Number(guild.level||1),progress=applyGuildLevelProgress(guild,earnedXp);guild={...guild,...progress.guild};await persistGuildProgress(client,guild);await addGuildHistory(client,guild.id,characterId,'pp-converted',{amount,guildXp:earnedXp,levelsGained:progress.levelsGained});let changedStates={};if(guild.level!==beforeLevel)changedStates=await syncGuildBenefitsForMembers(client,guild);await client.query('COMMIT');return {ok:true,message:`${amount.toLocaleString('pt-BR')} PP queimados no Cofre: +${earnedXp.toLocaleString('pt-BR')} XP de Guild.`,state:changedStates[own.id]||own.state,changedStates};
  }catch(e){try{await client.query('ROLLBACK')}catch{};throw e}finally{client.release()}
}
export async function upgradeGuildTechnology(accountId,characterId,technologyId){
  const id=String(technologyId||''),def=GUILD_TECHNOLOGIES[id];if(!def)return {ok:false,status:400,message:'Tecnologia invalida.'};
  const client=await pool.connect();try{await client.query('BEGIN');const own=await marketRow(client,characterId,accountId);if(!own){await client.query('ROLLBACK');return {ok:false,status:404,message:'Personagem nao encontrado.'}};const membership=await guildMemberRecord(client,characterId,{forUpdate:true});if(!membership||!guildOfficer(membership.role)){await client.query('ROLLBACK');return {ok:false,status:403,message:'Somente Lider e Vice podem pesquisar tecnologias.'}};const guild=await guildRow(client,membership.guild_id,{forUpdate:true});const tech=normalizeGuildTechnologies(guild.technologies),current=tech[id]||0;if(current>=def.maxLevel){await client.query('ROLLBACK');return {ok:false,status:409,message:'Tecnologia ja esta no nivel maximo.'}};const cost=guildTechnologyCost(id,current);if(Number(guild.guild_points||0)<cost){await client.query('ROLLBACK');return {ok:false,status:400,message:`Sao necessarios ${cost} Guild Point(s).`}};tech[id]=current+1;guild.technologies=tech;guild.guild_points=Number(guild.guild_points||0)-cost;await persistGuildProgress(client,guild);await addGuildHistory(client,guild.id,characterId,'technology-upgraded',{technologyId:id,technologyName:def.name,level:tech[id],cost});const changedStates=await syncGuildBenefitsForMembers(client,guild);await client.query('COMMIT');return {ok:true,message:`${def.name} agora esta no nivel ${tech[id]}/${def.maxLevel}.`,state:changedStates[own.id]||own.state,changedStates};
  }catch(e){try{await client.query('ROLLBACK')}catch{};throw e}finally{client.release()}
}
export async function updateGuildSettings(accountId,characterId,input={}){
  const client=await pool.connect();try{await client.query('BEGIN');const own=await marketRow(client,characterId,accountId);if(!own){await client.query('ROLLBACK');return {ok:false,status:404,message:'Personagem nao encontrado.'}};const membership=await guildMemberRecord(client,characterId,{forUpdate:true});if(!membership||membership.role!=='leader'){await client.query('ROLLBACK');return {ok:false,status:403,message:'Somente o Lider pode alterar a Guild.'}};const guild=await guildRow(client,membership.guild_id,{forUpdate:true});const message=String(input.messageOfDay??guild.message_of_day??'').replace(/[<>]/g,'').trim().slice(0,180),joinOpen=input.joinOpen==null?Boolean(guild.join_open):Boolean(input.joinOpen);await client.query(`UPDATE guilds SET message_of_day=$2,join_open=$3,updated_at=now() WHERE id=$1`,[guild.id,message,joinOpen]);await addGuildHistory(client,guild.id,characterId,'settings-updated',{joinOpen,messageOfDay:message});await client.query('COMMIT');return {ok:true,message:'Configuracoes da guild atualizadas.'};
  }catch(e){try{await client.query('ROLLBACK')}catch{};throw e}finally{client.release()}
}
export async function kickGuildMember(accountId,characterId,targetCharacterId){
  const client=await pool.connect();try{await client.query('BEGIN');const own=await marketRow(client,characterId,accountId);if(!own){await client.query('ROLLBACK');return {ok:false,status:404,message:'Personagem nao encontrado.'}};const membership=await guildMemberRecord(client,characterId,{forUpdate:true});if(!membership||membership.role!=='leader'){await client.query('ROLLBACK');return {ok:false,status:403,message:'Somente o Lider pode remover membros.'}};if(String(targetCharacterId)===String(characterId)){await client.query('ROLLBACK');return {ok:false,status:400,message:'O lider nao pode remover a si mesmo.'}};const targetMember=(await client.query(`SELECT gm.*,c.name FROM guild_members gm JOIN characters c ON c.id=gm.character_id WHERE gm.guild_id=$1 AND gm.character_id=$2 FOR UPDATE OF gm`,[membership.guild_id,targetCharacterId])).rows[0];if(!targetMember){await client.query('ROLLBACK');return {ok:false,status:404,message:'Membro nao encontrado.'}};await client.query(`DELETE FROM guild_members WHERE guild_id=$1 AND character_id=$2`,[membership.guild_id,targetCharacterId]);await addGuildHistory(client,membership.guild_id,characterId,'member-kicked',{targetCharacterId,name:targetMember.name});const target=await syncGuildBenefitsForCharacter(client,targetCharacterId,null);await client.query('COMMIT');return {ok:true,message:`${targetMember.name} foi removido da guild.`,changedStates:target?{[target.id]:target.state}:{}};
  }catch(e){try{await client.query('ROLLBACK')}catch{};throw e}finally{client.release()}
}
export async function summonGuildBoss(accountId,characterId,input={}){
  const bossType=String(input.bossType||'daishinkan')==='champa'?'champa':'daishinkan';
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const own=await marketRow(client,characterId,accountId);
    if(!own){await client.query('ROLLBACK');return {ok:false,status:404,message:'Personagem nao encontrado.'}};
    const membership=await guildMemberRecord(client,characterId,{forUpdate:true});
    if(!membership){await client.query('ROLLBACK');return {ok:false,status:403,message:'Voce nao pertence a uma Guild.'}};
    if(bossType==='daishinkan'&&!guildOfficer(membership.role)){
      await client.query('ROLLBACK');return {ok:false,status:403,message:'Somente Lider e Vice podem invocar o Daishinkan.'};
    }
    if(bossType==='champa'&&membership.role==='recruit'){
      await client.query('ROLLBACK');return {ok:false,status:403,message:'Recrutas nao podem invocar o Champa da Guild.'};
    }
    const guild=await guildRow(client,membership.guild_id,{forUpdate:true});
    const running=(await client.query(`SELECT id FROM guild_boss_runs WHERE guild_id=$1 AND status IN ('pending','active') LIMIT 1 FOR UPDATE`,[guild.id])).rows[0];
    if(running){await client.query('ROLLBACK');return {ok:false,status:409,message:'Ja existe um Boss da Guild pendente ou em andamento.'}};

    let summonCostPp=0;
    let costLabel='';
    if(bossType==='daishinkan'){
      summonCostPp=GUILD_BOSS_SUMMON_COST_PP;
      if(Number(guild.pp_vault||0)<summonCostPp){await client.query('ROLLBACK');return {ok:false,status:400,message:`O Cofre precisa de ${summonCostPp} PP para invocar o Daishinkan.`}};
      guild.pp_vault=Number(guild.pp_vault||0)-summonCostPp;
      guild.pp_burned=Number(guild.pp_burned||0)+summonCostPp;
      await persistGuildProgress(client,guild);
      costLabel=`${summonCostPp} PP foram queimados sem gerar XP`;
    }else{
      const dollId='server_13407';
      if(itemQuantity(own.state,dollId)<1){await client.query('ROLLBACK');return {ok:false,status:400,message:'Voce precisa de 1 Champa Doll no inventario para invocar este Boss.'}};
      if(!removeItemFromInventory(own.state,dollId,1)){await client.query('ROLLBACK');return {ok:false,status:400,message:'Nao foi possivel consumir a Champa Doll.'}};
      await saveMarketRow(client,own);
      costLabel='1 Champa Doll foi consumida do invocador';
    }

    const runId=crypto.randomUUID(),startsAt=new Date(Date.now()+GUILD_BOSS_START_DELAY_MS);
    await client.query(`INSERT INTO guild_boss_runs(id,guild_id,summoned_by,status,summon_cost_pp,boss_type,starts_at) VALUES($1,$2,$3,'pending',$4,$5,$6)`,[
      runId,guild.id,characterId,summonCostPp,bossType,startsAt
    ]);
    const memberIds=(await client.query(`SELECT character_id FROM guild_members WHERE guild_id=$1`,[guild.id])).rows.map(r=>r.character_id);
    await addGuildHistory(client,guild.id,characterId,'guild-boss-summoned',{runId,bossType,costPp:summonCostPp,itemId:bossType==='champa'?'server_13407':null,startsAt:startsAt.toISOString()});
    await client.query('COMMIT');
    return {
      ok:true,
      message:`${bossType==='champa'?'Champa':'Daishinkan'} da Guild invocado. ${costLabel}. A batalha inicia em 1 minuto.`,
      bossRun:{id:runId,guildId:guild.id,bossType,status:'pending',startsAt:startsAt.toISOString(),summonCostPp},
      memberIds,
      guild:guildPublicPayload(guild,memberIds.map(()=>({}))),
      state:own.state,
      changedStates:{[own.id]:own.state}
    };
  }catch(e){try{await client.query('ROLLBACK')}catch{};throw e}finally{client.release()}
}
export async function acceptGuildBoss(accountId,characterId,runId){
  const client=await pool.connect();try{await client.query('BEGIN');const own=await marketRow(client,characterId,accountId);if(!own){await client.query('ROLLBACK');return {ok:false,status:404,message:'Personagem nao encontrado.'}};const membership=await guildMemberRecord(client,characterId,{forUpdate:true});if(!membership){await client.query('ROLLBACK');return {ok:false,status:403,message:'Voce nao pertence a uma Guild.'}};const run=(await client.query(`SELECT * FROM guild_boss_runs WHERE id=$1 AND guild_id=$2 FOR UPDATE`,[runId,membership.guild_id])).rows[0];if(!run||run.status!=='pending'){await client.query('ROLLBACK');return {ok:false,status:409,message:'Este convite de Boss nao esta mais disponivel.'}};if(new Date(run.starts_at).getTime()<=Date.now()){await client.query('ROLLBACK');return {ok:false,status:409,message:'O tempo para aceitar terminou.'}};await client.query(`INSERT INTO guild_boss_participants(run_id,character_id,outcome) VALUES($1,$2,'accepted') ON CONFLICT(run_id,character_id) DO NOTHING`,[run.id,characterId]);await client.query('COMMIT');return {ok:true,message:'Convite aceito. Aguarde o inicio automatico da batalha.',run:{id:run.id,guildId:run.guild_id,bossType:String(run.boss_type||'daishinkan'),startsAt:run.starts_at,status:run.status},characterId};
  }catch(e){try{await client.query('ROLLBACK')}catch{};throw e}finally{client.release()}
}
export async function markGuildBossStarted(runId){
  const result=await pool.query(`UPDATE guild_boss_runs SET status='active',started_at=COALESCE(started_at,now()) WHERE id=$1 AND status='pending' RETURNING *`,[runId]);return result.rows[0]||null;
}
export async function completeGuildBossRun(runId,status='lost',participantOutcomes={}){
  const outcome=status==='won'?'won':'lost';const client=await pool.connect();try{await client.query('BEGIN');const run=(await client.query(`SELECT * FROM guild_boss_runs WHERE id=$1 FOR UPDATE`,[runId])).rows[0];if(!run){await client.query('ROLLBACK');return {ok:false,status:404,message:'Run de Boss nao encontrada.'}};if(!['pending','active'].includes(run.status)){await client.query('ROLLBACK');return {ok:true,alreadyFinished:true,status:run.status}};await client.query(`UPDATE guild_boss_runs SET status=$2,ended_at=now() WHERE id=$1`,[runId,outcome]);for(const [characterId,pOutcome] of Object.entries(participantOutcomes||{})){const safe=['accepted','alive','dead','rewarded'].includes(String(pOutcome))?String(pOutcome):(outcome==='won'?'rewarded':'dead');await client.query(`UPDATE guild_boss_participants SET outcome=$3 WHERE run_id=$1 AND character_id=$2`,[runId,characterId,safe]);}if(outcome==='won'){const g=await guildRow(client,run.guild_id,{forUpdate:true});if(g){const gb=normalizeGuildBossBestiary(g.guild_boss_bestiary);const type=String(run.boss_type||'daishinkan')==='champa'?'champa':'daishinkan';gb.kills[type]=Math.max(0,Number(gb.kills[type]||0))+1;await client.query(`UPDATE guilds SET guild_boss_bestiary=$2::jsonb,updated_at=now() WHERE id=$1`,[g.id,JSON.stringify(gb)]);}}await addGuildHistory(client,run.guild_id,run.summoned_by,`guild-boss-${outcome}`,{runId,bossType:String(run.boss_type||'daishinkan')});await client.query('COMMIT');return {ok:true,status:outcome,guildId:run.guild_id};}catch(e){try{await client.query('ROLLBACK')}catch{};throw e}finally{client.release()}
}
export async function guildBossAcceptedCharacterIds(runId){return (await pool.query(`SELECT character_id FROM guild_boss_participants WHERE run_id=$1 ORDER BY accepted_at`,[runId])).rows.map(r=>String(r.character_id));}

const MARKET_PP_ITEM_ID='premium_points_trade';
const MARKET_PP_LOT_SIZE=10;
function isMarketPremiumAsset(itemId){return String(itemId||'')===MARKET_PP_ITEM_ID}
function validPremiumMarketLot(quantity){const qty=Math.trunc(Number(quantity)||0);return qty>=MARKET_PP_LOT_SIZE&&qty%MARKET_PP_LOT_SIZE===0}
function isMarketCapsule(item){
  const name=String(item?.name||'').toLowerCase(),id=String(item?.id||'').toLowerCase();
  return item?.type==='capsule'||name.includes('capsule')||name.includes('cápsula')||id.includes('_capsule')||id.includes('capsule_');
}
function isMarketSenzu(item){
  const name=String(item?.name||'').toLowerCase();
  return item?.consumableKind==='senzu'||name.includes('senzu')||name.includes('rola bean')||name.includes('coca-cola bean');
}
function marketTradable(item){
  if(item?.virtualMarketAsset===true)return true;
  if(!item||item.id==='depot'||item.type==='currency'||isMarketCapsule(item))return false;
  // V21.19: todos os Senzus e todas as backpacks que nao sao Capsulas sao
  // negociaveis no Mercado Global, mesmo quando o item tem questOnly.
  if(isMarketSenzu(item))return true;
  if(item.type==='backpack')return true;
  if(item.questOnly===true||item.trainingSkill!=null)return false;
  return true;
}
function entryRarity(entry,item){return marketRarity(entry?.rarity||item?.rarity||'common')}
function takeMarketItem(state,containerId,index,quantity){
  const container=state.containers?.[String(containerId||'')];const i=Math.trunc(Number(index));const entry=container?.items?.[i];if(!entry)return {ok:false,message:'Item nao encontrado.'};
  const item=itemCatalog[entry.itemId];if(!marketTradable(item))return {ok:false,message:'Este item nao pode ser negociado.'};if(entry.locked)return {ok:false,message:'Desbloqueie o item antes de anunciar/vender.'};
  const available=Math.max(1,Math.trunc(Number(entry.quantity)||1));const qty=Math.max(1,Math.min(available,Math.trunc(Number(quantity)||1)));
  if(entry.containerId){const nested=state.containers?.[entry.containerId];if(nested?.items?.length)return {ok:false,message:'Esvazie a backpack antes de negocia-la.'};if(qty!==1)return {ok:false,message:'Backpacks sao negociadas uma por vez.'};delete state.containers[entry.containerId];}
  const payload={entry:{...entry,quantity:qty,locked:false}};delete payload.entry.containerId;
  if(qty>=available)container.items.splice(i,1);else entry.quantity=available-qty;
  return {ok:true,item,itemId:item.id,quantity:qty,rarity:entryRarity(entry,item),rarityTier:rarityDefinition(entryRarity(entry,item)).tier,payload};
}
function putMarketItem(state,itemId,payload,quantity){
  normalizeInventoryState(state);const entry=payload?.entry||{};const qty=Math.max(1,Math.trunc(Number(quantity)||Number(entry.quantity)||1));
  const depot=state.containers?.[state.depotContainerId];if(depot && depot.items.length>=Number(depot.capacity||0))depot.capacity=depot.items.length+20;
  const result=addItemToInventory(state,itemId,qty,itemCatalog,state.depotContainerId,{...entry,quantity:qty,locked:false});
  if(!result.ok && depot){depot.capacity=Math.max(Number(depot.capacity||0),depot.items.length+20);return addItemToInventory(state,itemId,qty,itemCatalog,state.depotContainerId,{...entry,quantity:qty,locked:false})}
  return result;
}
function takeMarketAsset(state,itemId,containerId,index,quantity){
  if(!isMarketPremiumAsset(itemId))return takeMarketItem(state,containerId,index,quantity);
  const qty=Math.trunc(Number(quantity)||0);
  if(!validPremiumMarketLot(qty))return {ok:false,message:'Premium Points so podem ser negociados em lotes de 10.'};
  if(marketBalance(state,'premium')<qty)return {ok:false,message:'Premium Points insuficientes.'};
  setMarketBalance(state,'premium',marketBalance(state,'premium')-qty);
  return {ok:true,item:itemCatalog[MARKET_PP_ITEM_ID],itemId:MARKET_PP_ITEM_ID,quantity:qty,rarity:'common',rarityTier:0,payload:{virtualMarketAsset:true,lotSize:MARKET_PP_LOT_SIZE}};
}
function putMarketAsset(state,itemId,payload,quantity){
  if(!isMarketPremiumAsset(itemId))return putMarketItem(state,itemId,payload,quantity);
  const qty=Math.max(0,Math.trunc(Number(quantity)||0));
  setMarketBalance(state,'premium',marketBalance(state,'premium')+qty);
  return {ok:true,virtualMarketAsset:true,quantity:qty};
}
async function addHistory(client,{listingId=null,requestId=null,sellerId,buyerId,itemId,payload,quantity,rarity,unitPrice,currency,source}){
  await client.query(`INSERT INTO market_history(listing_id,request_id,seller_character_id,buyer_character_id,item_id,item_payload,quantity,rarity,unit_price,currency,source) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)`,[listingId,requestId,sellerId,buyerId,itemId,JSON.stringify(payload||{}),quantity,rarity,unitPrice,currency,source]);
}
async function expireMarket(client,sellerCharacterId=null){
  const expired=(await client.query(sellerCharacterId?`SELECT * FROM market_listings WHERE status='active' AND expires_at<=now() AND seller_character_id=$1 ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT 100`:`SELECT * FROM market_listings WHERE status='active' AND expires_at<=now() ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT 100`,sellerCharacterId?[sellerCharacterId]:[])).rows;
  const changed=new Map();
  for(const listing of expired){const seller=await marketRow(client,listing.seller_character_id);if(!seller)continue;putMarketAsset(seller.state,listing.item_id,listing.item_payload,listing.quantity);setMarketBalance(seller.state,listing.currency,marketBalance(seller.state,listing.currency)+Number(listing.fee||0));await saveMarketRow(client,seller);changed.set(seller.id,seller.state);await client.query(`UPDATE market_listings SET status='expired',completed_at=now() WHERE id=$1`,[listing.id]);}
  return changed;
}
async function settleListingAgainstRequest(client,listing,request){
  const qty=Number(listing.quantity);if(Number(request.remaining_quantity)<qty)return null;
  const seller=await marketRow(client,listing.seller_character_id);const buyer=await marketRow(client,request.buyer_character_id);if(!seller||!buyer)return null;
  const gross=Number(request.unit_price)*qty;if(Number(request.escrow)<gross)return null;
  putMarketAsset(buyer.state,listing.item_id,listing.item_payload,qty);setMarketBalance(seller.state,listing.currency,marketBalance(seller.state,listing.currency)+gross);
  await saveMarketRow(client,seller);await saveMarketRow(client,buyer);
  const remaining=Number(request.remaining_quantity)-qty;const escrow=Number(request.escrow)-gross;
  await client.query(`UPDATE market_requests SET remaining_quantity=$2,escrow=$3,status=CASE WHEN $2=0 THEN 'filled' ELSE status END,completed_at=CASE WHEN $2=0 THEN now() ELSE completed_at END WHERE id=$1`,[request.id,remaining,escrow]);
  await client.query(`UPDATE market_listings SET status='sold',buyer_character_id=$2,completed_at=now() WHERE id=$1`,[listing.id,buyer.id]);
  await addHistory(client,{listingId:listing.id,requestId:request.id,sellerId:seller.id,buyerId:buyer.id,itemId:listing.item_id,payload:listing.item_payload,quantity:qty,rarity:listing.rarity,unitPrice:Number(request.unit_price),currency:listing.currency,source:'request-match'});
  return new Map([[seller.id,seller.state],[buyer.id,buyer.state]]);
}

export async function marketOverview(accountId,characterId){
  const client=await pool.connect();try{await client.query('BEGIN');const own=await marketRow(client,characterId,accountId);if(!own){await client.query('ROLLBACK');return {ok:false,status:404,message:'Personagem nao encontrado.'}};const changed=await expireMarket(client,characterId);if(changed.has(characterId))own.state=changed.get(characterId);
    const listings=(await client.query(`SELECT l.*,c.name seller_name FROM market_listings l JOIN characters c ON c.id=l.seller_character_id WHERE l.status='active' AND l.expires_at>now() ORDER BY l.created_at DESC LIMIT 1000`)).rows;
    const mine=listings.filter(x=>x.seller_character_id===characterId);
    const requests=(await client.query(`SELECT r.*,c.name buyer_name FROM market_requests r JOIN characters c ON c.id=r.buyer_character_id WHERE r.status='active' AND r.remaining_quantity>0 ORDER BY r.created_at DESC LIMIT 1000`)).rows;
    const history=(await client.query(`SELECT h.*,s.name seller_name,b.name buyer_name FROM market_history h LEFT JOIN characters s ON s.id=h.seller_character_id LEFT JOIN characters b ON b.id=h.buyer_character_id WHERE h.seller_character_id=$1 OR h.buyer_character_id=$1 ORDER BY h.created_at DESC LIMIT 500`,[characterId])).rows;
    await client.query('COMMIT');return {ok:true,listings,myListings:mine,requests,history,balance:{zeni:marketBalance(own.state,'zeni'),premium:marketBalance(own.state,'premium')},state:own.state,changedStates:Object.fromEntries(changed)};
  }catch(e){try{await client.query('ROLLBACK')}catch{};throw e}finally{client.release()}
}
export async function createMarketListing(accountId,characterId,input={}){
  const client=await pool.connect();try{await client.query('BEGIN');await expireMarket(client,characterId);const seller=await marketRow(client,characterId,accountId);if(!seller){await client.query('ROLLBACK');return {ok:false,status:404,message:'Personagem nao encontrado.'}};
    const requestedItemId=String(input.itemId||''),premiumAsset=isMarketPremiumAsset(requestedItemId);const price=marketPriceAmount(input.price),currency=premiumAsset?'zeni':marketCurrency(input.currency);if(price<1){await client.query('ROLLBACK');return {ok:false,status:400,message:'Informe um preco valido.'}};if(premiumAsset&&!validPremiumMarketLot(input.quantity)){await client.query('ROLLBACK');return {ok:false,status:400,message:'Premium Points so podem ser anunciados em lotes de 10.'}};
    const taken=takeMarketAsset(seller.state,premiumAsset?MARKET_PP_ITEM_ID:null,input.containerId,input.index,input.quantity);if(!taken.ok){await client.query('ROLLBACK');return {ok:false,status:400,message:taken.message}};
    const fee=premiumAsset?0:Math.max(1,Math.ceil(price*taken.quantity*MARKET_FEE_RATE));if(fee>0&&marketBalance(seller.state,currency)<fee){await client.query('ROLLBACK');return {ok:false,status:400,message:`Saldo insuficiente para a taxa de 2% (${fee}).`}};if(fee>0)setMarketBalance(seller.state,currency,marketBalance(seller.state,currency)-fee);await saveMarketRow(client,seller);
    const id=crypto.randomUUID(),expires=new Date(Date.now()+MARKET_DURATION_MS);const row=(await client.query(`INSERT INTO market_listings(id,seller_character_id,item_id,item_payload,quantity,rarity,rarity_tier,price,currency,fee,expires_at) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[id,seller.id,taken.itemId,JSON.stringify(taken.payload),taken.quantity,taken.rarity,taken.rarityTier,price,currency,fee,expires])).rows[0];
    const req=(await client.query(`SELECT * FROM market_requests WHERE status='active' AND item_id=$1 AND rarity=$2 AND currency=$3 AND unit_price>=$4 AND remaining_quantity>=$5 AND buyer_character_id<>$6 ORDER BY unit_price DESC,created_at LIMIT 1 FOR UPDATE`,[taken.itemId,taken.rarity,currency,price,taken.quantity,seller.id])).rows[0];let changed=new Map([[seller.id,seller.state]]);if(req){const m=await settleListingAgainstRequest(client,row,req);if(m)for(const [k,v] of m)changed.set(k,v)}
    await client.query('COMMIT');return {ok:true,message:req?'Item vendido instantaneamente para uma solicitacao existente.':'Anuncio criado por 7 dias.',listingId:id,state:changed.get(seller.id),changedStates:Object.fromEntries(changed)};
  }catch(e){try{await client.query('ROLLBACK')}catch{};throw e}finally{client.release()}
}
export async function buyMarketListing(accountId,characterId,listingId){
  const client=await pool.connect();try{await client.query('BEGIN');await expireMarket(client,characterId);const listing=(await client.query(`SELECT * FROM market_listings WHERE id=$1 AND status='active' AND expires_at>now() FOR UPDATE`,[listingId])).rows[0];if(!listing){await client.query('ROLLBACK');return {ok:false,status:404,message:'Anuncio indisponivel.'}};if(listing.seller_character_id===characterId){await client.query('ROLLBACK');return {ok:false,status:400,message:'Voce nao pode comprar seu proprio anuncio.'}};
    const buyer=await marketRow(client,characterId,accountId),seller=await marketRow(client,listing.seller_character_id);if(!buyer||!seller){await client.query('ROLLBACK');return {ok:false,status:404,message:'Personagem nao encontrado.'}};const total=Number(listing.price)*Number(listing.quantity);if(marketBalance(buyer.state,listing.currency)<total){await client.query('ROLLBACK');return {ok:false,status:400,message:'Saldo insuficiente.'}};
    setMarketBalance(buyer.state,listing.currency,marketBalance(buyer.state,listing.currency)-total);setMarketBalance(seller.state,listing.currency,marketBalance(seller.state,listing.currency)+total);putMarketAsset(buyer.state,listing.item_id,listing.item_payload,listing.quantity);await saveMarketRow(client,buyer);await saveMarketRow(client,seller);await client.query(`UPDATE market_listings SET status='sold',buyer_character_id=$2,completed_at=now() WHERE id=$1`,[listing.id,buyer.id]);await addHistory(client,{listingId:listing.id,sellerId:seller.id,buyerId:buyer.id,itemId:listing.item_id,payload:listing.item_payload,quantity:Number(listing.quantity),rarity:listing.rarity,unitPrice:Number(listing.price),currency:listing.currency,source:'listing'});await client.query('COMMIT');return {ok:true,message:'Compra concluida.',state:buyer.state,changedStates:{[buyer.id]:buyer.state,[seller.id]:seller.state}};
  }catch(e){try{await client.query('ROLLBACK')}catch{};throw e}finally{client.release()}
}
export async function cancelMarketListing(accountId,characterId,listingId){
  const client=await pool.connect();try{await client.query('BEGIN');const listing=(await client.query(`SELECT * FROM market_listings WHERE id=$1 AND seller_character_id=$2 AND status='active' FOR UPDATE`,[listingId,characterId])).rows[0];if(!listing){await client.query('ROLLBACK');return {ok:false,status:404,message:'Anuncio nao encontrado.'}};const seller=await marketRow(client,characterId,accountId);putMarketAsset(seller.state,listing.item_id,listing.item_payload,listing.quantity);await saveMarketRow(client,seller);await client.query(`UPDATE market_listings SET status='cancelled',completed_at=now() WHERE id=$1`,[listing.id]);await client.query('COMMIT');return {ok:true,message:Number(listing.fee||0)>0?'Anuncio cancelado. A taxa de 2% nao foi devolvida.':'Anuncio de PP cancelado sem taxa.',state:seller.state,changedStates:{[seller.id]:seller.state}};
  }catch(e){try{await client.query('ROLLBACK')}catch{};throw e}finally{client.release()}
}
export async function createMarketRequest(accountId,characterId,input={}){
  const client=await pool.connect();try{await client.query('BEGIN');await expireMarket(client,characterId);const buyer=await marketRow(client,characterId,accountId);if(!buyer){await client.query('ROLLBACK');return {ok:false,status:404,message:'Personagem nao encontrado.'}};const itemId=String(input.itemId||''),item=itemCatalog[itemId];if(!marketTradable(item)){await client.query('ROLLBACK');return {ok:false,status:400,message:'Item invalido.'}};const premiumAsset=isMarketPremiumAsset(itemId),rarity=premiumAsset?'common':marketRarity(input.rarity),currency=premiumAsset?'zeni':marketCurrency(input.currency),qty=Math.max(1,Math.min(9999,Math.trunc(Number(input.quantity)||1))),unitPrice=marketPriceAmount(input.price),total=unitPrice*qty;if(premiumAsset&&!validPremiumMarketLot(qty)){await client.query('ROLLBACK');return {ok:false,status:400,message:'Premium Points so podem ser solicitados em lotes de 10.'}};if(unitPrice<1||marketBalance(buyer.state,currency)<total){await client.query('ROLLBACK');return {ok:false,status:400,message:unitPrice<1?'Informe um preco valido.':'Saldo insuficiente para deixar em custodia.'}};setMarketBalance(buyer.state,currency,marketBalance(buyer.state,currency)-total);await saveMarketRow(client,buyer);const id=crypto.randomUUID();let remaining=qty,escrow=total;const changed=new Map([[buyer.id,buyer.state]]);
    const listings=(await client.query(`SELECT * FROM market_listings WHERE status='active' AND expires_at>now() AND item_id=$1 AND rarity=$2 AND currency=$3 AND price<=$4 AND seller_character_id<>$5 ORDER BY price,created_at FOR UPDATE`,[itemId,rarity,currency,unitPrice,buyer.id])).rows;
    for(const listing of listings){if(Number(listing.quantity)>remaining)continue;const seller=await marketRow(client,listing.seller_character_id);if(!seller)continue;const q=Number(listing.quantity),gross=unitPrice*q;if(escrow<gross)break;putMarketAsset(buyer.state,itemId,listing.item_payload,q);setMarketBalance(seller.state,currency,marketBalance(seller.state,currency)+gross);await saveMarketRow(client,seller);changed.set(seller.id,seller.state);remaining-=q;escrow-=gross;await client.query(`UPDATE market_listings SET status='sold',buyer_character_id=$2,completed_at=now() WHERE id=$1`,[listing.id,buyer.id]);await addHistory(client,{listingId:listing.id,requestId:id,sellerId:seller.id,buyerId:buyer.id,itemId,payload:listing.item_payload,quantity:q,rarity,unitPrice,currency,source:'request-match'});if(!remaining)break;}
    await saveMarketRow(client,buyer);await client.query(`INSERT INTO market_requests(id,buyer_character_id,item_id,rarity,quantity,remaining_quantity,unit_price,currency,escrow,status,completed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CASE WHEN $10='filled' THEN now() ELSE NULL END)`,[id,buyer.id,itemId,rarity,qty,remaining,unitPrice,currency,escrow,remaining?'active':'filled']);await client.query('COMMIT');return {ok:true,message:remaining?'Solicitacao criada. Valor reservado em custodia.':'Solicitacao atendida imediatamente.',state:buyer.state,changedStates:Object.fromEntries(changed)};
  }catch(e){try{await client.query('ROLLBACK')}catch{};throw e}finally{client.release()}
}
export async function sellToMarketRequest(accountId,characterId,requestId,input={}){
  const client=await pool.connect();try{await client.query('BEGIN');const request=(await client.query(`SELECT * FROM market_requests WHERE id=$1 AND status='active' AND remaining_quantity>0 FOR UPDATE`,[requestId])).rows[0];if(!request){await client.query('ROLLBACK');return {ok:false,status:404,message:'Solicitacao indisponivel.'}};if(request.buyer_character_id===characterId){await client.query('ROLLBACK');return {ok:false,status:400,message:'Voce nao pode vender para sua propria solicitacao.'}};const seller=await marketRow(client,characterId,accountId),buyer=await marketRow(client,request.buyer_character_id);const maxQty=Math.min(Number(request.remaining_quantity),Math.max(1,Math.trunc(Number(input.quantity)||1)));if(isMarketPremiumAsset(request.item_id)&&!validPremiumMarketLot(maxQty)){await client.query('ROLLBACK');return {ok:false,status:400,message:'Premium Points so podem ser vendidos em lotes de 10.'}};const taken=takeMarketAsset(seller.state,request.item_id,input.containerId,input.index,maxQty);if(!taken.ok){await client.query('ROLLBACK');return {ok:false,status:400,message:taken.message}};if(taken.itemId!==request.item_id||taken.rarity!==request.rarity){await client.query('ROLLBACK');return {ok:false,status:400,message:'O item ou a raridade nao corresponde a solicitacao.'}};const gross=Number(request.unit_price)*taken.quantity,premiumAsset=isMarketPremiumAsset(taken.itemId),fee=premiumAsset?0:Math.max(1,Math.ceil(gross*MARKET_FEE_RATE)),net=Math.max(0,gross-fee);if(Number(request.escrow)<gross){await client.query('ROLLBACK');return {ok:false,status:409,message:'Custodia insuficiente.'}};putMarketAsset(buyer.state,taken.itemId,taken.payload,taken.quantity);setMarketBalance(seller.state,request.currency,marketBalance(seller.state,request.currency)+net);await saveMarketRow(client,seller);await saveMarketRow(client,buyer);const remaining=Number(request.remaining_quantity)-taken.quantity,escrow=Number(request.escrow)-gross;await client.query(`UPDATE market_requests SET remaining_quantity=$2,escrow=$3,status=CASE WHEN $2=0 THEN 'filled' ELSE status END,completed_at=CASE WHEN $2=0 THEN now() ELSE completed_at END WHERE id=$1`,[request.id,remaining,escrow]);await addHistory(client,{requestId:request.id,sellerId:seller.id,buyerId:buyer.id,itemId:taken.itemId,payload:taken.payload,quantity:taken.quantity,rarity:taken.rarity,unitPrice:Number(request.unit_price),currency:request.currency,source:'request-direct'});await client.query('COMMIT');return {ok:true,message:fee>0?`Venda concluida. Taxa: ${fee}.`:'Venda de PP concluida sem taxa.',state:seller.state,changedStates:{[seller.id]:seller.state,[buyer.id]:buyer.state}};
  }catch(e){try{await client.query('ROLLBACK')}catch{};throw e}finally{client.release()}
}
export async function cancelMarketRequest(accountId,characterId,requestId){
  const client=await pool.connect();try{await client.query('BEGIN');const request=(await client.query(`SELECT * FROM market_requests WHERE id=$1 AND buyer_character_id=$2 AND status='active' FOR UPDATE`,[requestId,characterId])).rows[0];if(!request){await client.query('ROLLBACK');return {ok:false,status:404,message:'Solicitacao nao encontrada.'}};const buyer=await marketRow(client,characterId,accountId);setMarketBalance(buyer.state,request.currency,marketBalance(buyer.state,request.currency)+Number(request.escrow));await saveMarketRow(client,buyer);await client.query(`UPDATE market_requests SET status='cancelled',escrow=0,completed_at=now() WHERE id=$1`,[request.id]);await client.query('COMMIT');return {ok:true,message:'Solicitacao cancelada e custodia devolvida.',state:buyer.state,changedStates:{[buyer.id]:buyer.state}};
  }catch(e){try{await client.query('ROLLBACK')}catch{};throw e}finally{client.release()}
}
