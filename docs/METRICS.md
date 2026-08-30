# Métricas reais de produção

Números medidos na VPS de produção em 30 de agosto de 2026, com o sistema no ar, ao final do piloto de 15 dias. Nenhum valor é estimativa: todos vêm do processo em execução, dos logs do Nginx e do próprio banco.

## Operação

| Infraestrutura | |
|---|---:|
| Sistema | Ubuntu 24.04 LTS · Node 22.23 · Nginx 1.24 · PostgreSQL 16.15 |
| Uptime da máquina | 15 dias |
| Memória do processo Node | 76 MB |
| Heap em uso | 7,6 MB de 13,9 MB alocados |
| Reinícios do processo | 32 |
| Tamanho do banco | 10 MB |

| Tráfego atendido | |
|---|---:|
| Requisições HTTP | 64.417 |
| Conexões WebSocket estabelecidas (HTTP 101) | 163 |
| Tempo de resposta — mediana | 58 ms |
| Tempo de resposta — mínimo / máximo | 42 ms / 195 ms |
| Respostas servidas do cache (HTTP 304) | 12.257 |

## Estrutura de dados

Esquema completo em [`SCHEMA.sql`](SCHEMA.sql) — apenas estrutura, sem nenhum dado de jogador.

| | |
|---|---:|
| Tabelas | 20 |
| Colunas | 223 |
| Chaves estrangeiras | 33 |
| Constraints CHECK | 42 |
| Índices explícitos | 25 |
| Colunas `jsonb` | 11 |
| Blocos `BEGIN … COMMIT` no módulo de persistência | 37 |

Os números acima vêm do arquivo publicado, que é o `pg_dump` do banco de produção — estrutura completa, zero linha de dado (nenhum `INSERT`, nenhum `COPY`).

As migrações não viviam num diretório de versões: elas eram aplicadas pelo próprio backend na subida, de forma idempotente, no padrão `DO $$ BEGIN ALTER TABLE ... EXCEPTION WHEN duplicate_object THEN NULL; END $$`. Isso deixava o deploy seguro para repetir — subir a mesma versão duas vezes não quebrava o banco — ao custo de não ter um histórico de migrações separado, que é o que eu faria diferente hoje.

## Segurança e operação real

O servidor ficou exposto na internet pública e recebeu tráfego hostil automatizado desde o primeiro dia: a rota mais requisitada de toda a operação foi `/wp-admin/install.php` (4.371 tentativas), de varredores procurando instalações WordPress. O firewall manteve apenas as portas 22, 80 e 443 abertas, com o PostgreSQL restrito a `localhost`, e a aplicação registrou **576 eventos de segurança** e **540 registros de conexão** em tabelas próprias de auditoria.

Comportamentos que o piloto exercitou em produção, não em teste:

- **Autoridade do servidor rejeitando estado inválido do cliente** — cinco tentativas de regressão de nível foram detectadas e bloqueadas pelo módulo de autoridade, em vez de aceitas e persistidas.
- **Recusa de pagamento antes do provedor** — um cartão pré-pago foi bloqueado pela validação local por ausência de Device ID, sem chegar a consumir chamada externa.
- **Reconciliação de webhook** — um webhook do Mercado Pago referenciou um pagamento inexistente e foi tratado como falha de reconciliação, sem corromper o estado.
- **Falha de configuração detectada em runtime** — o envio de códigos por e-mail falhou com mensagem explícita de SMTP não configurado, em vez de falhar em silêncio.

## Contexto do piloto

O ambiente público funcionou como piloto fechado por 15 dias, sem divulgação: apenas amigos convidados testaram. A integração de pagamentos ficou homologada em ambiente de testes e **nenhum pagamento real foi processado** — os casos de recusa e reconciliação acima vêm dessa homologação e do tráfego do piloto.

Veja também [Arquitetura](ARCHITECTURE.md) e [Decisões técnicas](TECHNICAL-DECISIONS.md).
