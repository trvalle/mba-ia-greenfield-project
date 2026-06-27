/**
 * Result of successful video processing.
 * Contains extracted metadata and generated thumbnail information.
 */
export class VideoMetadata {
  /**
   * Duration of video in seconds (rounded down).
   */
  duration_seconds: number;

  /**
   * Video codec name (e.g., 'h264', 'hevc', 'vp9').
   * Extracted from ffprobe output.
   */
  codec_video?: string;

  /**
   * Audio codec name (e.g., 'aac', 'mp3', 'opus').
   * Extracted from ffprobe output. Undefined if no audio stream.
   */
  codec_audio?: string;

  /**
   * Video resolution as "WIDTHxHEIGHT" (e.g., '1920x1080').
   * Undefined if not a video stream or resolution cannot be determined.
   */
  resolution?: string;

  /**
   * Video bitrate in bits per second.
   * Undefined if not available from ffprobe output.
   */
  bitrate?: number;

  /**
   * Frames per second (rounded down).
   * Parsed from r_frame_rate field. Undefined if unavailable.
   */
  fps?: number;

  /**
   * Container format name (e.g., 'mov,mp4,m4a,3gp,3g2,mj2').
   * Undefined if unknown.
   */
  format?: string;
}

/**
 * Result of video processing operation.
 * Returned after successful metadata extraction and thumbnail generation.
 */
export class VideoProcessingResult {
  /**
   * UUID of the video entity.
   */
  videoId: string;

  /**
   * Duration of video in seconds (rounded down).
   */
  duration_seconds: number;

  /**
   * Extracted video metadata from ffprobe.
   */
  metadata: VideoMetadata;

  /**
   * S3/MinIO storage key for the generated thumbnail.
   * Format: thumbnails/channels/{channelId}/videos/{videoId}/thumb.jpg
   */
  thumbnail_key: string;

  /**
   * Size of the source video file in bytes.
   * Read from S3 object metadata after upload.
   */
  size_bytes: number;
}
