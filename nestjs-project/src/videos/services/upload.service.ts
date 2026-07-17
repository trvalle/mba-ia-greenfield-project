import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'crypto';
import { StorageService } from '../../storage/storage.service';
import { QueueService } from '../../queue/queue.service';
import { VideosRepository } from '../repositories/videos.repository';
import { Video } from '../entities/video.entity';
import {
  VideoNotFoundException,
  VideoInvalidStatusException,
  PublicIdGenerationException,
  StorageFileNotFoundException,
  FileNotFoundException,
} from '../../common/exceptions/domain.exception';
import { UploadInitRequest } from '../dtos/upload-init.request';
import { UploadInitResponse } from '../dtos/upload-init.response';
import { UploadCompleteResponse } from '../dtos/upload-complete.response';

/**
 * Service for handling two-phase video uploads:
 * 1. upload-init: create draft video, return presigned PUT URL
 * 2. upload-complete: verify file in storage, enqueue processing job
 */
@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);
  private readonly MAX_PUBLIC_ID_RETRIES = 5;
  private readonly presignExpirationSeconds: number;

  constructor(
    private readonly videosRepository: VideosRepository,
    private readonly storageService: StorageService,
    private readonly queueService: QueueService,
    private readonly configService: ConfigService,
  ) {
    // Get presign expiration from config
    this.presignExpirationSeconds = parseInt(
      this.configService.get<string>('PRESIGN_EXPIRATION_SECONDS', '3600'),
      10,
    );
  }

  /**
   * Generates a 12-character base62 public ID using crypto.randomBytes.
   * Base62 characters: A-Z, a-z, 0-9
   */
  private generatePublicId(): string {
    // 9 bytes = 72 bits ≈ 12 base62 chars
    const bytes = randomBytes(9);
    const base62Chars =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    let value = BigInt(0);

    for (let i = 0; i < bytes.length; i++) {
      value = (value << 8n) | BigInt(bytes[i]);
    }

    while (result.length < 12 && value > 0n) {
      result = base62Chars[Number(value % 62n)] + result;
      value = value / 62n;
    }

    // Pad with 'A' if needed
    while (result.length < 12) {
      result = 'A' + result;
    }

    return result.substring(0, 12);
  }

  /**
   * Formats the storage key according to TD-03 layout:
   * videos/channels/{channel_id}/videos/{video_id}/source.{ext}
   */
  private formatStorageKey(
    channelId: string,
    videoId: string,
    filename?: string,
  ): string {
    const ext = filename ? filename.split('.').pop() || 'mp4' : 'mp4';
    return `videos/channels/${channelId}/videos/${videoId}/source.${ext}`;
  }

  /**
   * Initialize a video upload (Phase 1 of 2-phase upload).
   *
   * Creates a draft video with a unique public_id (with retry on UNIQUE constraint violation).
   * Generates and returns a presigned PUT URL for the client to upload the file.
   *
   * Opção A: Uses UNIQUE constraint atomicity. On UNIQUE violation (error.code === '23505'),
   * regenerates public_id and retries INSERT (same attempt without transaction rollback).
   *
   * @param channelId UUID of the channel that will own the video
   * @param request Upload initialization request (title, description, channel_id, filename)
   * @returns Upload initialization response (videoId, publicId, uploadUrl, storageKey, expiresIn)
   * @throws PublicIdGenerationException if max retries exhausted
   */
  async initializeUpload(
    channelId: string,
    request: UploadInitRequest,
  ): Promise<UploadInitResponse> {
    let lastError: unknown;
    let video: Video | undefined;

    for (let attempt = 0; attempt < this.MAX_PUBLIC_ID_RETRIES; attempt++) {
      try {
        const newVideo = new Video();
        // Generate the UUID app-side so the definitive storage_key can be
        // written in a single INSERT — a fixed temporary key would collide
        // with the UNIQUE index on storage_key under concurrent uploads.
        newVideo.id = randomUUID();
        newVideo.channel_id = channelId;
        newVideo.title = request.title;
        newVideo.description = request.description || null;
        newVideo.public_id = this.generatePublicId();
        newVideo.status = 'draft';
        newVideo.storage_key = this.formatStorageKey(
          channelId,
          newVideo.id,
          request.filename,
        );
        newVideo.metadata = null;
        newVideo.size_bytes = request.sizeBytes || null;
        newVideo.thumbnail_key = null;
        newVideo.duration_seconds = null;
        newVideo.error_reason = null;

        video = await this.videosRepository.save(newVideo);

        this.logger.log(
          `Draft video created: videoId=${video.id}, publicId=${video.public_id}, channelId=${channelId}`,
        );
        break;
      } catch (error) {
        // Check for PostgreSQL UNIQUE constraint violation on public_id
        const errorCode = (error as { code?: string })?.code;
        if (errorCode === '23505') {
          // UNIQUE constraint violation — retry with new public_id
          lastError = error;
          this.logger.debug(
            `UNIQUE constraint violation on public_id (attempt ${attempt + 1}/${this.MAX_PUBLIC_ID_RETRIES}), retrying...`,
          );
          continue;
        }
        // Any other error: rethrow immediately
        this.logger.error(
          `Failed to create draft video: ${String(error)}`,
          error,
        );
        throw error;
      }
    }

    if (!video) {
      this.logger.error(
        `Failed to generate unique public_id after ${this.MAX_PUBLIC_ID_RETRIES} attempts`,
        lastError,
      );
      throw new PublicIdGenerationException(
        `Failed to generate unique public_id after ${this.MAX_PUBLIC_ID_RETRIES} attempts`,
      );
    }

    // Generate presigned PUT URL
    let uploadUrl: string;
    try {
      uploadUrl = await this.storageService.generatePresignedPutUrl(
        video.storage_key,
      );
    } catch (error) {
      this.logger.error(
        `Failed to generate presigned PUT URL for videoId=${video.id}`,
        error,
      );
      throw error;
    }

    return {
      videoId: video.id,
      publicId: video.public_id,
      uploadUrl,
      storageKey: video.storage_key,
      expiresIn: this.presignExpirationSeconds,
    };
  }

  /**
   * Complete a video upload (Phase 2 of 2-phase upload).
   *
   * Verifies that:
   * 1. The video exists and is owned by the specified channel
   * 2. The video is in 'draft' status
   * 3. The file was uploaded to storage
   *
   * Transitions the video status to 'processing' and enqueues a processing job.
   *
   * @param videoId UUID of the video to complete
   * @param channelId UUID of the channel that owns the video (for authorization)
   * @returns Upload completion response (videoId, publicId, status, timestamps)
   * @throws VideoNotFoundException if video not found or not owned by channel
   * @throws VideoInvalidStatusException if video is not in draft status
   * @throws StorageFileNotFoundException if file not found in storage
   */
  async completeUpload(
    videoId: string,
    channelId: string,
  ): Promise<UploadCompleteResponse> {
    // 1. Load video and validate ownership
    const video = await this.videosRepository.findByIdAndChannelId(
      videoId,
      channelId,
    );
    if (!video) {
      throw new VideoNotFoundException(
        `Video ${videoId} not found or not owned by channel ${channelId}`,
      );
    }

    // 2. Validate video is in draft status
    if (video.status !== 'draft') {
      throw new VideoInvalidStatusException(
        `Video must be in draft status to complete upload; current: ${video.status}`,
      );
    }

    // 3. Verify file exists in storage
    try {
      await this.storageService.headObject(video.storage_key);
      this.logger.debug(
        `File verified in storage: videoId=${videoId}, storageKey=${video.storage_key}`,
      );
    } catch (error) {
      if (error instanceof FileNotFoundException) {
        this.logger.warn(
          `Uploaded file not found in storage: videoId=${videoId}, storageKey=${video.storage_key}`,
        );
        throw new StorageFileNotFoundException(
          `Uploaded file not found in storage at ${video.storage_key}`,
        );
      }
      // Rethrow other errors
      throw error;
    }

    // 4. Transition status to processing
    video.status = 'processing';
    const updated = await this.videosRepository.save(video);

    this.logger.log(
      `Video transitioned to processing: videoId=${videoId}, channelId=${channelId}`,
    );

    // 5. Enqueue processing job
    try {
      await this.queueService.enqueueVideoProcessing({
        videoId: video.id,
        storageKey: video.storage_key,
        channelId: video.channel_id,
      });
    } catch (error) {
      this.logger.error(
        `Failed to enqueue processing job: videoId=${videoId}`,
        error,
      );
      throw error;
    }

    return {
      videoId: updated.id,
      publicId: updated.public_id,
      status: updated.status,
      duration_seconds: null,
      thumbnail_key: null,
      createdAt: updated.created_at.toISOString(),
    };
  }
}
