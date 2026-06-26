import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video } from '../entities/video.entity';
import { VideosRepository } from './videos.repository';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('VideosRepository (integration)', () => {
  let dataSource: DataSource;
  let videosRepository: VideosRepository;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let testUser: User;
  let testChannel: Channel;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videosRepository = new VideosRepository(dataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);

    // Create test user and channel
    testUser = await userRepository.save(
      userRepository.create({
        email: 'video-test@example.com',
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

  describe('Video CRUD', () => {
    it('should create a video', async () => {
      const video = videosRepository.create({
        channel_id: testChannel.id,
        title: 'Test Video',
        public_id: 'test123abc456',
        status: 'draft',
        storage_key:
          'videos/channels/test-channel/videos/test-video/source.mp4',
      });

      const saved = await videosRepository.save(video);

      expect(saved.id).toBeDefined();
      expect(saved.title).toBe('Test Video');
      expect(saved.status).toBe('draft');
      expect(saved.public_id).toBe('test123abc456');
      expect(saved.channel_id).toBe(testChannel.id);
    });

    it('should find video by public_id', async () => {
      const video = videosRepository.create({
        channel_id: testChannel.id,
        title: 'Searchable Video',
        public_id: 'search123abc',
        status: 'draft',
        storage_key: 'videos/search-key',
      });
      await videosRepository.save(video);

      const found = await videosRepository.findByPublicId('search123abc');

      expect(found).toBeDefined();
      expect(found?.title).toBe('Searchable Video');
      expect(found?.public_id).toBe('search123abc');
    });

    it('should find video by ID', async () => {
      const video = videosRepository.create({
        channel_id: testChannel.id,
        title: 'Test Video',
        public_id: 'findbyid123',
        status: 'draft',
        storage_key: 'videos/findbyid-key',
      });
      const saved = await videosRepository.save(video);

      const found = await videosRepository.findOne({ where: { id: saved.id } });

      expect(found).toBeDefined();
      expect(found?.id).toBe(saved.id);
      expect(found?.title).toBe('Test Video');
    });

    it('should find video by id and channel_id', async () => {
      const video = videosRepository.create({
        channel_id: testChannel.id,
        title: 'Channel Video',
        public_id: 'channelvid123',
        status: 'draft',
        storage_key: 'videos/channel-key',
      });
      const saved = await videosRepository.save(video);

      const found = await videosRepository.findByIdAndChannelId(
        saved.id,
        testChannel.id,
      );

      expect(found).toBeDefined();
      expect(found?.id).toBe(saved.id);
    });

    it('should find videos by channel_id', async () => {
      const video1 = videosRepository.create({
        channel_id: testChannel.id,
        title: 'Video 1',
        public_id: 'vid1',
        status: 'draft',
        storage_key: 'videos/vid1-key',
      });
      const video2 = videosRepository.create({
        channel_id: testChannel.id,
        title: 'Video 2',
        public_id: 'vid2',
        status: 'draft',
        storage_key: 'videos/vid2-key',
      });

      await videosRepository.save(video1);
      await videosRepository.save(video2);

      const found = await videosRepository.findByChannelId(testChannel.id);

      expect(found.length).toBe(2);
      expect(found[0].channel_id).toBe(testChannel.id);
      expect(found[1].channel_id).toBe(testChannel.id);
    });

    it('should find videos by status', async () => {
      const draftVideo = videosRepository.create({
        channel_id: testChannel.id,
        title: 'Draft Video',
        public_id: 'draft123',
        status: 'draft',
        storage_key: 'videos/draft-key',
      });
      const readyVideo = videosRepository.create({
        channel_id: testChannel.id,
        title: 'Ready Video',
        public_id: 'ready123',
        status: 'ready',
        storage_key: 'videos/ready-key',
      });
      const processingVideo = videosRepository.create({
        channel_id: testChannel.id,
        title: 'Processing Video',
        public_id: 'proc123',
        status: 'processing',
        storage_key: 'videos/processing-key',
      });

      await videosRepository.save(draftVideo);
      await videosRepository.save(readyVideo);
      await videosRepository.save(processingVideo);

      const drafts = await videosRepository.findByStatus('draft');
      const readyVideos = await videosRepository.findByStatus('ready');
      const processing = await videosRepository.findByStatus('processing');

      expect(drafts.length).toBe(1);
      expect(drafts[0].status).toBe('draft');

      expect(readyVideos.length).toBe(1);
      expect(readyVideos[0].status).toBe('ready');

      expect(processing.length).toBe(1);
      expect(processing[0].status).toBe('processing');
    });

    it('should update video status and metadata', async () => {
      const video = videosRepository.create({
        channel_id: testChannel.id,
        title: 'Metadata Test',
        public_id: 'metadata-xyz',
        status: 'draft',
        storage_key: 'videos/metadata-key',
      });
      const saved = await videosRepository.save(video);

      saved.status = 'ready';
      saved.metadata = {
        duration: 300,
        codec: 'h264',
        resolution: '1920x1080',
      };
      saved.duration_seconds = 300;
      saved.thumbnail_key = 'thumbnails/metadata-xyz/thumb.jpg';

      const updated = await videosRepository.save(saved);

      expect(updated.status).toBe('ready');
      expect(updated.metadata?.duration).toBe(300);
      expect(updated.duration_seconds).toBe(300);
      expect(updated.thumbnail_key).toBe('thumbnails/metadata-xyz/thumb.jpg');
    });

    it('should enforce unique constraint on public_id', async () => {
      const video1 = videosRepository.create({
        channel_id: testChannel.id,
        title: 'Video 1',
        public_id: 'unique123',
        status: 'draft',
        storage_key: 'videos/unique-key-1',
      });
      await videosRepository.save(video1);

      const video2 = videosRepository.create({
        channel_id: testChannel.id,
        title: 'Video 2',
        public_id: 'unique123',
        status: 'draft',
        storage_key: 'videos/unique-key-2',
      });

      await expect(videosRepository.save(video2)).rejects.toThrow();
    });

    it('should cascade delete video when channel is deleted', async () => {
      const video = videosRepository.create({
        channel_id: testChannel.id,
        title: 'Cascade Test Video',
        public_id: 'cascade-test-vid',
        status: 'draft',
        storage_key: 'videos/cascade-key',
      });
      const savedVideo = await videosRepository.save(video);

      // Verify video exists
      let found = await videosRepository.findOne({
        where: { id: savedVideo.id },
      });
      expect(found).toBeDefined();

      // Delete the channel
      await channelRepository.delete(testChannel.id);

      // Verify video was also deleted (cascade)
      found = await videosRepository.findOne({
        where: { id: savedVideo.id },
      });
      expect(found).toBeNull();
    });
  });

  describe('Migration', () => {
    it('should have created the videos table', async () => {
      const result = await dataSource.query<{ table_name: string }[]>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'videos'`,
      );
      expect(result.length).toBe(1);
      expect(result[0].table_name).toBe('videos');
    });

    it('should have all required columns with correct types', async () => {
      const result = await dataSource.query<
        Array<{ column_name: string; is_nullable: string; data_type: string }>
      >(
        `SELECT column_name, is_nullable, data_type
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'videos'
         ORDER BY column_name`,
      );

      const columnMap = new Map(result.map((r) => [r.column_name, r]));

      // Check required columns
      const requiredColumns = [
        'id',
        'channel_id',
        'title',
        'public_id',
        'status',
        'storage_key',
        'created_at',
        'updated_at',
      ];
      requiredColumns.forEach((colName) => {
        const col = columnMap.get(colName);
        expect(col).toBeDefined();
        expect(col?.is_nullable).toBe('NO');
      });

      // Check nullable columns
      const nullableColumns = [
        'thumbnail_key',
        'duration_seconds',
        'metadata',
        'size_bytes',
        'error_reason',
      ];
      nullableColumns.forEach((colName) => {
        const col = columnMap.get(colName);
        expect(col).toBeDefined();
        expect(col?.is_nullable).toBe('YES');
      });
    });

    it('should have foreign key constraint on channel_id', async () => {
      const result = await dataSource.query<Array<{ constraint_name: string }>>(
        `SELECT constraint_name FROM information_schema.table_constraints
         WHERE table_schema = 'public' AND table_name = 'videos' AND constraint_type = 'FOREIGN KEY'`,
      );
      expect(result.length).toBeGreaterThan(0);
    });

    it('should verify unique constraint on public_id through CRUD behavior', async () => {
      const public_id = 'unique_constraint_t';
      const video1 = videosRepository.create({
        channel_id: testChannel.id,
        title: 'Unique Test 1',
        public_id,
        status: 'draft',
        storage_key: 'videos/unique-test-1',
      });
      await videosRepository.save(video1);

      const video2 = videosRepository.create({
        channel_id: testChannel.id,
        title: 'Unique Test 2',
        public_id,
        status: 'draft',
        storage_key: 'videos/unique-test-2',
      });

      await expect(videosRepository.save(video2)).rejects.toThrow();
    });

    it('should support enum status values', async () => {
      const statuses: Array<'draft' | 'processing' | 'ready' | 'failed'> = [
        'draft',
        'processing',
        'ready',
        'failed',
      ];

      for (const status of statuses) {
        const video = videosRepository.create({
          channel_id: testChannel.id,
          title: `Enum Test ${status}`,
          public_id: `enum_test_${status}`,
          status,
          storage_key: `videos/enum-test-${status}`,
        });
        const saved = await videosRepository.save(video);
        expect(saved.status).toBe(status);
      }
    });
  });
});
