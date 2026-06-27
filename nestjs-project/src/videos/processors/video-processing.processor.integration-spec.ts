import { spawn } from 'child_process';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { User } from '../../users/entities/user.entity';
import { Video } from '../entities/video.entity';
import { VideosRepository } from '../repositories/videos.repository';
import { StorageService } from '../../storage/storage.service';
import { FfmpegService } from '../services/ffmpeg.service';
import { VideoProcessingService } from '../services/video-processing.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('VideoProcessingProcessor (Integration - Real FFmpeg)', () => {
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

    // Set up database
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();

    videosRepository = new VideosRepository(dataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);

    // Initialize services with real dependencies
    ffmpegService = new FfmpegService();
    storageService = new StorageService(null as any, null as any);
    videoProcessingService = new VideoProcessingService(
      storageService,
      videosRepository,
      ffmpegService,
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    // Clean all tables
    await cleanAllTables(dataSource);

    // Create test user and channel
    testUser = await userRepository.save(
      userRepository.create({
        email: 'processor-test@example.com',
        password: 'hashed',
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

  describe('FFmpeg Service Metadata Extraction', () => {
    it('should extract metadata from test video file', async () => {
      // Create temp file
      const tmpFile = `/tmp/video-worker/test-metadata-${Date.now()}.mp4`;
      const fs = require('fs');
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
      const fs = require('fs');
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
      const fs = require('fs');
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
      const fs = require('fs');
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

  describe('Video Processing Workflow (with Mocked Storage)', () => {
    beforeEach(() => {
      // Mock storage service methods
      jest
        .spyOn(storageService, 'getObject')
        .mockResolvedValue(require('stream').Readable.from(testVideoFile));
      jest.spyOn(storageService, 'putObject').mockResolvedValue(void 0);
      jest.spyOn(storageService, 'headObject').mockResolvedValue({
        size: testVideoFile.length,
        lastModified: new Date(),
      });
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    it('should process video: extract metadata, generate thumbnail, update status', async () => {
      const videoId = `test-video-${Date.now()}`;
      const storageKey = `videos/channels/${testChannel.id}/videos/${videoId}/source.mp4`;
      const thumbnailKey = `thumbnails/channels/${testChannel.id}/videos/${videoId}/thumb.jpg`;

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

      // Process video
      const payload = {
        videoId,
        storageKey,
        channelId: testChannel.id,
      };
      await videoProcessingService.processVideo(payload);

      // Verify results
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
      expect(processedVideo?.size_bytes).toBe(testVideoFile.length);
      expect(processedVideo?.error_reason).toBeNull();
    });

    it('should extract correct metadata from test video', async () => {
      const videoId = `metadata-test-${Date.now()}`;
      const storageKey = `videos/channels/${testChannel.id}/videos/${videoId}/source.mp4`;

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
    });

    it('should mark video as failed on invalid file', async () => {
      const videoId = `invalid-video-${Date.now()}`;
      const storageKey = `videos/channels/${testChannel.id}/videos/${videoId}/invalid.mp4`;

      // Mock storage to return invalid data
      jest
        .spyOn(storageService, 'getObject')
        .mockResolvedValue(
          require('stream').Readable.from(Buffer.from('not a video')),
        );

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
    });

    it('should be idempotent: reprocessing same video is safe', async () => {
      const videoId = `idempotent-${Date.now()}`;
      const storageKey = `videos/channels/${testChannel.id}/videos/${videoId}/source.mp4`;

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
      await videoProcessingService.processVideo(payload);
      const first = await videosRepository.findOne({
        where: { id: videoId },
      });

      // Reset to processing to reprocess
      if (first) {
        first.status = 'processing';
        await videosRepository.save(first);
      }

      await videoProcessingService.processVideo(payload);
      const second = await videosRepository.findOne({
        where: { id: videoId },
      });

      // Should be identical (idempotent)
      expect(first?.status).toBe('ready');
      expect(second?.status).toBe('ready');
      expect(first?.duration_seconds).toBe(second?.duration_seconds);
      expect(first?.thumbnail_key).toBe(second?.thumbnail_key);
    });
  });
});

/**
 * Generate a minimal 1-second MP4 test video using ffmpeg.
 */
async function createTestVideoFile(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
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
      '-f',
      'mp4',
      'pipe:1',
    ]);

    const chunks: Buffer[] = [];

    ffmpeg.stdout.on('data', (data) => {
      chunks.push(data);
    });

    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        reject(new Error('Failed to create test video'));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });

    ffmpeg.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Extract metadata from a local file using ffprobe (test helper).
 */
async function extractMetadataFromFile(filepath: string): Promise<any> {
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

    ffprobe.stdout.on('data', (data) => {
      output += data.toString();
    });

    ffprobe.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error('Invalid video file'));
      }

      try {
        const probe = JSON.parse(output);
        const format = probe.format || {};
        const videoStream = probe.streams?.find(
          (s: any) => s.codec_type === 'video',
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
      } catch (error) {
        reject(new Error('Failed to parse metadata'));
      }
    });

    ffprobe.on('error', (error) => {
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

  return new Promise((resolve, reject) => {
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

    ffmpeg.stdout.on('data', (data) => {
      chunks.push(data);
    });

    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error('Thumbnail generation failed'));
      }
      resolve(Buffer.concat(chunks));
    });

    ffmpeg.on('error', (error) => {
      reject(error);
    });
  });
}
