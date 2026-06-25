---
phase: 03
title: Library References — Phase 03: Upload e Processamento de Vídeos
date_created: 2026-06-25
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-06-25T18:54:11-03:00"
---

# Phase 03 Library References

## Overview

Phase 03 introduces backend infrastructure for video upload, processing, and streaming. Four new npm packages are added to support queue-based job processing (BullMQ), presigned URL generation for large-file uploads (AWS SDK v3), and Redis as the queue backend. System-level dependencies (FFmpeg/ffprobe) and Docker Compose services (Redis) are documented separately below. Notably, `nanoid` was considered for URL ID generation but rejected in favor of native Node.js `crypto.randomBytes()` to eliminate external dependencies and ensure future compatibility.

## NPM Dependencies (New)

### @nestjs/bullmq@11.0.4

- **npm URL:** https://www.npmjs.com/package/@nestjs/bullmq/v/11.0.4
- **GitHub:** https://github.com/nestjs/bull
- **License:** MIT
- **Description:** Official NestJS integration module for BullMQ, a fast and reliable Redis-based message queue system. Provides decorators (`@Processor`, `@InjectQueue`), `WorkerHost` base class, and queue event handlers for background job processing within NestJS applications.
- **Rationale:** Mandated by project rule `micro-use-queues.md`. Provides native NestJS integration for background video processing jobs (metadata extraction, thumbnail generation), enabling producer (API) and consumer (worker) patterns. Supports job retries, exponential backoff, idempotency via job IDs, and Bull Board monitoring dashboard.
- **Constraints/Notes:**
  - Peer dependency on `bullmq@5.79.1` (must be installed alongside)
  - Requires Redis (Docker Compose service: `redis:7` or later)
  - All NestJS 11.0.1 compatible; no breaking changes
  - CommonJS + ESM support
  - Connection config uses Docker Compose service names (e.g., `host: 'redis'`), never `localhost`
  - Processor classes must extend `WorkerHost` and use `@Processor(queueName)` decorator
  - Job options: `jobId` for idempotency, `attempts` for retries, `backoff` for exponential backoff

### bullmq@5.79.1

- **npm URL:** https://www.npmjs.com/package/bullmq/v/5.79.1
- **GitHub:** https://github.com/taskforcesh/bullmq
- **License:** MIT
- **Description:** Fast, reliable Redis-based distributed message queue for Node.js. Provides job scheduling, retries with exponential backoff, concurrency control, job priorities, parent-child dependencies, rate limiting, and event streams. Core library underlying `@nestjs/bullmq`.
- **Rationale:** Peer dependency required by `@nestjs/bullmq`. Phase 03 relies on BullMQ's native retry logic (`attempts`), exponential backoff, idempotency via job deduplication, and event handlers (`@OnQueueFailed`, `@OnWorkerEvent`) for robust video processing job handling.
- **Constraints/Notes:**
  - CommonJS + ESM dual support (fully compatible with Node.js 18+)
  - Requires Redis backend (not PostgreSQL or other queue backends)
  - Cross-language compatible: Elixir, Rust, Python implementations share identical Lua scripts and Redis data structures
  - Version 5.79.1 is stable and actively maintained (released 2025)
  - Job options enforce atomicity: all retry/backoff/removal behavior is Redis-backed
  - Bull Board integration available for queue monitoring

### @aws-sdk/client-s3@3.1075.0

- **npm URL:** https://www.npmjs.com/package/@aws-sdk/client-s3/v/3.1075.0
- **GitHub:** https://github.com/aws/aws-sdk-js-v3
- **License:** Apache-2.0
- **Description:** AWS SDK v3 modular S3 client for Node.js. Provides S3 operations (GetObject, PutObject, HeadBucket, CreateBucket, etc.) with native TypeScript support, middleware stack, and request/response streaming. Works identically with MinIO (S3-compatible object storage) and AWS S3.
- **Rationale:** Phase 03 uses presigned URL generation for large-file uploads (up to 10GB) and streaming downloads. AWS SDK v3 is the official, vendor-agnostic choice (works with both MinIO and AWS S3); it is stable, widely used, and provides drop-in compatibility for dev (MinIO) → prod (S3) migrations without code changes.
- **Constraints/Notes:**
  - Must be paired with `@aws-sdk/s3-request-presigner@3.1075.0` (released in lockstep)
  - CommonJS + ESM dual support (fully compatible with TypeScript strict mode)
  - Connection config uses Docker Compose service names internally: `S3_ENDPOINT_INTERNAL=http://minio:9000` (for API and worker operations); presigned URLs use public endpoint: `S3_ENDPOINT_PUBLIC=http://localhost:9000` (for clients outside Compose)
  - Supports presigned GET/PUT URLs with time-limited expiration (e.g., 1 hour)
  - Idempotent bucket creation via `headBucket` → `createBucket` pattern in `StorageModule.onModuleInit()`
  - Supports Range requests for streaming (`206 Partial Content`)

### @aws-sdk/s3-request-presigner@3.1075.0

- **npm URL:** https://www.npmjs.com/package/@aws-sdk/s3-request-presigner/v/3.1075.0
- **GitHub:** https://github.com/aws/aws-sdk-js-v3
- **License:** Apache-2.0
- **Description:** Utility package for AWS SDK v3 that generates presigned URLs for S3 operations. Allows temporary, credential-scoped access to S3 operations without exposing long-term AWS credentials. Works identically with MinIO presigned URL generation.
- **Rationale:** Phase 03 implements presigned PUT URLs for client uploads and presigned GET URLs for streaming/downloads. The presigner decouples the API from receiving large file payloads, enabling 10GB+ uploads directly to storage without blocking HTTP workers. Credentials are signed via AWS SigV4; presigned URLs are time-bounded (e.g., 1 hour expiration) and bucket/key-scoped.
- **Constraints/Notes:**
  - Must match `@aws-sdk/client-s3` version exactly (released in lockstep)
  - Requires `getSignedUrl()` function from presigner: `getSignedUrl(s3Client, command, { expiresIn })` pattern
  - CommonJS + ESM dual support
  - Supports custom signable headers (e.g., `content-type`) for multipart integrity
  - Can be initialized by spreading config from existing `S3Client`: `new S3RequestPresigner({ ...s3.config })`
  - Presigned URLs generated with `S3_ENDPOINT_PUBLIC` are safe for external clients; internal operations use `S3_ENDPOINT_INTERNAL`

## System Dependencies

### ffmpeg

- **Type:** System binary (not npm package)
- **Installation:** `RUN apt-get update && apt-get install -y ffmpeg` (in worker Dockerfile)
- **Included Tools:** ffmpeg (video encoding/transcoding) + ffprobe (metadata extraction)
- **Rationale:** Phase 03 worker container must extract video metadata (duration, resolution, codec) and generate thumbnails without external services. FFmpeg is the industry-standard, open-source video processing toolkit. Installed in the `video-worker` container only (API container does not need it, reducing image size). Invoked via native Node.js `child_process.spawn()` (not fluent-ffmpeg, which is archived and unmaintained).
- **Used in:** `video-worker` service for:
  - **ffprobe:** Extract metadata (duration, codec, resolution, frame rate) from uploaded video files
  - **ffmpeg:** Generate thumbnail image (single frame at 5s mark) for display in UI

### ffprobe

- **Type:** Included with ffmpeg binary
- **Installation:** Automatically installed as part of `apt-get install ffmpeg`
- **Rationale:** Lightweight companion tool bundled with FFmpeg; extracts video metadata without decoding the entire file. Used in worker's metadata extraction phase before thumbnail generation.
- **Used in:** `video-worker` service for metadata extraction (duration, resolution, codec, frame rate)

## Infrastructure Services (Docker Compose)

### Redis

- **Type:** Docker Compose service
- **Image:** `redis:7` (or later stable version)
- **Service Name (in docker-compose.yml):** `redis`
- **Connection (inside containers):** `redis://redis:6379` (Docker DNS resolution; service name as hostname)
- **Port (host access):** `6379` (for dev debugging only; not needed for inter-container communication)
- **Rationale:** BullMQ requires Redis as its backend for job storage, queue state, and atomic operations. Redis is in-memory, high-performance, and provides Lua scripting for atomic job transitions (enqueue, retry, dequeue, complete, fail). Introduces new infrastructure but enables horizontal worker scaling and decouples job processing from the API request cycle.
- **Configuration:**
  - No authentication required in local dev (Compose network isolation is sufficient)
  - Memory policy: `maxmemory-policy=noeviction` (keep all job data; alert if approaching limit)
  - Persistence: RDB snapshots via `save 900 1` (save after 900s if 1+ key changed) — safe for dev/test, optional in prod
- **BullMQ Integration:**
  - NestJS connection: `BullModule.forRoot({ connection: { host: 'redis', port: 6379 } })`
  - Queue creation: `BullModule.registerQueue({ name: 'video-processing' })`
  - Processor connects automatically via `@Processor('video-processing')` decorator

## Libraries Considered But Not Selected

### nanoid

- **Status:** CONSIDERED in TD-06, but REJECTED in favor of native crypto
- **Reason:** Phase 03 mandates native Node.js `crypto.randomBytes()` for public ID generation (zero external dependencies, future-proof against ESM migration). nanoid@3.3.7 is the last CommonJS-compatible version; v4+ is ESM-only and introduces breaking changes. Using native crypto eliminates the library upgrade burden and ensures the URL ID generation logic never depends on npm package stability.
- **Alternative Used:** Native `crypto.randomBytes(6).toString('base62')` with 12-character IDs (equivalent to YouTube's length). Collision probability: negligible (< 1 in 10^15). Retry on UNIQUE constraint violation (PostgreSQL error 23505) if collision occurs (theoretical edge case).
- **Evidence:** TD-06, Recommendation section, Option A Sub-option A2

## Version Compatibility

All versions verified for compatibility with:
- **NestJS:** 11.0.1 (from nestjs-project/package.json)
- **TypeORM:** 0.3.28 (from nestjs-project/package.json)
- **Node.js:** 18+ (LTS recommended; project uses node:22 in Docker)
- **CommonJS support:** Yes (all packages support both CommonJS and ESM)
- **PostgreSQL:** 17 (for video entity storage and idempotency tracking)
- **Redis:** 7+ (service dependency for BullMQ backend)
- **MinIO:** Latest (S3-compatible storage, used in local dev; AWS S3 used in prod)

## Integration Notes

### BullMQ Queue Setup (API Module)

```typescript
// In ApiModule or dedicated QueueModule
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';

BullModule.forRootAsync({
  useFactory: (configService: ConfigService) => ({
    connection: {
      host: configService.get('REDIS_HOST', 'redis'),
      port: configService.get('REDIS_PORT', 6379),
    },
  }),
  inject: [ConfigService],
}),
BullModule.registerQueue({
  name: 'video-processing',
}),
```

### S3 Client Configuration

```typescript
// In StorageModule
import { S3Client } from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';

const s3Client = new S3Client({
  region: 'us-east-1',
  endpoint: configService.get('S3_ENDPOINT_INTERNAL'),
  credentials: {
    accessKeyId: configService.get('S3_ACCESS_KEY_ID'),
    secretAccessKey: configService.get('S3_SECRET_ACCESS_KEY'),
  },
  forcePathStyle: true, // Required for MinIO
});
```

### Presigned URL Generation

```typescript
// In UploadService
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PutObjectCommand } from '@aws-sdk/client-s3';

const presignedUrl = await getSignedUrl(
  s3Client,
  new PutObjectCommand({
    Bucket: 'streamtube',
    Key: `videos/channels/${channelId}/videos/${videoId}/source.mp4`,
    ContentType: 'video/mp4',
  }),
  { expiresIn: 3600 } // 1 hour
);
```

### FFmpeg/ffprobe Invocation (Worker)

```typescript
// In VideoProcessor (worker)
import { spawn } from 'child_process';

async extractMetadata(videoPath: string): Promise<any> {
  const metadata = await new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration,codec_type:stream=duration,codec_name,width,height',
      '-of', 'json',
      videoPath,
    ]);
    
    let output = '';
    ffprobe.stdout.on('data', (data) => { output += data; });
    ffprobe.on('close', (code) => {
      if (code === 0) resolve(JSON.parse(output));
      else reject(new Error(`ffprobe exited with code ${code}`));
    });
  });
  
  return metadata;
}
```

## Docker Compose Environment Variables

Phase 03 introduces these new environment variables (add to `.env`):

```dotenv
# Redis (queue backend)
REDIS_HOST=redis
REDIS_PORT=6379

# S3/MinIO (object storage)
S3_ENDPOINT_INTERNAL=http://minio:9000
S3_ENDPOINT_PUBLIC=http://localhost:9000
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin
S3_REGION=us-east-1
```

All container-to-container connections must use `REDIS_HOST=redis` and `S3_ENDPOINT_INTERNAL` (service names). Presigned URLs for clients use `S3_ENDPOINT_PUBLIC`.

## Cross-Cutting Concerns

### Idempotency

- **Job enqueuing:** BullMQ prevents duplicate jobs via `jobId`. Phase 03 uses `jobId: videoId` to ensure calling `/videos/:id/upload-complete` twice enqueues the job only once.
- **Storage operations:** S3/MinIO PUT and HEAD operations are idempotent by nature (overwriting or checking existence is safe).
- **Database updates:** Worker uses video status transitions (draft → processing → ready/failed) to track progress; status checks are atomic per job.

### Error Handling

- **Job retry:** BullMQ `attempts: 3` + `backoff: { type: 'exponential', delay: 2000 }` retries failed jobs with 2s, 4s, 8s delays.
- **Failure recording:** Worker's `@OnQueueFailed()` handler updates video status to `failed` and stores error reason (e.g., "invalid codec", "storage full").
- **API errors:** Inherit Phase 02's error contract `{ statusCode, error, message }` for HTTP responses.

### Testing

- **Unit tests:** Mock BullMQ queue, S3 client, FFmpeg spawning. Use `jest.mock()` for external dependencies.
- **Integration tests:** Use real Redis + MinIO + PostgreSQL from docker-compose. Initialize test-specific queues and buckets.
- **E2E tests:** Exercise full flow: presigned PUT, upload-complete, streaming via HTTP Range requests. Use real containers.
- **Test data:** Seed minimal test videos (< 1MB) in `src/database/seeds/` for repeatability.

---

## Changelog

### 2026-06-25 — Initial

- Documented 4 new npm packages: `@nestjs/bullmq@11.0.4`, `bullmq@5.79.1`, `@aws-sdk/client-s3@3.1075.0`, `@aws-sdk/s3-request-presigner@3.1075.0`
- Documented system dependencies: ffmpeg/ffprobe binaries
- Documented Docker Compose service: Redis
- Explicitly noted nanoid rejection (TD-06, Option A Sub-option A2)
- Verified all packages for CommonJS support and NestJS 11.0.1 compatibility
- Included Docker Compose environment variables and integration patterns
