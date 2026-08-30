import { authoritativeNpcs } from '../../data/generated/absolute-npcs-v2000.js';
const byId=new Map(authoritativeNpcs.map(n=>[n.id,n]));
export function npcDefinition(id){return byId.get(id)||authoritativeNpcs.find(n=>n.name.toLowerCase()===String(id).toLowerCase())||null;}
export function npcGreeting(npc,playerName='Player'){const line=npc?.dialogues?.find(d=>d.trigger==='greet')||npc?.dialogues?.[0];return (line?.text||`Olá, ${playerName}.`).replace(/\|PLAYERNAME\|/g,playerName);}
export function npcReply(npc,message){const value=String(message||'').toLowerCase();return npc?.dialogues?.find(d=>value.includes(String(d.trigger).toLowerCase()))?.text||null;}
export function npcShop(npc,kind=null){return (npc?.shops||[]).filter(x=>!kind||x.kind===kind);}
export function npcTravelOptions(npc){return npc?.teleports||[];}
