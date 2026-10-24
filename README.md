# Organizador Grande Sertão

[![Publicar no Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/lookciano/Organizador)

Aplicação web para reunir informações de projetos, acompanhar assuntos e gerar visões por responsável, fornecedor e categoria. O modelo inicial de categorias veio dos títulos e subtítulos do relatório Grande Sertão e pode ser alterado separadamente em cada projeto.

## O que o MVP faz

- Cria projetos com estrutura inicial ou em branco.
- Abre diretamente no relatório vivo do projeto: uma página contínua com todas as seções e subtópicos da estrutura, inclusive os ainda sem registro. As sínteses ficam visíveis; cada seção oferece um botão discreto para mostrar ou ocultar os registros e fontes que a sustentam. O sumário serve para navegar pela página.
- Atualiza o relatório automaticamente a cada minuto enquanto a página está visível, com opção de atualizar na hora e imprimir ou salvar em PDF.
- Permite adicionar, renomear e arquivar categorias sem apagar assuntos já registrados.
- Em **Estrutura**, exporta a hierarquia como CSV para editar no Excel ou outra planilha e reimporta com prévia das mudanças. O ID de cada tópico existente deve permanecer na linha; para criar outro, use um código novo e deixe o ID vazio. Mover ou renomear um tópico mantém os assuntos e o histórico associados. A importação exige todas as linhas existentes e permite arquivar com `arquivado=1`.
- O item **Startup e Comissionamento → Startup das Subestações** vem dividido pelas subestações conhecidas do projeto. A mesma divisão é acrescentada uma única vez aos projetos existentes que ainda usam esse ramo do modelo.
- Recebe mensagens, transcrições, PDF, DOCX, TXT, Markdown e imagens PNG/JPEG/WebP de até 5 MB em uma conversa do projeto. Basta escrever ou anexar e enviar; o título é criado automaticamente. Arquivos de texto são lidos em partes para que um único documento possa atualizar vários assuntos em tópicos diferentes.
- Em **Contexto**, qualquer participante pode registrar informações permanentes do projeto em texto ou anexar PDF com texto, DOCX, TXT e Markdown. Cada acréscimo guarda data, autor e arquivo original; o responsável pelo projeto pode arquivar informações desatualizadas. A IA seleciona os trechos relevantes desse contexto ao classificar assuntos, interpretar arquivos e gerar sínteses. O contexto esclarece relações entre equipamentos, fabricantes, fornecedores, pessoas e locais, mas não conta como uma nova atualização de andamento.
- Usa a API do OpenRouter para extrair assuntos, prazos, responsáveis, fornecedores e evidências. A classificação considera o caminho completo de cada tópico, inclusive quando um mesmo local aparece em diferentes ramos. A API da OpenAI continua disponível como alternativa.
- Mantém fonte original e histórico por assunto. Ao abrir o histórico de uma seção, o relatório mostra a última atualização, sua data e todos os registros anteriores dos assuntos daquela seção e de seus subtópicos.
- Cada tópico com informações recebe uma síntese em pontos da IA baseada no histórico completo daquele tópico e de suas subseções. Há um ponto por assunto, com situação, responsáveis, fornecedores, prazos e pendências relevantes. Uma mudança comprovada pode ser destacada à parte, sem tratar repetições como novidade. A síntese é atualizada após novos registros, alterações manuais e mudanças na estrutura; o histórico permanece acessível para conferência.
- As versões geradas da síntese são guardadas. Na próxima atualização, a IA lê essas versões junto aos registros originais e ao estado atual; os registros prevalecem quando há divergência.
- Nas seções principais (1, 2, 3 etc.), a síntese geral reúne os assuntos por subestação e ordena os grupos pelas datas das últimas informações. Ações e responsáveis aparecem junto ao assunto; fatos sem subestação identificável ficam em **Informações gerais**. As sínteses dos subtópicos mantêm seu formato detalhado por assunto.
- Mostra o andamento da análise do anexo e quantos assuntos foram atualizados; documentos pendentes voltam à fila após uma reinicialização do serviço.
- Classifica registros manuais automaticamente quando o tópico fica em branco. Assuntos cuja categoria é duvidosa aparecem no relatório com uma pergunta simples para confirmação; também é possível tentar a classificação com IA novamente ou corrigir o tópico de um assunto já classificado.
- A tela **Organizar** permite revisar todos os assuntos ou somente os extraídos de uma mensagem/arquivo. Mostra os trechos que originaram cada assunto, permite corrigir títulos e tópicos em sequência e aplicar um tópico a vários itens selecionados antes de salvar. A Conversa oferece um atalho de revisão em cada fonte analisada.
- Títulos e tópicos corrigidos manualmente ficam protegidos contra mudanças de classificação em importações posteriores do mesmo assunto. O histórico da fonte é mantido e as sínteses dos tópicos são atualizadas após a correção.
- Permite atualizar assuntos manualmente e imprimir relatórios.
- Em **Matrizes e PDF → Últimas atualizações**, mostra os registros adicionados hoje ou nos últimos sete dias, com data, tópico, assunto, fonte e autor. O filtro de categoria inclui os subtópicos, e a visão pode ser impressa ou salva em PDF.
- Nas matrizes de responsabilidades e comunicação, **Analisar com contexto** consulta os assuntos e o contexto do projeto para sugerir responsáveis, fornecedores, contatos e ações, com trecho de apoio. Canal e frequência só são preenchidos quando definidos expressamente. A análise é mostrada para revisão, sem alterar os dados do projeto automaticamente.
- O responsável pelo projeto adiciona usuários em **Usuários**: informa o e-mail, copia o link de convite e o compartilha diretamente com a pessoa. Convites pendentes podem receber um novo link ou ser cancelados. O link anterior é invalidado ao renovar. Se SMTP estiver configurado, o convite inicial também pode ser enviado automaticamente por e-mail.

## Arquitetura

- Frontend: React e Vite.
- Serviço web: Node.js e Express no Render.
- Dados estruturados, sessões e arquivos pequenos: TiDB Cloud via `mysql2` com TLS verificado.
- Análise multimodal: Responses API do OpenRouter (ou da OpenAI como alternativa). O texto das fontes é tratado como dado, não como instrução.
- Acesso: login por e-mail e senha, sessões `HttpOnly`, participação por projeto e convites com token de uso único que expiram em 7 dias.

## Configuração

1. Crie uma instância TiDB Cloud e copie a URL MySQL da conexão TLS para `DATABASE_URL`.
   Se a URL apontar para um banco de sistema como `sys`, a aplicação criará e usará automaticamente o banco `organizador`.
2. No Render, conecte este repositório como **Web Service**. O arquivo `render.yaml` contém build, start e variáveis necessárias.
3. Configure no painel do Render `DATABASE_URL`, `BOOTSTRAP_EMAIL`, `BOOTSTRAP_PASSWORD`, `APP_ORIGIN` e `OPENROUTER_API_KEY`. Crie a chave em [OpenRouter Keys](https://openrouter.ai/keys) e salve-a apenas no Render. `OPENROUTER_MODEL` define o modelo; o padrão é `openai/gpt-4.1-mini`. Se preferir usar a OpenAI diretamente, configure `OPENAI_API_KEY` no lugar da chave OpenRouter. Quando as duas estiverem presentes, o OpenRouter tem prioridade. `BOOTSTRAP_PASSWORD` deve ter pelo menos 12 caracteres. `APP_ORIGIN` deve ser a URL HTTPS do serviço, sem barra final. As variáveis `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD` e `SMTP_FROM` são necessárias apenas para enviar convites automaticamente por e-mail.
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

O servidor escuta `0.0.0.0:${PORT}` e oferece `/health` para verificação. Para editar o frontend com recarga automática, rode `npm run dev` em outro terminal; o Vite encaminha `/api` para a porta 10000. No Relatório vivo, cada tópico aceita uma atualização escrita diretamente nele. O texto fica registrado como fonte, é analisado para atualizar os assuntos daquele tópico e entra no histórico e na síntese. A Conversa continua disponível para textos e arquivos que abrangem vários tópicos.

## Limites desta primeira versão

Os arquivos são armazenados no TiDB Cloud junto aos dados do projeto, com limite de 5 MB por envio. A extração de texto de PDF, DOCX, TXT e Markdown aceita até 180 mil caracteres e PDF com até 200 páginas por arquivo. PDFs sem texto selecionável e imagens podem ser enviados pela Conversa diretamente ao modelo para leitura; documentos adicionados ao Contexto precisam ter texto extraível. A qualidade da análise depende da legibilidade do arquivo e dos recursos do modelo configurado. A matriz de comunicação mostra interlocutores e assuntos citados; canal e frequência devem ser definidos pelo grupo. A análise automática requer `OPENROUTER_API_KEY` ou `OPENAI_API_KEY`; informações continuam sendo registradas e podem ser reprocessadas depois de configurar uma das chaves. O modelo escolhido deve aceitar os tipos de arquivo enviados e respostas estruturadas.
