import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VideosWorkerModule } from './videos/videos-worker.module';

/**
 * Video worker bootstrap.
 *
 * This is the entry point for the video-worker container.
 * It starts a NestJS application that listens for video processing jobs
 * on the BullMQ 'video-processing' queue.
 *
 * The application doesn't serve HTTP (no Controller, no public endpoints).
 * NestJS requires a port for application.listen(), but the worker doesn't expose it publicly.
 * Port 3001 is used (not exposed outside the container network).
 */
async function bootstrap() {
  const app = await NestFactory.create(VideosWorkerModule);
  const configService = app.get(ConfigService);
  const logger = new Logger('VideoWorker');

  // The worker doesn't serve HTTP, but NestJS needs a port.
  // Use 3001 (internal, not exposed outside the container).
  const port = configService.get('WORKER_PORT') || 3001;
  await app.listen(port);

  logger.log(
    `Video worker started on port ${port}, listening for jobs on 'video-processing' queue`,
  );
}

bootstrap().catch((error) => {
  console.error('Failed to start video worker:', error);
  process.exit(1);
});
