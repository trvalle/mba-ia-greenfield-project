import { Injectable } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../entities/channel.entity';

@Injectable()
export class ChannelsRepository extends Repository<Channel> {
  constructor(private dataSource: DataSource) {
    super(Channel, dataSource.createEntityManager());
  }

  async findByIdAndUserId(id: string, userId: string): Promise<Channel | null> {
    return this.findOne({ where: { id, user_id: userId } });
  }

  async findByUserId(userId: string): Promise<Channel | null> {
    return this.findOne({ where: { user_id: userId } });
  }
}
