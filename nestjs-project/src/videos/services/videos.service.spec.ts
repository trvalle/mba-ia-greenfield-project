import { Test, TestingModule } from '@nestjs/testing';
import { VideosService } from './videos.service';
import { VideosRepository } from '../repositories/videos.repository';
import { StorageService } from '../../storage/storage.service';
import { Video } from '../entities/video.entity';
import { VideoNotFoundException } from '../../common/exceptions/domain.exception';

describe('VideosService (Unit)', () => {
  let service: VideosService;
  let videosRepository: jest.Mocked<VideosRepository>;
  let storageService: jest.Mocked<StorageService>;

  const baseVideo: Partial<Video> = {
    id: 'video-uuid',
    public_id: 'abc123xyz789',
    title: 'Test Video',
    description: 'A description',
    status: 'ready',
    duration_seconds: 42,
    thumbnail_key: 'thumbnails/channels/ch-uuid/videos/video-uuid/thumb.jpg',
    size_bytes: 1024,
    channel: { id: 'channel-uuid', name: 'Test Channel' } as any,
    created_at: new Date('2026-06-26T10:00:00Z'),
    updated_at: new Date('2026-06-26T10:05:00Z'),
  };

  beforeEach(async () => {
    videosRepository = {
      findByPublicIdWithChannel: jest.fn(),
    } as any;

    storageService = {
      generatePresignedGetUrl: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: VideosRepository, useValue: videosRepository },
        { provide: StorageService, useValue: storageService },
      ],
    }).compile();

    service = module.get<VideosService>(VideosService);
  });

  describe('getMetadata', () => {
    it('should return metadata with presigned thumbnail URL for a processed video', async () => {
      videosRepository.findByPublicIdWithChannel.mockResolvedValue(
        baseVideo as Video,
      );
      storageService.generatePresignedGetUrl.mockResolvedValue(
        'http://localhost:9000/streamtube/thumbnails/...?X-Amz-Signature=xyz',
      );

      const result = await service.getMetadata('abc123xyz789');

      expect(result.videoId).toBe('video-uuid');
      expect(result.publicId).toBe('abc123xyz789');
      expect(result.status).toBe('ready');
      expect(result.duration_seconds).toBe(42);
      expect(result.thumbnail_url).toContain('X-Amz-Signature');
      expect(result.size_bytes).toBe(1024);
      expect(result.channel).toEqual({
        id: 'channel-uuid',
        name: 'Test Channel',
      });
      expect(result.created_at).toBe('2026-06-26T10:00:00.000Z');
      expect(storageService.generatePresignedGetUrl).toHaveBeenCalledWith(
        baseVideo.thumbnail_key,
      );
    });

    it('should return null thumbnail_url when video has no thumbnail yet', async () => {
      videosRepository.findByPublicIdWithChannel.mockResolvedValue({
        ...baseVideo,
        status: 'draft',
        thumbnail_key: null,
        duration_seconds: null,
        size_bytes: null,
      } as Video);

      const result = await service.getMetadata('abc123xyz789');

      expect(result.status).toBe('draft');
      expect(result.thumbnail_url).toBeNull();
      expect(result.duration_seconds).toBeNull();
      expect(result.size_bytes).toBeNull();
      expect(storageService.generatePresignedGetUrl).not.toHaveBeenCalled();
    });

    it('should convert bigint size_bytes returned as string to number', async () => {
      videosRepository.findByPublicIdWithChannel.mockResolvedValue({
        ...baseVideo,
        thumbnail_key: null,
        size_bytes: '1234567890' as unknown as number, // PG bigint comes back as string
      } as Video);

      const result = await service.getMetadata('abc123xyz789');

      expect(result.size_bytes).toBe(1234567890);
    });

    it('should throw VideoNotFoundException for an unknown public_id', async () => {
      videosRepository.findByPublicIdWithChannel.mockResolvedValue(null);

      await expect(service.getMetadata('unknown12345')).rejects.toThrow(
        VideoNotFoundException,
      );
    });
  });
});
