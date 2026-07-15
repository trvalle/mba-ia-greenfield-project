import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import { QueueService } from './queue.service';

/**
 * QueueModule sets up BullMQ with Redis backend for video processing.
 * Provides QueueService for enqueueing video processing jobs.
 *
 * Producer only — job processing/consumption is in SI-03.6 (worker).
 */
@Module({
  imports: [
    ConfigModule.forFeature(queueConfig),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get('REDIS_HOST') || 'redis',
          port: configService.get('REDIS_PORT') || 6379,
          maxRetriesPerRequest: null,
          enableOfflineQueue: true,
        },
      }),
    }),
    BullModule.registerQueue({
      name: 'video-processing',
    }),
  ],
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
