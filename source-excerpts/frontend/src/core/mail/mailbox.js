export function normalizeMailbox(value=[],now=Date.now()){
  const rows=Array.isArray(value)?value:[];
  const seen=new Set();
  return rows.filter(row=>{
    const id=String(row?.id||'');
    if(!id||seen.has(id))return false;
    seen.add(id);
    const expiresAt=Math.max(0,Number(row?.expiresAt||0));
    return !expiresAt||expiresAt>now;
  }).map(row=>({
    id:String(row.id),
    kind:['boost','gift','announcement'].includes(String(row.kind))?String(row.kind):'announcement',
    title:String(row.title||'Dragon Mail').slice(0,80),
    body:String(row.body||'').slice(0,500),
    createdAt:Math.max(0,Number(row.createdAt||now)),
    expiresAt:Math.max(0,Number(row.expiresAt||0)),
    attachment:row.attachment&&typeof row.attachment==='object'?structuredClone(row.attachment):null
  })).sort((a,b)=>b.createdAt-a.createdAt);
}

export function ensureMailbox(profile={}){
  profile.mailbox=normalizeMailbox(profile.mailbox||[]);
  return profile.mailbox;
}

export function createMail({id='',kind='announcement',title='Dragon Mail',body='',expiresAt=0,attachment=null,createdAt=Date.now()}={}){
  const mail={
    id:String(id||`mail-${createdAt}-${Math.random().toString(16).slice(2)}`),
    kind:['boost','gift','announcement'].includes(String(kind))?String(kind):'announcement',
    title:String(title||'Dragon Mail').slice(0,80),
    body:String(body||'').slice(0,500),
    createdAt:Math.max(0,Number(createdAt||Date.now())),
    expiresAt:Math.max(0,Number(expiresAt||0)),
    attachment:attachment&&typeof attachment==='object'?structuredClone(attachment):null
  };
  return mail;
}

export function addMail(profile={},mail={}){
  const mailbox=ensureMailbox(profile);
  const normalized=createMail(mail);
  const index=mailbox.findIndex(row=>String(row.id)===String(normalized.id));
  if(index>=0)mailbox[index]=normalized;else mailbox.unshift(normalized);
  profile.mailbox=normalizeMailbox(mailbox);
  return normalized;
}

export function removeMail(profile={},mailId=''){
  const id=String(mailId||'');
  const mailbox=ensureMailbox(profile);
  const index=mailbox.findIndex(row=>String(row.id)===id);
  if(index<0)return null;
  const [removed]=mailbox.splice(index,1);
  profile.mailbox=mailbox;
  return removed;
}

export function mailRemainingLabel(mail={},now=Date.now()){
  const expiresAt=Math.max(0,Number(mail?.expiresAt||0));
  if(!expiresAt)return 'Sem prazo para resgate';
  const ms=Math.max(0,expiresAt-now);
  const days=Math.floor(ms/86400000),hours=Math.floor((ms%86400000)/3600000),mins=Math.floor((ms%3600000)/60000);
  if(days>0)return `${days}d ${hours}h restantes`;
  if(hours>0)return `${hours}h ${mins}m restantes`;
  return `${Math.max(1,mins)}m restantes`;
}
