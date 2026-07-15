import { Test, TestingModule } from '@nestjs/testing';
import { Readable } from 'stream';
import { StreamService } from './stream.service';
import { VideosRepository } from '../repositories/videos.repository';
import { StorageService } from '../../storage/storage.service';
import { Video } from '../entities/video.entity';
import {
  VideoNotFoundException,
  InvalidRangeException,
  FileNotFoundException,
} from '../../common/exceptions/domain.exception';

describe('StreamService (Unit)', () => {
  let service: StreamService;
  let videosRepository: jest.Mocked<VideosRepository>;
  let storageService: jest.Mocked<StorageService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StreamService,
        {
          provide: VideosRepository,
          useValue: {
            findByPublicId: jest.fn(),
          },
        },
        {
          provide: StorageService,
          useValue: {
            headObject: jest.fn(),
            getObject: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<StreamService>(StreamService);
    videosRepository = module.get(VideosRepository);
    storageService = module.get(StorageService);
  });

  describe('streamVideo', () => {
    const createMockVideo = (overrides?: Partial<Video>): Video => ({
      id: '550e8400-e29b-41d4-a716-446655440000',
      channel_id: 'channel-id',
      title: 'Test Video',
      description: null,
      public_id: 'test-public-id',
      status: 'ready',
      storage_key: 'videos/channels/ch-1/videos/vid-1/source.mp4',
      thumbnail_key: null,
      duration_seconds: 100,
      metadata: null,
      size_bytes: 1000,
      error_reason: null,
      created_at: new Date(),
      updated_at: new Date(),
      channel: undefined as any,
      ...overrides,
    });

    it('should return 200 without Range header', async () => {
      const video = createMockVideo();
      const mockStream = new Readable();
      const fileSize = 5000;

      videosRepository.findByPublicId.mockResolvedValue(video);
      storageService.headObject.mockResolvedValue({ size: fileSize });
      storageService.getObject.mockResolvedValue(mockStream);

      const result = await service.streamVideo(video.public_id);

      expect(result.status).toBe(200);
      expect(result.headers['Content-Type']).toBe('video/mp4');
      expect(result.headers['Content-Length']).toBe(fileSize);
      expect(result.headers['Accept-Ranges']).toBe('bytes');
      expect(result.stream).toBe(mockStream);
      expect(storageService.getObject).toHaveBeenCalledWith(video.storage_key);
    });

    it('should return 206 with valid Range header (bytes=0-99)', async () => {
      const video = createMockVideo();
      const mockStream = new Readable();
      const fileSize = 5000;

      videosRepository.findByPublicId.mockResolvedValue(video);
      storageService.headObject.mockResolvedValue({ size: fileSize });
      storageService.getObject.mockResolvedValue(mockStream);

      const result = await service.streamVideo(video.public_id, 'bytes=0-99');

      expect(result.status).toBe(206);
      expect(result.headers['Content-Type']).toBe('video/mp4');
      expect(result.headers['Content-Length']).toBe(100);
      expect(result.headers['Content-Range']).toBe(`bytes 0-99/${fileSize}`);
      expect(result.headers['Accept-Ranges']).toBe('bytes');
      expect(storageService.getObject).toHaveBeenCalledWith(
        video.storage_key,
        0,
        99,
      );
    });

    it('should handle open-ended range (bytes=100-)', async () => {
      const video = createMockVideo();
      const mockStream = new Readable();
      const fileSize = 5000;

      videosRepository.findByPublicId.mockResolvedValue(video);
      storageService.headObject.mockResolvedValue({ size: fileSize });
      storageService.getObject.mockResolvedValue(mockStream);

      const result = await service.streamVideo(video.public_id, 'bytes=100-');

      expect(result.status).toBe(206);
      expect(result.headers['Content-Length']).toBe(fileSize - 100);
      expect(result.headers['Content-Range']).toBe(
        `bytes 100-${fileSize - 1}/${fileSize}`,
      );
      expect(storageService.getObject).toHaveBeenCalledWith(
        video.storage_key,
        100,
        fileSize - 1,
      );
    });

    it('should handle range from suffix (bytes=100-200)', async () => {
      const video = createMockVideo();
      const mockStream = new Readable();
      const fileSize = 5000;

      videosRepository.findByPublicId.mockResolvedValue(video);
      storageService.headObject.mockResolvedValue({ size: fileSize });
      storageService.getObject.mockResolvedValue(mockStream);

      const result = await service.streamVideo(
        video.public_id,
        'bytes=100-200',
      );

      expect(result.status).toBe(206);
      expect(result.headers['Content-Length']).toBe(101);
      expect(result.headers['Content-Range']).toBe(`bytes 100-200/${fileSize}`);
      expect(storageService.getObject).toHaveBeenCalledWith(
        video.storage_key,
        100,
        200,
      );
    });

    it('should throw VideoNotFoundException if video does not exist', async () => {
      videosRepository.findByPublicId.mockResolvedValue(null);

      await expect(service.streamVideo('non-existent-id')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('should throw VideoNotFoundException if video status is not ready', async () => {
      const video = createMockVideo({ status: 'draft' });

      videosRepository.findByPublicId.mockResolvedValue(video);

      await expect(service.streamVideo(video.public_id)).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('should throw VideoNotFoundException if storage file not found', async () => {
      const video = createMockVideo();

      videosRepository.findByPublicId.mockResolvedValue(video);
      storageService.headObject.mockRejectedValue(new FileNotFoundException());

      await expect(service.streamVideo(video.public_id)).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('should throw InvalidRangeException for invalid range', async () => {
      const video = createMockVideo();
      const fileSize = 5000;

      videosRepository.findByPublicId.mockResolvedValue(video);
      storageService.headObject.mockResolvedValue({ size: fileSize });

      // Range start >= file size
      await expect(
        service.streamVideo(video.public_id, 'bytes=5000-5099'),
      ).rejects.toThrow(InvalidRangeException);
    });

    it('should throw InvalidRangeException when start > end', async () => {
      const video = createMockVideo();
      const fileSize = 5000;

      videosRepository.findByPublicId.mockResolvedValue(video);
      storageService.headObject.mockResolvedValue({ size: fileSize });

      // Invalid range: start > end
      await expect(
        service.streamVideo(video.public_id, 'bytes=200-100'),
      ).rejects.toThrow(InvalidRangeException);
    });
  });

  describe('downloadVideo', () => {
    const createMockVideo = (overrides?: Partial<Video>): Video => ({
      id: '550e8400-e29b-41d4-a716-446655440000',
      channel_id: 'channel-id',
      title: 'Test Video',
      description: null,
      public_id: 'test-public-id',
      status: 'ready',
      storage_key: 'videos/channels/ch-1/videos/vid-1/source.mp4',
      thumbnail_key: null,
      duration_seconds: 100,
      metadata: null,
      size_bytes: 1000,
      error_reason: null,
      created_at: new Date(),
      updated_at: new Date(),
      channel: undefined as any,
      ...overrides,
    });

    it('should return download with correct headers', async () => {
      const video = createMockVideo();
      const mockStream = new Readable();
      const fileSize = 5000;

      videosRepository.findByPublicId.mockResolvedValue(video);
      storageService.headObject.mockResolvedValue({ size: fileSize });
      storageService.getObject.mockResolvedValue(mockStream);

      const result = await service.downloadVideo(video.public_id);

      expect(result.filename).toBe('source.mp4');
      expect(result.contentType).toBe('video/mp4');
      expect(result.contentLength).toBe(fileSize);
      expect(result.stream).toBe(mockStream);
    });

    it('should extract filename from storage key', async () => {
      const video = createMockVideo({
        storage_key: 'videos/channels/ch-1/videos/vid-1/my-video.mp4',
      });
      const mockStream = new Readable();

      videosRepository.findByPublicId.mockResolvedValue(video);
      storageService.headObject.mockResolvedValue({ size: 1000 });
      storageService.getObject.mockResolvedValue(mockStream);

      const result = await service.downloadVideo(video.public_id);

      expect(result.filename).toBe('my-video.mp4');
    });

    it('should use default filename if storage key has no extension', async () => {
      const video = createMockVideo({
        storage_key: 'videos/channels/ch-1/videos/vid-1/',
      });
      const mockStream = new Readable();

      videosRepository.findByPublicId.mockResolvedValue(video);
      storageService.headObject.mockResolvedValue({ size: 1000 });
      storageService.getObject.mockResolvedValue(mockStream);

      const result = await service.downloadVideo(video.public_id);

      expect(result.filename).toBe('video.mp4');
    });

    it('should throw VideoNotFoundException if video does not exist', async () => {
      videosRepository.findByPublicId.mockResolvedValue(null);

      await expect(service.downloadVideo('non-existent-id')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('should throw VideoNotFoundException if video status is not ready', async () => {
      const video = createMockVideo({ status: 'processing' });

      videosRepository.findByPublicId.mockResolvedValue(video);

      await expect(service.downloadVideo(video.public_id)).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('should throw VideoNotFoundException if storage file not found', async () => {
      const video = createMockVideo();

      videosRepository.findByPublicId.mockResolvedValue(video);
      storageService.headObject.mockRejectedValue(new FileNotFoundException());

      await expect(service.downloadVideo(video.public_id)).rejects.toThrow(
        VideoNotFoundException,
      );
    });
  });
});
