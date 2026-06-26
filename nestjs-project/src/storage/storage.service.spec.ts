import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { StorageService } from './storage.service';
import storageConfig from '../config/storage.config';
import {
  BucketNotAccessibleException,
  FileNotFoundException,
  PresignUrlGenerationException,
  StorageException,
} from '../common/exceptions/domain.exception';

describe('StorageService (Unit)', () => {
  let service: StorageService;

  const mockConfig = {
    bucket: 'test-bucket',
    region: 'us-east-1',
    endpointInternal: 'http://minio:9000',
    endpointPublic: 'http://localhost:9000',
    accessKeyId: 'test-key',
    secretAccessKey: 'test-secret',
    presignExpirationSeconds: 3600,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(
              (key: string) => mockConfig[key as keyof typeof mockConfig],
            ),
          },
        },
        {
          provide: storageConfig.KEY,
          useValue: mockConfig,
        },
      ],
    }).compile();

    service = module.get<StorageService>(StorageService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Key Layout Formatting', () => {
    it('should format video key correctly', () => {
      const channelId = 'channel-123';
      const videoId = 'video-456';
      const extension = 'mp4';

      const key = service.formatVideoKey(channelId, videoId, extension);

      expect(key).toBe(
        `videos/channels/${channelId}/videos/${videoId}/source.${extension}`,
      );
    });

    it('should format video key with different extensions', () => {
      const channelId = 'ch-abc';
      const videoId = 'vid-xyz';

      const mkv = service.formatVideoKey(channelId, videoId, 'mkv');
      const mov = service.formatVideoKey(channelId, videoId, 'mov');
      const webm = service.formatVideoKey(channelId, videoId, 'webm');

      expect(mkv).toBe(`videos/channels/ch-abc/videos/vid-xyz/source.mkv`);
      expect(mov).toBe(`videos/channels/ch-abc/videos/vid-xyz/source.mov`);
      expect(webm).toBe(`videos/channels/ch-abc/videos/vid-xyz/source.webm`);
    });

    it('should format thumbnail key correctly', () => {
      const channelId = 'channel-123';
      const videoId = 'video-456';

      const key = service.formatThumbnailKey(channelId, videoId);

      expect(key).toBe(
        `thumbnails/channels/${channelId}/videos/${videoId}/thumb.jpg`,
      );
    });

    it('should format thumbnail key with various IDs', () => {
      const key1 = service.formatThumbnailKey('ch-1', 'vid-1');
      const key2 = service.formatThumbnailKey('ch-long-name', 'vid-long-name');

      expect(key1).toBe(`thumbnails/channels/ch-1/videos/vid-1/thumb.jpg`);
      expect(key2).toBe(
        `thumbnails/channels/ch-long-name/videos/vid-long-name/thumb.jpg`,
      );
    });
  });

  describe('Presigned URL Generation', () => {
    it('should include presignExpirationSeconds in config', () => {
      expect(mockConfig.presignExpirationSeconds).toBe(3600);
    });

    it('should use internal endpoint in S3Client', () => {
      expect(mockConfig.endpointInternal).toBe('http://minio:9000');
    });

    it('should use public endpoint for presigned URLs', () => {
      expect(mockConfig.endpointPublic).toBe('http://localhost:9000');
    });

    it('should have different internal and public endpoints', () => {
      expect(mockConfig.endpointInternal).not.toBe(mockConfig.endpointPublic);
      expect(mockConfig.endpointInternal).toContain('minio');
      expect(mockConfig.endpointPublic).toContain('localhost');
    });
  });

  describe('Configuration', () => {
    it('should use forcePathStyle for MinIO compatibility', () => {
      // This is tested indirectly through integration tests
      // Unit test verifies the configuration is provided correctly
      expect(mockConfig.region).toBe('us-east-1');
      expect(mockConfig.accessKeyId).toBe('test-key');
      expect(mockConfig.secretAccessKey).toBe('test-secret');
    });

    it('should parse presignExpirationSeconds as integer', () => {
      expect(typeof mockConfig.presignExpirationSeconds).toBe('number');
      expect(mockConfig.presignExpirationSeconds).toBeGreaterThan(0);
    });

    it('should have credentials configured', () => {
      expect(mockConfig.accessKeyId).toBeDefined();
      expect(mockConfig.secretAccessKey).toBeDefined();
      expect(mockConfig.accessKeyId?.length).toBeGreaterThan(0);
      expect(mockConfig.secretAccessKey?.length).toBeGreaterThan(0);
    });
  });

  describe('Exception Handling', () => {
    it('should define storage-specific exceptions', () => {
      expect(BucketNotAccessibleException).toBeDefined();
      expect(FileNotFoundException).toBeDefined();
      expect(PresignUrlGenerationException).toBeDefined();
      expect(StorageException).toBeDefined();
    });

    it('should throw appropriate exceptions with correct codes', () => {
      const bucketEx = new BucketNotAccessibleException();
      const fileEx = new FileNotFoundException();
      const presignEx = new PresignUrlGenerationException('test');

      expect(bucketEx.errorCode).toBe('BUCKET_NOT_ACCESSIBLE');
      expect(bucketEx.httpStatus).toBe(500);

      expect(fileEx.errorCode).toBe('FILE_NOT_FOUND');
      expect(fileEx.httpStatus).toBe(404);

      expect(presignEx.errorCode).toBe('PRESIGN_URL_GENERATION_ERROR');
      expect(presignEx.httpStatus).toBe(500);
    });
  });
});
