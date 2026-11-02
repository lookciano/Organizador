# Projetos e lista única de tarefas

“+ Novo projeto” fica sempre disponível no seletor de projetos. A criação permite copiar a estrutura atual de qualquer projeto do qual o usuário participe, usar o modelo inicial Grande Sertão ou começar em branco. A cópia ocorre em uma transação: somente títulos, ordem e hierarquia dos tópicos ativos são reproduzidos, com novos IDs. Assuntos, arquivos, histórico, participantes, tarefas e vínculo de sala não são copiados. Guaporé pode começar pela estrutura de Grande Sertão e depois adaptá-la.

## Uma sala por projeto

A única tela Tarefas lê e modifica diretamente a lista da sala vinculada no Chatask. Não cria uma réplica local. O responsável pelo projeto escolhe uma sala à qual sua própria conta tenha acesso; uma sala não pode ser vinculada simultaneamente a dois projetos. Todos os usuários precisam conectar suas próprias contas e ter acesso à sala. O vínculo do projeto não concede acesso a ninguém no Chatask.

O código e a configuração do Chatask não precisam ser alterados. A integração usa apenas as rotas existentes de autenticação, salas, leitura de tarefas, extração de tarefa, edição de descrição e conclusão/reabertura. Não chama personalTasks, myTasks, allTasks, envio de mensagens ou exclusão. “Minhas tarefas” permanece exclusivamente no Chatask.

A tela atualiza a lista ao abrir, após operações e a cada minuto quando visível e sem edição em andamento. Há atualização manual. A criação usa o interpretador de texto do Chatask, que pode inferir responsável, prazo e prioridade; o resultado deve ser conferido. Não há edição direta desses três campos nas rotas existentes de tarefas de sala. Somente descrição e situação podem ser editadas. O ID real da tarefa é usado nas operações; o número por sala é somente apresentação.

## Conexão e proteção

A pessoa informa seu acesso ao Chatask no formulário do Organizador, que o encaminha exclusivamente ao endpoint HTTPS fixo do Chatask. A senha não é persistida. O token retornado nunca é enviado ao navegador: é cifrado com AES-256-GCM, chave derivada do segredo aleatório de 256 bits da sessão atual do Organizador, e identidade do usuário vinculada como dado autenticado. O banco armazena somente o hash da sessão e o token cifrado. A conexão não é compartilhada entre usuários ou sessões. Ao sair do Organizador ou desconectar, a credencial local é removida; uma nova sessão exige nova conexão. O token remoto não pode ser revogado pela integração porque o Chatask não fornece essa operação.

Todas as rotas do projeto exigem autenticação, participação e verificação de origem. Vincular sala exige proprietário do projeto e validação do acesso remoto. Uma edição valida que a tarefa pertence à sala e que updatedAt continua igual ao valor exibido. A comparação reduz sobrescritas acidentais, mas não equivale a uma atualização condicional atômica no Chatask, que ainda não possui essa operação.

Criações possuem uma identificação persistente de tentativa. Não há repetição automática de mutações. Se a resposta se perde, a interface informa que a criação pode ter ocorrido e pede conferência da lista antes de outra tentativa. Essa proteção evita repetições do mesmo pedido no Organizador; o Chatask não fornece idempotência transacional entre sistemas.

As tabelas adicionadas são chatask_connections, chatask_project_rooms e chatask_operations. Registros locais da versão anterior de Tarefas são preservados e contabilizados na tela, sem migração automática nem mistura com a lista do Chatask. Nenhuma tarefa pessoal é migrada ou exibida.

## Validação

Testes com TiDB descartável e serviço remoto simulado verificam migração aditiva, preservação de dados, rollback, cópia de estrutura, autorização, isolamento de sessões e projetos, vínculo exclusivo, edição, estado desatualizado, criação duplicada e falha ambígua. Os testes de interface verificam a lista única, ausência das rotas pessoais, conexão explícita, mudança de projeto e proteção contra reenvio. O teste visual local confirma criação de projeto e edição/conclusão de tarefa com dados sintéticos.

A ativação na sala real exige o usuário conectar sua conta e selecionar a sala. Nenhum teste cria ou altera tarefas no Chatask de produção.
