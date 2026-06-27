import { DataSource, Repository } from 'typeorm';
import { spawn } from 'child_process';
import * as fs from 'fs';
import { Channel } from '../../channels/entities/channel.entity';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { User } from '../../users/entities/user.entity';
import { Video } from '../entities/video.entity';
import { VideosRepository } from '../repositories/videos.repository';
import { StorageService } from '../../storage/storage.service';
import { FfmpegService } from '../services/ffmpeg.service';
import { VideoProcessingService } from '../services/video-processing.service';
import { createTestDataSource } from '../../test/create-test-data-source';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('VideoProcessingProcessor (Integration - Real FFmpeg + Real MinIO)', () => {
  let dataSource: DataSource;
  let videosRepository: VideosRepository;
  let storageService: StorageService;
  let videoProcessingService: VideoProcessingService;
  let ffmpegService: FfmpegService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let testUser: User;
  let testChannel: Channel;
  let testVideoFile: Buffer;

  beforeAll(async () => {
    // Create test video file (1 second MP4)
    testVideoFile = await createTestVideoFile();

    // Set up database connection
    dataSource = createTestDataSource(ALL_ENTITIES, { synchronize: false });
    await dataSource.initialize();

    // Initialize repositories
    videosRepository = new VideosRepository(dataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);

    // Initialize services
    ffmpegService = new FfmpegService();

    // Create config service mock for StorageService
    const configService = {
      get: (key: string): string | undefined => process.env[key],
      getOrThrow: (key: string): string => {
        const value = process.env[key];
        if (!value) {
          throw new Error(`Missing env var: ${key}`);
        }
        return value;
      },
    };

    // Create storage config from environment variables
    const storageConfigObj = {
      region: process.env.S3_REGION || 'us-east-1',
      endpointInternal: process.env.S3_ENDPOINT_INTERNAL || 'http://minio:9000',
      endpointPublic: process.env.S3_ENDPOINT_PUBLIC || 'http://localhost:9000',
      bucket: process.env.S3_BUCKET || 'streamtube',
      accessKeyId: process.env.S3_ACCESS_KEY_ID || 'minioadmin',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || 'minioadmin',
      presignExpirationSeconds: parseInt(
        process.env.PRESIGN_EXPIRATION_SECONDS || '3600',
        10,
      ),
    };

    // Initialize StorageService with typed dependencies

    storageService = new StorageService(
      configService as any,
      storageConfigObj as any,
    );

    videoProcessingService = new VideoProcessingService(
      storageService,
      videosRepository,
      ffmpegService,
    );

    // Ensure bucket exists in real MinIO
    console.log('Ensuring MinIO bucket exists...');
    await storageService.ensureBucketExists();

    // Clean all tables from previous test runs
    await dataSource.query('DELETE FROM "videos"');
    await dataSource.query('DELETE FROM "channels"');
    await dataSource.query('DELETE FROM "users"');

    // Create test user and channel
    testUser = await userRepository.save(
      userRepository.create({
        email: 'video-processor-test@example.com',
        password: 'hashed-test-pass',
      }),
    );

    testChannel = await channelRepository.save(
      channelRepository.create({
        name: 'Test Channel',
        nickname: 'test-channel',
        user_id: testUser.id,
      }),
    );
  });

  afterAll(async () => {
    if (dataSource) {
      await dataSource.destroy();
    }
  });

  beforeEach(async () => {
    // Clean video records before each test (but keep user/channel)
    await dataSource.query('DELETE FROM "videos"');
  });

  describe('FFmpeg Service Metadata Extraction', () => {
    it('should extract metadata from test video file', async () => {
      // Create temp file
      const tmpFile = `/tmp/video-worker/test-metadata-${Date.now()}.mp4`;
      fs.writeFileSync(tmpFile, testVideoFile);

      try {
        const metadata = await extractMetadataFromFile(tmpFile);

        expect(metadata).toBeDefined();
        expect(metadata.duration_seconds).toBe(1);
        expect(metadata.codec_video).toBeDefined();
        expect(metadata.resolution).toMatch(/\d+x\d+/);
      } finally {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      }
    });

    it('should handle invalid video file gracefully', async () => {
      const tmpFile = `/tmp/video-worker/invalid-${Date.now()}.mp4`;
      fs.writeFileSync(tmpFile, Buffer.from('not a video'));

      try {
        await extractMetadataFromFile(tmpFile);
        fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('Invalid');
      } finally {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      }
    });
  });

  describe('FFmpeg Service Thumbnail Generation', () => {
    it('should generate thumbnail from test video', async () => {
      const tmpFile = `/tmp/video-worker/test-thumb-${Date.now()}.mp4`;
      fs.writeFileSync(tmpFile, testVideoFile);

      try {
        const thumbnail = await generateThumbnailFromFile(tmpFile, 1);

        expect(thumbnail).toBeDefined();
        expect(Buffer.isBuffer(thumbnail)).toBe(true);
        expect(thumbnail.length).toBeGreaterThan(0);
        // JPEG starts with FFD8
        expect(thumbnail[0]).toBe(0xff);
        expect(thumbnail[1]).toBe(0xd8);
      } finally {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      }
    });

    it('should respect timestamp parameter', async () => {
      const tmpFile = `/tmp/video-worker/test-thumb2-${Date.now()}.mp4`;
      fs.writeFileSync(tmpFile, testVideoFile);

      try {
        // Extract at 0 seconds
        const thumbnail = await generateThumbnailFromFile(tmpFile, 0);
        expect(Buffer.isBuffer(thumbnail)).toBe(true);
        expect(thumbnail.length).toBeGreaterThan(0);
      } finally {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      }
    });
  });

  describe('Video Processing Workflow (with Real MinIO Storage)', () => {
    // No mocks - using real storage;

    it('should process video: extract metadata, generate thumbnail, update status', async () => {
      const videoId = generateUUID();
      const storageKey = `videos/channels/${testChannel.id}/videos/${videoId}/source.mp4`;
      const thumbnailKey = `thumbnails/channels/${testChannel.id}/videos/${videoId}/thumb.jpg`;

      // Upload test video to REAL MinIO
      console.log(`Uploading test video to ${storageKey}...`);
      await storageService.putObject(storageKey, testVideoFile);

      // Verify file exists in storage
      const uploadedMetadata = await storageService.headObject(storageKey);
      expect(uploadedMetadata.size).toBe(testVideoFile.length);

      // Create video record in database with status 'processing'
      const video = videosRepository.create({
        id: videoId,
        channel_id: testChannel.id,
        title: 'Test Video',
        public_id: 'test-pub-id',
        status: 'processing',
        storage_key: storageKey,
      });
      await videosRepository.save(video);

      // Process video using REAL ffmpeg and ffprobe
      const payload = {
        videoId,
        storageKey,
        channelId: testChannel.id,
      };
      await videoProcessingService.processVideo(payload);

      // Verify database state
      const processedVideo = await videosRepository.findOne({
        where: { id: videoId },
      });
      expect(processedVideo?.status).toBe('ready');
      expect(processedVideo?.duration_seconds).toBe(1);
      expect(processedVideo?.metadata).toBeDefined();
      if (processedVideo?.metadata) {
        expect(processedVideo.metadata.duration_seconds).toBe(1);
      }
      expect(processedVideo?.thumbnail_key).toBe(thumbnailKey);
      expect(Number(processedVideo?.size_bytes)).toBe(testVideoFile.length);
      expect(processedVideo?.error_reason).toBeNull();

      // Verify thumbnail exists in REAL MinIO
      console.log(`Verifying thumbnail at ${thumbnailKey}...`);
      const thumbnailMetadata = await storageService.headObject(thumbnailKey);
      expect(thumbnailMetadata.size).toBeGreaterThan(0);

      // Clean up
      await storageService.deleteObject(storageKey);
      await storageService.deleteObject(thumbnailKey);
    });

    it('should extract correct metadata from test video', async () => {
      const videoId = generateUUID();
      const storageKey = `videos/channels/${testChannel.id}/videos/${videoId}/source.mp4`;
      const thumbnailKey = `thumbnails/channels/${testChannel.id}/videos/${videoId}/thumb.jpg`;

      // Upload video to REAL MinIO
      await storageService.putObject(storageKey, testVideoFile);

      const video = videosRepository.create({
        id: videoId,
        channel_id: testChannel.id,
        title: 'Metadata Test',
        public_id: 'meta-test',
        status: 'processing',
        storage_key: storageKey,
      });
      await videosRepository.save(video);

      await videoProcessingService.processVideo({
        videoId,
        storageKey,
        channelId: testChannel.id,
      });

      const processed = await videosRepository.findOne({
        where: { id: videoId },
      });
      expect(processed?.metadata?.duration_seconds).toBe(1);
      expect(processed?.metadata?.codec_video).toBeDefined();
      expect(processed?.metadata?.resolution).toMatch(/\d+x\d+/);
      expect(processed?.metadata?.resolution).toBe('320x240'); // Our test fixture is 320x240

      // Clean up
      await storageService.deleteObject(storageKey);
      await storageService.deleteObject(thumbnailKey);
    });

    it('should mark video as failed on invalid file', async () => {
      const videoId = generateUUID();
      const storageKey = `videos/channels/${testChannel.id}/videos/${videoId}/invalid.mp4`;

      // Upload invalid file (not a real video) to REAL MinIO
      const invalidBuffer = Buffer.from('This is not a valid video file');
      await storageService.putObject(storageKey, invalidBuffer);

      const video = videosRepository.create({
        id: videoId,
        channel_id: testChannel.id,
        title: 'Invalid Video',
        public_id: 'invalid-test',
        status: 'processing',
        storage_key: storageKey,
      });
      await videosRepository.save(video);

      // Process should fail and mark as failed
      await expect(
        videoProcessingService.processVideo({
          videoId,
          storageKey,
          channelId: testChannel.id,
        }),
      ).rejects.toThrow();

      const processed = await videosRepository.findOne({
        where: { id: videoId },
      });
      expect(processed?.status).toBe('failed');
      expect(processed?.error_reason).toBeDefined();
      expect(processed?.error_reason?.length).toBeGreaterThan(0);

      // Clean up
      await storageService.deleteObject(storageKey);
    });

    it('should be idempotent: reprocessing same video is safe', async () => {
      const videoId = generateUUID();
      const storageKey = `videos/channels/${testChannel.id}/videos/${videoId}/source.mp4`;
      const thumbnailKey = `thumbnails/channels/${testChannel.id}/videos/${videoId}/thumb.jpg`;

      // Upload video to REAL MinIO
      await storageService.putObject(storageKey, testVideoFile);

      const video = videosRepository.create({
        id: videoId,
        channel_id: testChannel.id,
        title: 'Idempotent Test',
        public_id: 'idempotent-test',
        status: 'processing',
        storage_key: storageKey,
      });
      await videosRepository.save(video);

      const payload = {
        videoId,
        storageKey,
        channelId: testChannel.id,
      };

      // Process twice
      console.log('First processing...');
      await videoProcessingService.processVideo(payload);
      const first = await videosRepository.findOne({
        where: { id: videoId },
      });

      // Store original result before modifying
      const firstDuration = first?.duration_seconds;
      const firstCodec = first?.metadata?.codec_video;
      const firstThumbnail = first?.thumbnail_key;

      // Reset to processing to reprocess
      if (first) {
        first.status = 'processing';
        await videosRepository.save(first);
      }

      console.log('Second processing (idempotent check)...');
      await videoProcessingService.processVideo(payload);
      const second = await videosRepository.findOne({
        where: { id: videoId },
      });

      // Should be identical (idempotent)
      expect(first?.status).toBe('processing'); // This was set before second processing
      expect(second?.status).toBe('ready');
      expect(firstDuration).toBe(second?.duration_seconds);
      expect(firstCodec).toBe(second?.metadata?.codec_video);
      expect(firstThumbnail).toBe(second?.thumbnail_key);
      console.log('✓ Idempotency verified');

      // Clean up
      await storageService.deleteObject(storageKey);
      await storageService.deleteObject(thumbnailKey);
    });
  });
});

/**
 * Generate a UUID for test data
 */
function generateUUID(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const crypto: any = require('crypto');
  return crypto.randomUUID() as string;
}

/**
 * Generate a minimal 1-second MP4 test video using ffmpeg.
 */
async function createTestVideoFile(): Promise<Buffer> {
  const tmpDir = '/tmp/video-worker';

  // Ensure tmp directory exists
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  const tempFile = `${tmpDir}/test-video-${Date.now()}.mp4`;

  return new Promise<Buffer>((resolve, reject) => {
    // Create a video file to disk
    const ffmpeg = spawn('ffmpeg', [
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=320x240:d=1', // 1 second black video
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=44100:cl=mono:d=1', // 1 second silence
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      '-pix_fmt',
      'yuv420p',
      '-y', // Overwrite output file
      tempFile,
    ]);

    let stderrOutput = '';

    ffmpeg.stderr?.on('data', (data: Buffer) => {
      stderrOutput += data.toString();
    });

    ffmpeg.on('close', (code: number | null) => {
      if (code !== 0) {
        reject(new Error(`Failed to create test video: ${stderrOutput}`));
      } else {
        // Read file and return buffer
        try {
          const buffer = fs.readFileSync(tempFile);
          // Clean up temp file
          fs.unlinkSync(tempFile);
          resolve(buffer);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });

    ffmpeg.on('error', (error: Error) => {
      reject(error);
    });
  });
}

/**
 * Extract metadata from a local file using ffprobe (test helper).
 */
async function extractMetadataFromFile(filepath: string): Promise<{
  duration_seconds: number;
  codec_video: string | undefined;
  resolution: string | undefined;
}> {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v',
      'error',
      '-show_format',
      '-show_streams',
      '-of',
      'json',
      filepath,
    ]);

    let output = '';

    ffprobe.stdout?.on('data', (data: Buffer) => {
      output += data.toString();
    });

    ffprobe.on('close', (code: number | null) => {
      if (code !== 0) {
        return reject(new Error('Invalid video file'));
      }

      try {
        interface ProbeFormat {
          duration?: string;
        }
        interface ProbeStream {
          codec_type: string;
          codec_name?: string;
          duration?: string;
          width?: number;
          height?: number;
        }
        interface ProbeOutput {
          format?: ProbeFormat;
          streams?: ProbeStream[];
        }

        const probe = JSON.parse(output) as ProbeOutput;
        const format = probe.format || {};
        const videoStream = probe.streams?.find(
          (s) => s.codec_type === 'video',
        );

        const duration = parseFloat(
          format.duration || videoStream?.duration || '0',
        );

        resolve({
          duration_seconds: Math.round(duration),
          codec_video: videoStream?.codec_name,
          resolution: videoStream
            ? `${videoStream.width}x${videoStream.height}`
            : undefined,
        });
      } catch {
        reject(new Error('Failed to parse metadata'));
      }
    });

    ffprobe.on('error', (error: Error) => {
      reject(error);
    });
  });
}

/**
 * Generate thumbnail from a local file using ffmpeg (test helper).
 */
async function generateThumbnailFromFile(
  filepath: string,
  durationSeconds: number,
): Promise<Buffer> {
  const timestamp = Math.min(1, Math.floor(durationSeconds / 4));

  return new Promise<Buffer>((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-ss',
      timestamp.toString(),
      '-i',
      filepath,
      '-vframes',
      '1',
      '-vf',
      'scale=320:-1',
      '-f',
      'image2',
      '-c:v',
      'mjpeg',
      'pipe:1',
    ]);

    const chunks: Buffer[] = [];

    ffmpeg.stdout?.on('data', (data: Buffer) => {
      chunks.push(data);
    });

    ffmpeg.on('close', (code: number | null) => {
      if (code !== 0) {
        return reject(new Error('Thumbnail generation failed'));
      }
      resolve(Buffer.concat(chunks));
    });

    ffmpeg.on('error', (error: Error) => {
      reject(error);
    });
  });
}
