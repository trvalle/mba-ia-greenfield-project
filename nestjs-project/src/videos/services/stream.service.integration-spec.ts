import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Video } from '../entities/video.entity';
import { Channel } from '../../channels/entities/channel.entity';
import { User } from '../../users/entities/user.entity';
import { VideosRepository } from '../repositories/videos.repository';
import { StreamService } from './stream.service';
import { StorageService } from '../../storage/storage.service';
import { createTestDataSource } from '../../test/create-test-data-source';
import storageConfig from '../../config/storage.config';
import appConfig from '../../config/app.config';

describe('StreamService (Integration - Real MinIO)', () => {
  let service: StreamService;
  let module: TestingModule;
  let dataSource: DataSource;
  let videosRepository: VideosRepository;
  let storageService: StorageService;

  // Test data
  const testStorageKey = `test-videos/${Date.now()}/test-video.mp4`;
  const testFileContent = Buffer.from(
    'This is test video content for streaming',
  );
  let testChannelId: string;
  let testUserId: string;

  // Helper to generate unique 12-char public IDs for videos
  const generatePublicId = (): string => {
    return Math.random().toString(36).substring(2, 12).padEnd(12, 'a');
  };

  beforeAll(async () => {
    const entities = [User, Channel, Video];
    const ds = createTestDataSource(entities);

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [appConfig, storageConfig],
        }),
        TypeOrmModule.forRoot(ds.options),
        TypeOrmModule.forFeature(entities),
      ],
      providers: [VideosRepository, StorageService, StreamService],
    }).compile();

    service = module.get<StreamService>(StreamService);
    videosRepository = module.get<VideosRepository>(VideosRepository);
    storageService = module.get<StorageService>(StorageService);
    dataSource = module.get<DataSource>(DataSource);

    await dataSource.synchronize();

    // Create test user
    const userRepo = dataSource.getRepository(User);
    const testUser = userRepo.create({
      email: `test-${Date.now()}@example.com`,
      password: 'dummy',
    });
    const savedUser = await userRepo.save(testUser);
    testUserId = savedUser.id;

    // Create test channel
    const channelRepo = dataSource.getRepository(Channel);
    const testChannel = channelRepo.create({
      user_id: testUserId,
      name: `test-channel-${Date.now()}`,
      nickname: `test-nick-${Date.now()}`,
    });
    const savedChannel = await channelRepo.save(testChannel);
    testChannelId = savedChannel.id;

    // Ensure bucket exists
    await storageService.ensureBucketExists();

    // Upload test file
    await storageService.putObject(testStorageKey, testFileContent);
  }, 30000);

  afterEach(async () => {
    // Clean only videos, not channels/users (those are needed for following tests)
    try {
      await dataSource.query('DELETE FROM "videos"');
    } catch {
      // Ignore cleanup errors
    }
  });

  afterAll(async () => {
    try {
      // Delete test file
      try {
        await storageService.deleteObject(testStorageKey);
      } catch {
        // Ignore cleanup errors
      }

      if (dataSource && dataSource.isInitialized) {
        try {
          await dataSource.destroy();
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
    } catch {
      // Ensure function doesn't throw
    }
  }, 30000);

  describe('streamVideo', () => {
    it('should stream full video without Range header', async () => {
      // Create a ready video
      const video = new Video();
      video.channel_id = testChannelId;
      video.title = 'Stream Test Video';
      video.public_id = generatePublicId();
      video.status = 'ready';
      video.storage_key = testStorageKey;
      const savedVideo = await videosRepository.save(video);

      // Stream without Range
      const result = await service.streamVideo(savedVideo.public_id);

      expect(result.status).toBe(200);
      expect(result.headers['Content-Type']).toBe('video/mp4');
      expect(result.headers['Content-Length']).toBe(testFileContent.length);
      expect(result.headers['Accept-Ranges']).toBe('bytes');
      expect(result.stream).toBeDefined();

      // Read stream to verify content
      return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        result.stream.on('data', (chunk) => chunks.push(chunk));
        result.stream.on('end', () => {
          const content = Buffer.concat(chunks);
          expect(content.toString()).toContain('test video content');
          resolve(undefined);
        });
        result.stream.on('error', reject);
      });
    });

    it('should stream partial content with Range header', async () => {
      const video = new Video();
      video.channel_id = testChannelId;
      video.title = 'Range Test Video';
      video.public_id = generatePublicId();
      video.status = 'ready';
      video.storage_key = testStorageKey;
      const savedVideo = await videosRepository.save(video);

      // Stream bytes 0-9 (first 10 bytes)
      const result = await service.streamVideo(
        savedVideo.public_id,
        'bytes=0-9',
      );

      expect(result.status).toBe(206);
      expect(result.headers['Content-Length']).toBe(10);
      expect(result.headers['Content-Range']).toBe(
        `bytes 0-9/${testFileContent.length}`,
      );

      // Verify chunk size
      return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        result.stream.on('data', (chunk) => chunks.push(chunk));
        result.stream.on('end', () => {
          const content = Buffer.concat(chunks);
          expect(content.length).toBe(10);
          resolve(undefined);
        });
        result.stream.on('error', reject);
      });
    });

    it('should stream range from middle of file', async () => {
      const video = new Video();
      video.channel_id = testChannelId;
      video.title = 'Mid-Range Test';
      video.public_id = generatePublicId();
      video.status = 'ready';
      video.storage_key = testStorageKey;
      const savedVideo = await videosRepository.save(video);

      // Stream bytes 10-19 (10 bytes starting at position 10)
      const result = await service.streamVideo(
        savedVideo.public_id,
        'bytes=10-19',
      );

      expect(result.status).toBe(206);
      expect(result.headers['Content-Length']).toBe(10);
      expect(result.headers['Content-Range']).toBe(
        `bytes 10-19/${testFileContent.length}`,
      );
    });

    it('should throw NotFoundException if video does not exist', async () => {
      await expect(service.streamVideo('non-existent-video')).rejects.toThrow();
    });

    it('should throw NotFoundException if video status is not ready', async () => {
      const video = new Video();
      video.channel_id = testChannelId;
      video.title = 'Draft Video';
      video.public_id = generatePublicId();
      video.status = 'draft';
      video.storage_key = testStorageKey;
      const savedVideo = await videosRepository.save(video);

      await expect(service.streamVideo(savedVideo.public_id)).rejects.toThrow();
    });

    it('should handle open-ended range (bytes=10-)', async () => {
      const video = new Video();
      video.channel_id = testChannelId;
      video.title = 'Open-Ended Range';
      video.public_id = generatePublicId();
      video.status = 'ready';
      video.storage_key = testStorageKey;
      const savedVideo = await videosRepository.save(video);

      // Stream from byte 10 to end
      const result = await service.streamVideo(
        savedVideo.public_id,
        'bytes=10-',
      );

      expect(result.status).toBe(206);
      const expectedLength = testFileContent.length - 10;
      expect(result.headers['Content-Length']).toBe(expectedLength);
      expect(result.headers['Content-Range']).toBe(
        `bytes 10-${testFileContent.length - 1}/${testFileContent.length}`,
      );
    });

    it('should handle different video statuses', async () => {
      const statuses: Array<'draft' | 'processing' | 'ready' | 'failed'> = [
        'draft',
        'processing',
        'failed',
      ];

      for (const status of statuses) {
        const video = new Video();
        video.channel_id = testChannelId;
        video.title = `Video with status ${status}`;
        video.public_id = generatePublicId();
        video.status = status;
        video.storage_key = testStorageKey;
        const savedVideo = await videosRepository.save(video);

        await expect(
          service.streamVideo(savedVideo.public_id),
        ).rejects.toThrow();
      }
    });
  });

  describe('downloadVideo', () => {
    it('should return download with Content-Disposition', async () => {
      const video = new Video();
      video.channel_id = testChannelId;
      video.title = 'Download Test';
      video.public_id = generatePublicId();
      video.status = 'ready';
      video.storage_key = testStorageKey;
      const savedVideo = await videosRepository.save(video);

      const result = await service.downloadVideo(savedVideo.public_id);

      expect(result.filename).toBe('test-video.mp4');
      expect(result.contentType).toBe('video/mp4');
      expect(result.contentLength).toBe(testFileContent.length);
      expect(result.stream).toBeDefined();

      // Read stream to verify content
      return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        result.stream.on('data', (chunk) => chunks.push(chunk));
        result.stream.on('end', () => {
          const content = Buffer.concat(chunks);
          expect(content.equals(testFileContent)).toBe(true);
          resolve(undefined);
        });
        result.stream.on('error', reject);
      });
    });

    it('should throw NotFoundException if video not ready', async () => {
      const video = new Video();
      video.channel_id = testChannelId;
      video.title = 'Not Ready';
      video.public_id = generatePublicId();
      video.status = 'processing';
      video.storage_key = testStorageKey;
      const savedVideo = await videosRepository.save(video);

      await expect(
        service.downloadVideo(savedVideo.public_id),
      ).rejects.toThrow();
    });

    it('should extract correct filename from various storage keys', async () => {
      const testCases = [
        {
          key: 'videos/channels/ch1/videos/v1/source.mp4',
          expected: 'source.mp4',
        },
        {
          key: 'videos/channels/ch1/videos/v1/my-video.mov',
          expected: 'my-video.mov',
        },
        { key: 'videos/channels/ch1/videos/v1/file', expected: 'file' },
      ];

      for (const testCase of testCases) {
        // Create a temporary test file
        const tempKey = `${testStorageKey.split('/').slice(0, -1).join('/')}/${testCase.key.split('/').pop()}`;
        await storageService.putObject(tempKey, testFileContent);

        try {
          const video = new Video();
          video.channel_id = testChannelId;
          video.title = `Test ${testCase.key}`;
          video.public_id = generatePublicId();
          video.status = 'ready';
          video.storage_key = tempKey;
          const savedVideo = await videosRepository.save(video);

          const result = await service.downloadVideo(savedVideo.public_id);
          expect(result.filename).toBe(testCase.expected);
        } finally {
          await storageService.deleteObject(tempKey);
        }
      }
    });
  });

  describe('Order Independence', () => {
    it('should handle multiple streaming requests independently', async () => {
      // Create 3 ready videos
      const videos: Video[] = [];
      for (let i = 0; i < 3; i++) {
        const video = new Video();
        video.channel_id = testChannelId;
        video.title = `Concurrent Stream ${i}`;
        video.public_id = generatePublicId();
        video.status = 'ready';
        video.storage_key = testStorageKey;
        videos.push(await videosRepository.save(video));
      }

      // Stream all concurrently
      const promises = videos.map((v) =>
        service.streamVideo(v.public_id, 'bytes=0-9'),
      );

      const results = await Promise.all(promises);

      // All should succeed independently
      results.forEach((result) => {
        expect(result.status).toBe(206);
        expect(result.headers['Content-Length']).toBe(10);
      });
    });

    it('should handle concurrent downloads independently', async () => {
      // Create 2 ready videos
      const videos: Video[] = [];
      for (let i = 0; i < 2; i++) {
        const video = new Video();
        video.channel_id = testChannelId;
        video.title = `Concurrent Download ${i}`;
        video.public_id = generatePublicId();
        video.status = 'ready';
        video.storage_key = testStorageKey;
        videos.push(await videosRepository.save(video));
      }

      // Download all concurrently
      const promises = videos.map((v) => service.downloadVideo(v.public_id));

      const results = await Promise.all(promises);

      // All should succeed independently
      results.forEach((result) => {
        expect(result.contentLength).toBe(testFileContent.length);
        expect(result.contentType).toBe('video/mp4');
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle videos with various public_id formats', async () => {
      const publicIds = [
        'abcd1234efgh',
        'ABCD1234EFGH',
        'aBcD1234EfGh',
        'a1b2c3d4e5f6',
      ];

      for (const publicId of publicIds) {
        const video = new Video();
        video.channel_id = testChannelId;
        video.title = `Video with public_id ${publicId}`;
        video.public_id = publicId;
        video.status = 'ready';
        video.storage_key = testStorageKey;
        const savedVideo = await videosRepository.save(video);

        const result = await service.streamVideo(savedVideo.public_id);
        expect(result.status).toBe(200);
      }
    });

    it('should stream full file when Range header is malformed', async () => {
      const video = new Video();
      video.channel_id = testChannelId;
      video.title = 'Malformed Range Test';
      video.public_id = generatePublicId();
      video.status = 'ready';
      video.storage_key = testStorageKey;
      const savedVideo = await videosRepository.save(video);

      // Pass invalid range header (should be ignored)
      const result = await service.streamVideo(
        savedVideo.public_id,
        'invalid-range-header',
      );

      expect(result.status).toBe(200);
      expect(result.headers['Content-Length']).toBe(testFileContent.length);
    });

    it('should correctly calculate content-length for edge byte ranges', async () => {
      const video = new Video();
      video.channel_id = testChannelId;
      video.title = 'Edge Case Range';
      video.public_id = generatePublicId();
      video.status = 'ready';
      video.storage_key = testStorageKey;
      const savedVideo = await videosRepository.save(video);

      // Test: last single byte
      const lastByteRange = `bytes=${testFileContent.length - 1}-`;
      const result = await service.streamVideo(
        savedVideo.public_id,
        lastByteRange,
      );

      expect(result.status).toBe(206);
      expect(result.headers['Content-Length']).toBe(1);
    });
  });
});
