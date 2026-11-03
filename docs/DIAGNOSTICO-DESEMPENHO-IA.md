# Organizador Grande Sertão — como funciona e onde a IA perde tempo

Documento de diagnóstico técnico. Base: código do repositório `lookciano/Organizador`
(commit `bb6042b`), app em produção `organizador-grande-sertao.onrender.com`
(`/health` respondendo em ~0,3 s) e limites declarados no próprio código.

---

## 1. O que o aplicativo é

Um **"relatório vivo"** de projeto: em vez de guardar atas em arquivos, cada fato dito
sobre o projeto (mensagem, transcrição, PDF, DOCX, print) é lido pela IA e vira um
**assunto** dentro de um **tópico** de uma estrutura hierárquica fixa (a estrutura do
relatório Grande Sertão: Equipamentos, Subestações, Fornecimento, Startup e
Comissionamento…). O relatório é a soma dos assuntos atuais + síntese de cada tópico.

### 1.1 Fluxo principal

```
Fonte (texto/arquivo/imagem)
   └─► extração (1 chamada de IA por trecho de 12k caracteres)
         └─► assuntos: título, resumo, local, disciplina, fornecedor,
             responsável, prazo, status, evidência literal
               ├─► casamento com assunto existente (existing_item_id)
               └─► classificação no tópico (node_id + confiança)
                     └─► grava item + item_updates (histórico imutável)
                           └─► invalida a síntese do tópico e de todos os ancestrais
                                 └─► fila de sínteses (2 por vez)
                                       └─► resumo executivo das seções principais (1 por vez)
```

### 1.2 Peças

| Peça | Papel |
|---|---|
| `sources` | a fonte original (texto, arquivo, imagem) + status da análise |
| `items` | o **assunto** no estado atual (título, resumo, local, responsável, prazo, status) |
| `item_updates` | histórico append-only: cada leitura gera um registro com evidência |
| `structure_nodes` | a árvore de tópicos (77 nós no modelo inicial, mais as subestações) |
| `topic_summaries` | síntese em bullets por tópico, com `revision` (hash) e status |
| `topic_executive_summaries` | resumo executivo das seções principais, agrupado por subestação |
| `project_context_entries` | contexto permanente do projeto (glossário, relações, contratos) |
| `knowledge_analyses` | a "análise com contexto": varredura completa do projeto em etapas, com pausa/retomada |
| `chatask_*` | leitura das tarefas da sala do Chatask para comparar propostas |

### 1.3 O ciclo de atualização (e por que ele é caro)

1. **Ingestão.** Arquivo → 202 e processamento em background, **uma fonte por vez**
   (`server/index.mjs:503-518`). Texto puro → processamento **síncrono dentro do request**
   (`:544`), o navegador fica esperando a IA terminar.
2. **Extração.** O documento é cortado em trechos de 12.000 caracteres
   (`server/file-text.mjs:42`) e cada trecho é uma chamada **sequencial**
   (`server/ai.mjs:250-265`). Num PDF de 180 mil caracteres são **até 15 chamadas em série**.
3. **Atualização das sínteses.** Ao terminar, `updateTopicSummaries()` recalcula a
   impressão digital de **todos** os nós (`server/topic-summaries.mjs:146-205`) e enfileira
   os que mudaram.
4. **Sínteses.** Fila global com **2 concorrentes** (`:10`). Cada síntese relê itens +
   histórico de todo o ramo abaixo do nó e chama a IA em partes de 7.000 caracteres,
   também **sequenciais** (`server/ai.mjs:440-465`).
5. **Resumo executivo.** Depois da síntese de uma seção principal, entra numa fila com
   **1 concorrente** (`server/executive-summaries.mjs:42`), que por sua vez fatia a síntese
   em 2.800 caracteres e chama a IA em série (`server/ai.mjs:75-96`).
6. **Tela.** `/api/state` é recarregado a cada 60 s por usuário (`src/App.tsx:119-120`) e,
   a cada chamada, executa de novo `prepareTopicSummaries` + `prepareExecutiveSummaries`
   (`server/index.mjs:166-167`), carregando **todos** os itens e **todo** o histórico do
   projeto (`:133,141-157`).

### 1.4 A "Análise com contexto"

É o fluxo mais elaborado: planeja o pedido → carrega o corpus (sínteses, resumos,
estrutura, contexto, opcionalmente assuntos/histórico/originais) → corta em trechos de
5.000 caracteres (`server/project-analysis.mjs:85`) → revisa lote por lote → consolida →
responde com citações numeradas. Cada `advance` é **uma** etapa e **uma** chamada de IA,
avançada pelo *polling* do navegador (`src/ProjectAnalysis.tsx:26-32`, 2 s).

O desenho é sólido em integridade (nada é apagado, tudo tem evidência, nada é inventado
sem fonte). O problema é **quantidade de chamadas × tamanho do prefixo repetido**.

---

## 2. Diagnóstico: onde o tempo é consumido

### G1 — Extração 100% sequencial e com prefixo repetido (maior ganho imediato)

`server/ai.mjs:250` percorre os trechos com `for ... await`, um de cada vez. Em cada
chamada o prompt repete:

- a estrutura completa com caminho de cada nó — 77 nós = **3.458 caracteres ≈ 865 tokens**;
- até **100 assuntos existentes** (`:246`) — **8.197 caracteres ≈ 2.049 tokens**;
- até **18.000 caracteres de contexto** (`:251`) — **17.360 caracteres ≈ 4.340 tokens**;
- o trecho em si — 12.000 caracteres = **12.430 caracteres ≈ 3.108 tokens**.

Medido: **10.361 tokens de entrada para 3.108 tokens de conteúdo útil — 3,3× de sobrecarga**,
repetidos a cada trecho. Num PDF de 180 mil caracteres são 15 chamadas em série, ~155 mil
tokens de entrada, com `max_output_tokens: 12000` (`:261`), o que alonga cada geração.
Pior: **todo esse prefixo é reenviado do zero em cada chamada**, sem cache.

### G2 — Reenvio do acumulado na síntese (medido: impacto pequeno)

Em `server/ai.mjs:441` o prompt de cada parte reenvia o JSON dos pontos acumulados
(`part.bullets`). Cada registro formatado tem **1.010 caracteres** (medido a partir do
formato literal das linhas 435/437), mas o acumulado é **limitado pelo tamanho do lote**:
`batchSize` é 4 (ou 1 quando o tópico tem 20+ assuntos, `ai.mjs:484`). Ou seja, no máximo
**4 bullets por parte** — não o tópico inteiro.

Medição em carga realista (4 assuntos × 25 registros, 15 partes de 7 mil caracteres,
250 ms de latência simulada por chamada):

| Cenário | Antes | Com a mudança | Diferença |
|---|---|---|---|
| histórico intercalado | 119.129 chars | 121.289 chars | **+1,8%** |
| histórico em blocos | 111.269 chars | 109.121 chars | **−1,9%** |

Conclusão: **não compensa**. A mudança foi implementada, medida e revertida. O custo real
da síntese está na **quantidade de partes** (tamanho do histórico) e no **contexto de 18 mil
caracteres reenviado em cada parte**, não no eco do acumulado.

### G3 — Toda seção principal é re-sintetizada do zero

`relatedItems` (`server/topic-summaries.mjs:15-28`) sobe a árvore: um assunto novo em
qualquer folha marca como desatualizado **todos** os ancestrais. A síntese de uma seção
principal relê **itens + histórico completo de todos os descendentes**
(`:54-72`) e reconstrói o texto inteiro. Um único registro novo pode custar a
re-síntese do projeto quase inteiro, sem aproveitar a síntese anterior.

### G4 — Concorrência artificialmente baixa

- sínteses: **2** simultâneas (`:10`);
- resumos executivos: **1** (`executive-summaries.mjs:42`);
- extração: **1** por vez, e uma fonte por vez (`index.mjs:503`);
- análise com contexto: **3** análises simultâneas no total (`analysis-jobs.mjs:216`).

Nada disso é I/O caro: são chamadas de rede esperando o provedor. Com provedores que
aceitam 5–10 requisições paralelas, subir a concorrência é ganho quase linear.

### G5 — Nenhum cache de prompt, nenhum roteamento por velocidade

Não há `cache_control`, `prompt_cache_key` nem preferência de provedor em nenhum ponto
(`grep` limpo em `server/*.mjs`). Pior: o bloco de contexto é **diferente em cada tópico**,
porque `selectProjectContext` recebe a consulta do tópico e escolhe trechos diferentes
(`server/project-context.mjs:12`). Resultado: nenhum prefixo é idêntico entre chamadas, e
o cache automático do provedor (DeepSeek desconta prefixo repetido) nunca é aproveitado.
Também não há `provider: { sort: 'throughput' }` para o OpenRouter escolher a rota mais
rápida.

### G6 — Retry que dobra o tempo em vez de reduzir o problema

`server/ai.mjs:158-159` e `:207-209`: se a resposta vier `incomplete`, a segunda tentativa
repete **a mesma chamada com o dobro do limite de saída** (até 16 mil tokens). Em vez de
fatiar, o sistema tenta "caber mais" — e dobra a espera. Os fallbacks de divisão existem,
mas só depois de duas tentativas caras.

### G7 — `/api/state` carrega o projeto inteiro a cada 60 s

`server/index.mjs:133` traz todos os `items`; `:141-157` faz consultas em blocos de 400 ids
para trazer **todo** o `item_updates`; `:166-167` roda as duas preparações de síntese.
Com histórico grande, isso vira segundos de banco (TiDB remoto, TLS) a cada minuto, por
usuário — e atrasa a percepção de velocidade mesmo quando a IA está ociosa.

### G8 — Infraestrutura

`render.yaml`: plano **free**, 1 instância, hiberna após 15 min de inatividade. O primeiro
acesso depois de uma pausa custa dezenas de segundos e é facilmente confundido com "IA
lenta". Além disso, o processo é único: uma extração longa disputa o mesmo processo com o
`/api/state` de todos os usuários.

---

## 3. Plano de ação priorizado

### P0 — ganhos grandes, mudanças pequenas e reversíveis

1. **Paralelizar a extração por trecho** (`ai.mjs:250`): pool de 3 a 4 chamadas
   simultâneas, preservando a ordem de montagem dos resultados. 15 trechos sequenciais
   passam a ~4 ondas. *Ganho esperado: 3–4× no tempo de leitura de um documento.*
2. ~~**Parar de reenviar o acumulado na íntegra**~~ — **implementado, medido (−2%), revertido**.
   Ver G2: o acumulado é limitado a 4 assuntos por lote, então o eco não é o gargalo.
3. **Contexto do projeto como bloco fixo e cacheável**: selecionar o contexto **uma vez
   por projeto** (não por tópico), montar um dossiê de 3–5 mil caracteres — glossário de
   subestações, fornecedores, equipamentos, siglas — e colocá-lo sempre no **mesmo
   prefixo** da mensagem, antes de qualquer texto variável. Prefixo idêntico = cache do
   provedor + menos tokens. *Ganho: 3–5× menos entrada por chamada e mais consistência.*
4. **Síntese incremental das seções principais**: manter a síntese anterior e mandar
   apenas os registros novos/alterados (`update.created_at > generated_at`) com um
   marcador de "atualize sem reescrever". *Ganho: a re-síntese deixa de ser O(projeto).*
5. **Concorrência**: `MAX_CONCURRENT_SUMMARIES` 2 → 4, resumo executivo 1 → 2, e
   `active.size` da análise 3 → 5. *Ganho próximo de 2× na fila.* — **implementado para as
   duas filas de síntese** (ajustável por `SUMMARY_CONCURRENCY` / `EXECUTIVE_CONCURRENCY`).

### P1 — qualidade de interpretação e custo

6. **Classificação em dois estágios**: primeiro escolher o ramo de nível 1 (prompt com
   ~8 caminhos), depois a folha dentro do ramo (prompt com ~10). Hoje o modelo recebe os
   77 caminhos completos em todas as chamadas — mais caro e mais sujeito a confundir
   ramos parecidos (o próprio prompt admite o problema de "Ourolândia em vários ramos").
   *Ganho: menos tokens e menos erro de classificação.*
7. **Reduzir o catálogo de assuntos existentes** (`ai.mjs:246`): hoje vão 100 itens por
   trecho. Filtrar por similaridade de termos com o trecho (o utilitário já existe em
   `project-context.mjs`) e mandar os 20–30 candidatos relevantes.
8. **`max_output_tokens` proporcional ao conteúdo**: 12.000 tokens de saída para um trecho
   de 12 mil caracteres é o pior caso, não o típico. Usar ~4.000 e fatiar quando faltar
   espaço (o fallback já existe) reduz muito a latência de cauda.
9. **Fatiar antes de tentar de novo**: em vez de repetir com o dobro do limite
   (`ai.mjs:158`), dividir o trecho na primeira ocorrência de `incomplete`. Corta a espera
   dobrada.
10. **Roteamento por throughput no OpenRouter** (`provider: { sort: 'throughput' }`) e um
    modelo mais rápido para as tarefas curtas (classificação, planejamento, comparação de
    tarefas), mantendo o modelo atual para as sínteses longas.

### P2 — arquitetura

11. **`/api/state` incremental**: enviar apenas o que mudou desde um `cursor`
    (`updated_at`/`id`), com ETag; tirar a preparação de sínteses do caminho do GET
    (deixar só leitura; enfileirar em rota própria).
12. **Síntese sob demanda / priorizada**: sintetizar primeiro o que está na tela e o que
    tem prazo próximo; o resto em segundo plano. Hoje a fila ordena por "quantidade de
    trabalho", o que adia justamente os tópicos mais pesados (e mais visíveis).
13. **Plano pago mínimo no Render** ou *keep-alive*: elimina o cold start e evita
    disputa de processo único. É o item de melhor relação custo/percepção.
14. **Dossiê do projeto** persistido (glossário + relações), regenerado só quando o
    contexto muda. Serve tanto para acelerar quanto para a IA "entender rápido" o que é
    GSAAR, GSAVP, Ourolândia, qual fornecedor entrega o quê.

---

## 4. Como medir antes de mudar

`scripts/bench-ia.mjs` dispara chamadas com o mesmo formato usado pelo app (mesma API,
mesmo `json_schema` estrito) e reporta latência e tokens por cenário:

```bash
OPENROUTER_API_KEY=... node scripts/bench-ia.mjs
```

Cenários: classificação curta, extração com prefixo grande (sem cache), mesma extração
repetida (mede cache), e síntese com acumulado. Rodar antes/depois de cada item do P0 dá
o ganho real em segundos, sem depender de impressão.

---

## 5. Resumo em uma frase

O app não é lento porque o modelo é lento: ele gasta a maior parte do tempo **reenviando
o mesmo contexto várias vezes, em série, e refazendo a síntese inteira a cada registro
novo**. Paralelizar a extração, elevar a concorrência das filas, fixar o prefixo cacheável
e adotar síntese incremental atacam a maior parte da espera sem mexer na lógica de
integridade.

---

## 6. Resultado medido da branch `perf/p0-ia`

Simulação com 250 ms de latência por chamada (provedor remoto), mesmo volume nos dois
lados:

| Cenário | Antes | Depois | Ganho |
|---|---|---|---|
| Extração de documento em 12 trechos | 3,0 s | **1,0 s** | **3,0×** |
| Fila de sínteses (8 tópicos pendentes) | 8 vagas em série, 2 por vez | 4 por vez | **~2×** |
| Entrada enviada na extração | 169.671 chars | 169.671 chars | igual (o ganho é de tempo) |
| Síntese: eco do acumulado | 119.129 chars | 121.289 chars | revertido (ver G2) |

Nenhuma alteração de banco: sem migration, sem `ALTER`, sem escrita em dados existentes.
Os limites são ajustáveis por ambiente (`EXTRACTION_CONCURRENCY`, `SUMMARY_CONCURRENCY`,
`EXECUTIVE_CONCURRENCY`) para respeitar a taxa do provedor.

---

## 7. Rodada P1, P2 e P3

### P1 — raciocínio só onde há julgamento, e etapas encadeadas

| Etapa | Antes | Depois |
|---|---|---|
| `project_analysis_review` (extração) | `effort: low` | **desligado** |
| `project_analysis_reduce` (consolidação) | `effort: low` | **desligado** |
| `project_analysis_plan` | `effort: low` | **desligado** |
| `project_analysis_compare` (tarefas) | `effort: low` | `effort: low` |
| `knowledge_answer` direta | desligado | desligado |
| `knowledge_answer` em etapas | `effort: low` | `effort: low` |

O desligamento só acontece quando o modelo declara `mandatory:false` e aceita `none`;
fora disso permanece `effort: low`. A comparação de tarefas mantém o raciocínio porque
ali a decisão é de julgamento (mesma ação? reabertura?), não de extração.

O encadeamento remove a espera entre etapas: cada lote exigia um `POST /advance` do
cliente e um poll de 0,5 a 2 s. Agora o servidor re-claima o lease e segue sozinho até
concluir, pausar ou atingir `ANALYSIS_CHAIN_STEPS` (padrão 40).

### P2 — lista fechada de locais e lote por documento

`stationGlossaryBlock()` põe no início do prompt os nomes canônicos e as grafias aceitas,
mais o aviso de que `Jussiape (GST)` e `Jussiape (TAESA)` são frentes separadas. Entra na
leitura por lotes, na síntese de tópico e na resposta. Sem estrutura cadastrada o bloco
não é gerado — projeto sem estações não recebe local inventado.

`groupBatchByDocument()` mantém todas as partes de um mesmo documento no mesmo lote. Antes,
a parte criada por divisão (quando a IA responde `complete=false`) recebia número novo no
fim da fila e era lida sem o resto do registro.

### P3 — telemetria de custo

Toda chamada passa a registrar `ai_call:` com nome, tentativa, duração, status, motivo de
incompletude, modo de raciocínio e tokens de entrada, cache, saída e raciocínio. Nenhum
texto de pergunta, evidência ou resposta entra no log.

Com isso dá para responder o que antes era suposição: quanto do prefixo está sendo
reaproveitado (`cached_tokens`) e quanto do orçamento de saída o raciocínio consome
(`reasoning_tokens`).

### Validação

96 testes unitários, 18 de interface e 41 de integração em TiDB descartável.
