/**
 * Nạp dữ liệu danh mục tĩnh - tách khỏi vòng đời Pod API (chạy bằng Job / InitContainer sau migration):
 *   npm run db:seed                    # local (ts-node)
 *   node dist/core/database/seed-runner.js
 *
 *  - Mỗi seed chạy trong transaction riêng, giữ pg_advisory_xact_lock → nhiều Job chạy đồng thời không seed trùng.
 *  - Bật app.bypass_rls cục bộ trong transaction để seed được dữ liệu của nhiều tenant.
 *  - Trả exit code 1 khi lỗi để chặn rollout.
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { DataSource, DataSourceOptions } from 'typeorm';
import { loadAppConfig } from '../config/load-config';
import { describeDatabaseTarget } from '../config/resolvers/database.resolver';
import { buildDataSourceOptions } from './database.options';
import { SEEDS } from './seeds';
import type { DatabaseSeed } from './seeds/seed.interface';

/** Khóa advisory cố định cho tiến trình seed (số nguyên 64-bit bất kỳ, duy nhất trong hệ thống) */
const SEED_ADVISORY_LOCK_KEY = 7_311_046_120_001;

export async function runSeeds(seeds: DatabaseSeed[] = SEEDS): Promise<number> {
  const logger = new Logger('SeedRunner');
  const config = loadAppConfig();

  const applicable = seeds.filter((seed) => !seed.environments || seed.environments.includes(config.nodeEnv));
  if (applicable.length === 0) {
    logger.log('No seeds registered for this environment (src/core/database/seeds/index.ts).');
    return 0;
  }

  const baseOptions = buildDataSourceOptions(config);
  const dataSource = new DataSource({
    ...baseOptions,
    extra: { ...(baseOptions.extra as Record<string, unknown>), max: 1, min: 0 },
    entities: [`${__dirname}/../../**/*.entity.{ts,js}`],
  } as DataSourceOptions);

  try {
    await dataSource.initialize();
    logger.log(`Connected to ${describeDatabaseTarget(config.database.master)}. Running ${applicable.length} seed(s)...`);

    for (const seed of applicable) {
      const startedAt = Date.now();
      await dataSource.transaction(async (manager) => {
        await manager.query('SELECT pg_advisory_xact_lock($1)', [SEED_ADVISORY_LOCK_KEY]);
        await manager.query("SELECT set_config('app.bypass_rls', 'on', true)");
        await seed.run(manager);
      });
      logger.log(` - ${seed.name} (${Date.now() - startedAt}ms)`);
    }
    return 0;
  } catch (err: any) {
    logger.error(`Seeding failed: ${err.message}`, err.stack);
    return 1;
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

if (require.main === module) {
  runSeeds()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
