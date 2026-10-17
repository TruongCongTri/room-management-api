/**
 * DataSource cho TypeORM CLI (migration:run / migration:revert / migration:generate).
 * Migration được chạy bởi Kubernetes Job/InitContainer trước khi rollout Pod API,
 * tránh race-condition & table lock khi nhiều Pod cùng boot.
 *
 *   npm run migration:run
 *   npm run migration:generate -- src/core/database/migrations/CreateRoomsTable
 *
 * Lưu ý Supabase: chạy migration qua kết nối direct (IPv6) hoặc session pooler :5432;
 * transaction pooler :6543 không giữ được trạng thái phiên mà migration cần.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadAppConfig } from '../config/load-config';
import { buildDataSourceOptions } from './database.options';

const appConfig = loadAppConfig();

export default new DataSource({
  ...buildDataSourceOptions(appConfig),
  entities: [`${__dirname}/../../**/*.entity.{ts,js}`],
});
