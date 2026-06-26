import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  channel_id: string;

  @ManyToOne(() => Channel, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;

  @Column({ type: 'varchar', length: 500 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 20, unique: true })
  public_id: string;

  @Column({
    type: 'enum',
    enum: ['draft', 'processing', 'ready', 'failed'],
    default: 'draft',
  })
  status: 'draft' | 'processing' | 'ready' | 'failed';

  @Column({ type: 'varchar', length: 255 })
  storage_key: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  thumbnail_key: string | null;

  @Column({ type: 'int', nullable: true })
  duration_seconds: number | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any> | null;

  @Column({ type: 'bigint', nullable: true })
  size_bytes: number | null;

  @Column({ type: 'text', nullable: true })
  error_reason: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
