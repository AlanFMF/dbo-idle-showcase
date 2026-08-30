# Trechos selecionados do código

Esta pasta contém uma seleção da versão implantada em produção. O objetivo é permitir avaliação técnica sem distribuir o jogo completo.

## O que está incluído

- motores centrais do frontend em JavaScript;
- cliente WebSocket e módulos de renderização;
- API Node.js e autoridade do servidor;
- persistência PostgreSQL e regras transacionais;
- pagamentos, e-mail e PvP;
- editor e utilitários relevantes.

## O que foi omitido

- sprites, imagens, sons, mapas e catálogos;
- módulos de conteúdo e dados gerados;
- credenciais, banco e configurações da VPS;
- contas mock e dados de demonstração;
- arquivos necessários para reconstruir uma versão executável.

Algumas importações permanecem apontando para módulos omitidos. Isso é intencional: o código preserva o contexto de produção, mas funciona como leitura arquitetural, não como pacote instalável.

Consulte os guias específicos de [frontend](frontend/README.md) e [backend](backend/README.md).
