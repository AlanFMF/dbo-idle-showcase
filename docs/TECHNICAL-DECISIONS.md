# Decisões técnicas e trade-offs

## JavaScript modular no navegador

O cliente foi organizado em ES Modules sem framework de interface. Essa decisão reduziu dependências e permitiu controle direto sobre canvas, pixel art, eventos e ciclos de atualização.

**Trade-off:** conforme o produto cresceu, alguns pontos de composição ficaram grandes. Uma evolução natural seria separar a interface em componentes menores com contratos tipados.

## Backend autoritativo

Operações que alteram progressão, inventário, combate online, mercado, guildas e pagamentos são validadas no servidor. O cliente permanece responsável pela experiência visual, mas não é a fonte final para ações sensíveis.

**Benefício:** reduz manipulação do estado pelo navegador e centraliza regras críticas.

## WebSocket para estado online

WebSocket foi adotado para presença, party, PvP e eventos que exigem baixa latência. A API HTTP permanece adequada para cadastro, login e operações transacionais.

**Trade-off:** exige tratamento explícito de reconexão, autenticação, expiração e consistência entre memória e banco.

## PostgreSQL como fonte persistente

O banco concentra contas, sessões, personagens, economia, rankings, guildas, mercado e pagamentos. Operações financeiras e trocas utilizam validação transacional no backend.

**Evolução recomendada:** dividir o módulo de persistência por domínio e adicionar testes de integração executados em um banco descartável.

## Segredos fora do código

Credenciais de banco, e-mail e pagamentos são lidas de variáveis de ambiente. Diagnósticos utilizam presença, tamanho e fingerprint, sem registrar os valores completos.

## Infraestrutura direta

Nginx, PM2 e PostgreSQL foram usados diretamente na VPS. A solução foi simples de operar para o porte do projeto e permitiu compreender o ciclo completo de publicação.

**Evolução recomendada:** criar uma demonstração isolada com dados fictícios, testes automatizados, observabilidade estruturada e implantação reproduzível.
