import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideosTable1782433349864 } from './migrations/1782433349864-CreateVideosTable';
import { AddDescriptionToVideos1782948579264 } from './migrations/1782948579264-AddDescriptionToVideos';
import { AddStorageKeyUniqueConstraint1785912653000 } from './migrations/1785912653000-AddStorageKeyUniqueConstraint';
import { createTestDataSource } from '../test/create-test-data-source';

// Every table owned by the full migration chain. The suite drops and
// re-creates ALL of them so the `migrations` bookkeeping table stays complete
// after the run — dropping only a subset would leave `migration:run`
// broken for whoever runs it after the test suite.
const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
  'videos',
];

const ALL_MIGRATIONS = [
  CreateUsersAndChannels1775687773260,
  CreateAuthTokens1777579850478,
  CreateVideosTable1782433349864,
  AddDescriptionToVideos1782948579264,
  AddStorageKeyUniqueConstraint1785912653000,
];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: ALL_MIGRATIONS,
      },
    );

    await dataSource.initialize();

    await Promise.all([
      ...MANAGED_TABLES.map((table) =>
        dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`),
      ),
      dataSource.query(`DROP TABLE IF EXISTS "migrations" CASCADE`),
    ]);

    // DROP TABLE CASCADE does not remove enum types; drop them explicitly so
    // the migrations can re-run their CREATE TYPE regardless of prior DB
    // state (e.g., enum left behind by a previous migration run or
    // synchronize).
    await dataSource.query(
      `DROP TYPE IF EXISTS "public"."verification_tokens_type_enum" CASCADE`,
    );
    await dataSource.query(
      `DROP TYPE IF EXISTS "public"."videos_status_enum" CASCADE`,
    );
  }, 30000);

  afterAll(async () => {
    try {
      // The second test undoes the last migration. Re-apply the full chain so
      // the shared DB (tables AND `migrations` bookkeeping) is completely
      // migrated when subsequent suites — or a manual `migration:run` — run.
      if (dataSource && dataSource.isInitialized) {
        try {
          await dataSource.runMigrations();
          await dataSource.destroy();
        } catch {
          // Ignore cleanup errors
        }
      }
    } catch {
      // Ensure function doesn't throw
    }
  }, 30000);

  it('should apply all five migrations and create all five tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(ALL_MIGRATIONS.length);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);

    // Bookkeeping is complete: one row per migration
    const rows = await dataSource.query<{ name: string }[]>(
      `SELECT name FROM "migrations" ORDER BY id`,
    );
    expect(rows).toHaveLength(ALL_MIGRATIONS.length);
  });

  it('should revert the last migration and drop the storage_key unique index', async () => {
    await dataSource.undoLastMigration();

    const indexes = await dataSource.query<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'videos' AND indexname = 'idx_videos_storage_key_unique'`,
    );
    expect(indexes).toHaveLength(0);

    // The rest of the chain remains applied
    const rows = await dataSource.query<{ name: string }[]>(
      `SELECT name FROM "migrations" ORDER BY id`,
    );
    expect(rows).toHaveLength(ALL_MIGRATIONS.length - 1);
  });
});
