import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from './entities/channel.entity';
import { ChannelsService } from './channels.service';
import { ChannelsRepository } from './repositories/channels.repository';

@Module({
  imports: [TypeOrmModule.forFeature([Channel])],
  providers: [ChannelsService, ChannelsRepository],
  exports: [TypeOrmModule, ChannelsService, ChannelsRepository],
})
export class ChannelsModule {}
