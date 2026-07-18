---
phase: 03
title: Upload e Processamento de Vídeos
date_created: 2026-06-25
status: active
---

# Phase 03 Implementation Plan: Upload e Processamento de Vídeos

## Objective

Deliver the complete video upload, processing, and streaming infrastructure — enabling users to upload videos up to 10GB without API performance impact, automatically extract metadata, generate thumbnails, serve via HTTP Range requests, and establish unique, shareable video URLs. Establishes backend foundation for video-centric capabilities in subsequent phases.

---

## Step Implementations

### SI-03.0 — Infrastructure Setup (Must Run First)

**Description:** Initialize Docker Compose services, configure environment variables, install base npm dependencies, and add FFmpeg to the worker container. This step must execute before any other Phase 03 step because it provisions Redis, MinIO, and the worker container that all other steps depend on.

**Technical actions:**

- Update `nestjs-project/docker-compose.yml`:
  - Add `redis` service: image `redis:7`, container name `streamtube-redis`, port `6379:6379`, command `redis-server --appendonly yes --maxmemory-policy noeviction`
  - Add `video-worker` service: build from `nestjs-project/Dockerfile` (same context as API), container name `streamtube-video-worker`, environment vars: `NODE_ENV=development`, `DB_HOST=db`, `DB_PORT=5432`, `DB_USER=streamtube_user`, `DB_PASSWORD=streamtube_pass`, `DB_NAME=streamtube_dev`, `REDIS_HOST=redis`, `REDIS_PORT=6379`, `S3_ENDPOINT_INTERNAL=http://minio:9000`, `S3_ACCESS_KEY_ID=minioadmin`, `S3_SECRET_ACCESS_KEY=minioadmin`, `S3_REGION=us-east-1`, `PRESIGN_EXPIRATION_SECONDS=3600`. Command: `node dist/worker.js` (or create dedicated entry). Depends on: `db`, `redis`, `minio`. Network: `streamtube` (shared with API and DB)
  - Update API service to expose Redis/MinIO env vars (no functional change; already in `.env`)
  - Ensure `minio` service exists from Phase 02 context (MinIO is running; Phase 03 will use it for video storage)

- Update `nestjs-project/Dockerfile`:
  - Add before final RUN: `RUN apt-get update && apt-get install -y ffmpeg` (installs ffmpeg + ffprobe binaries, ~200-300MB image size increase)
  - Ensure `EXPOSE` includes all needed ports; no change needed for video-worker since it only connects to services, not inbound

- Update `nestjs-project/src/config/env.validation.ts` — add to Joi schema:
  - `REDIS_HOST` (string, default `'redis'`, required in Docker)
  - `REDIS_PORT` (number, default `6379`)
  - `S3_ENDPOINT_INTERNAL` (string, required — Docker Compose service name: `http://minio:9000`)
  - `S3_ENDPOINT_PUBLIC` (string, required — client-facing URL: `http://localhost:9000`)
  - `S3_BUCKET` (string, default `'streamtube'`)
  - `S3_ACCESS_KEY_ID` (string, required)
  - `S3_SECRET_ACCESS_KEY` (string, required)
  - `S3_REGION` (string, default `'us-east-1'`)
  - `PRESIGN_EXPIRATION_SECONDS` (number, default `3600`)

- Update `.env.example` — add all 8 new variables with comments explaining Docker vs. presigned URL endpoints:
  ```
  # Redis (BullMQ backend)
  REDIS_HOST=redis
  REDIS_PORT=6379
  
  # S3/MinIO (object storage)
  # INTERNAL: used by API and worker containers for operations
  # PUBLIC: used in presigned URLs for clients outside Compose
  S3_ENDPOINT_INTERNAL=http://minio:9000
  S3_ENDPOINT_PUBLIC=http://localhost:9000
  S3_BUCKET=streamtube
  S3_ACCESS_KEY_ID=minioadmin
  S3_SECRET_ACCESS_KEY=minioadmin
  S3_REGION=us-east-1
  
  # Presigned URL expiration (seconds)
  PRESIGN_EXPIRATION_SECONDS=3600
  ```

- Install npm packages in `nestjs-project/`:
  - `npm install @nestjs/bullmq@11.0.4`
  - `npm install bullmq@5.79.1`
  - `npm install @aws-sdk/client-s3@3.1075.0`
  - `npm install @aws-sdk/s3-request-presigner@3.1075.0`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/config/env.validation.spec.ts` (existing, extended) | Unit | All 8 new S3/Redis env vars are validated by Joi schema; missing required vars fail bootstrap |
| Docker integration test (manual or scripted) | Integration | `docker compose up` starts all 5 services (nestjs-api, db, redis, minio, video-worker) without errors; each container is healthy |
| Worker health check (integration) | Integration | `docker compose exec video-worker redis-cli -h redis ping` returns PONG; ffmpeg binary available: `docker compose exec video-worker ffmpeg -version` exits 0 |

**Dependencies:** None (must run first)

**Acceptance criteria:**

- [ ] `docker-compose.yml` has `redis` service (image `redis:7`, port 6379) and `video-worker` service (build from Dockerfile, depends on db/redis/minio)
- [ ] Worker Dockerfile includes `apt-get install -y ffmpeg` before final RUN
- [ ] `env.validation.ts` schema validates all 8 new variables (Joi required or defaults); missing S3_ENDPOINT_INTERNAL causes validation error at bootstrap
- [ ] `.env.example` documents all 8 new vars with comments explaining Docker networking
- [ ] `npm install` completes; all 4 npm packages in `nestjs-project/node_modules/`
- [ ] `docker compose up` succeeds; `docker compose exec video-worker ffmpeg -version` returns version info (binary present)

---

### SI-03.1 — Video Entity and Database Schema

**Description:** Define the `Video` entity with all required columns, relationships, and indexes. Generate TypeORM migration that creates the `videos` table. Create a TypeORM repository for data access.

**Technical actions:**

- Create `src/videos/entities/video.entity.ts`:
  ```typescript
  @Entity('videos')
  export class Video {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column('uuid')
    channel_id: string;

    @Column('varchar', { length: 20, unique: true })
    public_id: string;

    @Column('varchar', { length: 500 })
    title: string;

    @Column('text', { nullable: true })
    description?: string;

    @Column({
      type: 'enum',
      enum: ['draft', 'processing', 'ready', 'failed'],
      default: 'draft',
    })
    status: 'draft' | 'processing' | 'ready' | 'failed';

    @Column('varchar', { length: 255, unique: true })
    storage_key: string;

    @Column('varchar', { length: 255, nullable: true })
    thumbnail_key?: string;

    @Column('integer', { nullable: true })
    duration_seconds?: number;

    @Column('jsonb', { nullable: true })
    metadata?: Record<string, any>;

    @Column('bigint', { nullable: true })
    size_bytes?: number;

    @Column('text', { nullable: true })
    error_reason?: string;

    @CreateDateColumn()
    created_at: Date;

    @UpdateDateColumn()
    updated_at: Date;

    @ManyToOne(() => Channel, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'channel_id' })
    channel: Channel;
  }
  ```

- Create indexes on migration:
  - `idx_videos_public_id` (UNIQUE): on `public_id`
  - `idx_videos_channel_id`: on `channel_id`
  - `idx_videos_status`: on `status`

- Run `npm run migration:generate -- src/database/migrations/CreateVideosTable` — review generated migration file for correctness

- Create `src/videos/repositories/videos.repository.ts`:
  ```typescript
  @Injectable()
  export class VideosRepository {
    constructor(@InjectRepository(Video) private repo: Repository<Video>) {}

    async create(video: Partial<Video>): Promise<Video> {
      return this.repo.save(this.repo.create(video));
    }

    async findById(id: string): Promise<Video | null> {
      return this.repo.findOne({ where: { id } });
    }

    async findByPublicId(publicId: string): Promise<Video | null> {
      return this.repo.findOne({
        where: { public_id: publicId },
        relations: ['channel', 'channel.user'],
      });
    }

    async findByIdAndChannelId(id: string, channelId: string): Promise<Video | null> {
      return this.repo.findOne({ where: { id, channel_id: channelId } });
    }

    async update(id: string, data: Partial<Video>): Promise<Video | null> {
      await this.repo.update(id, data);
      return this.findById(id);
    }

    // Additional helper methods for status queries, etc.
  }
  ```

- Create `src/videos/videos.module.ts`:
  ```typescript
  @Module({
    imports: [TypeOrmModule.forFeature([Video])],
    providers: [VideosRepository],
    exports: [TypeOrmModule, VideosRepository],
  })
  export class VideosModule {}
  ```

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.spec.ts` | Unit | Entity columns, types, decorators (PK, FK, enums, defaults) are correct |
| `src/videos/repositories/videos.repository.spec.ts` | Unit | Repository methods (create, findById, update) work with mocked Repository |
| `src/database/migrations.integration-spec.ts` (extended from Phase 02) | Integration | Migration `CreateVideosTable` runs without error; `videos` table has all columns and indexes; schema matches entity decorators |

**Dependencies:** SI-03.0 (database must be accessible), Phase 02 (Channel entity must exist)

**Acceptance criteria:**

- [ ] Migration file created and documented; `npx typeorm migration:run` succeeds
- [ ] `videos` table exists with all columns: id, channel_id, public_id (UNIQUE), title, description, status (enum: draft/processing/ready/failed), storage_key (UNIQUE), thumbnail_key, duration_seconds, metadata (JSONB), size_bytes, error_reason, created_at, updated_at
- [ ] Indexes created: idx_videos_public_id (UNIQUE), idx_videos_channel_id, idx_videos_status
- [ ] VideosRepository methods (create, findById, findByPublicId) work end-to-end in integration test

---

### SI-03.2 — S3 Storage Module (MinIO/AWS SDK Configuration)

**Description:** Create a `StorageService` that wraps the AWS SDK v3 S3 client, provides idempotent bucket creation, generates presigned URLs, and supports both read/write operations via Range request streams.

**Technical actions:**

- Create `src/storage/storage.service.ts`:
  ```typescript
  @Injectable()
  export class StorageService {
    private s3Client: S3Client;

    constructor(private configService: ConfigService) {
      this.s3Client = new S3Client({
        region: configService.get('S3_REGION'),
        endpoint: configService.get('S3_ENDPOINT_INTERNAL'),
        credentials: {
          accessKeyId: configService.get('S3_ACCESS_KEY_ID'),
          secretAccessKey: configService.get('S3_SECRET_ACCESS_KEY'),
        },
        forcePathStyle: true, // Required for MinIO
      });
    }

    async onModuleInit(): Promise<void> {
      const bucket = this.configService.get('S3_BUCKET');
      try {
        await this.s3Client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch (error) {
        if (error.$metadata?.httpStatusCode === 404) {
          await this.s3Client.send(new CreateBucketCommand({ Bucket: bucket }));
        } else {
          throw error;
        }
      }
    }

    async generatePresignedPutUrl(storageKey: string, contentType?: string): Promise<string> {
      const bucket = this.configService.get('S3_BUCKET');
      const expiresIn = parseInt(this.configService.get('PRESIGN_EXPIRATION_SECONDS') || '3600');
      
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: storageKey,
        ContentType: contentType || 'application/octet-stream',
      });

      const presigner = new S3RequestPresigner({
        ...this.s3Client.config,
        endpoint: new URL(this.configService.get('S3_ENDPOINT_PUBLIC')),
      });

      const url = await getSignedUrl(presigner, command, { expiresIn });
      return url;
    }

    async generatePresignedGetUrl(storageKey: string): Promise<string> {
      const bucket = this.configService.get('S3_BUCKET');
      const expiresIn = parseInt(this.configService.get('PRESIGN_EXPIRATION_SECONDS') || '3600');

      const command = new GetObjectCommand({ Bucket: bucket, Key: storageKey });
      const presigner = new S3RequestPresigner({
        ...this.s3Client.config,
        endpoint: new URL(this.configService.get('S3_ENDPOINT_PUBLIC')),
      });

      return getSignedUrl(presigner, command, { expiresIn });
    }

    async headObject(storageKey: string): Promise<{ size: number; exists: boolean }> {
      const bucket = this.configService.get('S3_BUCKET');
      try {
        const response = await this.s3Client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: storageKey })
        );
        return { size: response.ContentLength || 0, exists: true };
      } catch (error) {
        if (error.$metadata?.httpStatusCode === 404) {
          return { size: 0, exists: false };
        }
        throw error;
      }
    }

    async getObject(storageKey: string, startByte?: number, endByte?: number): Promise<Readable> {
      const bucket = this.configService.get('S3_BUCKET');
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: storageKey,
        Range: startByte !== undefined && endByte !== undefined
          ? `bytes=${startByte}-${endByte}`
          : undefined,
      });

      const response = await this.s3Client.send(command);
      return response.Body as Readable;
    }

    async uploadFile(localPath: string, storageKey: string): Promise<void> {
      const bucket = this.configService.get('S3_BUCKET');
      const fileContent = readFileSync(localPath);

      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: storageKey,
          Body: fileContent,
        })
      );
    }
  }
  ```

- Create `src/storage/storage.module.ts`:
  ```typescript
  @Module({
    providers: [StorageService],
    exports: [StorageService],
  })
  export class StorageModule {}
  ```

- Add to `src/app.module.ts` imports: `StorageModule`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.service.spec.ts` | Unit | Presigned URL generation (mocked S3RequestPresigner); headObject logic with mock responses |
| `src/storage/storage.integration.spec.ts` | Integration | Real MinIO container; bucket creation (idempotent); presigned PUT/GET URLs work; getObject with Range returns Readable stream |

**Dependencies:** SI-03.0 (Redis, MinIO, env vars), Phase 02 (ConfigService)

**Acceptance criteria:**

- [ ] `StorageService` instantiates without error; injects `ConfigService`
- [ ] `onModuleInit()` creates bucket if missing (idempotent via headBucket check)
- [ ] `generatePresignedPutUrl()` returns signed URL with S3_ENDPOINT_PUBLIC domain (client can PUT directly)
- [ ] `generatePresignedGetUrl()` returns signed URL (client can GET directly)
- [ ] `headObject()` returns `{ exists: true, size: number }` for existing objects, `{ exists: false }` for missing
- [ ] `getObject()` returns Readable stream; Range header (startByte, endByte) is passed to S3Client
- [ ] Integration test: presigned URL works with real MinIO; Range requests return byte intervals correctly

---

### SI-03.3 — Redis and BullMQ Queue Module

**Description:** Configure BullMQ with Redis backend, define the video-processing queue, and create the video processor consumer that handles job lifecycle (enqueue, process, succeed/fail).

**Technical actions:**

- Create `src/queue/queue.module.ts`:
  ```typescript
  @Module({
    imports: [
      BullModule.forRootAsync({
        useFactory: (configService: ConfigService) => ({
          connection: {
            host: configService.get('REDIS_HOST', 'redis'),
            port: configService.get('REDIS_PORT', 6379),
            maxRetriesPerRequest: null,
            enableOfflineQueue: true,
          },
        }),
        inject: [ConfigService],
      }),
      BullModule.registerQueue({ name: 'video-processing' }),
    ],
    providers: [VideoProcessor],
    exports: [BullModule],
  })
  export class QueueModule {}
  ```

- Create `src/queue/video-processor.ts`:
  ```typescript
  interface VideoProcessingPayload {
    videoId: string;
    storageKey: string;
    channelId: string;
  }

  @Processor('video-processing')
  export class VideoProcessor extends WorkerHost {
    private logger = new Logger(VideoProcessor.name);

    constructor(
      private videosRepository: VideosRepository,
      private storageService: StorageService,
      private ffmpegService: FfmpegService,
    ) {
      super();
    }

    async process(job: Job<VideoProcessingPayload>): Promise<void> {
      const { videoId, storageKey } = job.data;
      this.logger.log(`Processing video ${videoId}`);

      // Download video from storage
      const videoPath = path.join('/tmp', `${videoId}.mp4`);
      const stream = await this.storageService.getObject(storageKey);
      const writeStream = createWriteStream(videoPath);
      await new Promise((resolve, reject) => {
        stream.pipe(writeStream).on('finish', resolve).on('error', reject);
      });

      try {
        // Extract metadata
        const metadata = await this.ffmpegService.extractMetadata(videoPath);
        const durationSeconds = Math.round(metadata.duration || 0);

        // Generate thumbnail
        const thumbnailPath = path.join('/tmp', `${videoId}_thumb.jpg`);
        await this.ffmpegService.generateThumbnail(videoPath, thumbnailPath);

        // Upload thumbnail
        const thumbnailKey = `thumbnails/channels/${job.data.channelId}/videos/${videoId}/thumb.jpg`;
        await this.storageService.uploadFile(thumbnailPath, thumbnailKey);

        // Update video status to ready
        await this.videosRepository.update(videoId, {
          status: 'ready',
          duration_seconds: durationSeconds,
          metadata,
          thumbnail_key: thumbnailKey,
        });

        this.logger.log(`Video ${videoId} processed successfully`);

        // Cleanup temp files
        unlinkSync(videoPath);
        unlinkSync(thumbnailPath);
      } catch (error) {
        this.logger.error(`Video processing failed for ${videoId}: ${error.message}`);
        throw error; // BullMQ will retry
      }
    }

    @OnQueueFailed()
    async onQueueFailed(job: Job<VideoProcessingPayload>, error: Error): Promise<void> {
      this.logger.error(`Job ${job.id} failed after ${job.attemptsMade} attempts: ${error.message}`);
      await this.videosRepository.update(job.data.videoId, {
        status: 'failed',
        error_reason: error.message,
      });
    }

    @OnWorkerEvent('completed')
    onCompleted(job: Job): void {
      this.logger.debug(`Job ${job.id} completed`);
    }
  }
  ```

- Create `src/video-worker/ffmpeg.service.ts` (used by processor):
  ```typescript
  @Injectable()
  export class FfmpegService {
    private logger = new Logger(FfmpegService.name);

    async extractMetadata(videoPath: string): Promise<Record<string, any>> {
      return new Promise((resolve, reject) => {
        const ffprobe = spawn('ffprobe', [
          '-v', 'error',
          '-show_entries',
          'format=duration:stream=width,height,codec_name,r_frame_rate',
          '-of', 'json',
          videoPath,
        ]);

        let output = '';
        ffprobe.stdout.on('data', (data) => { output += data; });
        ffprobe.stderr.on('data', (data) => { this.logger.warn(data.toString()); });

        ffprobe.on('close', (code) => {
          if (code === 0) {
            try {
              const parsed = JSON.parse(output);
              resolve({
                duration: parsed.format.duration,
                width: parsed.streams?.[0]?.width,
                height: parsed.streams?.[0]?.height,
                codec: parsed.streams?.[0]?.codec_name,
              });
            } catch (e) {
              reject(new Error(`Failed to parse ffprobe output: ${e.message}`));
            }
          } else {
            reject(new Error(`ffprobe exited with code ${code}`));
          }
        });
      });
    }

    async generateThumbnail(videoPath: string, outputPath: string): Promise<void> {
      return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
          '-i', videoPath,
          '-ss', '5', // 5 seconds into video
          '-frames:v', '1',
          '-q:v', '3', // Quality
          outputPath,
        ]);

        ffmpeg.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`ffmpeg exited with code ${code}`));
          }
        });
      });
    }
  }
  ```

- Add `QueueModule` to `src/app.module.ts` imports
- Create worker entry point `src/worker.ts` that initializes the NestJS app for the worker container

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/queue/video-processor.spec.ts` | Unit | Process logic (mocked ffprobe/ffmpeg, storage); state transitions (draft → processing → ready) |
| `src/queue/video-processor.integration.spec.ts` | Integration | Real Redis queue; real MinIO; ffprobe/ffmpeg available; full job lifecycle (enqueue → consume → complete/fail) |
| `src/video-worker/ffmpeg.service.spec.ts` | Unit | ffprobe/ffmpeg spawn calls, output parsing (mocked) |
| `src/video-worker/ffmpeg.service.integration.spec.ts` | Integration | Real ffmpeg binary; real temp files; metadata extraction correct; thumbnail generated |

**Dependencies:** SI-03.0 (Redis, env vars, FFmpeg binary), SI-03.1 (VideosRepository), SI-03.2 (StorageService)

**Acceptance criteria:**

- [ ] `QueueModule` registers with Redis at host: 'redis' (Docker Compose service name)
- [ ] `VideoProcessor` extends `WorkerHost`, decorated with `@Processor('video-processing')`
- [ ] Job enqueue works: `@InjectQueue('video-processing')` in controllers/services
- [ ] Job processing: ffprobe extracts duration, resolution, codec correctly; ffmpeg generates JPEG thumbnail
- [ ] Thumbnail uploaded to storage at path `thumbnails/channels/{channelId}/videos/{videoId}/thumb.jpg`
- [ ] Video status transitions: draft → processing → ready (on success) or failed (on exhausted retries)
- [ ] Integration test: real Redis queue, real MinIO, real ffmpeg work end-to-end

---

### SI-03.4 — Video Upload Endpoints (Presigned PUT Handshake)

**Description:** Implement `POST /videos/upload-init` and `POST /videos/:id/upload-complete` endpoints that establish the presigned PUT handshake for large-file uploads.

**Technical actions:**

- Create `src/videos/dtos/create-video.dto.ts`:
  ```typescript
  export class CreateVideoDto {
    @IsString()
    @MinLength(1)
    @MaxLength(500)
    title: string;

    @IsString()
    @IsOptional()
    @MaxLength(2000)
    description?: string;

    @IsUUID()
    channel_id: string;
  }
  ```

- Create `src/videos/dtos/upload-complete.dto.ts` (empty for now, may add multipart fields in Phase 04):
  ```typescript
  export class UploadCompleteDto {}
  ```

- Create `src/videos/services/upload.service.ts`:
  ```typescript
  @Injectable()
  export class UploadService {
    private logger = new Logger(UploadService.name);

    constructor(
      private videosRepository: VideosRepository,
      private channelsRepository: ChannelsRepository, // Phase 02
      private storageService: StorageService,
      @InjectQueue('video-processing')
      private videoQueue: Queue<VideoProcessingPayload>,
    ) {}

    async initializeUpload(userId: string, dto: CreateVideoDto): Promise<{
      videoId: string;
      public_id: string;
      presignedUrl: string;
      expiresIn: number;
    }> {
      // Verify user owns the channel
      const channel = await this.channelsRepository.findByIdAndUserId(
        dto.channel_id,
        userId,
      );
      if (!channel) {
        throw new ForbiddenException('User does not own this channel');
      }

      // Generate public ID (base62, 12 chars, UNIQUE)
      const public_id = await this.generateUniquePublicId();

      // Generate storage key
      const ext = 'mp4'; // Default; client may specify
      const storageKey = `videos/channels/${dto.channel_id}/videos/${uuid()}/source.${ext}`;

      // Create video as draft
      const video = await this.videosRepository.create({
        channel_id: dto.channel_id,
        public_id,
        title: dto.title,
        description: dto.description,
        status: 'draft',
        storage_key: storageKey,
      });

      // Generate presigned PUT URL (1 hour expiration)
      const presignedUrl = await this.storageService.generatePresignedPutUrl(
        storageKey,
        'video/mp4',
      );

      return {
        videoId: video.id,
        public_id: video.public_id,
        presignedUrl,
        expiresIn: 3600,
      };
    }

    async completeUpload(userId: string, videoId: string): Promise<{
      videoId: string;
      status: string;
      jobId: string;
    }> {
      const video = await this.videosRepository.findById(videoId);
      if (!video) {
        throw new NotFoundException('Video not found');
      }

      // Verify user owns the video
      const channel = await this.channelsRepository.findByIdAndUserId(
        video.channel_id,
        userId,
      );
      if (!channel) {
        throw new ForbiddenException('User does not own this video');
      }

      // Check video is in draft status
      if (video.status !== 'draft') {
        throw new BadRequestException(
          `Video is not in draft status; current status: ${video.status}`,
        );
      }

      // Verify file was uploaded to storage
      const { exists, size } = await this.storageService.headObject(video.storage_key);
      if (!exists || size === 0) {
        throw new ConflictException(
          `File not found in storage at ${video.storage_key}`,
        );
      }

      // Store file size
      video.size_bytes = size;

      // Enqueue processing job (idempotent by videoId)
      const job = await this.videoQueue.add(
        'process-video',
        {
          videoId: video.id,
          storageKey: video.storage_key,
          channelId: video.channel_id,
        },
        {
          jobId: video.id, // Idempotency key
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );

      // Update video status
      video.status = 'processing';
      await this.videosRepository.update(video.id, {
        status: 'processing',
        size_bytes: size,
      });

      return {
        videoId: video.id,
        status: 'processing',
        jobId: job.id,
      };
    }

    private async generateUniquePublicId(): Promise<string> {
      const maxRetries = 5;
      for (let i = 0; i < maxRetries; i++) {
        const publicId = this.generateBase62Id(12);
        const existing = await this.videosRepository.findByPublicId(publicId);
        if (!existing) {
          return publicId;
        }
      }
      throw new InternalServerErrorException(
        'Failed to generate unique public ID after retries',
      );
    }

    private generateBase62Id(length: number): string {
      const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
      const bytes = randomBytes(Math.ceil((length * 6) / 8));
      let id = '';
      for (let i = 0; i < length; i++) {
        id += chars[bytes[i] % chars.length];
      }
      return id;
    }
  }
  ```

- Create `src/videos/controllers/upload.controller.ts`:
  ```typescript
  @Controller('videos')
  @UseGuards(JwtAuthGuard)
  export class UploadController {
    constructor(private uploadService: UploadService) {}

    @Post('upload-init')
    async uploadInit(
      @CurrentUser() user: JwtPayload,
      @Body() dto: CreateVideoDto,
    ) {
      return this.uploadService.initializeUpload(user.sub, dto);
    }

    @Post(':id/upload-complete')
    async uploadComplete(
      @Param('id') videoId: string,
      @CurrentUser() user: JwtPayload,
    ) {
      return this.uploadService.completeUpload(user.sub, videoId);
    }
  }
  ```

- Add `UploadService`, `UploadController` to `VideosModule` providers/controllers

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/services/upload.service.spec.ts` | Unit | DTO validation, presigned URL generation (mocked), state transitions, ownership checks |
| `src/videos/services/upload.service.integration.spec.ts` | Integration | Real DB, real storage, real queue; full presigned URL flow; job enqueued correctly; idempotency (calling twice returns same jobId) |
| `test/videos.e2e-spec.ts` | E2E | Authenticated user → presigned URL → PUT file to MinIO → upload-complete → job in queue; 403 on non-owner; 400 on invalid body |

**Dependencies:** SI-03.1 (VideosRepository), SI-03.2 (StorageService), SI-03.3 (QueueModule), Phase 02 (JwtAuthGuard, ChannelsRepository)

**Acceptance criteria:**

- [ ] `POST /videos/upload-init` returns 201 + `{ videoId, public_id, presignedUrl, expiresIn: 3600 }`
- [ ] Presigned URL is valid; client can PUT binary data directly to MinIO
- [ ] `POST /videos/:id/upload-complete` validates file exists on storage (headObject)
- [ ] Job enqueued with `jobId = videoId` (calling twice doesn't create duplicate jobs)
- [ ] Video status transitions: draft (on init) → processing (on complete)
- [ ] 403 if user doesn't own the channel; 404 if video not found; 409 if file not on storage

---

### SI-03.5 — Video Streaming Endpoint (GET with Range/206)

**Description:** Implement `GET /videos/:public_id/stream` endpoint that handles HTTP Range requests, returns `206 Partial Content` with `Content-Range` header, and enables streaming without full file download.

**Technical actions:**

- Create `src/videos/controllers/stream.controller.ts`:
  ```typescript
  @Controller('videos')
  export class StreamController {
    constructor(private videosRepository: VideosRepository, private storageService: StorageService) {}

    @Get(':public_id/stream')
    @HttpCode(HttpStatus.OK)
    async stream(
      @Param('public_id') publicId: string,
      @Headers('range') range?: string,
    ): Promise<StreamableFile> {
      const video = await this.videosRepository.findByPublicId(publicId);
      if (!video || video.status !== 'ready') {
        throw new NotFoundException('Video not found or not ready');
      }

      const { size, exists } = await this.storageService.headObject(video.storage_key);
      if (!exists) {
        throw new InternalServerErrorException('Video file not found in storage');
      }

      let startByte = 0;
      let endByte = size - 1;
      let statusCode = HttpStatus.OK;

      if (range) {
        const matches = range.match(/bytes=(\d+)-(\d*)/);
        if (matches) {
          startByte = parseInt(matches[1], 10);
          endByte = matches[2] ? parseInt(matches[2], 10) : size - 1;

          if (startByte > endByte || startByte >= size) {
            throw new RangeNotSatisfiableException(
              `Range Not Satisfiable: bytes */${size}`,
            );
          }

          statusCode = HttpStatus.PARTIAL_CONTENT;
        }
      }

      const stream = await this.storageService.getObject(
        video.storage_key,
        startByte,
        endByte,
      );

      const response: StreamableFile = new StreamableFile(stream, {
        type: 'video/mp4',
        length: endByte - startByte + 1,
      });

      if (statusCode === HttpStatus.PARTIAL_CONTENT) {
        // Manually set headers for partial content (if using custom response interceptor)
        // response.headers['Content-Range'] = `bytes ${startByte}-${endByte}/${size}`;
        // response.headers['Accept-Ranges'] = 'bytes';
      }

      return response;
    }

    @Get(':public_id')
    async getMetadata(
      @Param('public_id') publicId: string,
    ) {
      const video = await this.videosRepository.findByPublicId(publicId);
      if (!video) {
        throw new NotFoundException('Video not found');
      }

      return {
        videoId: video.id,
        public_id: video.public_id,
        title: video.title,
        description: video.description,
        status: video.status,
        duration_seconds: video.duration_seconds,
        thumbnail_url: video.thumbnail_key
          ? await this.storageService.generatePresignedGetUrl(video.thumbnail_key)
          : null,
        size_bytes: video.size_bytes,
        channel: {
          id: video.channel.id,
          name: video.channel.name,
        },
        created_at: video.created_at,
        updated_at: video.updated_at,
      };
    }

    @Get(':public_id/download')
    async download(
      @Param('public_id') publicId: string,
    ): Promise<StreamableFile> {
      const video = await this.videosRepository.findByPublicId(publicId);
      if (!video || video.status !== 'ready') {
        throw new NotFoundException('Video not found or not ready');
      }

      const stream = await this.storageService.getObject(video.storage_key);
      return new StreamableFile(stream, {
        type: 'video/mp4',
        disposition: `attachment; filename="${video.public_id}.mp4"`,
      });
    }
  }
  ```

- Add `@Public()` decorator to all three routes (no authentication required)
- Add `StreamController` to `VideosModule` controllers

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/controllers/stream.controller.spec.ts` | Unit | Range header parsing; 206 response setup; 404 for missing video |
| `src/videos/controllers/stream.integration.spec.ts` | Integration | Real MinIO; Range requests work (bytes=0-999, 1000-1999, etc.); correct Content-Range headers; download endpoint |
| `test/videos.e2e-spec.ts` | E2E | Full Range request flow via HTTP client; seeking in video; 416 on invalid range |

**Dependencies:** SI-03.1 (VideosRepository), SI-03.2 (StorageService)

**Acceptance criteria:**

- [ ] `GET /videos/{public_id}/stream` without Range returns 200 (full file, Content-Type: video/mp4)
- [ ] `GET /videos/{public_id}/stream` with Range header returns 206 + Content-Range header (e.g., `bytes 0-999/10000`)
- [ ] Multiple partial Range requests (seek) work correctly
- [ ] `GET /videos/{public_id}/download` returns 200 with Content-Disposition: attachment
- [ ] `GET /videos/{public_id}` returns 200 with metadata JSON (title, duration, thumbnail_url, channel, etc.)
- [ ] 404 for non-existent or non-ready video

---

### SI-03.6 — FFmpeg Worker Implementation

**Description:** Complete the FFmpeg service in the worker container to extract video metadata via ffprobe and generate thumbnails via ffmpeg. Implement the main worker entry point that consumes jobs from the queue.

**Technical actions:**

- Finalize `src/video-worker/ffmpeg.service.ts` (started in SI-03.3):
  - Implement robust error handling, logging, temp file cleanup
  - Handle edge cases: invalid codec, corrupted file, ffmpeg crash
  - Validate output: metadata has duration, thumbnail file exists

- Create `src/worker.ts` — main entry point for worker container:
  ```typescript
  import { NestFactory } from '@nestjs/core';
  import { AppModule } from './app.module';

  async function bootstrap() {
    const app = await NestFactory.create(AppModule);
    
    // Skip HTTP server — worker only needs queue consumer
    app.enableShutdownHooks();
    
    await app.init();
    console.log('Video worker initialized and listening to video-processing queue');
  }

  bootstrap().catch((error) => {
    console.error('Worker bootstrap failed:', error);
    process.exit(1);
  });
  ```

- Update `nestjs-project/docker-compose.yml` — video-worker service command:
  ```yaml
  command: node dist/worker.js
  ```

- Ensure `package.json` build output includes both `main.ts` (API) and `worker.ts` (Worker)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/video-worker/ffmpeg.service.spec.ts` | Unit | ffprobe/ffmpeg spawn (mocked), output parsing, error handling |
| `src/video-worker/ffmpeg.service.integration.spec.ts` | Integration | Real ffmpeg binary; metadata extraction correct; thumbnail generated as valid JPEG; cleanup temp files |
| `test/videos.e2e-spec.ts` (lifecycle scenario) | E2E | Full job lifecycle: enqueue via API → worker processes → database updated → status='ready' |

**Dependencies:** SI-03.0 (FFmpeg binary in Dockerfile), SI-03.3 (VideoProcessor, FfmpegService)

**Acceptance criteria:**

- [ ] `ffprobe` extracts duration, resolution (width/height), codec, frame rate correctly from sample video
- [ ] `ffmpeg` generates JPEG thumbnail (valid image file) at 5-second mark
- [ ] Thumbnail uploaded to storage at correct path
- [ ] Video status='ready' after successful processing; metadata and thumbnail_key persisted
- [ ] Failed jobs (invalid codec, ffmpeg crash) update status='failed' + error_reason
- [ ] Worker logs errors clearly; temp files cleaned up after processing
- [ ] E2E: job lifecycle works end-to-end with real containers

---

### SI-03.7 — Error Handling and Response Format

**Description:** Ensure all video endpoints follow Phase 02's error contract and domain exception filter. Define video-specific exceptions and error catalog.

**Technical actions:**

- Create `src/videos/exceptions/video-not-found.exception.ts`:
  ```typescript
  export class VideoNotFoundException extends DomainException {
    constructor(message = 'Video not found') {
      super(message, 'VIDEO_NOT_FOUND', HttpStatus.NOT_FOUND);
    }
  }
  ```

- Create similar exceptions:
  - `VideoNotReadyException` (400, 'VIDEO_NOT_READY')
  - `VideoProcessingFailedException` (500, 'VIDEO_PROCESSING_FAILED')
  - `StorageException` (500, 'STORAGE_ERROR')
  - `InvalidVideoStatusException` (400, 'INVALID_VIDEO_STATUS')

- Apply domain exception filter globally (already done in Phase 02 SI-02.2)

- Update exception usage in all video controllers/services

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/exceptions.spec.ts` | Unit | Exception messages, HTTP status codes, error codes |
| Integration/E2E tests | Integration | Endpoints return correct `{ statusCode, error, message }` shape |

**Dependencies:** Phase 02 error handling infrastructure

**Acceptance criteria:**

- [ ] All video exceptions extend `DomainException`
- [ ] All video errors return `{ statusCode, error, message }` format
- [ ] HTTP status codes correct (400, 401, 403, 404, 500)
- [ ] Error codes documented in Technical Specification error catalog

---

### SI-03.8 — Integration Test Isolation and Robustness

**Description:** Ensure all integration tests manage their own state, are independent of execution order, and clean up after themselves.

**Technical actions:**

- For each `.integration.spec.ts` file:
  - In `beforeAll()`: 
    - Run migrations (or ensure DB is fresh)
    - Seed test data (users, channels, videos)
    - Ensure buckets exist in MinIO (create if missing)
    - Flush Redis queue (remove any stale jobs)
  - In each test case: use transactions with rollback, or isolation at test level (e.g., unique suffix per test)
  - In `afterAll()`: cleanup (optional; transactions handle cleanup)

- Example `upload.service.integration.spec.ts` setup:
  ```typescript
  describe('UploadService (integration)', () => {
    let uploadService: UploadService;
    let videosRepository: VideosRepository;
    let testDataSource: DataSource;

    beforeAll(async () => {
      testDataSource = createTestDataSource();
      await testDataSource.initialize();
      await testDataSource.runMigrations();

      // Seed test user, channel
      const user = await testDataSource.manager.save(User, { email: 'test@test.com' });
      const channel = await testDataSource.manager.save(Channel, { user_id: user.id });

      // Setup module
      const module = await Test.createTestingModule({...}).compile();
      uploadService = module.get(UploadService);
    });

    afterAll(async () => {
      await testDataSource.destroy();
    });

    it('should initialize upload and return presigned URL', async () => {
      const result = await uploadService.initializeUpload(user.id, {
        title: 'Test Video',
        channel_id: channel.id,
      });

      expect(result.videoId).toBeDefined();
      expect(result.presignedUrl).toContain('X-Amz-');
    });

    // Additional tests...
  });
  ```

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| All `.integration.spec.ts` files | Integration | No test order dependency; each suite manages own state; no cross-suite pollution |

**Dependencies:** All SI implementations

**Acceptance criteria:**

- [ ] Integration tests pass in any random execution order
- [ ] No test flakiness due to shared state
- [ ] Each suite manages own database schema (migrations or transactional rollback)
- [ ] MinIO buckets created at suite start (idempotent)
- [ ] Redis queue flushed before each suite
- [ ] Parallel test execution doesn't cause failures

---

## Technical Specifications

### Data Model

**videos table:**

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | UUID | PK, DEFAULT gen_uuid_v4() | Video identifier |
| channel_id | UUID | FK → channels(id), NOT NULL | Video owner (channel) |
| public_id | VARCHAR(20) | UNIQUE NOT NULL | URL-safe, shareable ID (base62, 12 chars) |
| title | VARCHAR(500) | NOT NULL | Video title |
| description | TEXT | nullable | Video description |
| status | ENUM (draft, processing, ready, failed) | DEFAULT 'draft' | Video lifecycle state |
| storage_key | VARCHAR(255) | UNIQUE NOT NULL | S3/MinIO object path: `videos/channels/{channel_id}/videos/{video_id}/source.{ext}` |
| thumbnail_key | VARCHAR(255) | nullable | S3/MinIO thumbnail path: `thumbnails/channels/{channel_id}/videos/{video_id}/thumb.jpg` |
| duration_seconds | INT | nullable | Video duration (filled by worker after ffprobe) |
| metadata | JSONB | nullable | Video metadata: `{ resolution, codec, bitrate, width, height, etc. }` |
| size_bytes | BIGINT | nullable | File size in bytes |
| error_reason | TEXT | nullable | Error message if status='failed' |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Creation time |
| updated_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP ON UPDATE | Last update time |

**Indexes:**
- `idx_videos_public_id` (UNIQUE): on `public_id`
- `idx_videos_channel_id`: on `channel_id`
- `idx_videos_status`: on `status`

**Relationships:**
- `channel_id` → `channels(id)` ON DELETE CASCADE

---

### API Contracts

#### POST /videos/upload-init

**Endpoint:** `POST /videos/upload-init`  
**Auth:** Required (JWT)  

**Request Body:**
```json
{
  "title": "My Video Title",
  "description": "Optional description",
  "channel_id": "uuid-of-channel"
}
```

**Response (201 Created):** _(shape as implemented — field names revised during implementation)_
```json
{
  "videoId": "uuid",
  "publicId": "abc123def456",
  "uploadUrl": "http://localhost:9000/streamtube/videos/channels/{channel_id}/videos/{video_id}/source.mp4?X-Amz-Algorithm=...",
  "storageKey": "videos/channels/{channel_id}/videos/{video_id}/source.mp4",
  "expiresIn": 3600
}
```

**Errors:**
- 400: Invalid title/channel_id (validation)
- 401: Unauthorized
- 403: User does not own channel
- 500: Storage error

---

#### POST /videos/:id/upload-complete

**Endpoint:** `POST /videos/:id/upload-complete`  
**Auth:** Required (JWT)  
**Params:** `id` = videoId (UUID)  

**Response (200 OK):** _(shape as implemented — jobId omitted since jobId = videoId by design)_
```json
{
  "videoId": "uuid",
  "publicId": "abc123def456",
  "status": "processing",
  "duration_seconds": null,
  "thumbnail_key": null,
  "createdAt": "2026-06-26T10:00:00.000Z"
}
```

**Side Effects:**
- Validates file exists in storage (headObject)
- Enqueues `process-video` job in `video-processing` queue
- Updates video status to 'processing'
- Idempotent: calling twice with same videoId doesn't enqueue twice (jobId deduplication)

**Errors:**
- 400: Video not in draft status (already processing/ready/failed)
- 401: Unauthorized
- 404: Video not found
- 409: File not found in storage
- 500: Queue/storage error

---

#### GET /videos/:public_id/stream

**Endpoint:** `GET /videos/:public_id/stream`  
**Auth:** Public (no auth required)  
**Params:** `public_id` = video's public_id (base62 string)  
**Headers:** (optional) `Range: bytes=start-end`  

**Response (200 OK or 206 Partial Content):**

Without Range:
```
HTTP/1.1 200 OK
Content-Type: video/mp4
Content-Length: 1234567890
[video bytes]
```

With Range:
```
HTTP/1.1 206 Partial Content
Content-Type: video/mp4
Content-Range: bytes 0-1023/1234567890
Content-Length: 1024
[1024 bytes of video]
```

**Errors:**
- 404: Video not found or not ready
- 416: Range not satisfiable

---

#### GET /videos/:public_id

**Endpoint:** `GET /videos/:public_id`  
**Auth:** Public  
**Params:** `public_id`  

**Response (200 OK):** _(shape as implemented in `videos.controller.ts` / `VideoMetadataResponse`)_
```json
{
  "videoId": "uuid",
  "publicId": "abc123def456",
  "title": "My Video",
  "description": "...",
  "status": "ready",
  "duration_seconds": 300,
  "thumbnail_url": "http://localhost:9000/streamtube/thumbnails/...",
  "size_bytes": 1234567890,
  "channel": { "id": "channel-uuid", "name": "Channel Name" },
  "created_at": "2026-06-25T10:00:00Z",
  "updated_at": "2026-06-25T10:05:00Z"
}
```

**Errors:**
- 404: Video not found

---

#### GET /videos/:public_id/download

**Endpoint:** `GET /videos/:public_id/download`  
**Auth:** Public  

**Response:** Same as /stream, but with header `Content-Disposition: attachment; filename="video.mp4"`

---

### Authorization Matrix

| Endpoint | Method | Auth | Owner | Other |
|----------|--------|------|-------|-------|
| /videos/upload-init | POST | JWT (user) | create draft in own channel | 403 if not channel owner |
| /videos/:id/upload-complete | POST | JWT (user) | complete own video | 403 if not owner |
| /videos/:public_id/stream | GET | Public | stream | stream (public) |
| /videos/:public_id/download | GET | Public | download | download (public) |
| /videos/:public_id | GET | Public | read metadata | read metadata (public) |

---

### Error Catalog

All video errors follow Phase 02 contract: `{ statusCode, error, message }`

| StatusCode | Error | Message | Trigger |
|-----------|-------|---------|---------|
| 400 | VALIDATION_ERROR | "{field} is required" / "invalid {field} format" | Invalid DTO |
| 400 | INVALID_VIDEO_STATUS | "Video is not in draft status; current status: {status}" | POST upload-complete when status != 'draft' |
| 401 | UNAUTHORIZED | "JWT missing or expired" | Missing/invalid token |
| 403 | FORBIDDEN | "User does not own this channel" | upload-init for channel not owned by user |
| 403 | FORBIDDEN | "User does not own this video" | upload-complete for video not owned by user |
| 404 | VIDEO_NOT_FOUND | "Video with ID {id} not found" | GET /videos/:id when not exists |
| 409 | STORAGE_ERROR | "File not found in storage at {storage_key}" | upload-complete but file not uploaded to S3 |
| 416 | RANGE_NOT_SATISFIABLE | "Range Not Satisfiable: bytes */{size}" | Range header exceeds file size |
| 500 | STORAGE_ERROR | "Storage service unavailable: {details}" | MinIO/S3 connection error |
| 500 | QUEUE_ERROR | "Failed to enqueue video processing job: {details}" | BullMQ/Redis error |
| 500 | DATABASE_ERROR | "Database transaction failed: {details}" | DB constraint/connection error |

---

### Events/Messages

**Queue Name:** `video-processing`

**Job Type:** `process-video`

**Payload Schema:**
```typescript
interface VideoProcessingPayload {
  videoId: string;        // Video UUID (used as idempotency key)
  storageKey: string;     // Path in S3: videos/channels/{channel_id}/videos/{video_id}/source.{ext}
  channelId: string;      // Channel UUID (for logging/auditing)
}
```

**Job Options (BullMQ):**
```typescript
{
  jobId: payload.videoId,  // Idempotency: same videoId = same job in queue
  priority: 10,            // Standard priority (lower = higher)
  attempts: 3,             // Retry up to 3 times on failure
  backoff: {
    type: 'exponential',
    delay: 2000,           // Start with 2s, exponentially increase (2s, 4s, 8s)
  },
  removeOnComplete: true,  // Delete successful jobs from queue (cleanup)
  removeOnFail: false,     // Keep failed jobs (for debugging)
}
```

**Producer (API, in upload.service.ts):**
```typescript
await this.videoQueue.add(
  'process-video',
  {
    videoId: video.id,
    storageKey: video.storage_key,
    channelId: video.channel_id,
  },
  {
    jobId: video.id,  // Idempotency key
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: true,
  }
);
```

**Consumer (Worker, video-processor.ts):**
1. Receive job with payload
2. Download video from storage
3. Extract metadata via ffprobe
4. Generate thumbnail via ffmpeg
5. Upload thumbnail to storage
6. Update database: status='ready', metadata, thumbnail_key
7. Return success

**Failure Handler:**
If job fails after 3 retries:
- Update database: status='failed', error_reason={error message}
- Log error for debugging

**Idempotency:**
- Job ID = videoId ensures duplicate enqueuing is prevented
- Worker is idempotent: reprocessing same video re-extracts metadata (safe, CPU-cost acceptable for Phase 03)

---

## Dependency Map

```
SI-03.0: Infrastructure Setup (no deps, must run first)
│
├─→ SI-03.1: Video Entity & Database Schema
│   │
│   ├─→ SI-03.4: Video Upload Endpoints
│   ├─→ SI-03.5: Video Streaming Endpoint
│   └─→ SI-03.6: FFmpeg Worker Implementation
│
├─→ SI-03.2: S3 Storage Module
│   ├─→ SI-03.4: Video Upload Endpoints
│   ├─→ SI-03.5: Video Streaming Endpoint
│   └─→ SI-03.6: FFmpeg Worker Implementation
│
├─→ SI-03.3: Redis & BullMQ Queue Module
│   ├─→ SI-03.4: Video Upload Endpoints
│   └─→ SI-03.6: FFmpeg Worker Implementation
│
├─→ SI-03.7: Error Handling & Response Format
│   └─→ All endpoints (SI-03.4, SI-03.5)
│
└─→ SI-03.8: Integration Tests Robustness (cross-cutting)

Linearized order: SI-03.0 → SI-03.1 → SI-03.2 → SI-03.3 → SI-03.4 → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8
```

---

## Deliverables

**Code & Artifacts:**
- [ ] `docker-compose.yml` updated (redis, minio, video-worker services)
- [ ] Worker Dockerfile with FFmpeg installed
- [ ] `env.validation.ts` with 8 new S3/Redis/Presign env vars (Joi schema)
- [ ] `.env.example` with defaults and comments
- [ ] `package.json` updated with 4 new npm packages
- [ ] `src/videos/entities/video.entity.ts` (ORM entity)
- [ ] `src/database/migrations/{timestamp}-create-videos-table.ts` (database migration)
- [ ] `src/videos/repositories/videos.repository.ts` (TypeORM repository)
- [ ] `src/storage/storage.service.ts` (S3 client wrapper)
- [ ] `src/storage/storage.module.ts` (NestJS module)
- [ ] `src/queue/queue.module.ts` (BullMQ configuration)
- [ ] `src/queue/video-processor.ts` (worker processor)
- [ ] `src/video-worker/ffmpeg.service.ts` (FFmpeg wrapper)
- [ ] `src/worker.ts` (worker entry point)
- [ ] `src/videos/services/upload.service.ts` (business logic)
- [ ] `src/videos/controllers/upload.controller.ts` (POST upload-init, upload-complete)
- [ ] `src/videos/controllers/stream.controller.ts` (GET stream, download, metadata)
- [ ] `src/videos/exceptions/*` (domain exceptions)
- [ ] All DTOs (CreateVideoDto, UploadCompleteDto, etc.)

**Tests:**
- [ ] Unit tests for all services (storage, queue, upload, stream, ffmpeg)
- [ ] Integration tests for database, MinIO, Redis, FFmpeg
- [ ] E2E tests for full upload/stream/download flow
- [ ] Test suites isolated (no order dependency)

**Definition of Done (DoD):**
```bash
# All tests pass
npm test                   # Unit + integration tests
npm run test:e2e          # End-to-end tests

# No TypeScript errors
npx tsc --noEmit

# Linting passes
npm run lint

# Code review approval (peer review)
```

---

## Implementation Notes

**Docker Networking — CRITICAL:**
- Inside containers, use Docker Compose service names: `db`, `redis`, `minio`, never `localhost` or `127.0.0.1`
- Environment variables for internal connections: `DB_HOST=db`, `REDIS_HOST=redis`, `S3_ENDPOINT_INTERNAL=http://minio:9000`
- Presigned URLs (for clients outside Compose): signed with `S3_ENDPOINT_PUBLIC=http://localhost:9000`

**Presigned URL Routing:**
- `S3_ENDPOINT_PUBLIC` used for signing URLs (clients outside Compose can reach this)
- `S3_ENDPOINT_INTERNAL` used by API/worker for SDK operations inside Compose network
- Mismatch will cause client PUT/GET to fail on presigned URL (points to unreachable endpoint)

**FFmpeg Installation:**
- Worker Dockerfile: `RUN apt-get update && apt-get install -y ffmpeg`
- Binaries available: `ffmpeg` and `ffprobe`
- Image size increases ~200-300 MB

**Queue Connection:**
- Redis connection: `redis://redis:6379` (service name, not localhost)
- BullMQ configuration: `registerQueue('video-processing', { connection: { host: 'redis', port: 6379 } })`

**Bucket Creation:**
- Idempotent at startup: `headBucket` → create if 404
- Both API and Worker containers initialize buckets on startup

**Public ID Generation:**
- Use native `crypto.randomBytes()` with base62 encoding (12 characters, zero npm dependencies)
- Collision probability negligible (~1 in 10^15); retry up to 5 times on UNIQUE constraint violation

**Error Recovery & Observability:**
- All ffprobe/ffmpeg errors captured and logged
- Job failures automatically retried by BullMQ (up to 3 times, exponential backoff)
- Failed jobs persisted in Redis queue for debugging (removeOnFail: false)
- Video status and error reason stored in database for UI/debugging

**Test Isolation:**
- Each integration test suite manages own database state (transactions or fixtures)
- MinIO buckets created at suite start (idempotent)
- Redis queue flushed before each suite
- No cross-suite state pollution

---

## Success Criteria

1. All SI-03.0 through SI-03.8 step implementations completed
2. All unit, integration, and E2E tests pass
3. `npx tsc --noEmit` reports zero TypeScript errors
4. `npm run lint` passes
5. Docker Compose services start successfully (api, db, redis, minio, video-worker)
6. Presigned URL flow works end-to-end (client uploads 10GB+ without blocking API)
7. Worker processes video, extracts metadata, generates thumbnail
8. Video streaming via Range/206 requests works
9. Unique public_id URLs generated without collisions
10. Error responses follow `{ statusCode, error, message }` contract
11. Code review approval (if required by project process)
