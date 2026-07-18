import { Injectable, Logger } from '@nestjs/common';
import { StorageService } from '../../storage/storage.service';
import { VideosRepository } from '../repositories/videos.repository';
import { VideoNotFoundException } from '../../common/exceptions/domain.exception';
import { VideoMetadataResponse } from '../dtos/video-metadata.response';

/**
 * Service for public video read operations (metadata).
 * Streaming/download live in StreamService; upload lifecycle in UploadService.
 */
@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    private readonly videosRepository: VideosRepository,
    private readonly storageService: StorageService,
  ) {}

  /**
   * Get public metadata for a video by its public_id.
   *
   * Returns the video in any lifecycle status (the status field lets clients
   * poll processing progress after upload-complete). Visibility rules
   * (public/unlisted) are Phase 04 scope.
   *
   * @param publicId Public ID of the video
   * @returns Video metadata including channel summary and thumbnail URL
   * @throws VideoNotFoundException if no video matches the public_id
   */
  async getMetadata(publicId: string): Promise<VideoMetadataResponse> {
    const video =
      await this.videosRepository.findByPublicIdWithChannel(publicId);
    if (!video) {
      this.logger.warn(`Video not found: publicId=${publicId}`);
      throw new VideoNotFoundException(`Video ${publicId} not found`);
    }

    // Thumbnail only exists after successful processing
    const thumbnailUrl = video.thumbnail_key
      ? await this.storageService.generatePresignedGetUrl(video.thumbnail_key)
      : null;

    return {
      videoId: video.id,
      publicId: video.public_id,
      title: video.title,
      description: video.description,
      status: video.status,
      duration_seconds: video.duration_seconds,
      thumbnail_url: thumbnailUrl,
      // bigint columns come back from PostgreSQL as strings
      size_bytes: video.size_bytes !== null ? Number(video.size_bytes) : null,
      channel: {
        id: video.channel.id,
        name: video.channel.name,
      },
      created_at: video.created_at.toISOString(),
      updated_at: video.updated_at.toISOString(),
    };
  }
}
