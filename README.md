# DBO IDLE

Estudo de caso full stack de um RPG idle multiplayer desenvolvido para navegador.

O projeto reuniu frontend em JavaScript, backend Node.js, comunicaÃ§Ã£o em tempo real com WebSocket, persistÃªncia em PostgreSQL, pagamentos com Mercado Pago e operaÃ§Ã£o em uma VPS Linux. Esta versÃ£o pÃºblica foi preparada exclusivamente para portfÃ³lio e contÃ©m documentaÃ§Ã£o e trechos selecionados do cÃ³digo de produÃ§Ã£o.

> Snapshot tÃ©cnico preservado em 30 de agosto de 2026: servidor `21.26.4` e cliente `22.4.4`.

| Recorte pÃºblico | Resultado |
|---|---:|
| Linhas de cÃ³digo selecionadas | 22.412 |
| Arquivos de cÃ³digo de produÃ§Ã£o | 56 |
| MÃ³dulos frontend demonstrados | 41 |
| MÃ³dulos JavaScript do backend | 13 |

## DemonstraÃ§Ã£o visual

[![Assistir Ã  demonstraÃ§Ã£o tÃ©cnica do DBO IDLE](docs/media/01-home.webp)](docs/media/DBO-IDLE-demonstracao-tecnica.mp4)

â–¶ï¸ **[Assistir ao vÃ­deo de demonstraÃ§Ã£o](docs/media/DBO-IDLE-demonstracao-tecnica.mp4)** â€” 1 minuto e 5 segundos, Full HD, sem Ã¡udio.

| Gameplay e hunts | TransformaÃ§Ãµes |
|---|---|
| ![Combate em uma hunt](docs/media/03-hunt.webp) | ![ProgressÃ£o de transformaÃ§Ãµes](docs/media/04-transformation.webp) |

| Mercado global | BestiÃ¡rio |
|---|---|
| ![Mercado entre jogadores](docs/media/05-market.webp) | ![BestiÃ¡rio e progressÃ£o permanente](docs/media/09-bestiary.webp) |

| Guildas | Wiki integrada |
|---|---|
| ![Sistema de guildas](docs/media/06-guild.webp) | ![Wiki do jogo](docs/media/08-wiki.webp) |

## Minha atuaÃ§Ã£o

Atuei no planejamento, desenvolvimento, integraÃ§Ã£o, implantaÃ§Ã£o e evoluÃ§Ã£o contÃ­nua do produto, incluindo:

- desenvolvimento da interface e dos motores de gameplay;
- criaÃ§Ã£o da API, autenticaÃ§Ã£o, persistÃªncia e comunicaÃ§Ã£o WebSocket;
- modelagem e manutenÃ§Ã£o do banco PostgreSQL;
- integraÃ§Ã£o de PIX e cartÃ£o com Mercado Pago;
- administraÃ§Ã£o de VPS Ubuntu com Nginx, PM2, SSL, firewall e backups;
- balanceamento de progressÃ£o, economia, equipamentos e recompensas;
- manutenÃ§Ã£o da Wiki, experiÃªncia do usuÃ¡rio e processo de publicaÃ§Ã£o.

## Arquitetura

```mermaid
flowchart TB
    Browser["Navegador"] --> Edge["Nginx e HTTPS"]
    Edge --> Frontend["Frontend estÃ¡tico"]
    Edge --> Backend["Node.js API e WebSocket"]
    Backend --> Database[("PostgreSQL")]
    Backend --> Integrations["Mercado Pago e SMTP"]
```

| Camada | Tecnologias | Responsabilidade |
|---|---|---|
| Interface | HTML, CSS e JavaScript ES Modules | RenderizaÃ§Ã£o, interaÃ§Ã£o e motores do cliente |
| Tempo real | WebSocket | Estado online, party, PvP e eventos de gameplay |
| Backend | Node.js | API, autenticaÃ§Ã£o e autoridade do servidor |
| Dados | PostgreSQL | Contas, personagens, mercado, guildas e pagamentos |
| Infraestrutura | Ubuntu, Nginx e PM2 | HTTPS, proxy reverso e operaÃ§Ã£o do processo |
| IntegraÃ§Ãµes | Mercado Pago e SMTP | Pagamentos, webhooks e verificaÃ§Ã£o por e-mail |

Mais detalhes em [Arquitetura](docs/ARCHITECTURE.md).

## Sistemas implementados

- contas, sessÃµes, verificaÃ§Ã£o de e-mail e recuperaÃ§Ã£o de senha;
- criaÃ§Ã£o de personagens, vocaÃ§Ãµes, transformaÃ§Ãµes e reborn;
- hunts, monstros, bosses, magias e progressÃ£o offline;
- inventÃ¡rio, containers, equipamentos, raridade e auto-loot;
- bestiÃ¡rio, quests, treinamento e passe de batalha;
- party, PvP, guildas, rankings e bosses de guilda;
- market entre jogadores, moedas e economia virtual;
- mailbox para comunicados, presentes e recompensas;
- pagamentos com reconciliaÃ§Ã£o e validaÃ§Ã£o de webhook;
- Wiki e ferramentas internas de ediÃ§Ã£o e auditoria.

Consulte o [mapa de funcionalidades](docs/FEATURES.md) para relacionar cada Ã¡rea aos mÃ³dulos demonstrativos.

## Onde comeÃ§ar a leitura do cÃ³digo

| Tema | Arquivo |
|---|---|
| Autoridade de gameplay | [server-authority.js](source-excerpts/backend/src/server-authority.js) |
| PersistÃªncia e regras transacionais | [database.js](source-excerpts/backend/src/database.js) |
| API e webhooks | [api.js](source-excerpts/backend/src/api.js) |
| Pagamentos | [payments.js](source-excerpts/backend/src/payments.js) |
| PvP em tempo real | [pvp.js](source-excerpts/backend/src/pvp.js) |
| Cliente WebSocket | [socket-client.js](source-excerpts/frontend/src/core/network/socket-client.js) |
| Motor de hunts | [hunt-engine.js](source-excerpts/frontend/src/core/hunt/hunt-engine.js) |
| TransformaÃ§Ãµes | [transformation-engine.js](source-excerpts/frontend/src/core/transformations/transformation-engine.js) |
| InventÃ¡rio e containers | [containers.js](source-excerpts/frontend/src/core/inventory/containers.js) |
| Balanceamento | [absolute-balance-engine.js](source-excerpts/frontend/src/core/balance/absolute-balance-engine.js) |

## Escopo deste repositÃ³rio

Este Ã© um repositÃ³rio de demonstraÃ§Ã£o tÃ©cnica, nÃ£o uma distribuiÃ§Ã£o executÃ¡vel do jogo. Foram deliberadamente excluÃ­dos:

- credenciais, arquivos `.env` e configuraÃ§Ãµes de produÃ§Ã£o;
- banco de dados, contas, personagens, logs e informaÃ§Ãµes de jogadores;
- sprites, mapas, sons, clientes e outros recursos de terceiros;
- catÃ¡logos gerados, backups, arquivos de implantaÃ§Ã£o e cÃ³digo duplicado;
- regras de conteÃºdo necessÃ¡rias para reconstruir o jogo completo.

Os trechos em [`source-excerpts`](source-excerpts/README.md) preservam a estrutura e o estilo do cÃ³digo implantado, mas algumas importaÃ§Ãµes apontam para conteÃºdos omitidos por seguranÃ§a e propriedade intelectual.

## DocumentaÃ§Ã£o

- [Arquitetura](docs/ARCHITECTURE.md)
- [Funcionalidades e mÃ³dulos](docs/FEATURES.md)
- [DecisÃµes tÃ©cnicas e trade-offs](docs/TECHNICAL-DECISIONS.md)
- [RelatÃ³rio de preparaÃ§Ã£o pÃºblica](docs/AUDIT-REPORT.md)
- [Roteiro para screenshots e vÃ­deo](docs/SCREENSHOTS.md)
- [SeguranÃ§a](SECURITY.md)
- [Avisos de propriedade intelectual](NOTICE.md)

## Status

O ambiente de produÃ§Ã£o estÃ¡ em processo de encerramento. A versÃ£o final, o banco e as configuraÃ§Ãµes foram preservados em backup privado com verificaÃ§Ã£o SHA-256. Este repositÃ³rio permanece como registro tÃ©cnico do projeto.

## Aviso

Projeto independente, criado para fins educacionais e de portfÃ³lio, sem vÃ­nculo oficial com as franquias que serviram como inspiraÃ§Ã£o. Marcas, personagens e recursos de terceiros pertencem aos respectivos titulares e nÃ£o sÃ£o distribuÃ­dos neste repositÃ³rio.
