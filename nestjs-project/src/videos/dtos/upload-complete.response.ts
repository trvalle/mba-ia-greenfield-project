import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO for POST /videos/{id}/upload-complete
 * Confirms that the upload was completed and processing has been queued.
 */
export class UploadCompleteResponse {
  @ApiProperty({
    description: 'UUID of the video',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  videoId: string;

  @ApiProperty({
    description: 'Public ID of the video',
    example: 'abc123xyz789',
  })
  publicId: string;

  @ApiProperty({
    description: 'Current status of the video (now in processing)',
    example: 'processing',
  })
  status: string;

  @ApiProperty({
    description: 'Duration in seconds (not yet available during processing)',
    example: null,
    nullable: true,
  })
  duration_seconds: number | null;

  @ApiProperty({
    description: 'Thumbnail storage key (not yet available during processing)',
    example: null,
    nullable: true,
  })
  thumbnail_key: string | null;

  @ApiProperty({
    description: 'ISO 8601 timestamp of when the video was created',
    example: '2026-06-26T10:30:00.000Z',
  })
  createdAt: string;
}
