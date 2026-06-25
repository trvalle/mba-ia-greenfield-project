---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-06-25
scope_description: "Backend foundation for video upload, processing, and streaming: queue infrastructure, large-file upload strategy, object storage layout, separate worker container, HTTP Range requests, unique video URLs, video status lifecycle, and message contract for background processing."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — Backend: upload endpoints, presigned URL generation, queue producer, stream/download handlers, video status lifecycle, error handling.
- `video-worker/` (new container) — Separate FFmpeg worker container: consumes queue jobs, extracts metadata with ffprobe, generates thumbnails, updates database.
- `next-frontend/` — Frontend deferred: upload UI, progress tracking, streaming player will be addressed in later phases when `next-frontend/` is initialized.

---

## TD-01: Queue Technology

**Scope:** Backend, Cross-layer (Producer in API, Consumer in Worker)

**Capability:** "Serviço de processamento em segundo plano (filas)"

**Context:** Phase 03 requires background job processing for video metadata extraction and thumbnail generation without blocking the HTTP request. The choice of queue technology impacts reliability (retry logic, idempotency), infrastructure (new Redis service), worker deployment (processor pattern), and observability. The project's `nestjs-best-practices` rule `micro-use-queues.md` explicitly mandates `@nestjs/bullmq` (BullMQ + Redis) as the standard for background job processing in NestJS applications.

**Options:**

### Option A: BullMQ via @nestjs/bullmq (Mandated Standard)
- Use `@nestjs/bullmq` (BullMQ + Redis backend). Producer enqueues jobs via `@InjectQueue('video-processing')`, consumer runs as separate `@Processor` decorated class via `WorkerHost` pattern. Retry, backoff, idempotency, and Bull Board monitoring are built-in.
- **Pros:**
  - **Mandated by repo rule** `micro-use-queues.md` — zero architectural conflict; aligns with project standards.
  - Retry and exponential backoff are native (`attempts: 3`, `backoff: { type: 'exponential' }`).
  - Idempotency via job deduplication key (`jobId: videoId` prevents duplicate enqueuing).
  - Bull Board dashboard for queue monitoring (`/admin/queues`).
  - Processor can run in same or separate container; clean separation via `@Processor('video-processing')`.
  - Extensive NestJS documentation and community examples.
- **Cons:**
  - Introduces **Redis** as a new dependency in Docker Compose (additional service + memory/CPU cost).
  - Slight complexity: connection config must use Docker Compose service name (`host: 'redis'`) — never `localhost`.

### Option B: pg-boss (PostgreSQL-based Queue)
- Fila em cima do PostgreSQL já existente, sem dependência de Redis. Jobs stored as rows in `job_queue` table, polled by worker.
- **Pros:**
  - Zero new infrastructure — uses existing PostgreSQL.
  - Transactional with business data (same database).
  - No additional memory footprint (Redis).
- **Cons:**
  - **Conflicts with repo rule** `micro-use-queues.md` — would trigger `ICC-N` validation error; not acceptable.
  - Throughput lower for heavy video jobs compared to BullMQ (Redis is in-memory).
  - Less idiomático em NestJS; fewer community patterns.

### Option C: Custom DIY Queue (LISTEN/NOTIFY or Polling)
- Implement queue logic manually using PostgreSQL `LISTEN/NOTIFY` or simple polling on a `jobs` table.
- **Pros:**
  - No external dependency.
- **Cons:**
  - Reinvent retry/backoff/idempotency from scratch — significant code debt.
  - Frágil: race conditions on job pickup, deadlock risk, no built-in monitoring.
  - More code to test; complex edge cases (job timeout, stale locks).
  - Unacceptable maintenance burden.

**Recommendation:** **Option A (BullMQ via @nestjs/bullmq).** Mandated by project rule; provides mature, production-ready job processing; retry and idempotency are native. Redis as a new service is acceptable infrastructure cost. Configure connection with Docker service name: `host: 'redis'`, never `localhost`.

**Libraries:**
- `@nestjs/bullmq@11.0.4` (explicit NestJS 11 support)
- `bullmq@5.79.1` (peer dependency, actively maintained, CommonJS + ESM)
- `redis` (Docker Compose service, any stable 6.x or 7.x)

**Decision:** **Option A** — BullMQ via @nestjs/bullmq + Redis. Producer enqueues jobs in API, consumer runs in separate video-worker container. Retry and exponential backoff are native via BullMQ. Connection uses Docker Compose service name (`host: 'redis'`), never `localhost`.

---

## TD-02: Upload Strategy for Large Files (up to 10GB)

**Scope:** Backend

**Capability:** "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance" + "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** Uploading 10GB files directly through the API would exhaust server memory and block HTTP workers. The project requirements emphasize not impacting performance and supporting resumption on connection failure. The upload must be decoupled from the HTTP request — the API receives a small request (metadata only), generates a credential for the client to upload directly to object storage, and initiates processing only after upload completion is confirmed.

**Options:**

### Option A: Presigned PUT (Single Request)
1. `POST /videos/upload-init` → creates video as `draft` status, generates random `storage_key`, returns presigned PUT URL (good for 1 hour).
2. Client makes `PUT` request directly to MinIO/S3 with full file binary (outside the API).
3. `POST /videos/:id/upload-complete` → validates object exists in storage via `headObject`, enqueues `process-video` job.
- **Pros:**
  - API never receives 10GB payload; memory-safe.
  - Handshake is explicit and testable: init → upload → complete.
  - Presigned URL is time-bounded and credential-scoped.
  - Aligns with §Pontos de Atenção requirement: "sem travar a API".
- **Cons:**
  - Single large PUT request cannot resume per-chunk; entire file must re-upload on connection failure.
  - Client-side implementation must handle timeout/retry for the entire file.

### Option B: Presigned Multipart Upload (Resumable)
1. `POST /videos/upload-init` → initiates S3 multipart upload, returns `uploadId` and array of presigned URLs (one per 100MB chunk).
2. Client uploads chunks in parallel via presigned URLs; can resume from last successful chunk.
3. `POST /videos/:id/upload-complete?uploadId=...&parts=[...]` → completes multipart, validates all parts, enqueues job.
- **Pros:**
  - **Resumable by chunk** — if chunk N fails, only chunk N needs re-upload (aligns with "retomar em caso de falha" §Pontos de Atenção).
  - Parallel chunk upload (improved upload speed for large files).
  - Resilient: network hiccup on chunk 50/100 doesn't reset the entire upload.
- **Cons:**
  - Handshake is more complex: init parts → upload parts (async, parallel) → complete multipart.
  - More endpoints and error cases: part upload failure, orphaned multipart abort, retry logic.
  - Client-side implementation is more intricate (part tracking, retry per part).

### Option C: tus Protocol (Dedicated Upload Server)
- Standalone tus server (open-source) handles resumable uploads. API delegates upload requests to tus server; tus persists state, handles retries.
- **Pros:**
  - Resumable by design; tus specification is battle-tested.
  - Separates upload logic from main API.
- **Cons:**
  - Introduces a new server + protocol outside the S3/presigned ecosystem.
  - Extra infrastructure complexity; out of scope for MVP phase.
  - Diverges from the planned S3-compatible storage (MinIO/S3).

**Recommendation:** **Option A as the piso funcional (minimum working solution), Option B if pursuing resilience.** Option A satisfies the literal requirement "sem travar a API" and is simpler to test end-to-end in Docker Compose. If the project prioritizes handling "retomar em caso de falha" explicitly, Option B (multipart presigned) is the S3-native path. Trade-off: **scope vs. robustness**. Recommend documenting the choice and noting that Option B can be added in Phase 04 if needed. For this phase, use **Option A** to minimize handshake complexity and testing surface.

**Critical Docker Constraint (applies to both A and B):**
- Presigned URL host routing: Worker and tests (inside Compose) connect to MinIO via `minio:9000` (internal service name). External clients connect via `localhost:9000` (or public domain in production). Presigned PUT URLs must be signed for the **public endpoint** (`S3_ENDPOINT_PUBLIC=http://localhost:9000`), but generated from code running in a container context. Store two env vars:
  - `S3_ENDPOINT_INTERNAL=http://minio:9000` (used by worker/tests for object operations)
  - `S3_ENDPOINT_PUBLIC=http://localhost:9000` (used in presigned URL generation for clients)

**Libraries:**
- `@aws-sdk/client-s3@3.1075.0` (CommonJS + ESM, dual-mode, stable latest)
- `@aws-sdk/s3-request-presigner@3.1075.0` (must match client-s3 version, released in lockstep)

**Decision:** **Option A** — Presigned PUT with explicit three-step handshake: `POST /videos/upload-init` (creates draft video, generates storage key, returns presigned PUT URL), client makes direct `PUT` to MinIO/S3, `POST /videos/:id/upload-complete` (validates object exists, enqueues job). Presigned URLs generated with `S3_ENDPOINT_PUBLIC` for external clients; internal operations (worker, tests) use `S3_ENDPOINT_INTERNAL` (Docker Compose service name).

---

## TD-03: S3/MinIO Bucket Layout & Client Configuration

**Scope:** Backend, Cross-layer (API reads/writes; Worker reads/writes; Frontend streams)

**Capability:** "Serviço de armazenamento de arquivos (vídeos e thumbnails)"

**Context:** Object storage must be configured for both the local development environment (MinIO in Docker Compose) and potential production (AWS S3). The choice of S3 client, bucket structure, and key naming scheme affects cost, organization, security, and scalability. The architecture diagram indicates "Object Storage (S3 or MinIO)" and notes frontend "streams from storage" — implying presigned/public access for playback.

**Options:**

### Option A: AWS SDK v3 + Single Bucket with Prefixes
- Use `@aws-sdk/client-s3` (v3.x) — works identically against MinIO and AWS S3 (drop-in replacement).
- Single bucket `streamtube` with prefix-based organization:
  - `videos/channels/{channel_id}/videos/{video_id}/source.{ext}` — original uploaded file
  - `thumbnails/channels/{channel_id}/videos/{video_id}/thumb.jpg` — generated thumbnail
- Bucket creation at startup via `createBucket` (idempotent — only creates if not exists).
- **Pros:**
  - AWS SDK v3 is stable, widely used, official AWS recommendation; no vendor lock-in for MinIO ↔ S3 swap.
  - Single bucket simplifies IAM policies (one bucket, granular key patterns).
  - Prefix-based organization is logical, easy to audit (`videos/*` vs `thumbnails/*`).
  - Idempotent creation avoids manual bucket provisioning.
  - Presigner works seamlessly in both AWS SDK v3 and MinIO.
- **Cons:**
  - Requires careful IAM policies if multi-tenant (policy per `channel_id` requires wildcard patterns).

### Option B: AWS SDK v3 + Two Separate Buckets
- Buckets: `streamtube-videos` (source files only) and `streamtube-thumbnails` (thumbnails only).
- **Pros:**
  - Clear separation of concerns; easier to manage retention policies per bucket (e.g., delete old thumbnails but keep videos).
  - Simpler IAM: one policy for videos bucket, one for thumbnails.
- **Cons:**
  - More buckets to manage/create at startup.
  - Slightly more code complexity (two client configurations or two bucket names in env).

### Option C: MinIO SDK directly (vendor-specific)
- Use `minio` npm package instead of AWS SDK. MinIO-specific API (e.g., `minioClient.fPutObject`).
- **Pros:**
  - Slightly more ergonomic for MinIO-only setups.
- **Cons:**
  - **Not drop-in for AWS S3** — would require code rewrites to migrate to production S3.
  - Locks into MinIO SDK; defeats "S3 or MinIO" flexibility.

**Recommendation:** **Option A (AWS SDK v3 + single bucket `streamtube` with prefixes).** Provides portability (MinIO ↔ S3 swap), clean organization, and idempotent startup. Use **Docker Compose service names** for internal connections: `S3_ENDPOINT_INTERNAL=http://minio:9000`, `S3_ENDPOINT_PUBLIC=http://localhost:9000`. Environment variables must be quoted if containing special characters.

**Bucket Creation & Initialization:**
Create buckets idempotently during application startup (e.g., in a `StorageModule` `onModuleInit`):
```typescript
async onModuleInit(): Promise<void> {
  const bucketName = 'streamtube';
  const exists = await this.s3Client.headBucket({ Bucket: bucketName }).catch(() => false);
  if (!exists) {
    await this.s3Client.createBucket({ Bucket: bucketName });
  }
}
```

**Libraries:**
- `@aws-sdk/client-s3@3.1075.0` (CommonJS + ESM, stable latest)
- `@aws-sdk/s3-request-presigner@3.1075.0` (paired with client-s3, released in lockstep)

**Decision:** **Option A** — AWS SDK v3 + single `streamtube` bucket with prefix-based organization: `videos/channels/{channel_id}/videos/{video_id}/source.{ext}` for originals, `thumbnails/channels/{channel_id}/videos/{video_id}/thumb.jpg` for thumbnails. Bucket creation idempotent at API/worker startup (via `headBucket` + `createBucket` if missing).

---

## TD-04: Separate Worker Container (FFmpeg/ffprobe)

**Scope:** Cross-layer (Worker container, communication via BullMQ queue)

**Capability:** "Processamento automático do vídeo após upload (extração de duração e metadados)" + "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Video processing (ffprobe metadata extraction, ffmpeg thumbnail generation) is CPU-intensive and can take seconds to minutes per file. Running this in the main API container would block HTTP workers. The architecture diagram explicitly shows a separate "Video Worker (FFmpeg)" container, allowing horizontal scaling and resource isolation. The worker consumes jobs from the BullMQ queue, processes asynchronously, and updates the database.

**Options:**

### Option A: Separate Container with FFmpeg + BullMQ Processor
- Create `video-worker` service in `docker-compose.yml` using the same Node.js/NestJS image as the API.
- Dockerfile includes `ffmpeg` and `ffprobe` binaries: `RUN apt-get install -y ffmpeg` (brings both tools).
- Worker container runs a `WorkerService` with `@Processor('video-processing')` decorator (BullMQ consumer pattern from `micro-use-queues`).
- Worker connects to Redis and PostgreSQL using Docker Compose service names (e.g., `redis`, `db`).
- **Pros:**
  - Aligns with architecture diagram (separate "Video Worker" container).
  - Scales independently: API and worker can run different instance counts.
  - Uses the same NestJS/BullMQ patterns — consistent codebase.
  - FFmpeg tools are first-class in the image.
  - Clean separation of concerns: API = HTTP + queue producer, Worker = job consumer + ffmpeg.
- **Cons:**
  - Worker container must include ffmpeg (adds ~200-300 MB to image).
  - Dockerfile build complexity: conditional inclusion of ffmpeg for API vs. worker (or accept larger API image).

### Option B: Worker as Separate Process in Same Container
- API and worker both run in the same container, as separate Node.js processes (via Supervisor or custom fork).
- **Pros:**
  - Single image; no duplication.
  - Simpler Dockerfile.
- **Cons:**
  - **Violates architecture diagram** — no separate container.
  - Harder to scale worker independently (if container scales, both processes scale together).
  - Debugging and logging more complex (two processes, one container).

### Option C: Lambda/Serverless Function for FFmpeg (AWS-specific)
- Offload processing to AWS Lambda or similar. Worker polls SQS for jobs, invokes Lambda.
- **Pros:**
  - Scales seamlessly; pay-per-use.
- **Cons:**
  - Out of scope for this phase (assumes AWS production); local Docker Compose dev breaks.
  - Over-engineering for MVP.

**Recommendation:** **Option A (separate `video-worker` container with FFmpeg).** Aligns with architecture diagram, enables independent scaling, and keeps concerns isolated. Accept the ~200MB image size for FFmpeg; it is a one-time Docker build cost. Use native Node.js `child_process.spawn()` directly to invoke FFmpeg/ffprobe — avoids the archived fluent-ffmpeg package and provides better control.

**Worker Implementation Pattern:**
```typescript
@Processor('video-processing')
export class VideoProcessor extends WorkerHost {
  async process(job: Job<VideoPayload>): Promise<void> {
    // 1. Download video from storage (or read presigned URL)
    // 2. ffprobe for metadata (duration, resolution, codec)
    // 3. ffmpeg -ss {t} -frames:v 1 for thumbnail
    // 4. Upload thumbnail to storage
    // 5. Update DB: status = 'ready', metadata, thumbnail_key
  }

  @OnQueueFailed()
  async onFailed(job: Job, error: Error): Promise<void> {
    // Update video: status = 'failed', error_reason
  }
}
```

**Docker Compose Service:**
```yaml
video-worker:
  build: .
  command: node dist/worker.js  # or custom startup
  environment:
    - NODE_ENV=development
    - DB_HOST=db
    - REDIS_HOST=redis
    - S3_ENDPOINT_INTERNAL=http://minio:9000
  depends_on:
    - db
    - redis
    - minio
```

**Libraries:**
- **Recommendation: Use native `child_process.spawn()` directly (Node.js built-in)**
  - Zero external dependencies
  - fluent-ffmpeg (v2.1.3) is archived/unmaintained (last update May 2025, 419 open issues)
  - Native approach provides more control, better error handling, and no maintenance risk

**Decision:** **Option A** — Separate `video-worker` container with FFmpeg binaries included (via `apt-get install ffmpeg` in Dockerfile). Worker runs `@Processor('video-processing')` decorated class with `WorkerHost` pattern, consuming jobs from BullMQ queue. Invokes ffprobe/ffmpeg via native `child_process.spawn()` (not fluent-ffmpeg, which is archived and unmaintained). Worker connects to database and storage using Docker Compose service names.

---

## TD-05: Video Streaming & Range Requests (206)

**Scope:** Backend

**Capability:** "Reprodução via streaming (sem necessidade de download completo)" + "Download do vídeo pelo usuário"

**Context:** Video playback requires HTTP Range requests (`206 Partial Content`) to stream video without forcing the client to download the entire file first. This applies to both browser playback (via `<video>` tag seeking) and manual downloads. The choice is between delegating Range handling to the storage service (via presigned URLs) or implementing Range logic in the API layer (proxy).

**Options:**

### Option A: Presigned GET URL (Direct Storage Streaming)
- API generates presigned GET URL with time-limited expiration (e.g., 1 hour).
- Frontend/client directly streams from MinIO/S3 URL; storage service natively handles Range/206 requests.
- No bytes pass through the API; bandwidth and CPU cost is zero for streaming.
- **Pros:**
  - Scalable: storage service handles Range/206 natively.
  - Zero API load for video streaming.
  - Simple: `return { url: presignedUrl }` endpoint.
  - Aligns with diagram: "Frontend streams from Object Storage".
  - Cost-effective: CDN can cache presigned URLs or put S3 behind CloudFront in production.
- **Cons:**
  - Presigned URL is temporary; client must request a new URL if stream lasts > 1 hour (rare for videos).
  - Less granular access control: authorization is only at URL expiration time; cannot revoke access mid-stream.

### Option B: API Proxy with Range Handling
- API endpoint `GET /videos/:public_id/stream` reads the `Range` header, fetches the byte interval from storage, responds with `206 Partial Content`.
- Full authorization check on every Range request (allows revoking access for unlisted videos in Phase 04).
- **Pros:**
  - Finer-grained authorization: can check video visibility/permissions on every Range request.
  - No temporary URLs; simpler client code (just request the same `/stream` endpoint multiple times).
  - Explicit control over video access in the API layer.
- **Cons:**
  - All bytes flow through the API; CPU/memory/bandwidth cost for streaming.
  - Slower than direct S3 streaming (API round-trip).
  - Does NOT scale as well (API is the bottleneck for popular videos).

### Option C: Hybrid (Presigned for Public, Proxy for Unlisted)
- Public videos use presigned URLs (Option A).
- Unlisted videos use API proxy (Option B) for access control.
- **Pros:**
  - Balanced: performance for public, control for unlisted.
- **Cons:**
  - Doubles implementation effort; two code paths.
  - More test coverage needed.

**Recommendation:** For a backend-focused phase, **Option B (API proxy with Range/206)** is more instructive and demonstrates explicit authorization control. It also aligns with "streaming without download" by showing the HTTP-level mechanism. However, for production scalability, Option A (presigned) is recommended. Document the trade-off in the TD: this phase prioritizes **authorization clarity** (Option B), knowing that Phase 05+ can optimize to direct presigned URLs (Option A) if needed.

**Implementation Pattern (Option B):**
```typescript
@Get(':public_id/stream')
async stream(
  @Param('public_id') publicId: string,
  @Headers('range') range?: string,
): Promise<StreamableFile> {
  // 1. Load video + authorize (check ownership, visibility)
  // 2. Get object metadata (size) from storage
  // 3. Parse Range header (or assume bytes=0-end if absent)
  // 4. Fetch byte range from storage
  // 5. Return 206 + Content-Range + Content-Length
}
```

**Download Endpoint (both A and B):**
```typescript
@Get(':public_id/download')
async download(
  @Param('public_id') publicId: string,
): Promise<StreamableFile | { url: string }> {
  // Option A: return presigned GET with attachment disposition
  // Option B: stream with Content-Disposition: attachment
}
```

**Libraries:**
- Built-in `StreamableFile` from `@nestjs/common` for response handling.
- AWS SDK v3 for `GetObjectCommand` with Range support.

**Decision:** **Option B** — API proxy with Range/206 handling. Endpoint `GET /videos/:public_id/stream` checks authorization (video visibility, ownership), reads `Range` header, fetches byte interval from storage, responds with `206 Partial Content`. Enables per-request authorization control. Download endpoint uses `Content-Disposition: attachment` for user downloads. Acknowledges trade-off: scalability cost vs. authorization clarity; presigned URLs (Option A) can be adopted in later phases for performance optimization.

---

## TD-06: Unique Video URL Strategy

**Scope:** Backend

**Capability:** "URL única por vídeo, sem conflito com outros vídeos"

**Context:** Each video must have a globally unique, short, and memorable URL for sharing and playback. The URL appears in database, frontend routes, and external links; it must never conflict with another video. The choice impacts database schema, URL length, SEO friendliness, and collision probability.

**Options:**

### Option A: Short Alphanumeric ID (nanoid or native crypto)
- Generate a short, unique `public_id` (e.g., 11-12 characters) using either:
  - **Sub-option A1:** `nanoid@3.3.7` with base62 alphabet (`0-9A-Za-z`) — CommonJS-compatible version; v4+ is ESM-only.
  - **Sub-option A2:** Native Node.js `crypto.randomBytes()` with base62 encoding — zero npm dependency, future-proof.
- Store in `videos.public_id` column with **UNIQUE index**.
- URL: `GET /videos/{public_id}` (short, friendly, no UUID verbosity).
- Collision retry on conflict: if a collision occurs during insert (< 1 in 10^15 probability), retry with a new ID.
- **Pros:**
  - Short, friendly URLs (YouTube-style: `dQw4w9WgXcQ`).
  - Base62 uses only alphanumeric characters (no special chars, URL-safe).
  - Collision probability is negligible (nanoid default: 21 chars = 10^41 possibilities).
  - Unique index guarantees no duplicates at DB level.
  - Retry on collision is simple and fast (collision is theoretical).
  - Native crypto approach (A2) avoids external dependency and works with CommonJS.
- **Cons:**
  - nanoid@3.3.7 (A1) will eventually need replacement as v3.x ages; crypto approach (A2) is future-proof.
  - Collision handling adds one edge case (needs test coverage).
  - No semantic meaning in ID (can't infer video creator, category, etc.).

### Option B: Use Video's UUID (Internal ID)
- Expose the `videos.id` (UUID) directly in URLs: `GET /videos/{id}`.
- **Pros:**
  - Zero collision risk: UUIDs are mathematically unique.
  - No extra column or index.
- **Cons:**
  - URLs are long and unfriendly: `/videos/550e8400-e29b-41d4-a716-446655440000` (36 chars).
  - Exposes internal database structure.
  - Not YouTube-style or shareable.

### Option C: Title-based Slug with Disambiguation
- Slug from video title + suffix (count or hash): `get-started-with-nextjs`, `get-started-with-nextjs-2`, etc.
- **Pros:**
  - SEO-friendly; semantic URL.
- **Cons:**
  - Collision handling is complex (must check for existing slugs, generate suffixes).
  - Title changes break old URLs (unless slug is immutable).
  - Special character handling (unicode, spaces → `-`).
  - More implementation effort for little gain in an MVP.

**Recommendation:** **Option A with Sub-option A2 (native crypto.randomBytes + base62 encoding).** Provides short, memorable URLs (YouTube-style), collision resistance, and zero external dependencies. Native approach is future-proof (no v3→v4 ESM migration concern like nanoid@3.3.7 has). If preferring a minimal npm package, use **Sub-option A1 (nanoid@3.3.7)** — the last CommonJS-compatible version. Use 12-character IDs (equivalent to YouTube length: `dQw4w9WgXcQ`).

**Database Schema:**
```sql
ALTER TABLE videos ADD COLUMN public_id VARCHAR(20) UNIQUE NOT NULL;
CREATE INDEX idx_videos_public_id ON videos(public_id);
```

**Generation & Retry Pattern:**
```typescript
const generatePublicId = customAlphabet(
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  12
);

async function createVideoWithPublicId(videoData: CreateVideoDto): Promise<Video> {
  let retries = 5;
  while (retries > 0) {
    const publicId = generatePublicId();
    try {
      return await this.videosRepository.save({
        ...videoData,
        public_id: publicId,
      });
    } catch (error) {
      if (error.code === '23505') { // UNIQUE violation
        retries--;
        continue;
      }
      throw error;
    }
  }
  throw new Error('Unable to generate unique public_id after retries');
}
```

**Libraries:**
- **Option A1:** `nanoid@3.3.7` (CommonJS-compatible; v4+ is ESM-only)
- **Option A2:** Native `crypto` (Node.js built-in, no package needed)

**Decision:** **Option A, Sub-option A2** — Generate `public_id` using native Node.js `crypto.randomBytes()` with base62 encoding (12 characters, YouTube-style). Store in `videos.public_id` column with `UNIQUE NOT NULL` index. Collision handling: catch `UNIQUE` constraint violation (PostgreSQL error code 23505), retry with a new ID (up to 5 retries; collision probability is negligible). Zero external dependencies; avoids nanoid v3 legacy support and v4 ESM migration concerns. URL: `GET /videos/{public_id}`.

---

## TD-07: Video Status Lifecycle & Error Handling

**Scope:** Backend, Cross-layer (API, Database, Worker)

**Capability:** Transversal — covers "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)", and implicit error handling for robustness.

**Context:** A video progresses through states from upload initiation to either successful processing or failure. Each state transition has prerequisites and side effects. The status lifecycle must be observable (for UI progress tracking), recoverable (retry failed videos), and idempotent (processing the same video twice must not corrupt state).

**States:**
- `draft` — Created in `POST /videos/upload-init`; awaiting file upload.
- `processing` — Enqueued in `POST /videos/:id/upload-complete`; job is in BullMQ queue or being processed by worker.
- `ready` — Worker finished successfully; metadata and thumbnail available.
- `failed` — Worker exhausted retry attempts; error reason recorded.

**Transitions:**
- `draft` → `processing` (on `upload-complete` endpoint call, not on file arrival).
- `processing` → `ready` (on worker success).
- `processing` → `failed` (on worker failure after `attempts` exhausted).
- `failed` → `processing` (optional: manual retry endpoint for later phases).

**Idempotency:**
- Job ID is `video_id` — prevents duplicate enqueuing if `upload-complete` is called twice for the same video.
- Worker uses `video_id` as idempotency key: if a job for the same video is retried, metadata extraction and thumbnail generation are re-run (safe, but CPU-costly; could optimize with a "last processed hash" field if needed).

**Failure Handling:**
- BullMQ `attempts: 3` + `backoff: { type: 'exponential', delay: 2000 }` — job retries up to 3 times with 2s, 4s, 8s delays.
- Worker's `@OnQueueFailed()` handler updates video status to `failed` and stores error reason (e.g., "invalid codec", "storage upload failed").
- API exposes optional `PATCH /videos/:id/retry` endpoint to manually re-queue a failed video (future phase).

**Database Schema:**
```sql
ALTER TABLE videos ADD COLUMN status VARCHAR(20) DEFAULT 'draft';
ALTER TABLE videos ADD COLUMN error_reason TEXT;
ALTER TABLE videos ADD COLUMN duration_seconds INT;
ALTER TABLE videos ADD COLUMN metadata JSONB;
ALTER TABLE videos ADD COLUMN thumbnail_key VARCHAR(255);
CREATE INDEX idx_videos_status ON videos(status);
```

**Recommendation:** Use the 4-state model above. Trigger processing transition via explicit `upload-complete` endpoint call (not via bucket notifications) for testability. BullMQ's native `attempts` and `backoff` handle retries. Document error reasons in the `error_reason` column for debugging and user feedback.

**Decision:** Approved — 4-state model: `draft` (video created, awaiting upload), `processing` (job enqueued, in queue or executing), `ready` (metadata extracted, thumbnail generated, all done), `failed` (retries exhausted, error stored). Transition to `processing` triggered explicitly by `POST /videos/:id/upload-complete` endpoint (not automatic on file arrival). Idempotency via `jobId = videoId` prevents duplicate job enqueuing. BullMQ `attempts: 3` + exponential backoff (2s, 4s, 8s) handle retries. Worker's `@OnQueueFailed()` updates video status to `failed` and persists `error_reason`. Database schema includes `status`, `error_reason`, `duration_seconds`, `metadata` (JSONB), `thumbnail_key`.

---

## TD-08: Queue Message Contract (Events/Messages)

**Scope:** Cross-layer (API producer, BullMQ queue, Worker consumer)

**Capability:** Transversal — "Serviço de processamento em segundo plano (filas)" with explicit message schema and idempotency guarantees (required for Technical Specification).

**Context:** The BullMQ queue sits between the API (producer) and Worker (consumer). The message contract defines job name, payload schema, retry options, and idempotency. A clear contract ensures robust, observable background processing and is required documentation for the Technical Specification `### Events/Messages` section in the Phase 03 implementation plan.

**Queue Definition:**
- **Queue Name:** `video-processing`
- **Job Name:** `process-video`

**Job Payload Schema:**
```typescript
interface VideoProcessingPayload {
  videoId: string;          // UUID of the video; used as idempotency key
  storageKey: string;       // Path in object storage: videos/channels/{channel_id}/videos/{video_id}/source.{ext}
  channelId: string;        // UUID of the channel (optional, but helps worker logs and audits)
}
```

**Job Options (BullMQ):**
```typescript
{
  jobId: payload.videoId,   // Idempotency key: prevents duplicate jobs for same video
  priority: 10,              // Standard priority (lower = higher priority)
  attempts: 3,               // Retry up to 3 times on failure
  backoff: {
    type: 'exponential',
    delay: 2000,             // Start with 2s delay, exponentially increase
  },
  removeOnComplete: true,    // Clean up successful jobs from queue
  removeOnFail: false,       // Keep failed jobs for debugging
}
```

**Producer (API):**
```typescript
async completeVideoUpload(videoId: string): Promise<void> {
  const video = await this.videosRepository.findOne(videoId);
  
  await this.videoQueue.add(
    'process-video',
    {
      videoId: video.id,
      storageKey: video.storage_key,
      channelId: video.channel_id,
    } satisfies VideoProcessingPayload,
    {
      jobId: video.id,  // Idempotency: same video_id = same job
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
    }
  );

  // Update status
  video.status = 'processing';
  await this.videosRepository.save(video);
}
```

**Consumer (Worker):**
```typescript
@Processor('video-processing')
export class VideoProcessor extends WorkerHost {
  async process(job: Job<VideoProcessingPayload>): Promise<void> {
    const { videoId, storageKey } = job.data;

    try {
      // 1. Download video from storage
      const videoPath = await this.downloadFromStorage(storageKey);

      // 2. Extract metadata (ffprobe)
      const metadata = await this.extractMetadata(videoPath);

      // 3. Generate thumbnail
      const thumbnailPath = await this.generateThumbnail(videoPath);

      // 4. Upload thumbnail
      const thumbnailKey = `${storageKey.replace(/source\.\w+$/, '')}thumb.jpg`;
      await this.uploadToStorage(thumbnailPath, thumbnailKey);

      // 5. Update database
      await this.updateVideoStatus(videoId, {
        status: 'ready',
        duration_seconds: metadata.duration,
        metadata: metadata,
        thumbnail_key: thumbnailKey,
      });

      // Cleanup temp files
      await this.cleanup(videoPath, thumbnailPath);
    } catch (error) {
      this.logger.error(`Video processing failed for ${videoId}: ${error.message}`);
      throw error; // BullMQ will retry
    }
  }

  @OnQueueFailed()
  async onQueueFailed(job: Job<VideoProcessingPayload>, error: Error): Promise<void> {
    this.logger.error(`Job ${job.id} failed after ${job.attemptsMade} attempts: ${error.message}`);
    
    // Record failure in database
    await this.updateVideoStatus(job.data.videoId, {
      status: 'failed',
      error_reason: error.message,
    });
  }
}
```

**Idempotency Guarantee:**
- `jobId = videoId` ensures that if `upload-complete` is called twice for the same video, only one job is created in the queue (BullMQ deduplicates by job ID).
- Worker is idempotent: reprocessing the same `videoId` re-extracts metadata and regenerates the thumbnail (safe but CPU-costly; OK for Phase 03, can optimize later with a "processed hash" if needed).

**Documentation for Technical Specification (Events/Messages section):**
```markdown
### Events/Messages

#### Video Processing Queue

**Queue Name:** `video-processing`

**Job Name:** `process-video`

**Payload Schema:**
```json
{
  "videoId": "uuid-string",
  "storageKey": "videos/channels/{channel_id}/videos/{video_id}/source.mp4",
  "channelId": "uuid-string"
}
```

**Options:**
- `jobId`: Set to `videoId` for idempotency
- `attempts`: 3
- `backoff`: Exponential, starting at 2000ms
- `removeOnComplete`: true
- `removeOnFail`: false

**Idempotency:** Idempotent by `videoId`; duplicate enqueuing is prevented by job ID deduplication.

**Success Effect:** Video status → `ready`; metadata and thumbnail stored in database and object storage.

**Failure Effect:** After 3 retries, video status → `failed`; error reason recorded in `error_reason` column.
```

**Recommendation:** Use the contract above. Document in Phase 03's Technical Specification under `### Events/Messages` with exact queue name, job name, payload schema, and retry strategy. BullMQ job IDs ensure idempotency; no additional deduplication logic needed.

**Libraries:**
- `@nestjs/bullmq` (BullMQ integration)
- `bullmq` (peer dependency)

**Decision:** Approved — Queue `video-processing`, job name `process-video`. Payload: `{ videoId: string, storageKey: string, channelId: string }` (minimal, focused on video identity and location). Job options: `jobId = videoId` (idempotency key), `attempts: 3`, `backoff: { type: 'exponential', delay: 2000 }`, `removeOnComplete: true`, `removeOnFail: false`. Idempotency guaranteed by job ID deduplication: calling `upload-complete` twice for the same video enqueues the job only once. Success: video status → `ready`, metadata + thumbnail stored. Failure after retries: status → `failed`, error recorded. Document in Phase 03 Tech Spec under `### Events/Messages` section.

---

## Summary Table

| TD | Topic | Recommendation | Key Libraries/Infrastructure |
|----|-------|-----------------|-----|
| TD-01 | Queue Technology | BullMQ + Redis (@nestjs/bullmq) | `@nestjs/bullmq@11.0.4`, `bullmq@5.79.1`, `redis` |
| TD-02 | Upload Strategy | Presigned PUT + init/complete (Option A) | `@aws-sdk/client-s3@3.1075.0`, `@aws-sdk/s3-request-presigner@3.1075.0` |
| TD-03 | Storage Layout | AWS SDK v3 + single bucket + prefixes | `@aws-sdk/client-s3@3.1075.0`, `@aws-sdk/s3-request-presigner@3.1075.0` |
| TD-04 | Worker Container | Separate `video-worker` + FFmpeg | native `child_process.spawn()` + `ffmpeg` binary |
| TD-05 | Streaming (206) | API proxy with Range/206 (Option B) | `@nestjs/common` StreamableFile |
| TD-06 | Unique URL | nanoid@3.3.7 (CommonJS) or native crypto base62 | `nanoid@3.3.7` OR native `crypto` |
| TD-07 | Status Lifecycle | 4-state model (draft → processing → ready/failed) | BullMQ (built-in) + database schema |
| TD-08 | Message Contract | Queue `video-processing`, job `process-video`, payload minimal, idempotency by `videoId` | `@nestjs/bullmq@11.0.4` |

---

## Critical Implementation Notes (Docker Compose & Environment)

1. **Connection Strings:** All services in containers use Docker Compose service names, never `localhost`.
   - `DB_HOST=db` (PostgreSQL container)
   - `REDIS_HOST=redis` (Redis container)
   - `S3_ENDPOINT_INTERNAL=http://minio:9000` (MinIO container, for API and worker)
   - `S3_ENDPOINT_PUBLIC=http://localhost:9000` (presigned URLs for clients outside Compose)

2. **FFmpeg Installation:** Worker Dockerfile must include `RUN apt-get install -y ffmpeg` to ensure `ffmpeg` and `ffprobe` are available.

3. **Bucket Creation:** Idempotent bucket creation on storage module initialization (not via separate `mc` client or manual provisioning).

4. **Testing:** Unit tests mock queue/storage; integration tests use real MinIO + Redis + PostgreSQL from Compose; e2e tests exercise the full flow via HTTP (presigned upload, complete, stream).

5. **Error Handling:** Inherits Phase 02's error contract (`{ statusCode, error, message }`); video-specific errors (invalid codec, storage unavailable) recorded in `error_reason` for observability.

---

## Decisions Pending User Review

All technical decisions above are marked `_[pending]_` and await explicit user review and authorization before implementation. The recommendations are based on:

- Official library documentation (via context7 for NestJS 11 + TypeORM 0.3.28 compatibility)
- Phase 03 capability bullets from `docs/project-plan.md`
- Existing project constraints (CLAUDE.md, CLAUDE.md project-instructions, `nestjs-best-practices` rules)
- Architecture diagram (software-arch.mermaid)
- Input research document (research-input-fase03-decisoes-tecnicas.md)

Each TD documents trade-offs clearly; users may choose alternatives if justified, with understanding of pros/cons.
