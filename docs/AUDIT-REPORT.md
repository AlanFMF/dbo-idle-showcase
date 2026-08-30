# Relatório de preparação pública

## Fonte analisada

- frontend de produção: 80.429 entradas, aproximadamente 706 MB após extração;
- backend de produção: 29 entradas, aproximadamente 1,2 MB após extração;
- versão do servidor: `21.26.4`;
- client build informado pela API: `22.4.4`;
- snapshot: 30 de agosto de 2026.

Hashes dos arquivos recebidos para preparação:

```text
c35d611c2055add2686b7a11a2580bc64b59ada18572e021d91b5227b77ff0c8  frontend-current.tar.gz
25d9845392837a2131b0689854f1a2652363d114252939a54040f4561db148bb  backend-current.tar.gz
```

## Verificações executadas

- teste completo de integridade dos dois arquivos compactados;
- validação contra caminhos absolutos e travessia por `..`;
- confirmação de ausência de links simbólicos nos pacotes;
- inventário por diretório, extensão e tamanho;
- busca por nomes de arquivos sensíveis;
- busca heurística por tokens, chaves privadas e credenciais de alta confiança;
- revisão de referências a variáveis de ambiente;
- validação sintática dos arquivos JavaScript selecionados;
- exclusão de dados, assets e cópias duplicadas.

Nenhum token de produção, chave privada ou arquivo `.env` foi localizado nos dois pacotes de código. Os arquivos privados foram corretamente preservados em backup separado.

## Conteúdo removido da seleção pública

- 66 mil+ imagens e sprites duplicados entre raiz e `/play`;
- mapas, registros e catálogos gerados;
- código de contas mock com credenciais de demonstração;
- módulos de dados com conteúdo específico do jogo;
- backups antigos e arquivos compactados;
- banco de dados e configurações operacionais;
- todos os recursos binários de terceiros.

## Conteúdo preservado

Foram selecionados 56 arquivos de código de produção, totalizando 22.412 linhas em HTML, CSS e JavaScript. O recorte cobre motores do frontend, API, persistência, pagamentos, PvP, autoridade do servidor e ferramentas de desenvolvimento.

## Limitação

A busca de segredos combina regras heurísticas e revisão direcionada; nenhuma varredura garante risco zero. Antes de tornar o repositório público, todas as credenciais do ambiente encerrado devem ser revogadas ou rotacionadas e o histórico Git deve ser verificado novamente.
