import fs from 'node:fs';
import nodemailer from 'nodemailer';
import { resolvePrivateConfig } from './config-paths.js';

const configPath=resolvePrivateConfig('email.local.json');
let transporter=null;
let cachedConfig=null;

function loadEmailConfig(){
  let fileConfig={};
  if(fs.existsSync(configPath)){
    try{fileConfig=JSON.parse(fs.readFileSync(configPath,'utf8').replace(/^\uFEFF/,''))}
    catch(error){throw new Error(`Config SMTP invalida em ${configPath}: ${error.message}`)}
  }
  const config={
    host:process.env.SMTP_HOST||fileConfig.host||'',
    port:Number(process.env.SMTP_PORT||fileConfig.port||587),
    secure:String(process.env.SMTP_SECURE??fileConfig.secure??'false').toLowerCase()==='true',
    user:process.env.SMTP_USER||fileConfig.user||'',
    password:process.env.SMTP_PASSWORD||fileConfig.password||'',
    fromName:process.env.SMTP_FROM_NAME||fileConfig.fromName||'DBO IDLE',
    fromEmail:process.env.SMTP_FROM_EMAIL||fileConfig.fromEmail||fileConfig.user||''
  };
  return config;
}

function smtpTransport(){
  const config=loadEmailConfig();
  if(!config.host||!config.port||!config.user||!config.password||!config.fromEmail){
    throw new Error('SMTP nao configurado. Execute CONFIGURAR-EMAIL.bat antes de liberar novos cadastros.');
  }
  const signature=JSON.stringify(config);
  if(!transporter||cachedConfig!==signature){
    transporter=nodemailer.createTransport({
      host:config.host,
      port:config.port,
      secure:config.secure,
      auth:{user:config.user,pass:config.password},
      requireTLS:!config.secure,
      connectionTimeout:10_000,
      greetingTimeout:10_000,
      socketTimeout:15_000
    });
    cachedConfig=signature;
  }
  return {transporter,config};
}

export async function verifyEmailTransport(){
  const {transporter,config}=smtpTransport();
  await transporter.verify();
  return {host:config.host,port:config.port,secure:config.secure,fromEmail:config.fromEmail};
}


export function emailConfigSummary(){
  const config=loadEmailConfig();
  return {
    configured:Boolean(config.host&&config.port&&config.user&&config.password&&config.fromEmail),
    host:config.host,port:config.port,secure:config.secure,user:config.user,fromEmail:config.fromEmail,fromName:config.fromName
  };
}

export async function sendTestEmail(toEmail=''){
  const {transporter,config}=smtpTransport();
  const recipient=String(toEmail||config.fromEmail).trim().toLowerCase();
  if(!recipient) throw new Error('Destinatario de teste nao informado.');
  const info=await transporter.sendMail({
    from:{name:config.fromName,address:config.fromEmail},
    to:recipient,
    subject:'DBO IDLE - Teste de envio SMTP',
    text:[
      'DBO IDLE',
      '',
      'Este e um e-mail de teste do servidor.',
      'Se voce recebeu esta mensagem, o envio SMTP esta funcionando.',
      '',
      `Remetente configurado: ${config.fromEmail}`
    ].join('\n'),
    html:`<!doctype html><html><body style="font-family:Arial,sans-serif;background:#111;color:#eee;padding:24px"><div style="max-width:520px;margin:auto;background:#1d1d1d;border-radius:12px;padding:28px"><h2 style="margin-top:0">DBO IDLE</h2><p><strong>Teste de envio concluido.</strong></p><p>Se voce recebeu esta mensagem, o SMTP do servidor esta funcionando.</p><p style="color:#aaa;font-size:13px">Remetente: ${config.fromEmail}</p></div></body></html>`
  });
  return {recipient,messageId:info.messageId||'',response:info.response||''};
}

export async function sendVerificationCode(email,code){
  const {transporter,config}=smtpTransport();
  const safeEmail=String(email).trim().toLowerCase();
  const safeCode=String(code).replace(/\D/g,'').slice(0,6);
  await transporter.sendMail({
    from:{name:config.fromName,address:config.fromEmail},
    to:safeEmail,
    subject:`${safeCode} - Codigo de verificacao DBO IDLE`,
    text:[
      'DBO IDLE',
      '',
      `Seu codigo de verificacao e: ${safeCode}`,
      '',
      'O codigo expira em 10 minutos.',
      'Se voce nao tentou criar uma conta, ignore esta mensagem.'
    ].join('\n'),
    html:`<!doctype html><html><body style="font-family:Arial,sans-serif;background:#111;color:#eee;padding:24px"><div style="max-width:520px;margin:auto;background:#1d1d1d;border-radius:12px;padding:28px"><h2 style="margin-top:0">DBO IDLE</h2><p>Use o codigo abaixo para confirmar seu e-mail:</p><div style="font-size:34px;font-weight:700;letter-spacing:8px;padding:18px 0">${safeCode}</div><p>Este codigo expira em <strong>10 minutos</strong>.</p><p style="color:#aaa;font-size:13px">Se voce nao tentou criar uma conta, ignore esta mensagem.</p></div></body></html>`
  });
}

export async function sendPasswordResetCode(email,code){
  const {transporter,config}=smtpTransport();
  const safeEmail=String(email).trim().toLowerCase();
  const safeCode=String(code).replace(/\D/g,'').slice(0,6);
  await transporter.sendMail({
    from:{name:config.fromName,address:config.fromEmail},
    to:safeEmail,
    subject:`${safeCode} - Recuperacao de senha DBO IDLE`,
    text:[
      'DBO IDLE',
      '',
      `Seu codigo para redefinir a senha e: ${safeCode}`,
      '',
      'O codigo expira em 10 minutos.',
      'Se voce nao solicitou a recuperacao de senha, ignore esta mensagem.'
    ].join('\n'),
    html:`<!doctype html><html><body style="font-family:Arial,sans-serif;background:#111;color:#eee;padding:24px"><div style="max-width:520px;margin:auto;background:#1d1d1d;border-radius:12px;padding:28px"><h2 style="margin-top:0">DBO IDLE</h2><p>Use o codigo abaixo para redefinir sua senha:</p><div style="font-size:34px;font-weight:700;letter-spacing:8px;padding:18px 0">${safeCode}</div><p>Este codigo expira em <strong>10 minutos</strong>.</p><p style="color:#aaa;font-size:13px">Se voce nao solicitou a recuperacao, ignore esta mensagem.</p></div></body></html>`
  });
}
