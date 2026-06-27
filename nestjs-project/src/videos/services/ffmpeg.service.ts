import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { spawn } from 'child_process';
import * as fs from 'fs';

/**
 * FfmpegService wraps ffmpeg and ffprobe command-line tools.
 * Uses child_process.spawn() for streaming large media files.
 *
 * Per TD-04: Do NOT use fluent-ffmpeg or any wrapper library.
 * Spawn ffmpeg/ffprobe directly, handle exit codes and stderr.
 */
@Injectable()
export class FfmpegService {
  private readonly logger = new Logger(FfmpegService.name);
  private readonly TEMP_DIR = '/tmp/video-worker';

  constructor() {
    if (!fs.existsSync(this.TEMP_DIR)) {
      fs.mkdirSync(this.TEMP_DIR, { recursive: true });
    }
  }

  /**
   * Extract video metadata using ffprobe.
   * Reads ffprobe output from stdin (piped file stream).
   *
   * Returns: {
   *   duration_seconds: number;
   *   codec_video?: string;
   *   codec_audio?: string;
   *   resolution?: string;
   *   bitrate?: number;
   *   fps?: number;
   *   format?: string;
   * }
   */
  async extractMetadata(videoStream: NodeJS.ReadableStream): Promise<{
    duration_seconds: number;
    codec_video?: string;
    codec_audio?: string;
    resolution?: string;
    bitrate?: number;
    fps?: number;
    format?: string;
  }> {
    return new Promise((resolve, reject) => {
      // Spawn ffprobe with JSON output format
      const ffprobe = spawn('ffprobe', [
        '-v',
        'error',
        '-show_format',
        '-show_streams',
        '-of',
        'json',
        'pipe:0', // Read from stdin
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
          return reject(
            new BadRequestException(
              'ffprobe failed: invalid or unsupported video format',
            ),
          );
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

          // Extract duration (prefer format-level duration, fall back to video stream)
          const duration = parseFloat(
            format.duration || videoStream?.duration || '0',
          );

          // Extract resolution
          const resolution = videoStream
            ? `${videoStream.width}x${videoStream.height}`
            : undefined;

          // Extract FPS from r_frame_rate field (e.g., "30/1" -> 30)
          let fps: number | undefined;
          if (videoStream?.r_frame_rate) {
            try {
              fps = Math.round(eval(videoStream.r_frame_rate));
            } catch {
              fps = undefined;
            }
          }

          // Extract bitrate
          const bitrate = videoStream?.bit_rate
            ? parseInt(videoStream.bit_rate, 10)
            : undefined;

          resolve({
            duration_seconds: Math.round(duration),
            codec_video: videoStream?.codec_name,
            codec_audio: audioStream?.codec_name,
            resolution,
            bitrate,
            fps,
            format: format.format_name,
          });
        } catch (error) {
          this.logger.error(
            `Failed to parse ffprobe output: ${(error as Error).message}`,
          );
          reject(new BadRequestException('Failed to parse video metadata'));
        }
      });

      ffprobe.on('error', (error) => {
        this.logger.error(`ffprobe spawn error: ${error.message}`);
        reject(
          new BadRequestException('ffprobe not available or failed to start'),
        );
      });

      // Pipe input stream to ffprobe stdin
      videoStream.pipe(ffprobe.stdin);
    });
  }

  /**
   * Generate thumbnail from video stream.
   * Extracts a single frame at specified timestamp, scales to 320px width, converts to JPEG.
   *
   * Returns: Buffer containing JPEG image
   */
  async generateThumbnail(
    videoStream: NodeJS.ReadableStream,
    timestampSeconds: number = 1,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      // Spawn ffmpeg to extract a frame and convert to JPEG
      const ffmpeg = spawn('ffmpeg', [
        '-ss',
        timestampSeconds.toString(), // Seek to timestamp
        '-i',
        'pipe:0', // Read video from stdin
        '-vframes',
        '1', // Extract 1 frame only
        '-vf',
        'scale=320:-1', // Scale to 320px width, maintain aspect ratio
        '-f',
        'image2', // Output format: image
        '-c:v',
        'mjpeg', // Video codec: JPEG
        'pipe:1', // Write to stdout
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
          return reject(
            new BadRequestException('Failed to generate thumbnail'),
          );
        }
        resolve(Buffer.concat(chunks));
      });

      ffmpeg.on('error', (error) => {
        this.logger.error(`ffmpeg spawn error: ${error.message}`);
        reject(new BadRequestException('ffmpeg not available'));
      });

      videoStream.pipe(ffmpeg.stdin);
    });
  }
}
