# Frontend selecionado

O frontend original utiliza HTML, CSS, JavaScript ES Modules e renderização especializada para sprites e mapas.

Os arquivos desta seleção vieram da árvore implantada em `/play/src`. Recursos binários e módulos de dados foram excluídos.

Pontos recomendados para leitura:

- `src/core/network/socket-client.js` — conexão, autenticação e mensagens;
- `src/core/hunt/hunt-engine.js` — loop e regras de hunt;
- `src/core/transformations/transformation-engine.js` — rotas e progressão;
- `src/core/inventory/containers.js` — containers e organização de itens;
- `src/core/equipment/equipment.js` — slots, validação e atributos;
- `src/core/balance/absolute-balance-engine.js` — fórmulas e multiplicadores;
- `src/core/render/` — movimento, auras e processamento visual;
- `src/editor/map-editor.js` — ferramenta interna de edição.

A pasta `landing/` preserva apenas HTML, CSS e JavaScript da página pública. As imagens referenciadas não são distribuídas.
