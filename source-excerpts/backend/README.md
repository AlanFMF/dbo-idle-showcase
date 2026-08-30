# Backend selecionado

O backend original utiliza Node.js, PostgreSQL, WebSocket e SMTP.

Pontos recomendados para leitura:

- `src/api.js` — roteamento HTTP e webhooks;
- `src/database.js` — esquema, persistência e transações de domínio;
- `src/server.js` — inicialização HTTP/WebSocket e orquestração;
- `src/server-authority.js` — validação autoritativa de gameplay;
- `src/pvp.js` — ciclo de duelos em tempo real;
- `src/payments.js` — criação, consulta e reconciliação de pagamentos;
- `src/env.js` — carregamento e diagnóstico seguro de configuração;
- `src/email.js` — transporte e mensagens transacionais.

Este diretório não contém o banco, `.env`, mapas ou módulos privados necessários para iniciar o servidor completo. O arquivo `.env.example` na raiz contém apenas placeholders.
