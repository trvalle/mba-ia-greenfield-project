# Briefing de Decisões Técnicas — INPUT do `/research` (Fase 03)

> **Status deste arquivo:** insumo de partida para a skill `research`. **Não é** o artefato oficial.
> O artefato oficial é `docs/decisions/technical-decisions-phase-03-videos.md`, gerado pela skill,
> com cada TD rastreável a um bullet da Fase 03 e com versões confirmadas via `context7`.
>
> **Como usar:** cole o prompt da Etapa 1 do playbook, deixe a skill produzir os TDs, e use as
> recomendações abaixo como linha de base crítica. **Valide tudo** contra `context7` + `package.json`
> antes de fixar — não aceite minha recomendação como verdade final.

## Contexto aterrissado (lido do repositório, não presumido)

- **Stack instalada (`nestjs-project/package.json`):** NestJS 11, TypeORM 0.3.28, `pg` 8, `argon2`,
  `joi` (validação de config), `@nestjs/throttler`, `@nestjs/swagger`, Jest 30, Supertest 7.
  **Não há** lib de fila, cliente S3/MinIO nem ffmpeg instalados — esta fase introduz libs novas
  (por isso `library-refs.md` é esperado).
- **Regra do repo que restringe a fila:** `.claude/skills/nestjs-best-practices/rules/micro-use-queues.md`
  manda usar **`@nestjs/bullmq`** (BullMQ + Redis). A fila "TBD" do `project-plan.md` na prática já
  tem um forte viés do próprio repo. ⚠️ O exemplo da regra hardcoda `host: 'localhost'` — **isso
  viola** a regra de Docker Networking do `CLAUDE.md` (host = nome do serviço). Use `host: redis`.
- **Arquitetura-alvo (`docs/diagrams/software-arch.mermaid`):** já prevê 3 containers novos —
  `Video Worker (FFmpeg)`, `Object Storage (S3/MinIO)`, `Message Queue (TBD)`. Worker é **container
  separado**; o frontend "streams from Object Storage".
- **Formato de erro herdado (Fase 02):** `{ statusCode, error, message }`, com `error` carregando o
  código de domínio. A Fase 03 herda isso.
- **Object storage NÃO é decisão aberta:** é S3-compatível → MinIO local em Docker. O que se decide é
  *como usar* (buckets/chaves, pré-assinatura).

---

## TD-01 — Tecnologia de fila

**Capability:** "Serviço de processamento em segundo plano (filas)".

- **Opção A — BullMQ (`@nestjs/bullmq` + Redis).** Fila madura, retry/backoff nativos, `Processor`
  decorators, integra com o ecossistema Nest.
  - Prós: já **mandado pela regra `micro-use-queues`** (zero conflito de constraint); retry,
    idempotência, observabilidade (Bull Board) prontos; worker como `@Processor` em processo separado.
  - Contras: adiciona **Redis** ao Compose (novo serviço + dependência operacional).
- **Opção B — pg-boss (fila em cima do PostgreSQL).** Usa o Postgres já existente, sem Redis.
  - Prós: zero infra nova; transacional com o banco.
  - Contras: **conflita com a regra do repo** (provável `ICC-N` no `plan-validate`); menos idiomático
    em Nest; throughput menor para jobs pesados.
- **Opção C — fila caseira (LISTEN/NOTIFY ou tabela + polling).** 
  - Prós: nenhuma dependência.
  - Contras: reinventar retry/backoff/idempotência; frágil; mais código para testar. Descartável.

**Recomendação:** **A (BullMQ + Redis).** Alinha com a regra do projeto (evita conflito de validação),
e o worker vira um `@Processor` num container dedicado. Custo: 1 serviço `redis` no Compose.
**Confirmar via context7:** versão de `@nestjs/bullmq` e `bullmq` compatíveis com NestJS 11.
**Armadilha:** `connection.host = redis` (serviço do Compose), nunca `localhost`.

---

## TD-02 — Estratégia de upload de 10GB sem travar a API

**Capability:** "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance" +
"Pré-cadastro automático do vídeo como rascunho ao iniciar o upload".

- **Opção A — Presigned PUT direto ao storage + handshake `init/complete`.**
  1. `POST /videos/upload-init` → cria o vídeo como **`draft`**, gera `storage_key` + **presigned PUT URL**.
  2. Cliente faz `PUT` do binário **direto no MinIO/S3** (a API nunca recebe os bytes).
  3. `POST /videos/:id/complete` → valida que o objeto existe no storage e **enfileira** o job de processamento.
  - Prós: API nunca segura 10GB; testável de forma determinística; handshake explícito.
  - Contras: cliente faz 1 PUT grande (sem retomada de chunk individual).
- **Opção B — Presigned **Multipart** Upload (S3 multipart).** A API inicia o multipart, devolve URLs
  por parte; cliente sobe partes em paralelo; `complete-multipart` junta.
  - Prós: **retomável por parte**, paralelo, resiliente a queda de conexão (o `project-plan.md`
    §Pontos de Atenção cita "permita retomar em caso de falha").
  - Contras: handshake mais complexo (init parts → upload parts → complete); mais endpoints e testes.
- **Opção C — `tus` (protocolo de upload resumível).** Servidor tus dedicado.
  - Prós: resumível por design.
  - Contras: introduz um servidor/protocolo extra fora do padrão S3 do projeto; mais peças.

**Recomendação:** **A como piso funcional; B se quiser pontuar "retomada".** Para o critério literal
("sem travar a API"), A já satisfaz e é mais simples de testar end-to-end no Compose. Se for perseguir
o "retomar em caso de falha" do §Pontos de Atenção, B (multipart presigned) é o caminho S3-nativo.
**Decisão sua:** escopo vs. robustez. Documente o trade-off no TD.
**Armadilha (R4):** o presigned URL é assinado para um **host**. Worker e testes e2e (dentro do Compose)
falam com `minio:9000`; um cliente externo fala com `localhost:9000`. Separe via env
(`S3_ENDPOINT_INTERNAL` vs `S3_ENDPOINT_PUBLIC`) e gere a URL pública para o cliente, interna para
worker/testes.

---

## TD-03 — Layout de buckets/chaves e cliente S3

**Capability:** "Serviço de armazenamento de arquivos (vídeos e thumbnails)".

- **Cliente:** AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`) **ou** `minio` SDK.
  - SDK AWS v3: troca MinIO↔S3 sem mudar código (mesma API), presigner oficial. **Recomendado** pela
    portabilidade prometida no enunciado ("trocaria por S3 em produção").
  - `minio` SDK: ergonômico para MinIO, mas menos "drop-in" para S3 real.
- **Buckets/chaves (proposta):**
  - bucket `videos` → `channels/{channel_id}/videos/{video_id}/source.{ext}`
  - bucket `thumbnails` → `channels/{channel_id}/videos/{video_id}/thumb.jpg`
  - (ou 1 bucket `streamtube` com prefixos `videos/...` e `thumbnails/...` — decida 1 vs 2 buckets).
- **Provisionamento dos buckets:** criar no boot (idempotente) ou via container `mc` (MinIO client)
  no Compose. Decida e registre.

**Recomendação:** AWS SDK v3 + 1 bucket com prefixos (`videos/`, `thumbnails/`), criação idempotente no
startup do módulo de storage. **Confirmar via context7:** versões do `@aws-sdk/*` e API de presigner.

---

## TD-04 — Worker, extração de metadados e thumbnail

**Capability:** "Processamento automático do vídeo após upload (extração de duração e metadados)" +
"Geração automática de thumbnail a partir de um frame do vídeo".

- **Onde roda:** **container separado** `video-worker` no Compose (consistente com o diagrama).
  Pode reusar a mesma imagem do backend com `command` diferente (entrypoint que sobe só o `@Processor`),
  ou um app Nest standalone. ⚠️ **A imagem do worker precisa de `ffmpeg`** (`apt-get install -y ffmpeg`
  no Dockerfile) — traz `ffprobe` junto.
- **Como processa:**
  - Baixa o objeto do storage (ou usa stream/URL) → `ffprobe` para duração+metadados →
    `ffmpeg -ss <t> -frames:v 1` para o thumbnail → faz upload do thumbnail → atualiza a linha do vídeo
    (`status = ready`, `duration_seconds`, `metadata`, `thumbnail_key`).
- **Lib:** `fluent-ffmpeg` (wrapper) **ou** `child_process.spawn('ffprobe'/'ffmpeg')` direto.
  - `fluent-ffmpeg`: ergonômico, mas é um wrapper a mais para manter.
  - spawn direto: zero dependência extra, controle total, fácil de testar com binário real.

**Recomendação:** worker como container dedicado reusando a imagem do backend + `ffmpeg` instalado;
`@Processor` BullMQ; `ffprobe`/`ffmpeg` via `spawn` (ou `fluent-ffmpeg` se preferir ergonomia).
**Confirmar via context7:** se usar `fluent-ffmpeg`, a versão e tipos.

---

## TD-05 — Streaming (Range/206) e Download

**Capability:** "Reprodução via streaming (sem necessidade de download completo)" + "Download do vídeo
pelo usuário".

- **Opção A — Presigned GET (ou redirect 302) para o storage.** O MinIO/S3 serve `Range`/`206` nativamente.
  - Prós: a API não streama bytes; escala; alinha com "frontend streams from storage" do diagrama.
  - Contras: expõe URL temporária; controle de acesso fica na assinatura/expiração.
- **Opção B — API faz proxy de Range.** Endpoint lê o header `Range`, busca o intervalo no storage e
  responde `206 Partial Content`.
  - Prós: controle total de autorização/visibilidade na API (útil para `unlisted` nas fases futuras).
  - Contras: bytes passam pela API (custo de banda), mas **sob demanda por range** (não trava como o
    upload de 10GB).
- **Download:** `GET /videos/:public_id/download` → presigned GET com `response-content-disposition:
  attachment` (A) ou proxy com `Content-Disposition` (B).

**Recomendação:** para um desafio backend, **B (proxy de Range/206)** demonstra explicitamente o
critério "streaming sem download completo" e mantém a autorização na API; **A** é mais escalável.
Decida pelo que quer evidenciar. Em ambos, **streaming ≠ caminho do upload** — o risco de "travar a API"
é só no upload (TD-02), resolvido por presigned.

---

## TD-06 — URL única por vídeo

**Capability:** "URL única por vídeo, sem conflito com outros vídeos".

- **Opção A — `public_id` curto (nanoid base62, ~11 chars, estilo YouTube).** Coluna `public_id` unique.
  - Prós: URL curta/amigável; colisão improvável; índice unique garante unicidade.
  - Contras: precisa lib `nanoid` (ou gerar com `crypto`).
- **Opção B — UUID do próprio vídeo na URL.** Sem coluna extra.
  - Prós: zero lib, já é unique.
  - Contras: URL longa/feia; expõe o id interno.
- **Opção C — slug de título + sufixo.** 
  - Contras: colisões e necessidade de desambiguação; mais complexo. Descartável aqui.

**Recomendação:** **A (`public_id` nanoid + índice unique)**, com retry em colisão (mesmo padrão do
nickname na Fase 02). Atende "URL curta e única que nunca conflite" do §Pontos de Atenção.
**Confirmar via context7:** versão de `nanoid` compatível (atenção a ESM/CJS com NestJS 11/TypeORM).

---

## TD-07 — Ciclo de status e tratamento de falha

**Capability:** transversal a "pré-cadastro como rascunho", "processamento automático" e o entregável de
status.

- **Estados:** `draft` (criado no `upload-init`) → `processing` (enfileirado no `complete`) →
  `ready` (worker concluiu) | `failed` (worker falhou após esgotar tentativas).
- **Idempotência:** o job deve ser idempotente — reprocessar o mesmo vídeo não duplica thumbnail nem
  corrompe estado (use `video_id` como base da chave/idempotência).
- **Falha:** BullMQ com `attempts: 3` + `backoff` exponencial; ao esgotar, `OnQueueFailed` grava
  `status = failed` + `error_reason`. Opcional: endpoint de **retry** que re-enfileira (`failed → processing`).
- **Gatilho do processamento:** o `POST /videos/:id/complete` é o disparo explícito (mais testável que
  depender de bucket notifications do MinIO). Registre essa escolha.

**Recomendação:** estados acima + idempotência por `video_id` + `attempts/backoff` + `failed` com motivo.
Trigger explícito via `complete`.

---

## TD-08 — Contrato de Eventos/Mensagens (alimenta a Tech Spec `Events/Messages`)

**Capability:** transversal — a fila introduz a subseção **`### Events/Messages`** no plano (nova nesta
fase; sem ela o plano reprova).

- **Fila:** `video-processing`.
- **Job:** `process-video`.
- **Payload (proposta):** `{ videoId: string, storageKey: string, channelId: string }` — mínimo;
  o worker busca o resto no banco. Evite payload gordo.
- **Opções de job:** `attempts: 3`, `backoff: { type: 'exponential', delay: 1000 }`,
  `removeOnComplete`, `removeOnFail`.
- **Idempotência:** `jobId = videoId` (impede enfileiramento duplicado para o mesmo vídeo).
- **Resultado/efeito:** worker atualiza a linha `videos` (status/metadados/thumbnail) — não há "reply
  queue"; o estado vive no Postgres.

**Recomendação:** documente exatamente isto no `### Events/Messages` do `plan-build`
(nome da fila, nome do job, schema do payload, opções, idempotência, efeito em sucesso/falha).

---

## TD-09 — Estratégia de testes da infra

**Capability:** transversal — "Testes nos níveis adequados, verdes" + enunciado: "não simule o que dá
para rodar de verdade".

- **Unit (`*.spec.ts`):** serviços puros (geração de `public_id`, montagem de chaves, mapeamento de
  status) com colaboradores mockados.
- **Integração (`*.integration-spec.ts`):** contra **MinIO + Redis + Postgres reais** do Compose —
  presign + PUT + complete + enfileiramento; worker consumindo o job e atualizando o banco; `ffprobe`
  rodando sobre um vídeo de teste pequeno (fixture).
- **E2E (`*.e2e-spec.ts` via Supertest):** fluxo HTTP `init → (PUT no MinIO) → complete → status →
  stream(206) → download`, dentro do Compose (hosts internos: `minio:9000`, `redis`, `db`).
- ⚠️ **Não mocke** storage/fila/ffmpeg — viola o enunciado e enfraquece a suíte. Use um **fixture de
  vídeo minúsculo** no repositório para os testes de processamento (segundos, poucos KB).

**Recomendação:** pirâmide acima, infra real do Compose; fixture de vídeo pequeno versionado para os
testes de worker/ffprobe.

---

## Tabela-resumo (para conferir contra o TD oficial gerado)

| TD | Tema | Recomendação base | Principal armadilha |
|----|------|-------------------|---------------------|
| TD-01 | Fila | BullMQ + Redis | `host: redis`, não `localhost` |
| TD-02 | Upload 10GB | Presigned PUT + init/complete (multipart se quiser retomada) | host interno vs público do presign |
| TD-03 | Storage layout | AWS SDK v3, 1 bucket + prefixos, criação idempotente | criar bucket no boot |
| TD-04 | Worker/thumbnail | Container dedicado + ffmpeg na imagem; ffprobe/ffmpeg | ffmpeg ausente na imagem |
| TD-05 | Streaming/Download | Proxy Range/206 (ou presigned GET) | confundir com caminho de upload |
| TD-06 | URL única | `public_id` nanoid + unique + retry | ESM/CJS do nanoid |
| TD-07 | Status/falha | draft→processing→ready/failed, idempotente, retry | gatilho via complete (testável) |
| TD-08 | Events/Messages | fila `video-processing`, job `process-video`, payload mínimo, jobId=videoId | esquecer a Tech Spec nova |
| TD-09 | Testes infra | unit + integração + e2e contra Compose real | mockar o que roda de verdade |

> Lembrete final: estas são **recomendações de partida**. A skill `research` + `context7` produzem o
> documento oficial com as versões reais. Você decide e justifica cada TD — a pipeline cuida da
> rastreabilidade que o desafio exige.
