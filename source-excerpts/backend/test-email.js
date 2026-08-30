import { verifyEmailTransport, sendTestEmail, emailConfigSummary } from '../src/email.js';

const send=process.argv.includes('--send');
try{
  const summary=emailConfigSummary();
  console.log(`[SMTP] host=${summary.host}:${summary.port} secure=${summary.secure} user=${summary.user} from=${summary.fromEmail}`);
  const info=await verifyEmailTransport();
  console.log(`[OK] Autenticacao SMTP aceita: ${info.host}:${info.port}`);
  if(send){
    const sent=await sendTestEmail();
    console.log(`[OK] E-mail de teste aceito para entrega em ${sent.recipient}`);
    if(sent.messageId) console.log(`[OK] Message-ID: ${sent.messageId}`);
    if(sent.response) console.log(`[SMTP] ${sent.response}`);
  }
  process.exit(0);
}catch(error){
  console.error('[ERRO] SMTP:',error?.message||error);
  if(error?.code) console.error('[ERRO] Codigo:',error.code);
  if(error?.response) console.error('[ERRO] Resposta SMTP:',error.response);
  process.exit(1);
}
