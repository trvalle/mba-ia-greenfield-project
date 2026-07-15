---
phase: 03
title: Upload e Processamento de Vídeos
status: active
date_created: 2026-06-25
sources_mtime:
  docs/project-plan.md: 2026-06-25T03:15:52Z
  docs/decisions/technical-decisions-phase-03-videos.md: 2026-06-25T21:52:54Z
---

# Phase 03 Context: Upload e Processamento de Vídeos

## Overview

Upload de arquivos grandes sem travar o sistema, processamento automático do vídeo e geração de URL única.

## Capabilities & Deliverables

**Capabilities (from Fase 03):**
- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Deliverables:** Upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/` (API), `video-worker/` (new container for FFmpeg processing), `next-frontend/` (deferred to later phases for upload UI and player)

## Technical Decisions (Decided)

All 8 technical decisions are in `DECIDED` status and ready for implementation.

| TD | Topic | Recommendation | Key Libraries |
|----|-------|-----------------|-----------|
| TD-01 | Queue Technology | BullMQ + Redis via @nestjs/bullmq | `@nestjs/bullmq@11.0.4`, `bullmq@5.79.1`, `redis` |
| TD-02 | Upload Strategy | Presigned PUT (init/complete pattern) | `@aws-sdk/client-s3@3.1075.0`, `@aws-sdk/s3-request-presigner@3.1075.0` |
| TD-03 | Storage Layout | AWS SDK v3 + single bucket with prefixes | `@aws-sdk/client-s3@3.1075.0`, `@aws-sdk/s3-request-presigner@3.1075.0` |
| TD-04 | Worker Container | Separate `video-worker` + FFmpeg via child_process | native `child_process.spawn()`, `ffmpeg` binary |
| TD-05 | Streaming (206) | API proxy with Range/206 handling | `@nestjs/common` StreamableFile |
| TD-06 | Unique URL | Base62-encoded 12-char ID (native crypto, zero dependencies) | native `crypto` |
| TD-07 | Status Lifecycle | 4-state model (draft → processing → ready/failed) | BullMQ + database schema |
| TD-08 | Message Contract | Queue `video-processing`, job `process-video` | `@nestjs/bullmq@11.0.4`, `bullmq@5.79.1` |

### TD-01: Queue Technology — BullMQ + Redis

Mandated by project rule `micro-use-queues.md`. Provides native retry logic, exponential backoff, idempotency via job deduplication, and Bull Board monitoring. Producer enqueues jobs in API; consumer runs as separate `@Processor` class in worker container. Redis introduced as new Docker Compose service; connection must use Docker Compose service name (`host: 'redis'`), never `localhost`.

**Key implication:** Architecture cleanly separates synchronous HTTP (API) from asynchronous processing (Worker); enables independent horizontal scaling.

### TD-02: Upload Strategy — Presigned PUT (Option A)

Three-step handshake: `POST /videos/upload-init` creates draft video and returns presigned PUT URL (1-hour expiration), client uploads file directly to MinIO/S3 (not through API), `POST /videos/:id/upload-complete` validates file exists and enqueues processing job. This approach keeps the 10GB payload out of the API, preventing memory exhaustion and HTTP worker blocking.

**Critical:** Presigned URLs must be signed with `S3_ENDPOINT_PUBLIC` (client-facing URL: `http://localhost:9000`), but generated from code running inside containers. Store two env vars:
- `S3_ENDPOINT_INTERNAL=http://minio:9000` (internal Docker service name)
- `S3_ENDPOINT_PUBLIC=http://localhost:9000` (external client endpoint for presigned URL generation)

**Key implication:** Scalable, testable, aligns with "sem travar a API" requirement. Option B (multipart presigned) can be adopted in Phase 04 if resumability becomes critical.

### TD-03: S3/MinIO Bucket Layout — AWS SDK v3 + Single Bucket with Prefixes

Use official AWS SDK v3 (not vendor-specific MinIO SDK) for portability. Single bucket `streamtube` with prefix-based organization:
- `videos/channels/{channel_id}/videos/{video_id}/source.{ext}` — original uploaded file
- `thumbnails/channels/{channel_id}/videos/{video_id}/thumb.jpg` — generated thumbnail

Bucket creation idempotent at startup (check with `headBucket`, create if missing).

**Key implication:** Drop-in compatibility between MinIO (dev) and AWS S3 (production); granular prefix patterns enable future IAM policies per channel.

### TD-04: Separate Worker Container — FFmpeg + BullMQ Processor

Create `video-worker` service in Docker Compose (same Node.js/NestJS image as API, plus `apt-get install ffmpeg`). Worker container runs `@Processor('video-processing')` decorated class, consuming jobs from Redis queue. Invokes ffprobe/ffmpeg via native `child_process.spawn()` (not fluent-ffmpeg, which is archived and unmaintained). Connects to PostgreSQL and MinIO using Docker Compose service names.

**Key implication:** Aligns with architecture diagram (separate Video Worker container); enables independent scaling and resource isolation; production-grade separation of concerns.

### TD-05: Video Streaming & Range Requests — API Proxy with Range/206

Endpoint `GET /videos/:public_id/stream` checks authorization, reads HTTP `Range` header, fetches byte interval from object storage, responds with `206 Partial Content` and `Content-Range` header. This path enforces per-request authorization checks, allowing fine-grained access control (e.g., unlisted videos in Phase 04). Trade-off: scalability cost vs. authorization clarity; direct presigned URLs (Option A) can optimize for performance in later phases if needed.

**Key implication:** Demonstrates HTTP-level Range/206 streaming mechanism; enables future access revocation for unlisted videos; presigned URLs (Option A) remains available as performance optimization path.

### TD-06: Unique Video URL Strategy — Base62 Public ID (Native Crypto Only)

Generate 12-character base62 alphanumeric `public_id` using native Node.js `crypto.randomBytes()` with base62 encoding. **Zero external dependencies; use native crypto exclusively.** Store in `videos.public_id` column with `UNIQUE NOT NULL` index. Collision probability negligible (~1 in 10^15); retry on constraint violation (theoretical edge case, max 5 retries). URLs: `GET /videos/{public_id}` (YouTube-style: `dQw4w9WgXcQ`).

**Key implication:** Short, shareable, friendly URLs without exposing UUID structure; native crypto approach is future-proof and avoids external dependency maintenance burden.

### TD-07: Video Status Lifecycle — 4-State Model

Four states: `draft` (created, awaiting upload), `processing` (job enqueued or executing), `ready` (metadata extracted, thumbnail generated, all done), `failed` (retries exhausted, error persisted). Idempotency via `jobId = videoId` prevents duplicate job enqueuing if `upload-complete` endpoint is called twice. BullMQ native `attempts: 3` + `backoff: { type: 'exponential', delay: 2000 }` handle retries; worker's `@OnQueueFailed()` updates status to `failed` and stores error reason.

**Atomic "ready" Transition:** Worker sets video status to `ready` as a **single atomic database transaction** that includes status update, duration_seconds, metadata (JSONB), and thumbnail_key. Status is visible to API clients immediately upon database commit (no eventual-consistency window).

**Key implication:** Observable progress for UI, recoverable on failure, idempotent by design. Database columns added: `status`, `error_reason`, `duration_seconds`, `metadata` (JSONB), `thumbnail_key`.

### TD-08: Queue Message Contract — `video-processing` Queue

Queue name: `video-processing`. Job name: `process-video`. Minimal payload: `{ videoId: string, storageKey: string, channelId: string }`. Job options: `jobId = videoId` (idempotency key), `attempts: 3`, `backoff: { type: 'exponential', delay: 2000 }`, `removeOnComplete: true`, `removeOnFail: false`. Idempotency guaranteed by job ID deduplication. Success: video status → `ready`, metadata + thumbnail stored. Failure after retries: status → `failed`, error recorded.

**Key implication:** Clear, testable message contract; required documentation for Phase 03 Technical Specification `### Events/Messages` section.

## Architecture & Integration Points

**Queue-based async processing:**
- API (producer): `POST /videos/:id/upload-complete` → enqueue job with `jobId = videoId`
- Redis: BullMQ queue (Docker Compose service `redis`)
- Worker (consumer): Separate `video-worker` container, `@Processor('video-processing')`

**Object storage:**
- MinIO (dev) or AWS S3 (prod), Docker Compose service `minio`
- Bucket: `streamtube` with prefixes
- Presigned URLs: signed with `S3_ENDPOINT_PUBLIC`, used by clients for direct upload/download

**Video processing:**
- ffprobe: Extract metadata (duration, resolution, codec, etc.)
- ffmpeg: Generate thumbnail from video frame
- All invoked via native `child_process.spawn()` in worker container

**Database:**
- PostgreSQL (Docker Compose service `db`)
- New table columns: `status`, `error_reason`, `duration_seconds`, `metadata`, `thumbnail_key`, `public_id` (UNIQUE)

**Docker Compose services (new/modified):**
- `redis`: BullMQ backend (new)
- `video-worker`: FFmpeg + worker processor (new)
- `minio`: S3-compatible object storage (existing from Phase 01, used in Phase 03)

## Inherited Conventions (from Phases 01–02)

**Authentication & Authorization:**
- JWT global guard: `@UseGuards(JwtAuthGuard)` on protected endpoints
- Refresh token rotation strategy (Phase 02/TD-03): tokens stored in DB, rotated on every refresh
- Public endpoints (e.g., video streaming) bypass auth guard or use permissive checks

**Error Handling:**
- Custom domain exception filter: response shape `{ statusCode: number, error: string, message: string }`
- Domain-specific error codes (e.g., `ERR_VIDEO_NOT_FOUND`, `ERR_PROCESSING_FAILED`)
- HTTP status codes: 400 (validation), 401 (auth), 403 (ownership), 404 (not found), 500 (server error)

**Validation:**
- Global `ValidationPipe` in `main.ts`: `transform: true`, `whitelist: true`, `forbidNonWhitelisted: true`
- DTO validation via `class-validator` decorators + `class-transformer` (Phase 02/TD-06)
- Validation errors propagate through exception filter

**Data Access:**
- Repository pattern: TypeORM repositories per entity (e.g., `VideosRepository`)
- `@InjectRepository(Video)` decorator for dependency injection
- Entity relationships via TypeORM decorators (`@OneToMany`, `@ManyToOne`, etc.)

**Database Migrations:**
- Versioned migration files: `src/migrations/{timestamp}-{description}.ts`
- Migration runner: `npx typeorm migration:run`
- Migrations use TypeORM entities and schema builders for type safety

**Configuration:**
- `@nestjs/config` with namespaced `registerAs()` factories (one per domain in `src/config/`)
- Env validation via Joi schema in `src/config/env.validation.ts`
- Config injection: `ConfigType<typeof xxxConfig>` + `@Inject(xxxConfig.KEY)`

## Testing Strategy

**Unit tests** (spec files, `describe` + `it` blocks):
- Service layer: storage operations (upload, download, presigned URL generation), queue producer logic, public ID generation with collision retry, video status transitions
- Mock external dependencies: S3 SDK, Redis, database repository
- Test error cases: storage unavailable, presigned URL expiration, collision on unique ID generation

**Integration tests** (`.integration.spec.ts`):
- Full flow: `POST /videos/upload-init` → presigned URL generation → `POST /videos/:id/upload-complete` → job enqueued in real BullMQ
- Video processor: consume job from real Redis, invoke ffprobe/ffmpeg (if available), update database
- Database: real PostgreSQL via Testcontainers or transactional rollback per test
- Storage: real MinIO container (Docker Compose test fixture)

**E2E tests** (`.e2e-spec.ts`):
- Full HTTP flow: authenticated user initiates upload, gets presigned URL, calls upload-complete, job queued
- Stream/download endpoints: Range request handling, 206 Partial Content response, Content-Range headers
- Error cases: unauthorized access, nonexistent video, storage unavailable
- Uses real API, real database, real MinIO, real Redis (all from Docker Compose)

**Test data & setup:**
- Use factory functions or database seeders to create test videos, channels, users
- Real Testcontainers for PostgreSQL (if not using transactional rollback)
- Mock ffprobe/ffmpeg in unit tests; real binaries available in integration/e2e tests (via worker container or test environment)

## Critical Implementation Notes

**Docker Networking — CRITICAL:**
- Inside containers, use Docker Compose service names: `db`, `redis`, `minio`
- Never use `localhost` or `127.0.0.1` for inter-container communication
- Environment variables for internal connections: `DB_HOST=db`, `REDIS_HOST=redis`, `S3_ENDPOINT_INTERNAL=http://minio:9000`
- Presigned URLs (for clients outside Compose): signed with `S3_ENDPOINT_PUBLIC=http://localhost:9000`

**FFmpeg Installation:**
- Worker Dockerfile: `RUN apt-get update && apt-get install -y ffmpeg`
- Binaries available: `ffmpeg` and `ffprobe`
- Consider image size: ~200-300 MB overhead for FFmpeg

**Queue Connection:**
- Redis connection: `redis://redis:6379` (service name, not localhost)
- BullMQ configuration in module: `registerQueue('video-processing', { connection: { host: 'redis', port: 6379 } })`

**Bucket Creation:**
- Idempotent at startup: `headBucket` → create if 404
- Both API and Worker containers must initialize buckets (or shared startup script)

**Presigned URL Consistency & Expiration:**
- Always use `S3_ENDPOINT_PUBLIC` for URL generation (clients need this)
- Always use `S3_ENDPOINT_INTERNAL` for SDK operations inside containers (API downloads for streaming, worker reads for processing)
- Mismatch will cause client to fail on presigned URL (points to wrong host)
- **Presigned URL expiration:** Configure via `PRESIGN_EXPIRATION_SECONDS` environment variable (default: 3600 seconds = 1 hour). Add to `env.validation.ts` Joi schema and `.env.example`. Use in S3 presigner: `expiresIn: parseInt(process.env.PRESIGN_EXPIRATION_SECONDS || '3600')`

**Error Recovery & Observability:**
- All errors from ffprobe/ffmpeg captured and logged
- Job failures automatically retried by BullMQ (up to 3 times)
- Failed jobs persisted in Redis queue for debugging (removeOnFail: false)
- Video status and error reason stored in database for UI/debugging

## Capability Coverage Verification

| Capability (literal from project-plan) | Covered by TD(s) | Remarks |
|---|---|---|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | TD-03, TD-04 | TD-03 defines bucket layout; TD-04 worker uploads thumbnails to storage |
| Serviço de processamento em segundo plano (filas) | TD-01, TD-08 | TD-01 chooses BullMQ/Redis; TD-08 defines message contract and idempotency |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | TD-02 | Presigned PUT strategy decouples upload from API, prevents memory exhaustion |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | TD-07 | Status lifecycle: draft state created in `upload-init` endpoint |
| Processamento automático do vídeo após upload (extração de duração e metadados) | TD-01, TD-04, TD-07, TD-08 | TD-01/TD-08 queue contract; TD-04 worker executes ffprobe; TD-07 status workflow |
| Geração automática de thumbnail a partir de um frame do vídeo | TD-04 | Worker uses ffmpeg to extract frame, saves to storage |
| URL única por vídeo, sem conflito com outros vídeos | TD-06 | Base62 public_id with UNIQUE constraint and collision retry |
| Reprodução via streaming (sem necessidade de download completo) | TD-05 | Range/206 streaming via API proxy; client can seek without full download |
| Download do vídeo pelo usuário | TD-05 | Download endpoint returns full file or presigned URL with attachment disposition |

All Fase 03 capabilities are covered by at least one technical decision. ✓

## Out of Scope (Phase 03)

- **Frontend upload/streaming UI:** Deferred to later phase when `next-frontend/` is initialized. Phase 03 focuses on backend API and worker infrastructure.
- **Advanced resumable uploads (multipart):** Option B (presigned multipart) is a future optimization if network resilience becomes critical. Phase 03 uses Option A (single presigned PUT).
- **Direct presigned URLs for streaming:** Option A (direct storage streaming) deferred to later phases for performance optimization. Phase 03 uses Option B (API proxy with Range/206) for authorization clarity.
- **Video transcoding/quality variants:** Out of scope; Phase 03 stores original file only. Future phases may add HLS/DASH streaming with multiple quality tiers.
- **Live streaming:** Out of scope; architecture assumes on-demand video upload/playback only.
- **Watermarking, DRM, or content protection:** Out of scope for MVP.

## Next Phase Dependency

**Phase 04 — Gerenciamento de Vídeos e Canal** depends on Phase 03 output:
- Video entity with `status`, `public_id`, `duration`, `thumbnail_key` columns must be finalized in Phase 03
- APIs for streaming and download (TD-05) become entry points for Phase 04's visibility settings (public/unlisted)
- Queue infrastructure (TD-01, TD-08) enables future background jobs (e.g., retry failed videos, re-encode variants)

**Phase 05 — Página de Visualização do Vídeo** depends on:
- Streaming endpoint from Phase 03/TD-05 (player consumes Range/206 responses)
- Unique `public_id` URLs from Phase 03/TD-06 (page routes on `/videos/{public_id}`)
- Video metadata (duration, thumbnail) populated by Phase 03 processing

---

## Summary

Phase 03 establishes backend infrastructure for robust video upload and processing. Eight technical decisions (all decided, ready for implementation) define:
1. **Queue technology** (BullMQ/Redis) for asynchronous job processing
2. **Upload strategy** (presigned PUT) to handle 10GB files without API memory impact
3. **Storage layout** (AWS SDK v3, single bucket, prefix-based organization)
4. **Separate worker container** (FFmpeg, BullMQ processor) for CPU-intensive metadata extraction and thumbnail generation
5. **Range/206 streaming** (API proxy) for per-request authorization control
6. **Unique video URLs** (base62 public IDs) with collision protection
7. **Status lifecycle** (draft → processing → ready/failed) with idempotency guarantees
8. **Message contract** (video-processing queue, process-video job) for clear, testable async communication

All decisions inherit authentication, error handling, validation, and repository patterns from Phases 01–02. Testing spans unit (mocked), integration (real containers), and E2E (full HTTP flow). Critical implementation focus: Docker Compose service names for networking, presigned URL endpoint routing (internal vs. external), and FFmpeg binary availability in worker container.
