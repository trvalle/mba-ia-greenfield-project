import { ApiProperty } from '@nestjs/swagger';

/**
 * Channel summary embedded in the video metadata response.
 */
export class VideoMetadataChannel {
  @ApiProperty({
    description: 'UUID of the channel that owns the video',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  id: string;

  @ApiProperty({
    description: 'Display name of the channel',
    example: 'My Channel',
  })
  name: string;
}

/**
 * Response DTO for GET /videos/:public_id
 * Public metadata of a video, including its processing status.
 */
export class VideoMetadataResponse {
  @ApiProperty({
    description: 'UUID of the video',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  videoId: string;

  @ApiProperty({
    description: 'Unique public ID for the video (12-char base62)',
    example: 'abc123xyz789',
  })
  publicId: string;

  @ApiProperty({
    description: 'Video title',
    example: 'My First Video',
  })
  title: string;

  @ApiProperty({
    description: 'Video description',
    example: 'A short description',
    nullable: true,
  })
  description: string | null;

  @ApiProperty({
    description: 'Video lifecycle status',
    enum: ['draft', 'processing', 'ready', 'failed'],
    example: 'ready',
  })
  status: 'draft' | 'processing' | 'ready' | 'failed';

  @ApiProperty({
    description: 'Video duration in seconds (null until processed)',
    example: 300,
    nullable: true,
  })
  duration_seconds: number | null;

  @ApiProperty({
    description: 'Presigned GET URL for the thumbnail (null until processed)',
    example:
      'http://localhost:9000/streamtube/thumbnails/...?X-Amz-Signature=...',
    nullable: true,
  })
  thumbnail_url: string | null;

  @ApiProperty({
    description: 'File size in bytes (null until upload completes)',
    example: 1234567890,
    nullable: true,
  })
  size_bytes: number | null;

  @ApiProperty({
    description: 'Channel that owns the video',
    type: VideoMetadataChannel,
  })
  channel: VideoMetadataChannel;

  @ApiProperty({
    description: 'Creation timestamp (ISO 8601)',
    example: '2026-06-25T10:00:00.000Z',
  })
  created_at: string;

  @ApiProperty({
    description: 'Last update timestamp (ISO 8601)',
    example: '2026-06-25T10:05:00.000Z',
  })
  updated_at: string;
}
