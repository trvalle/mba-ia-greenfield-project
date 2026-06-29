import { MigrationInterface, QueryRunner, TableIndex } from 'typeorm';

export class AddStorageKeyUniqueConstraint1785912653000
  implements MigrationInterface
{
  name = 'AddStorageKeyUniqueConstraint1785912653000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add unique constraint via index on storage_key
    await queryRunner.createIndex(
      'videos',
      new TableIndex({
        name: 'idx_videos_storage_key_unique',
        columnNames: ['storage_key'],
        isUnique: true,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove unique constraint
    await queryRunner.dropIndex('videos', 'idx_videos_storage_key_unique');
  }
}
