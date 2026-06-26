import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableForeignKey,
  TableIndex,
} from 'typeorm';

export class CreateVideosTable1782433349864 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'videos',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'gen_random_uuid()',
          },
          {
            name: 'channel_id',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'title',
            type: 'varchar',
            length: '500',
            isNullable: false,
          },
          {
            name: 'public_id',
            type: 'varchar',
            length: '20',
            isNullable: false,
          },
          {
            name: 'status',
            type: 'enum',
            enum: ['draft', 'processing', 'ready', 'failed'],
            default: "'draft'",
            isNullable: false,
          },
          {
            name: 'storage_key',
            type: 'varchar',
            length: '255',
            isNullable: false,
          },
          {
            name: 'thumbnail_key',
            type: 'varchar',
            length: '255',
            isNullable: true,
          },
          {
            name: 'duration_seconds',
            type: 'int',
            isNullable: true,
          },
          {
            name: 'metadata',
            type: 'jsonb',
            isNullable: true,
          },
          {
            name: 'size_bytes',
            type: 'bigint',
            isNullable: true,
          },
          {
            name: 'error_reason',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'created_at',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
            isNullable: false,
          },
          {
            name: 'updated_at',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
            isNullable: false,
          },
        ],
      }),
      true,
    );

    // Foreign key
    await queryRunner.createForeignKey(
      'videos',
      new TableForeignKey({
        columnNames: ['channel_id'],
        referencedTableName: 'channels',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
      }),
    );

    // Indexes
    await queryRunner.createIndex(
      'videos',
      new TableIndex({
        columnNames: ['public_id'],
        isUnique: true,
        name: 'idx_videos_public_id',
      }),
    );

    await queryRunner.createIndex(
      'videos',
      new TableIndex({
        columnNames: ['channel_id'],
        name: 'idx_videos_channel_id',
      }),
    );

    await queryRunner.createIndex(
      'videos',
      new TableIndex({
        columnNames: ['status'],
        name: 'idx_videos_status',
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('videos');
  }
}
