# Organizador Grande Sertão

[![Publicar no Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/lookciano/Organizador)

Aplicação web para reunir informações de projetos, acompanhar assuntos e gerar visões por responsável, fornecedor e categoria. O modelo inicial de categorias veio dos títulos e subtítulos do relatório Grande Sertão e pode ser alterado separadamente em cada projeto.

## O que o MVP faz

- Cria projetos com estrutura inicial ou em branco.
- Permite adicionar, renomear e arquivar categorias sem apagar assuntos já registrados.
- Recebe texto, transcrições, PDF, DOCX, TXT, Markdown e imagens PNG/JPEG/WebP de até 5 MB.
- Usa a API da OpenAI para extrair assuntos, prazos, responsáveis, fornecedores e evidências, ligando atualizações aos assuntos já conhecidos quando houver correspondência clara.
- Mantém fonte original, histórico por assunto, atualização manual e relatórios imprimíveis.
- Convida participantes por e-mail para um projeto específico. A entrega automática usa SMTP; sem SMTP, a interface disponibiliza um link de convite para o administrador enviar manualmente.

## Arquitetura

- Frontend: React e Vite.
- Serviço web: Node.js e Express no Render.
- Dados estruturados, sessões e arquivos pequenos: TiDB Cloud via `mysql2` com TLS verificado.
- Análise multimodal: Responses API da OpenAI. O texto das fontes é tratado como dado, não como instrução.
- Acesso: login por e-mail e senha, sessões `HttpOnly`, participação por projeto e convites com token de uso único que expiram em 7 dias.

## Configuração

1. Crie uma instância TiDB Cloud e copie a URL MySQL da conexão TLS para `DATABASE_URL`.
2. No Render, conecte este repositório como **Web Service**. O arquivo `render.yaml` contém build, start e variáveis necessárias.
3. Configure as variáveis sensíveis no painel do Render: `DATABASE_URL`, `BOOTSTRAP_EMAIL`, `BOOTSTRAP_PASSWORD`, `OPENAI_API_KEY`, `APP_ORIGIN`, `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD` e `SMTP_FROM`. `BOOTSTRAP_PASSWORD` deve ter pelo menos 12 caracteres. `APP_ORIGIN` deve ser a URL HTTPS do serviço, sem barra final.
4. O serviço cria as tabelas e a primeira conta no início. Entre com `BOOTSTRAP_EMAIL` e `BOOTSTRAP_PASSWORD`, crie o projeto e escolha o modelo Grande Sertão.
5. Convide colaboradores pela área **Pessoas**. Eles poderão criar a própria senha pelo link recebido.

As variáveis estão exemplificadas em `.env.example`; nunca inclua valores reais no GitHub. O arquivo `render.yaml` usa o plano gratuito para evitar contratação automática de um plano pago.

## Desenvolvimento local

Use Node.js 20 ou superior. Preencha uma cópia local de `.env.example` em `.env` ou exporte as variáveis no terminal. Em seguida:

```bash
npm ci
npm run build
npm start
```

O servidor escuta `0.0.0.0:${PORT}` e oferece `/health` para verificação. Para editar o frontend com recarga automática, rode `npm run dev` em outro terminal; o Vite encaminha `/api` para a porta 10000.

## Limites desta primeira versão

Os arquivos são armazenados no TiDB Cloud junto aos dados do projeto, com limite de 5 MB por envio. A matriz de comunicação mostra interlocutores e assuntos citados; canal e frequência devem ser definidos pelo grupo. A análise automática requer `OPENAI_API_KEY`; informações continuam sendo registradas e podem ser reprocessadas depois de configurar a chave.
