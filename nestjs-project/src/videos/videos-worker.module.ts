import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Video } from './entities/video.entity';
import { VideosRepository } from './repositories/videos.repository';
import { VideoProcessingService } from './services/video-processing.service';
import { VideoProcessingProcessor } from './processors/video-processing.processor';
import { FfmpegService } from './services/ffmpeg.service';
import { StorageModule } from '../storage/storage.module';

/**
 * VideosWorkerModule sets up the video processing worker.
 *
 * This module:
 * - Registers the BullMQ processor for 'video-processing' queue
 * - Provides VideoProcessingService and FfmpegService
 * - Imports StorageModule for S3/MinIO access
 * - Connects to database for Video entity persistence
 *
 * This module is used ONLY in the video-worker application (main-worker.ts).
 * It is NOT imported into the main API application (main.ts / AppModule).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get('REDIS_HOST') || 'redis',
          port: configService.get('REDIS_PORT') || 6379,
          maxRetriesPerRequest: null,
        },
      }),
    }),
    BullModule.registerQueue({
      name: 'video-processing',
    }),
    StorageModule,
  ],
  providers: [
    VideosRepository,
    FfmpegService,
    VideoProcessingService,
    VideoProcessingProcessor,
  ],
})
export class VideosWorkerModule {}
