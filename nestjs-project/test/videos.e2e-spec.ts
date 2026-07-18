// E2E for the video pipeline: upload-init → presigned PUT → upload-complete →
// worker processing → metadata/stream/download.
//
// Docker networking (playbook R4 / CLAUDE.md): this suite runs INSIDE the
// Compose network, where localhost:9000 is not MinIO. Presigned URLs must be
// signed for the internal endpoint so the PUT below actually reaches MinIO.
// This must happen before AppModule (and storage.config) is loaded.
process.env.S3_ENDPOINT_PUBLIC =
  process.env.S3_ENDPOINT_INTERNAL ?? 'http://minio:9000';

import * as fs from 'fs';
import { spawn } from 'child_process';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { Channel } from '../src/channels/entities/channel.entity';
import { Video } from '../src/videos/entities/video.entity';
import { StorageService } from '../src/storage/storage.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let module: TestingModule;
  let dataSource: DataSource;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let testVideoBuffer: Buffer;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = module.get(DataSource);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    storageService = module.get(StorageService);
    throttlerStorage = module.get<ThrottlerStorageService>(ThrottlerStorage);

    await storageService.ensureBucketExists();
    testVideoBuffer = await createTestVideoFile();
  }, 60000);

  afterAll(async () => {
    if (app) {
      try {
        await app.close();
      } catch {
        // Ignore cleanup errors
      }
    }
    if (module) {
      try {
        await module.close();
      } catch {
        // Ignore cleanup errors
      }
    }
  }, 30000);

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function captureConfirmationToken(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        capturedToken = t;
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    return capturedToken;
  }

  /**
   * Registers, confirms and logs a user in, returning the access token and
   * the id of the channel automatically created for the user.
   */
  async function setupUserWithChannel(
    email: string,
  ): Promise<{ accessToken: string; channelId: string }> {
    const token = await captureConfirmationToken(email);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'password123' });
    const accessToken = loginRes.body.access_token as string;

    const meRes = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);
    const channel = await channelRepository.findOneBy({
      user_id: meRes.body.sub,
    });
    return { accessToken, channelId: channel!.id };
  }

  /** Seeds a ready video with a real object in MinIO (deterministic — no worker). */
  async function seedReadyVideo(
    channelId: string,
    publicId: string,
  ): Promise<{ storageKey: string; size: number }> {
    const storageKey = `videos/channels/${channelId}/videos/seed-${publicId}/source.mp4`;
    await storageService.putObject(storageKey, testVideoBuffer);
    await videoRepository.save(
      videoRepository.create({
        channel_id: channelId,
        title: `Seeded ${publicId}`,
        public_id: publicId,
        status: 'ready',
        storage_key: storageKey,
        duration_seconds: 1,
        size_bytes: testVideoBuffer.length,
      }),
    );
    return { storageKey, size: testVideoBuffer.length };
  }

  describe('POST /videos/upload-init', () => {
    it('returns 201 with presigned URL and creates a draft video', async () => {
      const { accessToken, channelId } = await setupUserWithChannel(
        'uploader1@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos/upload-init')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          title: 'E2E Upload Video',
          channel_id: channelId,
          filename: 'test.mp4',
        })
        .expect(201);

      expect(res.body.videoId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(res.body.publicId).toMatch(/^[a-zA-Z0-9]{12}$/);
      expect(res.body.uploadUrl).toContain('X-Amz-Signature');
      expect(res.body.storageKey).toBe(
        `videos/channels/${channelId}/videos/${res.body.videoId}/source.mp4`,
      );
      expect(res.body.expiresIn).toBe(3600);

      const video = await videoRepository.findOneBy({ id: res.body.videoId });
      expect(video?.status).toBe('draft');
      expect(video?.public_id).toBe(res.body.publicId);
    });

    it('returns 401 without an access token', async () => {
      await request(app.getHttpServer())
        .post('/videos/upload-init')
        .send({ title: 'No auth', channel_id: 'irrelevant' })
        .expect(401);
    });

    it('returns 403 when the channel belongs to another user', async () => {
      const owner = await setupUserWithChannel('channelowner@example.com');
      const intruder = await setupUserWithChannel('intruder@example.com');

      await request(app.getHttpServer())
        .post('/videos/upload-init')
        .set('Authorization', `Bearer ${intruder.accessToken}`)
        .send({ title: 'Not my channel', channel_id: owner.channelId })
        .expect(403);
    });

    it('returns 400 with VALIDATION_ERROR when title is missing', async () => {
      const { accessToken, channelId } = await setupUserWithChannel(
        'novalidation@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos/upload-init')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ channel_id: channelId })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /videos/:id/upload-complete', () => {
    it('completes the upload after a real presigned PUT to MinIO', async () => {
      const { accessToken, channelId } = await setupUserWithChannel(
        'uploader2@example.com',
      );

      const initRes = await request(app.getHttpServer())
        .post('/videos/upload-init')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          title: 'Complete Flow',
          channel_id: channelId,
          filename: 'test.mp4',
        })
        .expect(201);

      // Upload the binary straight to MinIO through the presigned URL —
      // the file never passes through the API (TD-02).
      const putRes = await fetch(initRes.body.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(testVideoBuffer),
      });
      expect(putRes.ok).toBe(true);

      const completeRes = await request(app.getHttpServer())
        .post(`/videos/${initRes.body.videoId}/upload-complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(completeRes.body.videoId).toBe(initRes.body.videoId);
      expect(completeRes.body.publicId).toBe(initRes.body.publicId);
      expect(completeRes.body.status).toBe('processing');
    });

    it('returns 409 when the file was not uploaded to storage', async () => {
      const { accessToken, channelId } =
        await setupUserWithChannel('nofile@example.com');

      const initRes = await request(app.getHttpServer())
        .post('/videos/upload-init')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ title: 'Never uploaded', channel_id: channelId })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/videos/${initRes.body.videoId}/upload-complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(409);
    });

    it('returns 404 for a non-existent video id', async () => {
      const { accessToken } = await setupUserWithChannel('ghost@example.com');

      await request(app.getHttpServer())
        .post('/videos/00000000-0000-0000-0000-000000000000/upload-complete')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(404);
    });

    it('returns 403 when completing a video owned by another user', async () => {
      const owner = await setupUserWithChannel('owner2@example.com');
      const intruder = await setupUserWithChannel('intruder2@example.com');

      const initRes = await request(app.getHttpServer())
        .post('/videos/upload-init')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ title: 'Protected', channel_id: owner.channelId })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/videos/${initRes.body.videoId}/upload-complete`)
        .set('Authorization', `Bearer ${intruder.accessToken}`)
        .expect(403);
    });
  });

  describe('GET /videos/:public_id (metadata)', () => {
    it('returns 404 for an unknown public_id', async () => {
      await request(app.getHttpServer())
        .get('/videos/unknown00000')
        .expect(404);
    });

    it('returns draft metadata right after upload-init (processing pollable)', async () => {
      const { accessToken, channelId } = await setupUserWithChannel(
        'metadraft@example.com',
      );

      const initRes = await request(app.getHttpServer())
        .post('/videos/upload-init')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ title: 'Draft Meta', channel_id: channelId })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get(`/videos/${initRes.body.publicId}`)
        .expect(200);

      expect(res.body.videoId).toBe(initRes.body.videoId);
      expect(res.body.publicId).toBe(initRes.body.publicId);
      expect(res.body.title).toBe('Draft Meta');
      expect(res.body.status).toBe('draft');
      expect(res.body.thumbnail_url).toBeNull();
      expect(res.body.duration_seconds).toBeNull();
      expect(res.body.channel.id).toBe(channelId);
      expect(res.body.channel.name).toBeDefined();
    });
  });

  describe('GET /videos/:public_id/stream and /download (seeded ready video)', () => {
    it('streams the full file with 200 and Accept-Ranges when no Range header', async () => {
      const { channelId } = await setupUserWithChannel('streamer1@example.com');
      const { size } = await seedReadyVideo(channelId, 'e2estream001');

      const res = await request(app.getHttpServer())
        .get('/videos/e2estream001/stream')
        .expect(200);

      expect(res.headers['content-type']).toBe('video/mp4');
      expect(Number(res.headers['content-length'])).toBe(size);
      expect(res.headers['accept-ranges']).toBe('bytes');
    });

    it('returns 206 with Content-Range for a partial Range request', async () => {
      const { channelId } = await setupUserWithChannel('streamer2@example.com');
      const { size } = await seedReadyVideo(channelId, 'e2estream002');

      const res = await request(app.getHttpServer())
        .get('/videos/e2estream002/stream')
        .set('Range', 'bytes=0-99')
        .expect(206);

      expect(res.headers['content-range']).toBe(`bytes 0-99/${size}`);
      expect(Number(res.headers['content-length'])).toBe(100);
    });

    it('returns 416 for a Range beyond the file size', async () => {
      const { channelId } = await setupUserWithChannel('streamer3@example.com');
      await seedReadyVideo(channelId, 'e2estream003');

      await request(app.getHttpServer())
        .get('/videos/e2estream003/stream')
        .set('Range', 'bytes=999999999-999999999')
        .expect(416);
    });

    it('returns 404 when streaming a video that is not ready', async () => {
      const { accessToken, channelId } = await setupUserWithChannel(
        'notready@example.com',
      );

      const initRes = await request(app.getHttpServer())
        .post('/videos/upload-init')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ title: 'Still draft', channel_id: channelId })
        .expect(201);

      await request(app.getHttpServer())
        .get(`/videos/${initRes.body.publicId}/stream`)
        .expect(404);
    });

    it('downloads the file with Content-Disposition: attachment', async () => {
      const { channelId } = await setupUserWithChannel(
        'downloader@example.com',
      );
      const { size } = await seedReadyVideo(channelId, 'e2edownload01');

      const res = await request(app.getHttpServer())
        .get('/videos/e2edownload01/download')
        .expect(200);

      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.headers['content-type']).toBe('video/mp4');
      expect(Number(res.headers['content-length'])).toBe(size);
    });
  });

  describe('Full lifecycle with real worker (upload → process → stream)', () => {
    it('processes the uploaded video to ready and serves it via Range/206', async () => {
      const { accessToken, channelId } = await setupUserWithChannel(
        'lifecycle@example.com',
      );

      // 1. init
      const initRes = await request(app.getHttpServer())
        .post('/videos/upload-init')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          title: 'Lifecycle Video',
          channel_id: channelId,
          filename: 'lifecycle.mp4',
        })
        .expect(201);

      // 2. presigned PUT of a real 1-second MP4
      const putRes = await fetch(initRes.body.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(testVideoBuffer),
      });
      expect(putRes.ok).toBe(true);

      // 3. complete → job enqueued for the video-worker container
      await request(app.getHttpServer())
        .post(`/videos/${initRes.body.videoId}/upload-complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      // 4. the real worker (video-worker container) consumes the job:
      //    ffprobe metadata + ffmpeg thumbnail + status transition.
      //    Poll the DB (not HTTP) so the global rate limiter is not tripped.
      await waitForDbStatus(initRes.body.videoId, ['ready', 'failed'], 90000);

      // Reset the throttler before the final HTTP assertions
      throttlerStorage.storage.clear();

      const metaRes = await request(app.getHttpServer())
        .get(`/videos/${initRes.body.publicId}`)
        .expect(200);
      const metadata = metaRes.body;
      expect(metadata.status).toBe('ready');
      expect(metadata.duration_seconds).toBeGreaterThanOrEqual(1);
      expect(metadata.thumbnail_url).toContain('X-Amz-Signature');
      expect(metadata.size_bytes).toBe(testVideoBuffer.length);

      // 5. stream the processed video with a Range request
      const streamRes = await request(app.getHttpServer())
        .get(`/videos/${initRes.body.publicId}/stream`)
        .set('Range', 'bytes=0-99')
        .expect(206);
      expect(streamRes.headers['content-range']).toBe(
        `bytes 0-99/${testVideoBuffer.length}`,
      );
    }, 120000);

    async function waitForDbStatus(
      videoId: string,
      targets: string[],
      timeoutMs: number,
    ): Promise<Video> {
      const start = Date.now();
      for (;;) {
        const video = await videoRepository.findOneBy({ id: videoId });
        if (video && targets.includes(video.status)) {
          return video;
        }
        if (Date.now() - start > timeoutMs) {
          throw new Error(
            `Timed out waiting for status in [${targets.join(', ')}]; last=${video?.status}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  });
});

/** Generates a real 1-second MP4 (H.264 + AAC) using the container's ffmpeg. */
async function createTestVideoFile(): Promise<Buffer> {
  const tmpDir = '/tmp/videos-e2e';
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }
  const tempFile = `${tmpDir}/test-video-${Date.now()}.mp4`;

  return new Promise<Buffer>((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=320x240:d=1',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=44100:cl=mono:d=1',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      '-pix_fmt',
      'yuv420p',
      '-y',
      tempFile,
    ]);

    let stderrOutput = '';
    ffmpeg.stderr?.on('data', (data: Buffer) => {
      stderrOutput += data.toString();
    });

    ffmpeg.on('close', (code: number | null) => {
      if (code !== 0) {
        reject(new Error(`Failed to create test video: ${stderrOutput}`));
        return;
      }
      try {
        const buffer = fs.readFileSync(tempFile);
        fs.unlinkSync(tempFile);
        resolve(buffer);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    ffmpeg.on('error', (error: Error) => {
      reject(error);
    });
  });
}
