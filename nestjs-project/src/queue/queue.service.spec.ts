import { Test, TestingModule } from '@nestjs/testing';
import { QueueService } from './queue.service';
import { VideoProcessingPayload } from '../videos/dtos/video-processing-payload.dto';
import { QueueException } from '../common/exceptions/domain.exception';
import queueConfig from '../config/queue.config';

describe('QueueService (Unit)', () => {
  let service: QueueService;
  let mockQueue: any;
  let mockConfig: any;

  beforeEach(async () => {
    mockQueue = {
      add: jest.fn().mockResolvedValue({ id: 'job-123' }),
      getJob: jest.fn(),
    };

    mockConfig = {
      jobNames: { processVideo: 'process-video' },
      queueNames: { videoProcessing: 'video-processing' },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QueueService,
        {
          provide: 'BullQueue_video-processing',
          useValue: mockQueue,
        },
        {
          provide: queueConfig.KEY,
          useValue: mockConfig,
        },
      ],
    }).compile();

    service = module.get<QueueService>(QueueService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('enqueueVideoProcessing', () => {
    it('should enqueue a video processing job with idempotency key', async () => {
      const payload: VideoProcessingPayload = {
        videoId: 'video-uuid-123',
        storageKey:
          'videos/channels/channel-uuid/videos/video-uuid-123/source.mp4',
        channelId: 'channel-uuid',
      };

      await service.enqueueVideoProcessing(payload);

      expect(mockQueue.add).toHaveBeenCalledWith(
        'process-video',
        payload,
        expect.objectContaining({
          jobId: 'video-uuid-123',
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
          removeOnComplete: true,
          removeOnFail: false,
        }),
      );
    });

    it('should enqueue job with correct payload structure', async () => {
      const payload: VideoProcessingPayload = {
        videoId: 'test-video-id',
        storageKey: 'test-storage-key',
        channelId: 'test-channel-id',
      };

      await service.enqueueVideoProcessing(payload);

      const callArgs = mockQueue.add.mock.calls[0];
      expect(callArgs[1]).toEqual(payload);
    });

    it('should throw QueueException when enqueueing fails', async () => {
      const payload: VideoProcessingPayload = {
        videoId: 'test-video-id',
        storageKey: 'test-storage-key',
        channelId: 'test-channel-id',
      };

      const error = new Error('Redis connection failed');

      mockQueue.add.mockRejectedValueOnce(error);

      await expect(service.enqueueVideoProcessing(payload)).rejects.toThrow(
        QueueException,
      );
    });

    it('should use videoId as jobId for idempotency', async () => {
      const payload: VideoProcessingPayload = {
        videoId: 'idempotent-video-uuid',
        storageKey: 'videos/1/source.mp4',
        channelId: 'ch-1',
      };

      await service.enqueueVideoProcessing(payload);

      const callArgs = mockQueue.add.mock.calls[0];
      expect(callArgs[2].jobId).toBe('idempotent-video-uuid');
    });
  });

  describe('getJobStatus', () => {
    it('should return job status when job exists', async () => {
      const mockJob = {
        id: 'job-123',
        getState: jest.fn().mockResolvedValue('active'),
        progress: 50,
        attemptsMade: 1,
        opts: { attempts: 3 },
      };

      mockQueue.getJob.mockResolvedValue(mockJob);

      const status = await service.getJobStatus('job-123');

      expect(status).toEqual({
        id: 'job-123',
        state: 'active',
        progress: 50,
        attempts: 1,
        maxAttempts: 3,
      });
    });

    it('should return null when job does not exist', async () => {
      mockQueue.getJob.mockResolvedValue(null);

      const status = await service.getJobStatus('non-existent-job');

      expect(status).toBeNull();
    });

    it('should throw QueueException when getJob fails', async () => {
      const error = new Error('Redis error');

      mockQueue.getJob.mockRejectedValueOnce(error);

      await expect(service.getJobStatus('job-123')).rejects.toThrow(
        QueueException,
      );
    });

    it('should handle job with no progress', async () => {
      const mockJob = {
        id: 'job-456',
        getState: jest.fn().mockResolvedValue('waiting'),
        progress: null,
        attemptsMade: 0,
        opts: { attempts: 3 },
      };

      mockQueue.getJob.mockResolvedValue(mockJob);

      const status = await service.getJobStatus('job-456');

      expect(status?.progress).toBeNull();
      expect(status?.state).toBe('waiting');
    });
  });

  describe('job options validation', () => {
    it('should set exponential backoff correctly', async () => {
      const payload: VideoProcessingPayload = {
        videoId: 'backoff-test',
        storageKey: 'videos/test/source.mp4',
        channelId: 'ch-test',
      };

      await service.enqueueVideoProcessing(payload);

      const callArgs = mockQueue.add.mock.calls[0];
      expect(callArgs[2].backoff).toEqual({
        type: 'exponential',
        delay: 2000,
      });
    });

    it('should set removeOnComplete to true', async () => {
      const payload: VideoProcessingPayload = {
        videoId: 'cleanup-test',
        storageKey: 'videos/test/source.mp4',
        channelId: 'ch-test',
      };

      await service.enqueueVideoProcessing(payload);

      const callArgs = mockQueue.add.mock.calls[0];
      expect(callArgs[2].removeOnComplete).toBe(true);
    });

    it('should set removeOnFail to false', async () => {
      const payload: VideoProcessingPayload = {
        videoId: 'debug-test',
        storageKey: 'videos/test/source.mp4',
        channelId: 'ch-test',
      };

      await service.enqueueVideoProcessing(payload);

      const callArgs = mockQueue.add.mock.calls[0];
      expect(callArgs[2].removeOnFail).toBe(false);
    });

    it('should set attempts to 3', async () => {
      const payload: VideoProcessingPayload = {
        videoId: 'retry-test',
        storageKey: 'videos/test/source.mp4',
        channelId: 'ch-test',
      };

      await service.enqueueVideoProcessing(payload);

      const callArgs = mockQueue.add.mock.calls[0];
      expect(callArgs[2].attempts).toBe(3);
    });
  });
});
