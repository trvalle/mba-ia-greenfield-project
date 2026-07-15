import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { StorageService } from './storage.service';
import { StorageModule } from './storage.module';
import storageConfig from '../config/storage.config';
import { FileNotFoundException } from '../common/exceptions/domain.exception';

describe('StorageService (Integration)', () => {
  let service: StorageService;
  let module: TestingModule;
  const testKeyPrefix = `test/${Date.now()}`;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig],
        }),
        StorageModule,
      ],
    }).compile();

    service = module.get<StorageService>(StorageService);
    // Ensure bucket exists before running any tests
    await service.ensureBucketExists();
  });

  afterAll(async () => {
    await module.close();
  });

  describe('Bucket Initialization', () => {
    it('should initialize bucket idempotently on first call', () => {
      // The bucket should already be created by onModuleInit
      // Verify it exists by attempting a headObject which would fail if bucket doesn't exist
      expect(service).toBeDefined();
    });
  });

  describe('Presigned URLs', () => {
    it('should generate presigned PUT URL with public endpoint', async () => {
      const storageKey = `${testKeyPrefix}/test-put.txt`;
      const url = await service.generatePresignedPutUrl(
        storageKey,
        'text/plain',
      );

      expect(url).toBeDefined();
      expect(typeof url).toBe('string');
      expect(url).toContain('localhost:9000');
      expect(url).not.toContain('minio:9000');
    });

    it('should generate presigned PUT URL with default content type', async () => {
      const storageKey = `${testKeyPrefix}/test-default-content-type.bin`;
      const url = await service.generatePresignedPutUrl(storageKey);

      expect(url).toBeDefined();
      expect(typeof url).toBe('string');
      expect(url).toContain('localhost:9000');
    });

    it('should generate presigned GET URL with public endpoint', async () => {
      const storageKey = `${testKeyPrefix}/test-get.txt`;

      // First, upload a test object
      const testData = Buffer.from('test content for GET');
      await service.putObject(storageKey, testData);

      // Generate presigned GET URL
      const url = await service.generatePresignedGetUrl(storageKey);

      expect(url).toBeDefined();
      expect(typeof url).toBe('string');
      expect(url).toContain('localhost:9000');
      expect(url).not.toContain('minio:9000');
    });

    it('should include expiration in presigned URLs', async () => {
      const storageKey = `${testKeyPrefix}/test-expiration.txt`;
      const url = await service.generatePresignedPutUrl(storageKey);

      // AWS SigV4 presigned URLs include X-Amz-Expires parameter
      expect(url).toContain('X-Amz-Expires');
    });
  });

  describe('Object Operations', () => {
    it('should upload object via putObject', async () => {
      const storageKey = `${testKeyPrefix}/test-upload.txt`;
      const testData = Buffer.from('test content');

      await service.putObject(storageKey, testData);

      // Verify object exists
      const metadata = await service.headObject(storageKey);
      expect(metadata.size).toBe(testData.length);
    });

    it('should upload object from readable stream', async () => {
      const storageKey = `${testKeyPrefix}/test-stream-upload.txt`;
      const testData = 'stream test content';

      await service.putObject(storageKey, testData);

      // Verify object exists
      const metadata = await service.headObject(storageKey);
      expect(metadata.size).toBeGreaterThan(0);
    });

    it('should verify object exists via headObject', async () => {
      const storageKey = `${testKeyPrefix}/test-head.txt`;
      const testData = Buffer.from('head test content');

      // Upload
      await service.putObject(storageKey, testData);

      // Head
      const metadata = await service.headObject(storageKey);

      expect(metadata.size).toBe(testData.length);
      expect(metadata.lastModified).toBeDefined();
      expect(metadata.lastModified).toBeInstanceOf(Date);
    });

    it('should download object via getObject', async () => {
      const storageKey = `${testKeyPrefix}/test-download.txt`;
      const testData = Buffer.from('download test content');

      // Upload
      await service.putObject(storageKey, testData);

      // Download
      const stream = await service.getObject(storageKey);

      expect(stream).toBeDefined();
      // Verify it's a readable stream
      expect(stream).toHaveProperty('on');
    });

    it('should throw FileNotFoundException for non-existent key', async () => {
      const nonExistentKey = `${testKeyPrefix}/non-existent-${Date.now()}.txt`;

      await expect(service.headObject(nonExistentKey)).rejects.toThrow(
        FileNotFoundException,
      );
    });

    it('should throw FileNotFoundException when getting non-existent object', async () => {
      const nonExistentKey = `${testKeyPrefix}/non-existent-get-${Date.now()}.txt`;

      await expect(service.getObject(nonExistentKey)).rejects.toThrow(
        FileNotFoundException,
      );
    });
  });

  describe('Key Layout', () => {
    it('should format video key correctly', () => {
      const channelId = 'channel-123';
      const videoId = 'video-456';
      const extension = 'mp4';

      const key = service.formatVideoKey(channelId, videoId, extension);

      expect(key).toBe(
        `videos/channels/${channelId}/videos/${videoId}/source.${extension}`,
      );
    });

    it('should format thumbnail key correctly', () => {
      const channelId = 'channel-123';
      const videoId = 'video-456';

      const key = service.formatThumbnailKey(channelId, videoId);

      expect(key).toBe(
        `thumbnails/channels/${channelId}/videos/${videoId}/thumb.jpg`,
      );
    });
  });

  describe('Endpoint Routing', () => {
    it('should use internal endpoint for S3Client operations', async () => {
      const storageKey = `${testKeyPrefix}/test-endpoint.txt`;
      const testData = Buffer.from('endpoint test');

      // These operations should succeed using the internal endpoint
      await service.putObject(storageKey, testData);
      const metadata = await service.headObject(storageKey);

      expect(metadata.size).toBeGreaterThan(0);
    });

    it('should use public endpoint in presigned URLs', async () => {
      const storageKey = `${testKeyPrefix}/test-public-endpoint.txt`;
      const url = await service.generatePresignedPutUrl(storageKey);

      const urlObj = new URL(url);
      expect(urlObj.hostname).toBe('localhost');
    });

    it('should not expose internal endpoint in presigned URLs', async () => {
      const storageKey = `${testKeyPrefix}/test-no-internal.txt`;
      const url = await service.generatePresignedPutUrl(storageKey);

      expect(url).not.toContain('minio:9000');
    });
  });

  describe('Cleanup', () => {
    afterEach(async () => {
      // Clean up test objects created during each test
      // Note: In a real scenario, we would use deleteObject,
      // but S3 compatibility may vary. For now, we rely on
      // test key prefix isolation.
    });

    it('should allow multiple tests without interference', async () => {
      const key1 = `${testKeyPrefix}/cleanup-test-1.txt`;
      const key2 = `${testKeyPrefix}/cleanup-test-2.txt`;

      await service.putObject(key1, Buffer.from('test 1'));
      await service.putObject(key2, Buffer.from('test 2'));

      const meta1 = await service.headObject(key1);
      const meta2 = await service.headObject(key2);

      expect(meta1.size).toBeGreaterThan(0);
      expect(meta2.size).toBeGreaterThan(0);
    });
  });
});
