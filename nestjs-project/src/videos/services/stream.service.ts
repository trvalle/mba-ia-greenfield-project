import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Readable } from 'stream';
import { StorageService } from '../../storage/storage.service';
import { VideosRepository } from '../repositories/videos.repository';
import { FileNotFoundException } from '../../common/exceptions/domain.exception';

/**
 * Service for streaming and downloading videos.
 * Implements HTTP 206 Partial Content support for Range requests.
 */
@Injectable()
export class StreamService {
  private readonly logger = new Logger(StreamService.name);

  constructor(
    private readonly videosRepository: VideosRepository,
    private readonly storageService: StorageService,
  ) {}

  /**
   * Stream a video with optional Range header support.
   *
   * Returns:
   * - 200 OK with full file if no Range header
   * - 206 Partial Content with requested byte range if Range header present
   *
   * @param publicId Public ID of the video
   * @param rangeHeader Optional HTTP Range header (e.g., "bytes=0-99")
   * @returns Object with status, headers, and readable stream
   * @throws NotFoundException if video not found or not ready
   * @throws BadRequestException if range is invalid
   */
  async streamVideo(
    publicId: string,
    rangeHeader?: string,
  ): Promise<{
    status: number;
    headers: Record<string, string | number>;
    stream: Readable;
  }> {
    // Load and validate video
    const video = await this.videosRepository.findByPublicId(publicId);
    if (!video) {
      this.logger.warn(`Video not found: publicId=${publicId}`);
      throw new NotFoundException(`Video ${publicId} not found`);
    }

    if (video.status !== 'ready') {
      this.logger.warn(
        `Video not ready for streaming: publicId=${publicId}, status=${video.status}`,
      );
      throw new NotFoundException(
        `Video ${publicId} is not ready for streaming (status: ${video.status})`,
      );
    }

    // Get object metadata
    let metadata: { size: number };
    try {
      const result = await this.storageService.headObject(video.storage_key);
      metadata = {
        size: typeof result.size === 'number' ? result.size : 0,
      };
    } catch (error) {
      if (error instanceof FileNotFoundException) {
        this.logger.error(
          `Storage file not found: publicId=${publicId}, storageKey=${video.storage_key}`,
        );
        throw new NotFoundException(
          `Video file not found in storage (publicId: ${publicId})`,
        );
      }
      throw error;
    }

    const fileSize = metadata.size;
    const contentType = 'video/mp4'; // Default content type for videos

    // Parse Range header (e.g., "bytes=0-99", "bytes=100-", "bytes=100-200")
    let startByte: number | undefined;
    let endByte: number | undefined;

    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
      if (match) {
        if (match[1]) startByte = parseInt(match[1], 10);
        if (match[2]) endByte = parseInt(match[2], 10);
      }
    }

    // Determine response range
    if (rangeHeader && (startByte !== undefined || endByte !== undefined)) {
      // 206 Partial Content
      const start = startByte !== undefined ? startByte : 0;
      const end = endByte !== undefined ? endByte : fileSize - 1;

      // Validate range
      if (start > end || start >= fileSize) {
        this.logger.warn(
          `Invalid range requested: publicId=${publicId}, range=${rangeHeader}, fileSize=${fileSize}`,
        );
        throw new BadRequestException(
          `Range not satisfiable: requested ${start}-${end}, file size ${fileSize}`,
        );
      }

      const streamResult = await this.storageService.getObject(
        video.storage_key,
        start,
        end,
      );

      this.logger.debug(
        `Streaming partial content: publicId=${publicId}, range=${start}-${end}/${fileSize}`,
      );

      return {
        status: 206,
        headers: {
          'Content-Type': contentType,
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
        },
        stream: streamResult,
      };
    }

    // 200 OK — full file
    const streamResult = await this.storageService.getObject(video.storage_key);

    this.logger.debug(
      `Streaming full content: publicId=${publicId}, size=${fileSize}`,
    );

    return {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': fileSize,
        'Accept-Ranges': 'bytes',
      },
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      stream: streamResult as Readable,
    };
  }

  /**
   * Download a video file.
   *
   * Returns the full video file with Content-Disposition: attachment header.
   *
   * @param publicId Public ID of the video
   * @returns Object with filename, contentType, contentLength, and readable stream
   * @throws NotFoundException if video not found or not ready
   */
  async downloadVideo(publicId: string): Promise<{
    filename: string;
    contentType: string;
    contentLength: number;
    stream: Readable;
  }> {
    // Load and validate video
    const video = await this.videosRepository.findByPublicId(publicId);
    if (!video) {
      this.logger.warn(`Video not found for download: publicId=${publicId}`);
      throw new NotFoundException(`Video ${publicId} not found`);
    }

    if (video.status !== 'ready') {
      this.logger.warn(
        `Video not ready for download: publicId=${publicId}, status=${video.status}`,
      );
      throw new NotFoundException(
        `Video ${publicId} is not ready for download (status: ${video.status})`,
      );
    }

    // Get metadata
    let metadata: { size: number };
    try {
      const result = await this.storageService.headObject(video.storage_key);
      metadata = {
        size: typeof result.size === 'number' ? result.size : 0,
      };
    } catch (error) {
      if (error instanceof FileNotFoundException) {
        this.logger.error(
          `Storage file not found: publicId=${publicId}, storageKey=${video.storage_key}`,
        );
        throw new NotFoundException(
          `Video file not found in storage (publicId: ${publicId})`,
        );
      }
      throw error;
    }

    const streamResult = await this.storageService.getObject(video.storage_key);

    // Infer filename from storage_key (e.g., videos/channels/ch-1/videos/vid-1/source.mp4 → source.mp4)
    const filename = video.storage_key.split('/').pop() || 'video.mp4';

    this.logger.debug(
      `Downloading video: publicId=${publicId}, filename=${filename}, size=${metadata.size}`,
    );

    return {
      filename,
      contentType: 'video/mp4',
      contentLength: metadata.size,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      stream: streamResult as Readable,
    };
  }
}
