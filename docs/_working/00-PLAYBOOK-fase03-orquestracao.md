# Playbook de Orquestração — Fase 03 (Upload e Processamento de Vídeos)

> **O que este arquivo É:** o roteiro de maestro para conduzir o Claude Code pela pipeline
> nativa do repositório, sem pular etapas e sem cair nos critérios de reprova.
>
> **O que este arquivo NÃO É:** um PRD nem um substituto dos artefatos da fase. Os artefatos
> (`context.md`, `validation.md`, `phase-03-videos.md`, `progress.md`, `library-refs.md`,
> `technical-decisions-*.md`) **são gerados pelas skills**, não copiados daqui. Rastreabilidade
> é critério de aceite — artefato sem origem na pipeline reprova.

---

## 0. Resposta direta à sua pergunta (estrutura de pastas)

**Sim — você trabalha DENTRO do fork do `mba-ia-greenfield-project`. Não crie repositório novo
nem scaffolde pastas manualmente.** Motivos concretos:

1. O enunciado é explícito: "você não cria um repositório novo, apenas adiciona/edita arquivos".
2. A **fundação de IA só existe dentro do repo base**: `.claude/skills/` (research, plan-context,
   plan-validate, plan-resolve, plan-build, implement-phase, nestjs-best-practices,
   testing-guide-nestjs-project, typeorm, playwright-cli), `.claude/agents/` (sub-agents de leitura
   usados pelas skills), `CLAUDE.md`, `.mcp.json`, `skills-lock.json`. Sem isso, o workflow não roda.
3. A Fase 03 **continua** o backend existente (`nestjs-project/src/{auth,users,channels,common,...}`).
   Você soma o módulo `videos/`, não reescreve.

Ação: `Fork` no GitHub → `git clone` do SEU fork → trabalhar a partir de `dev`.

---

## 1. Pré-voo (setup) — checklist bloqueante

Faça TUDO antes de tocar em qualquer skill. Cada item é um gate; se falhar, pare e corrija.

- [ ] **Fork criado e clonado** do seu usuário (não do `devfullcycle`).
- [ ] **Branch base correta:** `git checkout dev` (Git Flow do projeto: features saem de `dev`,
      voltam para `dev`; `main` é intocável).
- [ ] **Branch de trabalho:** `git checkout -b feature/phase-03-videos` a partir de `dev`.
- [ ] **Backend de pé:** `cd nestjs-project && docker compose up -d` (sobe `nestjs-api`, `db`, `mailpit`).
- [ ] **Dependências instaladas:** `node_modules/` presente no `nestjs-project`.
- [ ] **Migrations aplicadas:** `docker compose exec nestjs-api npm run migration:run`.
- [ ] **Suíte atual VERDE (baseline):**
      `docker compose exec nestjs-api npm test -- --runInBand` e
      `docker compose exec nestjs-api npm run test:e2e`.
      Se a baseline já estiver vermelha, conserte/registre antes — senão você não saberá o que a Fase 03 quebrou.
- [ ] **MCP `context7` configurado.** ⚠️ **Risco real:** o `.mcp.json` do repo só tem o servidor
      `postgres`. As skills `research` e `plan-resolve` exigem `context7` ("antes de implementar,
      consulte a doc oficial via context7"). Confirme que `context7` está no seu `.mcp.json`
      (ou na config global do Claude Code). Sem ele, a etapa de fixar libs/versões fica cega e você
      arrisca usar APIs deprecadas (= reprova "CLAUDE.md inconsistente com o código").
- [ ] **MCP `postgres` ativo** (já vem no `.mcp.json`), útil para inspecionar a tabela `videos` depois.

---

## 2. Mapa de armadilhas → Reprova automática

Cada armadilha abaixo mapeia diretamente para um item da lista "Reprova automática" ou "Critérios de
Aceite". Trate como checklist de defesa.

| # | Armadilha | Por que acontece | Mitigação | Reprova que evita |
|---|-----------|------------------|-----------|-------------------|
| R1 | Passar o arquivo de 10GB **pela API** | Caminho intuitivo (`multipart` no controller) | Upload **direto ao storage via URL pré-assinada** (presigned PUT/multipart). A API só emite a URL e recebe um "complete". | "Passar o arquivo de 10GB pela API de forma que trave" |
| R2 | BullMQ com `host: 'localhost'` | A própria skill `micro-use-queues` traz esse exemplo | Usar **`host: redis`** (nome do serviço no Compose). Regra Docker do CLAUDE.md tem precedência sobre o exemplo da skill. | "CLAUDE.md inconsistente"; testes vermelhos no Compose |
| R3 | Esquecer o serviço `redis` no Compose | BullMQ exige Redis; não está no compose atual | Adicionar serviço `redis` no `compose.yaml` (SI de infra) | "Não ter fila/worker/storage reais subindo no Compose" |
| R4 | Presigned URL com host errado (MinIO) | URL assinada com host interno (`minio:9000`) não abre no browser; com `localhost` não abre dentro do Compose | Decidir endpoint **interno** (worker/testes ↔ `minio:9000`) vs **público** (cliente ↔ `localhost:9000`) via env. Os testes e2e rodam DENTRO do Compose → usam o host interno. | Testes e2e vermelhos / streaming quebrado |
| R5 | FFmpeg ausente na imagem do worker | A imagem Node não traz ffmpeg/ffprobe | `apt-get install -y ffmpeg` no Dockerfile do worker (ou imagem com ffmpeg) | Processamento/thumbnail não funcionam |
| R6 | Mockar storage/fila nos testes | Hábito de unit test | Enunciado proíbe: "não simule o que dá para rodar de verdade". Integração/e2e contra **MinIO + Redis + Postgres reais** do Compose. | "Testes nos níveis adequados" / suíte rasa |
| R7 | Pular `plan-validate` em `clean` | Pressa para implementar | `plan-build` **hard-bloqueia** se `validation.md != clean`. Itere `validate ↔ resolve`. | "validation.md que não fecha em clean" |
| R8 | Commit direto na `main` | Descuido | Toda a Fase 03 vive em `feature/phase-03-videos` a partir de `dev`. | "Commit direto na main" |
| R9 | `tsc`/`lint` deixados como dívida | "depois eu arrumo" | DoD exige `npx tsc --noEmit` (código 0) + `npm run lint` antes de declarar pronto. | "tsc com erro, lint quebrado" |
| R10 | Plano sem `Events/Messages` | Seção é **nova** nesta fase (a fila introduz) | Garantir no `plan-build` a subseção `### Events/Messages` (schema do job, fila, retry, idempotência). | "Plano sem as Technical Specifications" |
| R11 | CLAUDE.md desatualizado | Esquecer o passo final | Atualizar CLAUDE.md com módulo `videos`, endpoints, fila/worker/storage **refletindo o código real**. | "CLAUDE.md inconsistente com o código" |

---

## 3. A pipeline, comando a comando (com gates e prompts)

Ordem canônica (lida direto das skills): **research → plan-context → plan-validate → plan-resolve →
(loop validate↔resolve até `clean`) → plan-build → plan-test-specs (opcional) → implement-phase**.

> **Invocação no Claude Code:** as skills têm `disable-model-invocation: true` — você as dispara
> explicitamente. Use as frases-gatilho abaixo (extraídas das próprias `SKILL.md`). Se seu Claude Code
> expõe slash-commands, o menu `/` lista os nomes (`research`, `plan-context`, `plan-validate`,
> `plan-resolve`, `plan-build`, `plan-test-specs`, `implement-phase`). Confirme pelo menu `/` antes.

### Etapa 1 — Research (decisões técnicas)

**Antes:** revise o arquivo `research-input-fase03-decisoes-tecnicas.md` (gerado junto com este playbook).
Ele é o **insumo** que evita saída rasa do `/research`.

**Prompt:**
```
Use a skill research para a fase 03 (Upload e Processamento de Vídeos).
Leia docs/project-plan.md §Fase 03 como escopo. Como insumo de partida, considere a análise de
trade-offs em research-input-fase03-decisoes-tecnicas.md, mas valide cada opção contra as versões
realmente instaladas (package.json do nestjs-project) usando o MCP context7, e contra as decisões já
tomadas em docs/decisions/ e as regras em .claude/skills/nestjs-best-practices/rules/.
Cubra explicitamente: (1) tecnologia de fila; (2) estratégia de upload de 10GB sem travar a API;
(3) layout de buckets/chaves e upload pré-assinado no MinIO/S3; (4) worker (container separado,
ffprobe/ffmpeg, thumbnail); (5) streaming via Range/206 e download; (6) estratégia de URL única;
(7) ciclo de status e tratamento de falha; (8) contrato de eventos/mensagens da fila.
Salve em docs/decisions/technical-decisions-phase-03-videos.md no formato das decisões existentes.
```

**Gate G1:** o arquivo `docs/decisions/technical-decisions-phase-03-videos.md` existe, cada TD tem
**`Capability:`** apontando para um bullet literal da Fase 03, e o campo **`Decision:`** está
`_[pending]_`. **Você** preenche as decisões (revisão crítica) antes de seguir.

> ⚠️ Reconcilie a fila com a regra `micro-use-queues` (que aponta BullMQ). Se você escolher BullMQ,
> não há conflito; se escolher outra, o `plan-validate` provavelmente abre um `ICC-N`
> (Inherited Constraint Conflict) contra a regra. Decida com consciência disso.

### Etapa 2 — plan-context

**Prompt:**
```
Use a skill plan-context para a fase 03 (argumento: 03 ou o slug phase-03-videos).
Consolide docs/project-plan.md §Fase 03, o technical-decisions-phase-03-videos.md já decidido,
as convenções herdadas das fases 01/02 e os requisitos de teste. Gere
docs/phases/phase-03-videos/context.md.
```
**Gate G2:** `context.md` criado; `## Capability Coverage` lista todos os bullets da Fase 03; cada
bullet mapeia para ≥1 TD. `sources_mtime` preenchido.

### Etapa 3 — plan-validate (1ª passada)

**Prompt:**
```
Use a skill plan-validate para a fase 03. Gere docs/phases/phase-03-videos/validation.md com o
veredito status: clean|dirty.
```
**Gate G3:** leia o `validation.md`. Espere `dirty` na primeira rodada (decisões faltando `MD-N`,
ambiguidades `AMB-N`, gaps `DG-N`, conflitos herdados `ICC-N`). Isso é saudável.

### Etapa 4 — plan-resolve

**Prompt:**
```
Use a skill plan-resolve para a fase 03. Resolva as pendências apontadas no validation.md.
Para cada lib nova (fila, cliente S3/MinIO, ffmpeg/ffprobe, gerador de URL única), confirme a versão
compatível com o package.json instalado via context7 e registre em
docs/phases/phase-03-videos/library-refs.md.
```
**Gate G4:** `library-refs.md` criado com libs+versões confirmadas; TDs antes `pending` agora decididos;
`context.md` repatcheado.

### Etapa 5 — Loop validate ↔ resolve até `clean`

Repita Etapa 3 → Etapa 4 até `validation.md` fechar em **`status: clean`**. **Não avance** com `dirty`.
"Plano frouxo gera implementação frouxa."

### Etapa 6 — plan-build (o plano executável)

**Prompt:**
```
Use a skill plan-build para a fase 03. Gere docs/phases/phase-03-videos/phase-03-videos.md com
Step Implementations (SI-03.x), Technical Specifications e Dependency Map e Deliverables.
Garanta na seção Technical Specifications as subseções: Data Model (tabela videos ligada ao canal),
API Contracts, Authorization Matrix, Error Catalog e Events/Messages (schema do job de processamento,
nome da fila, attempts/backoff, chave de idempotência, comportamento em falha).
```
**Gate G6 (contrato de formato — confira item a item):**
- [ ] SIs numerados `SI-03.1, SI-03.2, …`, cada um com **Description, Technical actions, Tests
      (tabela File|Layer|Verifies), Dependencies, Acceptance criteria**.
- [ ] `### Data Model` com a tabela `videos` (ver §4 abaixo para o shape mínimo esperado).
- [ ] `### API Contracts` para os endpoints de upload-init/complete, streaming, download, status.
- [ ] `### Authorization Matrix` (quem pode: dono do canal vs anônimo para watch/stream/download).
- [ ] `### Error Catalog` no formato `{ statusCode, error, message }` herdado da Fase 02.
- [ ] **`### Events/Messages`** (NOVA nesta fase — a fila exige). Sem ela = reprova.
- [ ] `## Dependency Map` + ordem linearizada.
- [ ] `## Deliverables` com checklist incluindo os comandos de DoD (test, test:e2e, tsc, build).

### Etapa 7 — plan-test-specs (opcional)

Só dispara se o plano tiver frontmatter `test_specs_aware: true` e SIs com campo `Test Specs:`.
Para um desafio backend com infra real, normalmente **não é necessário** — os testes de integração/e2e
contra Compose já cobrem. Se a skill abortar dizendo que não se aplica, é o comportamento esperado.

### Etapa 8 — implement-phase (SI a SI)

**Prompt (modo padrão, pausando entre SIs — recomendado):**
```
Use a skill implement-phase para a fase 03 (docs/phases/phase-03-videos/phase-03-videos.md).
Implemente SI a SI, rodando apenas os testes do SI a cada passo, e PARE para confirmação antes de cada
próximo SI. Antes de implementar com qualquer lib nova, consulte a doc via context7 e siga a versão
fixada em library-refs.md. Tudo roda em containers do Compose; use os nomes dos serviços como host
(redis, minio, db) — nunca localhost. Atualize o progress.md a cada SI.
```
**Disciplina por SI (a skill já impõe):** implementa → escreve testes → roda só os testes do SI →
até 3 tentativas de fix → atualiza `progress.md` → PARA e pergunta "Seguir para SI-03.X+1?".

> Só use modo contínuo ("execute tudo / autopilot") se quiser correr o risco de deixar vários SIs sem
> revisão humana. Para um desafio avaliado, **pausar é mais seguro**.

---

## 4. Shape mínimo esperado da tabela `videos` (referência, não substitui o Data Model do plano)

Use isto apenas para **conferir** se o `plan-build` produziu algo coerente. O modelo canônico é o que
o plano definir; este é o piso de sanidade derivado dos bullets da Fase 03.

| Coluna | Tipo | Notas |
|--------|------|-------|
| id | uuid PK | |
| channel_id | uuid FK → channels.id | dono do vídeo (relação com o canal) |
| title | varchar | título (pode nascer do filename no rascunho) |
| public_id | varchar unique | identificador da **URL única** (ex.: nanoid base62, ~11 chars) |
| status | enum | `draft → processing → ready → failed` |
| storage_key | varchar | chave do arquivo de vídeo no bucket |
| thumbnail_key | varchar nullable | chave do thumbnail gerado |
| duration_seconds | int nullable | extraído via ffprobe |
| metadata | jsonb nullable | codec, resolução, bitrate, container |
| size_bytes | bigint nullable | |
| error_reason | text nullable | preenchido em `failed` |
| created_at / updated_at | timestamp | `@CreateDateColumn` / `@UpdateDateColumn` |

**Índices:** `(public_id)` unique, `(channel_id)`, `(status)`.

---

## 5. Definition of Done + Git Flow (gate final)

Antes do push, rode os 4 do CLAUDE.md (dentro do Compose):

```
docker compose exec nestjs-api npm test -- --runInBand        # unit + integração
docker compose exec nestjs-api npm run test:e2e               # e2e
docker compose exec nestjs-api npx tsc --noEmit               # deve sair com código 0
docker compose exec nestjs-api npm run lint                   # deve passar
```

Git:
```
git add -A
git commit -m "<mensagem curta focada no porquê>"
git push origin feature/phase-03-videos
# Abrir PR feature/phase-03-videos -> dev (nunca -> main)
```

Atualize o **CLAUDE.md** (seção de vídeos) refletindo o código real: módulo `videos`, endpoints,
fila/worker, storage. Documentação citando arquivo/comportamento inexistente reprova.

---

## 6. Rastreador de Critérios de Aceite (marque antes do push)

**Decisões e planejamento**
- [ ] `technical-decisions-phase-03-videos.md` com fila, upload, streaming, processamento/thumbnail, ciclo de status — justificados.
- [ ] `docs/phases/phase-03-videos/` com `context.md`, `validation.md` (**clean**), `phase-03-videos.md`, `progress.md`, `library-refs.md`.
- [ ] Plano com SIs `SI-03.x` + Technical Specs (Data Model, API Contracts, Authorization Matrix, Error Catalog, **Events/Messages**) + Dependency Map + Deliverables.

**Feature**
- [ ] Upload até 10GB **sem travar a API**, com pré-cadastro do vídeo como rascunho ao iniciar.
- [ ] Processamento automático pós-upload: duração/metadados (ffprobe) + thumbnail (ffmpeg).
- [ ] URL única por vídeo, sem conflito.
- [ ] Streaming (Range/206, sem download completo) + download disponível.
- [ ] Ciclo de status (`draft → processing → ready/failed`) refletido no banco.

**Infra e qualidade**
- [ ] Storage (MinIO), fila (Redis+BullMQ) e worker subindo via `docker compose`.
- [ ] Migration cria a tabela `videos`; entidade ligada ao canal.
- [ ] Testes verdes (`npm test` e `npm run test:e2e`), níveis adequados, sem mock do que roda de verdade.
- [ ] DoD completa: suíte verde + `tsc --noEmit` (0) + `lint`.
- [ ] Git Flow: trabalho em `feature/*` a partir de `dev`, sem commit em `main`.

**Documentação**
- [ ] `CLAUDE.md` atualizado com a seção de vídeos, coerente com o código.

---

## 7. Resumo executável (fluxo de 1 página)

```
fork + clone (SEU fork)
git checkout dev && git checkout -b feature/phase-03-videos
cd nestjs-project && docker compose up -d && npm run migration:run
baseline verde (test + test:e2e)
confirmar MCP context7 ativo
── pipeline ──────────────────────────────────────────────
research            → technical-decisions-phase-03-videos.md   [você decide os TDs]
plan-context        → context.md
plan-validate       → validation.md (dirty esperado)
plan-resolve        → library-refs.md + TDs decididos
loop validate↔resolve até status: clean        ← GATE bloqueante
plan-build          → phase-03-videos.md (com Events/Messages) ← GATE de formato
implement-phase     → código + progress.md, SI a SI, testes verdes por SI
── fechamento ────────────────────────────────────────────
DoD: test + test:e2e + tsc --noEmit + lint
atualizar CLAUDE.md
commit + push + PR para dev
revisar Critérios de Aceite item a item
```
