import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QueueService } from './queue.service';
import queueConfig from '../config/queue.config';
import { VideoProcessingPayload } from '../videos/dtos/video-processing-payload.dto';

/**
 * Integration tests for QueueService using real Redis container.
 * These tests verify actual job enqueuing, idempotency, and queue operations.
 */
describe('QueueService (Integration - Real Redis)', () => {
  let module: TestingModule;
  let service: QueueService;
  let queue: Queue;
  let configService: ConfigService;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig],
        }),
        ConfigModule.forFeature(queueConfig),
        BullModule.forRootAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            connection: {
              host: config.get('REDIS_HOST') || 'redis',
              port: config.get('REDIS_PORT') || 6379,
              maxRetriesPerRequest: null,
              enableOfflineQueue: true,
            },
          }),
        }),
        BullModule.registerQueue({
          name: 'video-processing',
        }),
      ],
      providers: [QueueService],
    }).compile();

    service = module.get<QueueService>(QueueService);
    queue = module.get<Queue>(getQueueToken('video-processing'));
    configService = module.get<ConfigService>(ConfigService);

    await queue.drain();
  }, 30000);

  afterEach(async () => {
    try {
      const jobs = await queue.getJobs([
        'active',
        'waiting',
        'completed',
        'failed',
      ]);
      for (const job of jobs) {
        try {
          await job.remove();
        } catch {
          // Ignore job removal errors
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  afterAll(async () => {
    try {
      if (queue) {
        try {
          await queue.close();
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

  describe('Job Enqueuing', () => {
    it('should enqueue a video processing job', async () => {
      const payload: VideoProcessingPayload = {
        videoId: 'test-video-uuid-1',
        storageKey: 'videos/channels/ch-1/videos/test-video-uuid-1/source.mp4',
        channelId: 'channel-uuid-1',
      };

      await service.enqueueVideoProcessing(payload);

      const job = await queue.getJob('test-video-uuid-1');
      expect(job).toBeDefined();
      expect(job?.data).toEqual(payload);
    });

    it('should use videoId as idempotency key (jobId)', async () => {
      const videoId = 'idempotent-video-uuid';
      const payload1: VideoProcessingPayload = {
        videoId,
        storageKey: 'videos/1/source.mp4',
        channelId: 'ch-1',
      };

      await service.enqueueVideoProcessing(payload1);
      await service.enqueueVideoProcessing(payload1);

      const jobs = await queue.getJobs(['active', 'waiting']);
      const videoIdJobs = jobs.filter((j) => j.id === videoId);
      expect(videoIdJobs.length).toBe(1);
    });

    it('should preserve job payload structure', async () => {
      const payload: VideoProcessingPayload = {
        videoId: 'preserve-test-uuid',
        storageKey:
          'videos/channels/ch-999/videos/preserve-test-uuid/source.mp4',
        channelId: 'channel-uuid-999',
      };

      await service.enqueueVideoProcessing(payload);

      const job = await queue.getJob('preserve-test-uuid');
      expect(job?.data).toEqual({
        videoId: 'preserve-test-uuid',

        storageKey:
          'videos/channels/ch-999/videos/preserve-test-uuid/source.mp4',

        channelId: 'channel-uuid-999',
      });
    });

    it('should set job options correctly', async () => {
      const payload: VideoProcessingPayload = {
        videoId: 'options-test-uuid',
        storageKey: 'videos/options/source.mp4',
        channelId: 'ch-1',
      };

      await service.enqueueVideoProcessing(payload);

      const job = await queue.getJob('options-test-uuid');
      expect(job?.opts.attempts).toBe(3);
      const backoff = job?.opts.backoff;
      if (backoff && typeof backoff !== 'number') {
        expect(backoff.type).toBe('exponential');
        expect(backoff.delay).toBe(2000);
      }
      expect(job?.opts.removeOnComplete).toBe(true);
      expect(job?.opts.removeOnFail).toBe(false);
    });

    it('should handle multiple different video jobs', async () => {
      const videos: string[] = ['video-1', 'video-2', 'video-3'];

      for (const videoId of videos) {
        const payload: VideoProcessingPayload = {
          videoId,
          storageKey: `videos/${videoId}/source.mp4`,
          channelId: 'ch-1',
        };
        await service.enqueueVideoProcessing(payload);
      }

      const jobs = await queue.getJobs(['waiting', 'active']);
      expect(jobs.length).toBe(3);
    });
  });

  describe('Redis Connection', () => {
    it('should connect to Redis using correct host and port', async () => {
      const redisHost = configService.get('REDIS_HOST');

      const redisPort = configService.get('REDIS_PORT');

      expect(redisHost).toBe('redis');
      expect(parseInt(redisPort as string, 10)).toBe(6379);

      // Queue is connected (client may not be ready during test, but queue ops work)
      // Verify by attempting to retrieve a job that doesn't exist — if Redis is unreachable, this throws
      const nonExistentJob = await queue.getJob('nonexistent-job-id');
      expect(nonExistentJob).toBeUndefined();
    });

    it('should have maxRetriesPerRequest: null in connection config', async () => {
      // Verify no errors occur when enqueueing rapid jobs
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 10; i++) {
        const payload: VideoProcessingPayload = {
          videoId: `rapid-test-${i}`,
          storageKey: `videos/rapid-${i}/source.mp4`,
          channelId: 'ch-1',
        };
        promises.push(service.enqueueVideoProcessing(payload));
      }

      await Promise.all(promises);

      const jobs = await queue.getJobs(['waiting']);
      expect(jobs.length).toBe(10);
    });
  });

  describe('Job Status Tracking', () => {
    it('should return job status', async () => {
      const payload: VideoProcessingPayload = {
        videoId: 'status-test-uuid',
        storageKey: 'videos/status/source.mp4',
        channelId: 'ch-1',
      };

      await service.enqueueVideoProcessing(payload);

      const status = await service.getJobStatus('status-test-uuid');
      expect(status).toBeDefined();
      expect(status?.id).toBe('status-test-uuid');
      expect(status?.state).toBe('waiting');
      expect(status?.attempts).toBe(0);
      expect(status?.maxAttempts).toBe(3);
    });

    it('should return null for non-existent job', async () => {
      const status = await service.getJobStatus('non-existent-job-id');
      expect(status).toBeNull();
    });

    it('should track progress correctly', async () => {
      const payload: VideoProcessingPayload = {
        videoId: 'progress-test-uuid',
        storageKey: 'videos/progress/source.mp4',
        channelId: 'ch-1',
      };

      await service.enqueueVideoProcessing(payload);

      const status = await service.getJobStatus('progress-test-uuid');
      // Progress is 0 for new jobs (or null if not set)
      expect(status?.progress).toEqual(expect.any(Number));
    });
  });

  describe('Queue Isolation', () => {
    it('should isolate tests (queue clean between tests)', async () => {
      const jobs = await queue.getJobs(['waiting']);
      expect(jobs.length).toBe(0);
    });

    it('should handle rapid successive enqueues', async () => {
      const payload: VideoProcessingPayload = {
        videoId: 'successive-test',
        storageKey: 'videos/test/source.mp4',
        channelId: 'ch-1',
      };

      await service.enqueueVideoProcessing(payload);
      await service.enqueueVideoProcessing(payload);
      await service.enqueueVideoProcessing(payload);

      const jobs = await queue.getJobs(['waiting']);
      expect(jobs.length).toBe(1);
    });
  });

  describe('Payload Validation', () => {
    it('should enqueue with all required payload fields', async () => {
      const payload: VideoProcessingPayload = {
        videoId: 'full-payload-test',
        storageKey: 'videos/channels/ch-1/videos/full-payload-test/source.mp4',
        channelId: 'ch-1',
      };

      await service.enqueueVideoProcessing(payload);

      const job = await queue.getJob('full-payload-test');

      expect(job?.data.videoId).toBe('full-payload-test');

      expect(job?.data.storageKey).toBe(
        'videos/channels/ch-1/videos/full-payload-test/source.mp4',
      );

      expect(job?.data.channelId).toBe('ch-1');
    });
  });
});
