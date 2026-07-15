/**
 * Payload for video processing job in BullMQ queue.
 * Used when enqueueing a video for processing (metadata extraction, thumbnail generation).
 */
export class VideoProcessingPayload {
  /**
   * UUID of the video entity.
   * Also used as the jobId for idempotency: enqueueing the same videoId twice
   * will not create duplicate jobs.
   */
  videoId: string;

  /**
   * S3/MinIO storage key for the source video file.
   * Format: videos/channels/{channelId}/videos/{videoId}/source.{ext}
   */
  storageKey: string;

  /**
   * UUID of the channel that owns the video.
   * Used for logging and thumbnail storage path.
   */
  channelId: string;
}
