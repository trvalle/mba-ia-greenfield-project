import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import { Readable } from 'stream';
import { spawn } from 'child_process';
import { StorageService } from '../../storage/storage.service';
import { VideosRepository } from '../repositories/videos.repository';
import { FfmpegService } from './ffmpeg.service';
import type { VideoProcessingPayload } from '../dtos/video-processing-payload.dto';

/**
 * VideoProcessingService orchestrates video processing workflow.
 *
 * Workflow:
 * 1. Download video from storage
 * 2. Extract metadata using ffprobe
 * 3. Generate thumbnail using ffmpeg
 * 4. Upload thumbnail to storage
 * 5. Update video entity: status=ready, metadata, thumbnail_key, size_bytes
 * 6. On error: status=failed, error_reason populated
 *
 * Errors are rethrown so BullMQ can retry the job.
 */
@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    private storageService: StorageService,
    private videosRepository: VideosRepository,
    private ffmpegService: FfmpegService,
  ) {}

  /**
   * Process a video: extract metadata, generate thumbnail, update entity.
   * Throws on error (BullMQ will retry).
   */
  async processVideo(payload: VideoProcessingPayload): Promise<void> {
    const { videoId, storageKey, channelId } = payload;

    this.logger.log(
      `Starting processing: videoId=${videoId}, storageKey=${storageKey}`,
    );

    try {
      // 1. Load video from database
      const video = await this.videosRepository.findOne({
        where: { id: videoId },
      });
      if (!video) {
        throw new Error(`Video ${videoId} not found in database`);
      }

      // 2. Download video from storage
      this.logger.debug(`Downloading video from storage: ${storageKey}`);
      const videoStream = await this.storageService.getObject(storageKey);

      // Save to temp file (can't reuse stream for multiple operations)
      const { tmpFile } = await this.saveStreamToTemp(videoStream);

      try {
        // 3. Extract metadata from temp file
        this.logger.debug(`Extracting metadata from ${tmpFile}`);
        const metadata = await this.extractMetadataFromFile(tmpFile);

        // 4. Generate thumbnail from temp file
        this.logger.debug(`Generating thumbnail from ${tmpFile}`);
        const thumbnail = await this.generateThumbnailFromFile(
          tmpFile,
          metadata.duration_seconds,
        );

        // 5. Upload thumbnail to storage
        const thumbnailKey = `thumbnails/channels/${channelId}/videos/${videoId}/thumb.jpg`;
        this.logger.debug(`Uploading thumbnail to ${thumbnailKey}`);
        await this.storageService.putObject(thumbnailKey, thumbnail);

        // 6. Get file size from storage
        const fileMetadata = await this.storageService.headObject(storageKey);
        const sizeBytes = fileMetadata.size;

        // 7. Atomically update video to ready state
        this.logger.debug(`Updating video to ready state`);
        video.status = 'ready';
        video.duration_seconds = metadata.duration_seconds;
        video.metadata = metadata;
        video.thumbnail_key = thumbnailKey;
        video.size_bytes = sizeBytes;
        video.error_reason = null;

        await this.videosRepository.save(video);

        this.logger.log(
          `✓ Processing completed: videoId=${videoId}, duration=${metadata.duration_seconds}s`,
        );
      } finally {
        // Clean up temp file
        await this.cleanupTempFile(tmpFile);
      }
    } catch (error) {
      this.logger.error(
        `✗ Processing failed: videoId=${videoId}, error=${(error as Error).message}`,
      );

      // Mark video as failed (BullMQ will retry this job)
      try {
        const video = await this.videosRepository.findOne({
          where: { id: videoId },
        });
        if (video && video.status === 'processing') {
          video.status = 'failed';
          video.error_reason = (error as Error).message || 'Processing failed';
          await this.videosRepository.save(video);
        }
      } catch (updateError) {
        this.logger.error(
          `Failed to update video as failed: ${(updateError as Error).message}`,
        );
      }

      // Re-throw so BullMQ retries the job
      throw error;
    }
  }

  /**
   * Save readable stream to a temporary file.
   * Returns the file path.
   */
  private async saveStreamToTemp(
    stream: Readable,
  ): Promise<{ tmpFile: string }> {
    const tmpFile = `/tmp/video-worker/video-${Date.now()}.tmp`;
    const writeStream = fs.createWriteStream(tmpFile);

    return new Promise((resolve, reject) => {
      stream.pipe(writeStream);
      writeStream.on('finish', () => resolve({ tmpFile }));
      writeStream.on('error', reject);
      stream.on('error', reject);
    });
  }

  /**
   * Extract metadata from a local file using ffprobe.
   */
  private async extractMetadataFromFile(filepath: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const ffprobe = spawn('ffprobe', [
        '-v',
        'error',
        '-show_format',
        '-show_streams',
        '-of',
        'json',
        filepath,
      ]);

      let output = '';
      let errorOutput = '';

      ffprobe.stdout.on('data', (data) => {
        output += data.toString();
      });

      ffprobe.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      ffprobe.on('close', (code) => {
        if (code !== 0) {
          this.logger.error(`ffprobe exited with code ${code}: ${errorOutput}`);
          return reject(new BadRequestException('Invalid video file'));
        }

        try {
          const probe = JSON.parse(output);
          const format = probe.format || {};
          const videoStream = probe.streams?.find(
            (s: any) => s.codec_type === 'video',
          );
          const audioStream = probe.streams?.find(
            (s: any) => s.codec_type === 'audio',
          );

          const duration = parseFloat(
            format.duration || videoStream?.duration || '0',
          );

          // Extract FPS
          let fps: number | undefined;
          if (videoStream?.r_frame_rate) {
            try {
              fps = Math.round(eval(videoStream.r_frame_rate));
            } catch {
              fps = undefined;
            }
          }

          resolve({
            duration_seconds: Math.round(duration),
            codec_video: videoStream?.codec_name,
            codec_audio: audioStream?.codec_name,
            resolution: videoStream
              ? `${videoStream.width}x${videoStream.height}`
              : undefined,
            bitrate: videoStream?.bit_rate
              ? parseInt(videoStream.bit_rate, 10)
              : undefined,
            fps,
            format: format.format_name,
          });
        } catch (error) {
          this.logger.error(
            `Failed to parse metadata: ${(error as Error).message}`,
          );
          reject(new BadRequestException('Failed to parse metadata'));
        }
      });

      ffprobe.on('error', (error) => {
        this.logger.error(`ffprobe spawn error: ${error.message}`);
        reject(new BadRequestException('ffprobe not available'));
      });
    });
  }

  /**
   * Generate thumbnail from a local file using ffmpeg.
   * Extracts frame at 1 second or 1/4 through the video (whichever is earlier).
   */
  private async generateThumbnailFromFile(
    filepath: string,
    durationSeconds: number,
  ): Promise<Buffer> {
    // Extract frame at 1 second or 1/4 through the video
    const timestamp = Math.min(1, Math.floor(durationSeconds / 4));

    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-ss',
        timestamp.toString(),
        '-i',
        filepath,
        '-vframes',
        '1',
        '-vf',
        'scale=320:-1',
        '-f',
        'image2',
        '-c:v',
        'mjpeg',
        'pipe:1',
      ]);

      const chunks: Buffer[] = [];
      let errorOutput = '';

      ffmpeg.stdout.on('data', (data) => {
        chunks.push(data);
      });

      ffmpeg.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      ffmpeg.on('close', (code) => {
        if (code !== 0) {
          this.logger.error(
            `ffmpeg thumbnail generation failed: ${errorOutput}`,
          );
          return reject(new BadRequestException('Thumbnail generation failed'));
        }
        resolve(Buffer.concat(chunks));
      });

      ffmpeg.on('error', (error) => {
        this.logger.error(`ffmpeg spawn error: ${error.message}`);
        reject(new BadRequestException('ffmpeg not available'));
      });
    });
  }

  /**
   * Delete temporary file, ignoring errors if file doesn't exist.
   */
  private async cleanupTempFile(filepath: string): Promise<void> {
    try {
      if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
      }
    } catch (error) {
      this.logger.warn(
        `Failed to cleanup temp file ${filepath}: ${(error as Error).message}`,
      );
    }
  }
}
