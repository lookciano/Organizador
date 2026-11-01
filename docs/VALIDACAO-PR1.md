# Validação do PR #1

O PR adiciona busca textual e tarefas por projeto. A migração cria apenas `second_brain_tasks`; não há migração destrutiva nem extração de tarefas por IA nesta etapa.

## Correções e evidências

- Prazos rejeitam datas inexistentes, valores de tipo incorreto e sufixos que antes eram truncados.
- A interface evita duplicação por duplo envio, descarta buscas antigas e reinicia o formulário ao trocar de projeto.
- Dependências com alertas foram atualizadas, incluindo Nodemailer. A composição de convites foi validada sem envio externo; SMTP real ainda exige homologação.
- `npm run check`, `npm run build`, 33 testes existentes, quatro testes de interface e 18 cenários de integração passaram no macOS com Node 22 e TiDB 8.5.3.
- A auditoria npm não apontou vulnerabilidades no momento da validação.
- A integração verifica migração, repetição da inicialização, login/logout, isolamento entre projetos, entradas inválidas, preservação dos registros e inicialização da versão anterior com a nova tabela presente.
- O snapshot foi recuperado em TiDB local descartável, com autorização do responsável. As quantidades de linhas inseridas e recuperadas coincidiram. As impressões digitais de todos os registros antigos permaneceram iguais após a migração, uma segunda inicialização e a inicialização do banco pela versão anterior. Nenhum dado do backup acompanha este repositório.

## Reproduzir com dados sintéticos

Requisitos: Node 22, Docker, OpenSSL, Bash e histórico Git incluindo a versão-base `17ce042768bd21c8adb55bbf114a4f9981de5b0f`.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:ui
npm run build
npm audit --audit-level=moderate
npm run test:local-tidb
```

O último comando cria um TiDB temporário, com imagem fixada por digest, porta aleatória vinculada a 127.0.0.1 e TLS verificado. Usa somente dados sintéticos e remove seu contêiner ao terminar. Não forneça credenciais de produção. `test:integration` sozinho é ignorado se a URL do banco de teste não estiver configurada; a execução completa deve usar `test:local-tidb`.

O workflow `Validate application` executa esses comandos nos eventos de PR, sem etapa de publicação. O teste de interface usa DOM simulado: não substitui a aceitação visual em navegador.

## Condições para a publicação

1. Confirmar que o workflow passou no commit final e revisar o diff.
2. Em homologação isolada, verificar a apresentação em navegador, login, alternância de projetos, busca e criação/alteração de tarefas. Validar as configurações reais de SMTP, IA, origem da aplicação e conexão TLS sem compartilhar segredos.
3. Antes da publicação, obter um snapshot recente se houver novos dados desde a cópia validada, conferir a configuração de bootstrap e registrar o commit de produção e as configurações para reversão.
4. Obter autorização explícita para merge e deploy. Na consulta realizada em 2026-11-01, o Render seguia `main` com deploy automático e previews de PR desligados. Portanto, mesclar em `main` pode iniciar a publicação automaticamente. Reconfirmar a configuração antes da liberação.
5. Depois de uma publicação autorizada, verificar `/health` e os fluxos principais. Se houver regressão, reimplantar a versão anterior registrada, mantendo a tabela de tarefas. O ensaio local confirmou compatibilidade do banco com essa reversão; não apagar a tabela nem restaurar um snapshot antigo sobre dados novos como procedimento automático.

## Limites

Não foi feito merge, deploy, restauração no TiDB Cloud, envio real de e-mail nem chamada externa de IA. A recuperação local comprova a legibilidade do snapshot e a preservação dos registros no ensaio; não mede desempenho ou disponibilidade do ambiente de produção. Credenciais, arquivos SQL, hashes de registros e dados pessoais não devem ser incluídos no PR ou no workflow.
