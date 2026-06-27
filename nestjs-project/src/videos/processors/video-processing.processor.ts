import { Logger } from '@nestjs/common';
import { Processor } from '@nestjs/bullmq';
import { WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import type { VideoProcessingPayload } from '../dtos/video-processing-payload.dto';
import { VideoProcessingService } from '../services/video-processing.service';

/**
 * VideoProcessingProcessor consumes 'process-video' jobs from 'video-processing' queue.
 *
 * Each job processes a video:
 * - Extracts metadata
 * - Generates thumbnail
 * - Updates video entity
 *
 * BullMQ handles retries based on job options (attempts:3 with exponential backoff).
 */
@Processor('video-processing')
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(private videoProcessingService: VideoProcessingService) {
    super();
  }

  async process(job: Job<VideoProcessingPayload>): Promise<void> {
    this.logger.log(`[Job ${job.id}] Processing video: ${job.data.videoId}`);

    try {
      await this.videoProcessingService.processVideo(job.data);
      this.logger.log(`[Job ${job.id}] ✓ Completed`);
    } catch (error) {
      this.logger.error(
        `[Job ${job.id}] ✗ Failed: ${(error as Error).message}`,
      );
      // BullMQ will handle retries based on job options
      throw error;
    }
  }
}
