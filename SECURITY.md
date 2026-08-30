# Segurança

Este repositório contém somente documentação e trechos selecionados de código. O ambiente de produção, o banco e as credenciais não são distribuídos.

## Conteúdo que nunca deve ser enviado

- arquivos `.env` ou configurações privadas;
- dumps PostgreSQL, backups e logs;
- tokens, chaves de API, certificados ou chaves SSH;
- credenciais de Mercado Pago, SMTP ou armazenamento;
- dados de contas, personagens ou pagamentos;
- configurações completas da VPS.

O `.gitignore` cobre essas categorias, mas ele não substitui a revisão do conteúdo antes de cada commit.

## Antes de tornar o repositório público

1. Revisar `git status` e `git diff --cached`.
2. Confirmar que somente documentação, mídia aprovada e código selecionado foram adicionados.
3. Executar uma varredura de segredos em todo o histórico.
4. Revogar ou rotacionar as credenciais utilizadas no ambiente encerrado.
5. Manter o dump do banco apenas em armazenamento privado.

## Relato de problema

Caso seja identificada alguma informação sensível, utilize o recurso privado de relato de vulnerabilidade do GitHub. Não abra uma issue pública contendo o valor encontrado.
