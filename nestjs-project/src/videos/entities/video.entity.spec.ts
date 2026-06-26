import { Video } from './video.entity';

describe('Video Entity', () => {
  it('should create a valid Video instance', () => {
    const video = new Video();
    video.id = 'test-uuid';
    video.channel_id = 'channel-uuid';
    video.title = 'Test Video';
    video.public_id = 'abc123def456';
    video.status = 'draft';
    video.storage_key =
      'videos/channels/channel-uuid/videos/video-uuid/source.mp4';
    video.created_at = new Date();
    video.updated_at = new Date();

    expect(video.id).toBe('test-uuid');
    expect(video.title).toBe('Test Video');
    expect(video.status).toBe('draft');
    expect(video.channel_id).toBe('channel-uuid');
    expect(video.public_id).toBe('abc123def456');
  });

  it('should handle nullable fields', () => {
    const video = new Video();
    video.thumbnail_key = null;
    video.duration_seconds = null;
    video.metadata = null;
    video.size_bytes = null;
    video.error_reason = null;

    expect(video.thumbnail_key).toBeNull();
    expect(video.duration_seconds).toBeNull();
    expect(video.metadata).toBeNull();
    expect(video.size_bytes).toBeNull();
    expect(video.error_reason).toBeNull();
  });

  it('should accept metadata as JSON object', () => {
    const video = new Video();
    video.metadata = {
      duration: 300,
      codec: 'h264',
      resolution: '1920x1080',
      width: 1920,
      height: 1080,
    };

    expect(video.metadata.duration).toBe(300);
    expect(video.metadata.codec).toBe('h264');
    expect(video.metadata.resolution).toBe('1920x1080');
  });

  it('should support all video status states', () => {
    const statuses: Array<'draft' | 'processing' | 'ready' | 'failed'> = [
      'draft',
      'processing',
      'ready',
      'failed',
    ];

    statuses.forEach((status) => {
      const video = new Video();
      video.status = status;
      expect(video.status).toBe(status);
    });
  });

  it('should properly initialize channel relationship', () => {
    const video = new Video();
    video.channel_id = 'channel-uuid';
    // channel relationship will be populated when loaded from DB
    expect(video.channel_id).toBe('channel-uuid');
  });
});
