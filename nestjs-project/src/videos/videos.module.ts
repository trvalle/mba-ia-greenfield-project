import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Video } from './entities/video.entity';
import { VideosRepository } from './repositories/videos.repository';
import { QueueModule } from '../queue/queue.module';

@Module({
  imports: [TypeOrmModule.forFeature([Video]), QueueModule],
  providers: [VideosRepository],
  exports: [TypeOrmModule, VideosRepository, QueueModule],
})
export class VideosModule {}
