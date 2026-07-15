import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO for POST /videos/upload-init
 * Contains the presigned PUT URL for uploading the video file.
 */
export class UploadInitResponse {
  @ApiProperty({
    description: 'UUID of the newly created draft video',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  videoId: string;

  @ApiProperty({
    description: 'Unique public ID for the video (12-char base62)',
    example: 'abc123xyz789',
  })
  publicId: string;

  @ApiProperty({
    description:
      'Presigned PUT URL for uploading the video file. Valid for expiresIn seconds.',
    example:
      'http://localhost:9000/streamtube/videos/channels/...?X-Amz-Signature=...',
  })
  uploadUrl: string;

  @ApiProperty({
    description: 'Storage key (S3 path) where the file will be stored',
    example: 'videos/channels/ch-uuid/videos/vid-uuid/source.mp4',
  })
  storageKey: string;

  @ApiProperty({
    description: 'Seconds until the presigned URL expires',
    example: 3600,
  })
  expiresIn: number;
}
