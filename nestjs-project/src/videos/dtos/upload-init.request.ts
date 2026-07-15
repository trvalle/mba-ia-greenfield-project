import {
  IsString,
  IsOptional,
  IsUUID,
  MinLength,
  MaxLength,
  IsNumber,
  Min,
} from 'class-validator';

/**
 * Request DTO for POST /videos/upload-init
 * Initializes a video upload by creating a draft video and returning a presigned PUT URL.
 */
export class UploadInitRequest {
  /** Video title (1-500 characters). */
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  title: string;

  /** Optional video description. */
  @IsOptional()
  @IsString()
  description?: string;

  /** UUID of the channel that will own this video. User must be the channel owner. */
  @IsUUID()
  channel_id: string;

  /** Optional original filename, used to preserve the file extension in storage. */
  @IsOptional()
  @IsString()
  filename?: string;

  /** Optional file size in bytes (hint for validation). */
  @IsOptional()
  @IsNumber()
  @Min(1)
  sizeBytes?: number;
}
