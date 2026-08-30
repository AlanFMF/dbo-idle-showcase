import {characters} from '../data/characters.js';
import {zones} from '../data/zones.js';
import {items} from '../data/items.js';
const SAVE_KEY='dbo-idle-save-v1';
const xpNeeded=l=>Math.floor(60*Math.pow(l,1.55));
export class Game {
 constructor(){this.listeners=[];this.state=this.load()||this.fresh();this.lastTick=Date.now();this.applyOffline();}
 fresh(){return {version:1,characterId:null,level:1,xp:0,zeni:0,zoneId:'earth-plains',enemy:null,hp:100,maxHp:100,inventory:{},equipment:{weapon:null,armor:null,accessory:null},stats:{kills:0,playSeconds:0},log:['Bem-vindo ao DBO Idle.']};}
 get character(){return characters.find(x=>x.id===this.state.characterId)} get zone(){return zones.find(x=>x.id===this.state.zoneId)}
 transformation(){return [...this.character.transformations].reverse().find(t=>this.state.level>=t.level)}
 derived(){if(!this.character)return null; const t=this.transformation();let atk=this.character.base.attack*t.multiplier,def=this.character.base.defense*t.multiplier,hp=this.character.base.hp*t.multiplier;for(const id of Object.values(this.state.equipment)){const i=items.find(x=>x.id===id);if(i){atk+=i.attack||0;def+=i.defense||0;}}return {attack:Math.floor(atk),defense:Math.floor(def),maxHp:Math.floor(hp),speed:this.character.base.speed,form:t.name};}
 selectCharacter(id){this.state.characterId=id;const d=this.derived();this.state.maxHp=d.maxHp;this.state.hp=d.maxHp;this.spawn();this.save();this.emit();}
 setZone(id){const z=zones.find(x=>x.id===id);if(!z||this.state.level<z.level)return;this.state.zoneId=id;this.spawn();this.push(`Você viajou para ${z.name}.`);this.save();this.emit();}
 spawn(){const list=this.zone.monsters;const base=list[Math.floor(Math.random()*list.length)];this.state.enemy={...base,currentHp:base.hp};}
 tick(seconds=1){if(!this.character)return;this.state.stats.playSeconds+=seconds;for(let i=0;i<Math.max(1,Math.floor(seconds*2));i++)this.combatStep(.5);this.save();this.emit();}
 combatStep(dt){if(!this.state.enemy)this.spawn();const d=this.derived(),e=this.state.enemy;const dealt=Math.max(1,(d.attack-e.defense*.55)*d.speed*dt);e.currentHp-=dealt;if(e.currentHp<=0){this.reward(e);this.spawn();return;}const received=Math.max(0.5,(e.attack-d.defense*.5)*dt);this.state.hp-=received;if(this.state.hp<=0){this.state.hp=d.maxHp;this.state.zeni=Math.max(0,this.state.zeni-Math.ceil(this.state.zeni*.02));this.push('Você foi derrotado e voltou ao treinamento.');this.spawn();}}
 reward(e){this.state.xp+=e.xp;this.state.zeni+=e.zeni;this.state.stats.kills++;for(const drop of e.drops||[])if(Math.random()<drop.chance){this.state.inventory[drop.itemId]=(this.state.inventory[drop.itemId]||0)+1;this.push(`Drop: ${items.find(i=>i.id===drop.itemId)?.name}`)}while(this.state.xp>=xpNeeded(this.state.level)){this.state.xp-=xpNeeded(this.state.level);this.state.level++;const d=this.derived();this.state.maxHp=d.maxHp;this.state.hp=d.maxHp;this.push(`Nível ${this.state.level} alcançado!`);}}
 equip(itemId){const item=items.find(i=>i.id===itemId);if(!item||item.slot==='consumable'||!this.state.inventory[itemId])return;this.state.equipment[item.slot]=itemId;this.save();this.emit();}
 use(itemId){const item=items.find(i=>i.id===itemId);if(item?.heal&&this.state.inventory[itemId]>0){this.state.inventory[itemId]--;this.state.hp=Math.min(this.state.maxHp,this.state.hp+item.heal);this.save();this.emit();}}
 applyOffline(){if(!this.character)return;const s=Math.min(8*3600,Math.max(0,(Date.now()-(this.state.savedAt||Date.now()))/1000));if(s>30){const before={xp:this.state.xp,zeni:this.state.zeni,kills:this.state.stats.kills};this.tick(Math.min(s,3600));this.push(`Progresso offline: +${this.state.zeni-before.zeni} zenis, ${this.state.stats.kills-before.kills} vitórias.`)}}
 push(m){this.state.log.unshift(m);this.state.log=this.state.log.slice(0,8)} save(){this.state.savedAt=Date.now();localStorage.setItem(SAVE_KEY,JSON.stringify(this.state))} load(){try{return JSON.parse(localStorage.getItem(SAVE_KEY))}catch{return null}} reset(){localStorage.removeItem(SAVE_KEY);location.reload()} on(fn){this.listeners.push(fn)} emit(){this.listeners.forEach(fn=>fn(this.state))}
}
export {xpNeeded,characters,zones,items};
