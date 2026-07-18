import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService, ConfigType } from '@nestjs/config';
import { Video } from './entities/video.entity';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { VideosRepository } from './repositories/videos.repository';
import { VideoProcessingService } from './services/video-processing.service';
import { VideoProcessingProcessor } from './processors/video-processing.processor';
import { FfmpegService } from './services/ffmpeg.service';
import { StorageModule } from '../storage/storage.module';
import databaseConfig from '../config/database.config';
import storageConfig from '../config/storage.config';
import queueConfig from '../config/queue.config';
import { envValidationSchema } from '../config/env.validation';

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
    // The worker is a standalone Nest app (main-worker.ts), so it needs its
    // own root ConfigModule and TypeORM DataSource — it does not inherit
    // anything from AppModule.
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, storageConfig, queueConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        // Explicit entity list: the worker only forFeatures Video, but the
        // Video→Channel→User relation graph must be present in the metadata.
        entities: [Video, Channel, User, RefreshToken, VerificationToken],
        synchronize: false,
      }),
    }),
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
