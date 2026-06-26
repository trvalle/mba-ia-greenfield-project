import { Injectable, Inject, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import { VideoProcessingPayload } from '../videos/dtos/video-processing-payload.dto';
import { QueueException } from '../common/exceptions/domain.exception';

/**
 * Producer service for enqueueing video processing jobs.
 * This service only enqueues jobs; job processing is handled by SI-03.6 (worker/consumer).
 */
@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(
    @InjectQueue('video-processing')
    private readonly videoProcessingQueue: Queue,
    @Inject(queueConfig.KEY)
    private readonly config: ConfigType<typeof queueConfig>,
  ) {}

  /**
   * Enqueue a video for processing.
   * Uses videoId as jobId for idempotency: calling this twice with the same videoId
   * will not create duplicate jobs — the second call updates the existing job.
   *
   * @param payload Video processing payload (videoId, storageKey, channelId)
   * @throws QueueException if enqueueing fails
   */
  async enqueueVideoProcessing(payload: VideoProcessingPayload): Promise<void> {
    try {
      await this.videoProcessingQueue.add(
        this.config.jobNames.processVideo,
        payload,
        {
          jobId: payload.videoId,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );

      this.logger.log(
        `Video processing job enqueued: videoId=${payload.videoId}, channelId=${payload.channelId}`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error enqueueing job';
      this.logger.error(
        `Failed to enqueue video processing: ${message}`,
        error,
      );
      throw new QueueException(
        `Failed to enqueue video processing: ${message}`,
      );
    }
  }

  /**
   * Get the status of a video processing job.
   *
   * @param jobId Job ID (typically equals videoId)
   * @returns Job status object with id, state, progress, attempts, maxAttempts, or null if job not found
   */
  async getJobStatus(jobId: string): Promise<{
    id: string;
    state: string;
    progress: number | null;
    attempts: number;
    maxAttempts: number | undefined;
  } | null> {
    try {
      const job = await this.videoProcessingQueue.getJob(jobId);

      if (!job) {
        return null;
      }

      return {
        id: job.id!,
        state: await job.getState(),
        progress: job.progress as number | null,
        attempts: job.attemptsMade,
        maxAttempts: job.opts.attempts,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error fetching job';
      this.logger.error(`Failed to get job status: ${message}`, error);
      throw new QueueException(`Failed to get job status: ${message}`);
    }
  }
}
