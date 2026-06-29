import { DataSource, Repository } from 'typeorm';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { User } from '../../users/entities/user.entity';
import { Video } from '../entities/video.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { UploadService } from './upload.service';
import { VideosRepository } from '../repositories/videos.repository';
import { StorageService } from '../../storage/storage.service';
import { QueueService } from '../../queue/queue.service';
import {
  PublicIdGenerationException,
  VideoNotFoundException,
  VideoInvalidStatusException,
  StorageFileNotFoundException,
} from '../../common/exceptions/domain.exception';
import { UploadInitRequest } from '../dtos/upload-init.request';
import { UploadInitResponse } from '../dtos/upload-init.response';
import storageConfig from '../../config/storage.config';
import queueConfig from '../../config/queue.config';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('UploadService (Integration)', () => {
  let dataSource: DataSource;
  let uploadService: UploadService;
  let videosRepository: VideosRepository;
  let storageService: StorageService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoProcessingQueue: Queue;
  let testModule: TestingModule;

  let testUser: User;
  let testChannel: Channel;
  let testUser2: User;
  let testChannel2: Channel;

  beforeAll(async () => {
    // Initialize the real test database
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();

    // Create the test module with real services and infrastructure
    testModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: process.env.DB_HOST ?? 'db',
          port: Number(process.env.DB_PORT ?? 5432),
          username: process.env.DB_USERNAME ?? 'streamtube',
          password: process.env.DB_PASSWORD ?? 'streamtube',
          database: process.env.DB_DATABASE ?? 'streamtube',
          entities: ALL_ENTITIES,
          synchronize: false,
        }),
        TypeOrmModule.forFeature([Video, User, Channel]),
        BullModule.forRoot({
          connection: {
            host: process.env.REDIS_HOST ?? 'redis',
            port: Number(process.env.REDIS_PORT ?? 6379),
          },
        }),
        BullModule.registerQueue({
          name: 'video-processing',
        }),
      ],
      providers: [
        UploadService,
        VideosRepository,
        StorageService,
        QueueService,
        ConfigService,
      ],
    }).compile();

    uploadService = testModule.get<UploadService>(UploadService);
    videosRepository = testModule.get<VideosRepository>(VideosRepository);
    storageService = testModule.get<StorageService>(StorageService);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoProcessingQueue = testModule.get<Queue>('BullQueue_video-processing');

    // Ensure MinIO bucket exists
    await storageService.ensureBucketExists();

    // Clear Redis queue
    if (videoProcessingQueue) {
      await videoProcessingQueue.clean(0, 10000);
    }
  }, 30000);

  afterAll(async () => {
    try {
      // Clean up queue
      if (videoProcessingQueue) {
        try {
          await videoProcessingQueue.clean(0, 10000);
          await videoProcessingQueue.close();
        } catch {
          // Ignore cleanup errors
        }
      }

      // Close test module
      if (testModule) {
        try {
          await testModule.close();
        } catch {
          // Ignore cleanup errors
        }
      }

      // Destroy database connection
      if (dataSource && dataSource.isInitialized) {
        try {
          await dataSource.destroy();
        } catch {
          // Ignore cleanup errors
        }
      }
    } catch {
      // Ensure function doesn't throw
    }
  }, 30000);

  beforeEach(async () => {
    // Clean all test data
    await cleanAllTables(dataSource);

    // Create test users and channels
    testUser = await userRepository.save(
      userRepository.create({
        email: 'test-upload-user1@example.com',
        password: 'hashed',
      }),
    );

    testChannel = await channelRepository.save(
      channelRepository.create({
        name: 'Test Upload Channel 1',
        nickname: 'test-upload-ch-1',
        user_id: testUser.id,
      }),
    );

    testUser2 = await userRepository.save(
      userRepository.create({
        email: 'test-upload-user2@example.com',
        password: 'hashed',
      }),
    );

    testChannel2 = await channelRepository.save(
      channelRepository.create({
        name: 'Test Upload Channel 2',
        nickname: 'test-upload-ch-2',
        user_id: testUser2.id,
      }),
    );

    // Clear queue jobs
    if (videoProcessingQueue) {
      await videoProcessingQueue.clean(0, 10000);
    }
  });

  afterEach(async () => {
    // Clean up any videos created during the test
    await dataSource.query('DELETE FROM "videos"');

    // Clear queue jobs
    if (videoProcessingQueue) {
      await videoProcessingQueue.clean(0, 10000);
    }
  });

  describe('Scenario 1: upload-init Creates Draft Video', () => {
    it('should create draft video with unique public_id and return presigned URL', async () => {
      const request: UploadInitRequest = {
        title: 'Integration Test Video',
        channel_id: testChannel.id,
        filename: 'test.mp4',
      };

      const response = await uploadService.initializeUpload(
        testChannel.id,
        request,
      );

      // Verify response structure
      expect(response.videoId).toBeDefined();
      expect(response.videoId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      ); // UUID format
      expect(response.publicId).toMatch(/^[a-zA-Z0-9]{12}$/); // 12 base62 chars
      expect(response.uploadUrl).toContain('localhost:9000');
      expect(response.uploadUrl).toContain('X-Amz-Signature');
      expect(response.expiresIn).toBe(3600);

      // Verify storage key format
      expect(response.storageKey).toContain('videos/channels/');
      expect(response.storageKey).toContain(testChannel.id);
      expect(response.storageKey).toContain('source.mp4');

      // Verify database state
      const video = await videosRepository.findOne({
        where: { id: response.videoId },
      });
      expect(video).toBeDefined();
      expect(video?.status).toBe('draft');
      expect(video?.public_id).toBe(response.publicId);
      expect(video?.storage_key).toBe(response.storageKey);
      expect(video?.created_at).toBeDefined();
      expect(video?.channel_id).toBe(testChannel.id);
      expect(video?.title).toBe(request.title);
    });

    it('should use default .mp4 extension if no filename provided', async () => {
      const request: UploadInitRequest = {
        title: 'No Extension Video',
        channel_id: testChannel.id,
      };

      const response = await uploadService.initializeUpload(
        testChannel.id,
        request,
      );

      expect(response.storageKey).toContain('source.mp4');
    });

    it('should preserve extension from filename', async () => {
      const request: UploadInitRequest = {
        title: 'MOV Video',
        channel_id: testChannel.id,
        filename: 'my-video.mov',
      };

      const response = await uploadService.initializeUpload(
        testChannel.id,
        request,
      );

      expect(response.storageKey).toContain('source.mov');
    });

    it('should generate unique public_id on each call', async () => {
      const request1: UploadInitRequest = {
        title: 'Video 1',
        channel_id: testChannel.id,
      };

      const request2: UploadInitRequest = {
        title: 'Video 2',
        channel_id: testChannel.id,
      };

      const response1 = await uploadService.initializeUpload(
        testChannel.id,
        request1,
      );
      const response2 = await uploadService.initializeUpload(
        testChannel.id,
        request2,
      );

      expect(response1.publicId).not.toBe(response2.publicId);

      // Verify both are in database
      const video1 = await videosRepository.findOne({
        where: { id: response1.videoId },
      });
      const video2 = await videosRepository.findOne({
        where: { id: response2.videoId },
      });
      expect(video1?.public_id).toBe(response1.publicId);
      expect(video2?.public_id).toBe(response2.publicId);
    });
  });

  describe('Scenario 2: public_id Collision Retry', () => {
    afterEach(() => {
      // Clear all mocks after each test in this describe block
      jest.clearAllMocks();
    });

    it('should retry public_id generation on UNIQUE constraint violation and succeed', async () => {
      // Pre-populate a video with a known public_id
      const existingVideo = videosRepository.create({
        channel_id: testChannel.id,
        title: 'Existing Video',
        public_id: 'collision01a',
        status: 'draft',
        storage_key: 'videos/channels/existing/videos/existing/source.mp4',
      });
      await videosRepository.save(existingVideo);

      // Mock generatePublicId to collide once, then return unique IDs (max 12 chars)
      let callCount = 0;
      const originalGeneratePublicId = (uploadService as any).generatePublicId;
      jest
        .spyOn(uploadService as any, 'generatePublicId')
        .mockImplementation(function (this: UploadService) {
          callCount++;
          if (callCount === 1) {
            return 'collision01a'; // Will collide with existing
          }
          // Return a new unique ID (exactly 12 chars)
          return `uniqueId00${callCount}`.substring(0, 12);
        });

      const response = await uploadService.initializeUpload(testChannel.id, {
        title: 'Collision Test',
        channel_id: testChannel.id,
      });

      // Should have retried and succeeded
      expect(response.publicId).not.toBe('collision01a');

      const savedVideo = await videosRepository.findOne({
        where: { id: response.videoId },
      });
      expect(savedVideo?.public_id).toBe(response.publicId);

      // Restore original method
      (uploadService as any).generatePublicId = originalGeneratePublicId;
    });

    it('should throw PublicIdGenerationException after 5 failed retries', async () => {
      // Pre-populate videos with IDs that will collide
      for (let i = 0; i < 5; i++) {
        const video = videosRepository.create({
          channel_id: testChannel.id,
          title: `Collision Video ${i}`,
          public_id: `collisionXY${i}`,
          status: 'draft',
          storage_key: `videos/channels/test/videos/collision-${i}/source.mp4`,
        });
        await videosRepository.save(video);
      }

      // Mock generator to always return a colliding ID
      const originalGeneratePublicId = (uploadService as any).generatePublicId;
      jest
        .spyOn(uploadService as any, 'generatePublicId')
        .mockReturnValue('collisionXY0'); // Always returns same ID

      await expect(
        uploadService.initializeUpload(testChannel.id, {
          title: 'Will Fail',
          channel_id: testChannel.id,
        }),
      ).rejects.toThrow(PublicIdGenerationException);

      // Should have attempted 5 times (the retry loop)
      expect((uploadService as any).generatePublicId).toHaveBeenCalledTimes(5);

      // Restore original method
      (uploadService as any).generatePublicId = originalGeneratePublicId;
    });
  });

  describe('Scenario 3: upload-complete Full Flow (Real Storage, Real Queue)', () => {
    it('should complete upload: verify file, transition status, enqueue job', async () => {
      // Step 1: Initialize upload
      const uploadInitResponse = await uploadService.initializeUpload(
        testChannel.id,
        {
          title: 'Complete Flow Test',
          channel_id: testChannel.id,
        },
      );
      const videoId = uploadInitResponse.videoId;
      const storageKey = uploadInitResponse.storageKey;

      // Step 2: Upload file to MinIO using INTERNAL endpoint
      const fileContent = Buffer.from('fake video file content for testing');
      await storageService.putObject(storageKey, fileContent);

      // Verify file exists
      const metadata = await storageService.headObject(storageKey);
      expect(metadata.size).toBe(fileContent.length);
      expect(metadata.lastModified).toBeDefined();

      // Step 3: Complete upload
      const completeResponse = await uploadService.completeUpload(
        videoId,
        testChannel.id,
      );

      // Verify response
      expect(completeResponse.status).toBe('processing');
      expect(completeResponse.videoId).toBe(videoId);
      expect(completeResponse.publicId).toBeDefined();
      expect(completeResponse.createdAt).toBeDefined();
      expect(completeResponse.duration_seconds).toBeNull();
      expect(completeResponse.thumbnail_key).toBeNull();

      // Verify database transition
      const updatedVideo = await videosRepository.findOne({
        where: { id: videoId },
      });
      expect(updatedVideo?.status).toBe('processing');

      // Verify job enqueued
      const job = await videoProcessingQueue.getJob(videoId);
      expect(job).toBeDefined();
      expect(job?.data).toEqual({
        videoId,
        storageKey,
        channelId: testChannel.id,
      });
      expect(job?.id).toBe(videoId); // jobId = videoId for idempotency
      expect(job?.opts.attempts).toBe(3);
    });

    it('should throw error if video file not uploaded to storage', async () => {
      // Step 1: Initialize upload
      const uploadInitResponse = await uploadService.initializeUpload(
        testChannel.id,
        {
          title: 'Missing File Test',
          channel_id: testChannel.id,
        },
      );
      const videoId = uploadInitResponse.videoId;

      // Step 2: Do NOT upload file to storage

      // Step 3: Try to complete upload (should fail)
      await expect(
        uploadService.completeUpload(videoId, testChannel.id),
      ).rejects.toThrow(StorageFileNotFoundException);

      // Video should still be in draft status
      const video = await videosRepository.findOne({
        where: { id: videoId },
      });
      expect(video?.status).toBe('draft');
    });

    it('should transition draft to processing exactly once', async () => {
      // Step 1: Initialize upload
      const uploadInitResponse = await uploadService.initializeUpload(
        testChannel.id,
        {
          title: 'State Transition Test',
          channel_id: testChannel.id,
        },
      );
      const videoId = uploadInitResponse.videoId;

      // Step 2: Upload file
      await storageService.putObject(
        uploadInitResponse.storageKey,
        Buffer.from('test content'),
      );

      // Verify initial state
      let video = await videosRepository.findOne({
        where: { id: videoId },
      });
      expect(video?.status).toBe('draft');

      // Step 3: Complete upload
      const response = await uploadService.completeUpload(
        videoId,
        testChannel.id,
      );
      expect(response.status).toBe('processing');

      // Verify final state
      video = await videosRepository.findOne({
        where: { id: videoId },
      });
      expect(video?.status).toBe('processing');
    });
  });

  describe('Scenario 4: Authorization Check', () => {
    it('should reject upload-complete if video not owned by channel', async () => {
      // Create video for testChannel
      const uploadInitResponse = await uploadService.initializeUpload(
        testChannel.id,
        {
          title: 'Channel 1 Video',
          channel_id: testChannel.id,
        },
      );
      const videoId = uploadInitResponse.videoId;

      // Upload file
      await storageService.putObject(
        uploadInitResponse.storageKey,
        Buffer.from('test content'),
      );

      // testChannel2 (different user) tries to complete testChannel's video
      await expect(
        uploadService.completeUpload(videoId, testChannel2.id),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('should reject upload-complete if video is not in draft status', async () => {
      // Create and complete a video
      const uploadInitResponse = await uploadService.initializeUpload(
        testChannel.id,
        {
          title: 'Processing Video',
          channel_id: testChannel.id,
        },
      );
      const videoId = uploadInitResponse.videoId;

      // Upload file
      await storageService.putObject(
        uploadInitResponse.storageKey,
        Buffer.from('test content'),
      );

      // Complete upload (transitions to processing)
      await uploadService.completeUpload(videoId, testChannel.id);

      // Try to complete again (should fail — not in draft)
      await expect(
        uploadService.completeUpload(videoId, testChannel.id),
      ).rejects.toThrow(VideoInvalidStatusException);
    });

    it('should throw VideoNotFoundException for non-existent video', async () => {
      const fakeVideoId = '00000000-0000-0000-0000-000000000000';

      await expect(
        uploadService.completeUpload(fakeVideoId, testChannel.id),
      ).rejects.toThrow(VideoNotFoundException);
    });
  });

  describe('Order Independence', () => {
    it('should handle multiple concurrent uploads without collision', async () => {
      const uploadTasks: Array<Promise<UploadInitResponse>> = [];

      // Initiate 5 uploads concurrently
      for (let i = 0; i < 5; i++) {
        uploadTasks.push(
          uploadService.initializeUpload(testChannel.id, {
            title: `Concurrent Video ${i}`,
            channel_id: testChannel.id,
          }),
        );
      }

      const responses = await Promise.all(uploadTasks);

      // Verify all succeeded with unique public_ids
      const publicIds = new Set(responses.map((r) => r.publicId));
      expect(publicIds.size).toBe(5); // All unique

      // Verify all are in database
      const videos = await videosRepository.findByChannelId(testChannel.id);
      expect(videos.length).toBe(5);
    });

    it('should allow multiple channels to upload independently', async () => {
      // Upload to channel 1
      const ch1Response = await uploadService.initializeUpload(testChannel.id, {
        title: 'Channel 1 Video',
        channel_id: testChannel.id,
      });

      // Upload to channel 2
      const ch2Response = await uploadService.initializeUpload(
        testChannel2.id,
        {
          title: 'Channel 2 Video',
          channel_id: testChannel2.id,
        },
      );

      // Verify they are separate
      expect(ch1Response.videoId).not.toBe(ch2Response.videoId);
      expect(ch1Response.publicId).not.toBe(ch2Response.publicId);

      // Verify each is owned by its channel
      const video1 = await videosRepository.findOne({
        where: { id: ch1Response.videoId },
      });
      const video2 = await videosRepository.findOne({
        where: { id: ch2Response.videoId },
      });

      expect(video1?.channel_id).toBe(testChannel.id);
      expect(video2?.channel_id).toBe(testChannel2.id);
    });
  });
});
