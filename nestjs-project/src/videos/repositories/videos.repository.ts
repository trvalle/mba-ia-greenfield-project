import { Injectable } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { Video } from '../entities/video.entity';

@Injectable()
export class VideosRepository extends Repository<Video> {
  constructor(private dataSource: DataSource) {
    super(Video, dataSource.createEntityManager());
  }

  async findByPublicId(publicId: string): Promise<Video | null> {
    return this.findOne({ where: { public_id: publicId } });
  }

  async findByIdAndChannelId(
    id: string,
    channelId: string,
  ): Promise<Video | null> {
    return this.findOne({ where: { id, channel_id: channelId } });
  }

  async findByChannelId(channelId: string): Promise<Video[]> {
    return this.find({
      where: { channel_id: channelId },
      order: { created_at: 'DESC' },
    });
  }

  async findByStatus(
    status: 'draft' | 'processing' | 'ready' | 'failed',
  ): Promise<Video[]> {
    return this.find({ where: { status } });
  }
}
