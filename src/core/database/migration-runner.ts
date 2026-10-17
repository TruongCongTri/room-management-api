/**
 * CLI Entry point độc lập dùng cho Kubernetes InitContainers / Job hoặc CI/CD Pipeline:
 *   node dist/core/database/migration-runner.js            # chạy migration
 *   node dist/core/database/migration-runner.js --dry-run  # chỉ liệt kê migration đang chờ
 *
 * Dùng đúng schema env, naming strategy, TLS và IP family như ứng dụng (buildDataSourceOptions),
 * chạy toàn bộ migration trong MỘT transaction và trả exit code 1 khi lỗi để chặn rollout.
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { DataSource, DataSourceOptions } from 'typeorm';
import { loadAppConfig } from '../config/load-config';
import { describeDatabaseTarget } from '../config/resolvers/database.resolver';
import { buildDataSourceOptions } from './database.options';
import { diagnoseDatabaseNetwork } from './database.network';

export async function runMigrations(options: { dryRun?: boolean } = {}): Promise<number> {
  const logger = new Logger('MigrationRunner');
  const config = loadAppConfig();
  const db = config.database;

  if (db.poolMode === 'transaction') {
    logger.warn(
      'DATABASE_URL points at a transaction pooler (:6543). Prefer the direct connection or the session pooler (:5432) for migrations.',
    );
  }

  await diagnoseDatabaseNetwork(db, logger);

  // Migration chỉ chạy trên Master (nơi duy nhất cho phép DDL), một kết nối là đủ
  const baseOptions = buildDataSourceOptions(config);
  const dataSource = new DataSource({
    ...baseOptions,
    extra: { ...(baseOptions.extra as Record<string, unknown>), max: 1, min: 0 },
    entities: [`${__dirname}/../../**/*.entity.{ts,js}`],
  } as DataSourceOptions);

  try {
    await dataSource.initialize();
    logger.log(`Connected to ${describeDatabaseTarget(db.master)}.`);

    const pending = await dataSource.showMigrations();
    if (options.dryRun) {
      logger.log(pending ? 'There are pending migrations (see TypeORM output above).' : 'Schema is up to date.');
      return 0;
    }

    const migrations = await dataSource.runMigrations({ transaction: 'all' });
    if (migrations.length === 0) {
      logger.log('Schema is already up to date. No migrations executed.');
    } else {
      logger.log(`Successfully applied ${migrations.length} migration(s):`);
      migrations.forEach((m) => logger.log(` - ${m.name}`));
    }
    return 0;
  } catch (err: any) {
    logger.error(`Migration failed: ${err.message}`, err.stack);
    return 1; // Exit code 1 để Kubernetes InitContainer chặn deploy Pod chính
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

if (require.main === module) {
  runMigrations({ dryRun: process.argv.includes('--dry-run') })
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
