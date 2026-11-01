# Perguntas ao projeto, tarefas e cópia do relatório

A busca anterior comparava a pergunta inteira com cada campo de texto. Uma frase como “me fala tudo sobre o cubículo de Ceara Mirim” não encontrava um registro com “Cubículo de Ceará-Mirim”.

O Segundo Cérebro agora aceita perguntas. Reutiliza o provedor/modelo já configurado no servidor para extrair termos da pergunta e elaborar uma resposta sobre as evidências recuperadas. A leitura inclui assuntos, históricos, contexto ativo e texto de fontes e anexos suportados. A seleção considera palavras sem acentos, hífens, plurais simples e termos sugeridos pelo modelo, com trechos sobrepostos para localizar informações dentro de documentos. Não usa um índice vetorial e não promete cobertura exaustiva.

Cada parágrafo tem referências numéricas. O servidor rejeita respostas vazias, sem referências ou com referências inexistentes. O usuário pode expandir os trechos e abrir o assunto/histórico ou a seção de origem. Uma falha da IA mostra os trechos e uma mensagem explícita, sem fingir que não há registros. Nenhuma fonte de outro projeto é consultada; o endpoint exige sessão, participação no projeto e a verificação de origem já existente.

Para limitar consumo e memória, há uma consulta por usuário e três simultâneas por processo. A leitura prioriza até 1.000 assuntos, 5.000 históricos, 200 fontes e 200 contextos; extrai até 40 anexos/20 MB e mantém até 4 milhões de caracteres. A resposta recebe até 24 trechos/42 mil caracteres. Limites atingidos e anexos ilegíveis são informados na interface. Imagens e PDFs sem texto dependem dos registros previamente analisados. Esses limites não substituem uma futura indexação persistente para projetos muito maiores.

Tarefas ganhou uma entrada própria no menu. Os endpoints e a tabela existentes foram preservados; não há migração de dados nesta entrega. O Relatório vivo ganhou botões discretos com ícone de duas folhas para copiar sínteses e resumos executivos, inclusive a mudança relevante da síntese, com feedback de sucesso/falha e suporte a teclado. Os controles não aparecem na impressão.

## Preparação para o Chatask

Referência consultada: `lookciano/Chataskweb`, especialmente `drizzle/schema.ts` e `server/routers.ts`. Nenhum código ou dado do Chatask foi alterado.

O Chatask relaciona tarefas a salas, mensagens e usuários numéricos (`chatRoomId`, `messageId`, `assignedToId`, `assignedToName`). O Organizador usa projetos/itens com UUIDs e um responsável em texto livre. Os estados também diferem: Chatask usa `pending`, `completed`, `cancelled`; Organizador possui `pendente`, `em_andamento`, `bloqueado`, `concluido`.

A integração futura precisa definir o vínculo projeto–sala, o mapeamento de responsáveis, os estados sem equivalente, qual sistema prevalece em conflitos e uma autenticação entre serviços com escopo limitado. Deve manter uma chave externa estável e operações idempotentes para não duplicar tarefas. Não compartilhar cookies, senhas ou acesso direto ao banco entre os aplicativos. Esta entrega separa a interface e preserva os IDs atuais, sem ativar sincronização ou criar credenciais antecipadamente.

## Verificação

`npm run check`, `npm test`, `npm run test:ui`, `npm run build` e `npm run test:local-tidb` cobrem recuperação da pergunta de exemplo, grafia, evidência no interior de anexos, escopo por projeto, autorização, referências inválidas, indisponibilidade da IA, isolamento de formulários e cópia de texto. Os testes automáticos do modelo usam respostas simuladas; a validação do provedor real deve ser feita pela pergunta de exemplo no serviço configurado, sem registrar o conteúdo privado em logs ou no PR.
