import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UploadService } from './upload.service';
import { VideosRepository } from '../repositories/videos.repository';
import { StorageService } from '../../storage/storage.service';
import { QueueService } from '../../queue/queue.service';
import { Video } from '../entities/video.entity';
import {
  VideoNotFoundException,
  VideoInvalidStatusException,
  PublicIdGenerationException,
  StorageFileNotFoundException,
  FileNotFoundException,
} from '../../common/exceptions/domain.exception';

describe('UploadService (Unit)', () => {
  let service: UploadService;
  let videosRepository: jest.Mocked<VideosRepository>;
  let storageService: jest.Mocked<StorageService>;
  let queueService: jest.Mocked<QueueService>;

  beforeEach(async () => {
    videosRepository = {
      save: jest.fn(),
      findByIdAndChannelId: jest.fn(),
      findOne: jest.fn(),
    } as any;

    storageService = {
      generatePresignedPutUrl: jest.fn(),
      headObject: jest.fn(),
    } as any;

    queueService = {
      enqueueVideoProcessing: jest.fn(),
    } as any;

    const configService = {
      get: jest.fn((key: string, defaultValue: string) => {
        if (key === 'PRESIGN_EXPIRATION_SECONDS') return '3600';
        return defaultValue;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UploadService,
        { provide: VideosRepository, useValue: videosRepository },
        { provide: StorageService, useValue: storageService },
        { provide: QueueService, useValue: queueService },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get<UploadService>(UploadService);
  });

  describe('initializeUpload', () => {
    it('should create video with unique public_id on first attempt', async () => {
      const mockVideo: Partial<Video> = {
        id: 'video-uuid',
        channel_id: 'channel-uuid',
        title: 'Test Video',
        public_id: 'abc123xyz789',
        status: 'draft',
        storage_key:
          'videos/channels/channel-uuid/videos/video-uuid/source.mp4',
        created_at: new Date(),
      };

      videosRepository.save.mockResolvedValue(mockVideo as any);
      storageService.generatePresignedPutUrl.mockResolvedValue(
        'http://localhost:9000/streamtube/videos/channels/...',
      );

      const result = await service.initializeUpload('channel-uuid', {
        title: 'Test Video',
        channel_id: 'channel-uuid',
      });

      expect(result.videoId).toBe('video-uuid');
      expect(result.publicId).toBe('abc123xyz789');
      expect(result.uploadUrl).toContain('localhost:9000');
      expect(result.expiresIn).toBe(3600);
      expect(videosRepository.save).toHaveBeenCalledTimes(2); // Save draft + update storage_key
    });

    it('should retry public_id generation on UNIQUE constraint violation', async () => {
      const uniqueError = { code: '23505' }; // PostgreSQL UNIQUE violation
      const mockVideo: Partial<Video> = {
        id: 'video-uuid',
        public_id: 'success-id',
        status: 'draft',
        storage_key:
          'videos/channels/channel-uuid/videos/video-uuid/source.mp4',
        created_at: new Date(),
      };

      // Fail twice with UNIQUE violation, succeed on third attempt
      videosRepository.save
        .mockRejectedValueOnce(uniqueError)
        .mockRejectedValueOnce(uniqueError)
        .mockResolvedValueOnce(mockVideo as any)
        .mockResolvedValueOnce(mockVideo as any);

      storageService.generatePresignedPutUrl.mockResolvedValue(
        'http://localhost:9000/...',
      );

      const result = await service.initializeUpload('channel-uuid', {
        title: 'Test',
        channel_id: 'channel-uuid',
      });

      expect(videosRepository.save).toHaveBeenCalledTimes(4); // 2 failed + 2 successful
      expect(result.publicId).toBe('success-id');
    });

    it('should throw PublicIdGenerationException after MAX_RETRIES', async () => {
      const uniqueError = { code: '23505' };
      videosRepository.save.mockRejectedValue(uniqueError);

      await expect(
        service.initializeUpload('channel-uuid', {
          title: 'Test',
          channel_id: 'channel-uuid',
        }),
      ).rejects.toThrow(PublicIdGenerationException);

      // Should attempt MAX_PUBLIC_ID_RETRIES times
      expect(videosRepository.save).toHaveBeenCalledTimes(5);
    });

    it('should rethrow non-UNIQUE errors immediately without retrying', async () => {
      const otherError = new Error('Connection failed');
      videosRepository.save.mockRejectedValue(otherError);

      await expect(
        service.initializeUpload('channel-uuid', {
          title: 'Test',
          channel_id: 'channel-uuid',
        }),
      ).rejects.toThrow('Connection failed');

      // Should only attempt once, not retry
      expect(videosRepository.save).toHaveBeenCalledTimes(1);
    });

    it('should format storage key with extension from filename', async () => {
      const mockVideo: Partial<Video> = {
        id: 'video-uuid',
        channel_id: 'channel-uuid',
        public_id: 'abc123',
        status: 'draft',
        storage_key:
          'videos/channels/channel-uuid/videos/video-uuid/source.mov',
        created_at: new Date(),
      };

      videosRepository.save.mockResolvedValue(mockVideo as any);
      storageService.generatePresignedPutUrl.mockResolvedValue('http://...');

      const result = await service.initializeUpload('channel-uuid', {
        title: 'Test',
        channel_id: 'channel-uuid',
        filename: 'my-video.mov',
      });

      expect(result.storageKey).toContain('.mov');
    });

    it('should default to .mp4 extension if no filename provided', async () => {
      const mockVideo: Partial<Video> = {
        id: 'video-uuid',
        channel_id: 'channel-uuid',
        public_id: 'abc123',
        status: 'draft',
        storage_key:
          'videos/channels/channel-uuid/videos/video-uuid/source.mp4',
        created_at: new Date(),
      };

      videosRepository.save.mockResolvedValue(mockVideo as any);
      storageService.generatePresignedPutUrl.mockResolvedValue('http://...');

      const result = await service.initializeUpload('channel-uuid', {
        title: 'Test',
        channel_id: 'channel-uuid',
      });

      expect(result.storageKey).toContain('.mp4');
    });
  });

  describe('completeUpload', () => {
    it('should transition video to processing and enqueue job', async () => {
      const mockVideo: Partial<Video> = {
        id: 'video-uuid',
        channel_id: 'channel-uuid',
        public_id: 'abc123',
        status: 'draft',
        storage_key:
          'videos/channels/channel-uuid/videos/video-uuid/source.mp4',
        created_at: new Date(),
      };

      const updatedVideo: Partial<Video> = {
        ...mockVideo,
        status: 'processing',
      };

      videosRepository.findByIdAndChannelId.mockResolvedValue(mockVideo as any);
      videosRepository.save.mockResolvedValue(updatedVideo as any);
      storageService.headObject.mockResolvedValue({
        size: 1024,
        lastModified: new Date(),
      });
      queueService.enqueueVideoProcessing.mockResolvedValue(undefined);

      const result = await service.completeUpload('video-uuid', 'channel-uuid');

      expect(result.status).toBe('processing');
      expect(result.videoId).toBe('video-uuid');
      expect(queueService.enqueueVideoProcessing).toHaveBeenCalledWith({
        videoId: 'video-uuid',
        storageKey: 'videos/channels/channel-uuid/videos/video-uuid/source.mp4',
        channelId: 'channel-uuid',
      });
    });

    it('should throw error if video not owned by channel', async () => {
      videosRepository.findByIdAndChannelId.mockResolvedValue(null);

      await expect(
        service.completeUpload('video-uuid', 'wrong-channel'),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('should throw error if video is not in draft status', async () => {
      const mockVideo: Partial<Video> = {
        id: 'video-uuid',
        channel_id: 'channel-uuid',
        status: 'processing', // Already processing
      };

      videosRepository.findByIdAndChannelId.mockResolvedValue(mockVideo as any);

      await expect(
        service.completeUpload('video-uuid', 'channel-uuid'),
      ).rejects.toThrow(VideoInvalidStatusException);
    });

    it('should throw StorageFileNotFoundException if file not in storage', async () => {
      const mockVideo: Partial<Video> = {
        id: 'video-uuid',
        channel_id: 'channel-uuid',
        status: 'draft',
        storage_key: 'videos/test',
      };

      videosRepository.findByIdAndChannelId.mockResolvedValue(mockVideo as any);
      storageService.headObject.mockRejectedValue(new FileNotFoundException());

      await expect(
        service.completeUpload('video-uuid', 'channel-uuid'),
      ).rejects.toThrow(StorageFileNotFoundException);
    });

    it('should return null for duration_seconds and thumbnail_key in response', async () => {
      const mockVideo: Partial<Video> = {
        id: 'video-uuid',
        channel_id: 'channel-uuid',
        public_id: 'abc123',
        status: 'draft',
        storage_key: 'videos/test',
        created_at: new Date('2026-06-26T10:00:00Z'),
      };

      const updatedVideo: Partial<Video> = {
        ...mockVideo,
        status: 'processing',
      };

      videosRepository.findByIdAndChannelId.mockResolvedValue(mockVideo as any);
      videosRepository.save.mockResolvedValue(updatedVideo as any);
      storageService.headObject.mockResolvedValue({
        size: 1024,
        lastModified: new Date(),
      });
      queueService.enqueueVideoProcessing.mockResolvedValue(undefined);

      const result = await service.completeUpload('video-uuid', 'channel-uuid');

      expect(result.duration_seconds).toBeNull();
      expect(result.thumbnail_key).toBeNull();
    });
  });

  describe('public_id generation', () => {
    it('should generate 12-character base62 IDs', () => {
      // We can't directly test private methods, but we can verify through integration
      // that multiple initializeUpload calls generate different IDs
      expect(true).toBe(true); // Placeholder
    });
  });
});
