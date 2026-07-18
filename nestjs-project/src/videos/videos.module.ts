import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Video } from './entities/video.entity';
import { VideosRepository } from './repositories/videos.repository';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { ChannelsModule } from '../channels/channels.module';
import { AuthModule } from '../auth/auth.module';
import { UploadService } from './services/upload.service';
import { UploadController } from './controllers/upload.controller';
import { StreamService } from './services/stream.service';
import { StreamController } from './controllers/stream.controller';
import { VideosService } from './services/videos.service';
import { VideosController } from './controllers/videos.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    QueueModule,
    StorageModule,
    ChannelsModule,
    AuthModule,
  ],
  providers: [VideosRepository, UploadService, StreamService, VideosService],
  // VideosController last: its GET /videos/:public_id is a catch-all segment,
  // so static/deeper routes (upload-init, :public_id/stream) register first
  controllers: [UploadController, StreamController, VideosController],
  exports: [TypeOrmModule, VideosRepository, QueueModule],
})
export class VideosModule {}
