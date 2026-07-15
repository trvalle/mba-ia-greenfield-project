import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddDescriptionToVideos1782948579264 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'videos',
      new TableColumn({
        name: 'description',
        type: 'text',
        isNullable: true,
        // Insert after title, before public_id
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('videos', 'description');
  }
}
