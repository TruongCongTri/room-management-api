/**
 * Cấu hình phân tách luồng:
 *  các câu truy vấn ghi (INSERT, UPDATE, DELETE) tự động trỏ về node Master,
 *  các câu truy vấn đọc (SELECT) được phân tải sang cụm Replica (nếu có cấu hình).
 * Tuyệt đối đặt synchronize: false trong doanh nghiệp.
 *
 * Cùng một module chạy được với:
 *  - PostgreSQL local (biến rời DB_MASTER_*, có thể ép IPv6 ::1 qua DB_IP_FAMILY=6)
 *  - Supabase online (DATABASE_URL, pooler IPv4 / direct IPv6, TLS bắt buộc)
 */
import {
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  OnModuleInit,
} from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AppConfigService } from '../config/app-config.service';
import { describeDatabaseTarget } from '../config/resolvers/database.resolver';
import { ShutdownRegistry } from '../shutdown/shutdown.registry';
import { ShutdownPhase } from '../shutdown/shutdown.interface';
import { TypeOrmLoggerService } from './typeorm-logger.service';
import { buildDataSourceOptions } from './database.options';
import { diagnoseDatabaseNetwork } from './database.network';

/**
 * Tự đăng ký việc đóng pool vào Pha 5 (sau Redis) thay vì hardcode trong GracefulShutdownService,
 * đồng thời kiểm tra role kết nối có làm vô hiệu hóa Row-Level Security hay không.
 */
@Injectable()
export class DatabaseLifecycle implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger('Database');

  constructor(
    private readonly dataSource: DataSource,
    private readonly shutdownRegistry: ShutdownRegistry,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    this.shutdownRegistry.register(
      'TypeOrmConnectionPool',
      ShutdownPhase.RELEASE_POOLS,
      async () => {
        if (this.dataSource.isInitialized) {
          await this.dataSource.destroy();
        }
      },
      100, // Đóng sau cùng
    );
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.dataSource.isInitialized) return;

    const db = this.config.database;
    this.logger.log(
      `PostgreSQL connected: ${describeDatabaseTarget(db.master)} ` +
        `(provider=${db.provider}, ssl=${db.sslMode}, ipFamily=${db.ipFamily || 'auto'}, ` +
        `poolMode=${db.poolMode}, replica=${db.replica ? describeDatabaseTarget(db.replica) : 'none'})`,
    );

    await this.checkRowLevelSecurityRole();
  }

  /**
   * Superuser và role có BYPASSRLS bỏ qua mọi policy RLS (kể cả FORCE ROW LEVEL SECURITY):
   * khi đó cách ly tenant chỉ còn dựa vào tầng ORM. Production nên dùng role riêng NOSUPERUSER NOBYPASSRLS.
   */
  private async checkRowLevelSecurityRole(): Promise<void> {
    const mode = this.config.database.rlsRoleCheck;
    if (mode === 'off') return;

    try {
      const [row] = await this.dataSource.query(
        'SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      );
      if (!row || (!row.rolsuper && !row.rolbypassrls)) return;

      const message =
        `Connected as role '${row.role}' which bypasses Row-Level Security ` +
        `(superuser=${row.rolsuper}, bypassrls=${row.rolbypassrls}); tenant isolation falls back to the ORM layer only. ` +
        `Use a dedicated role: CREATE ROLE app_user LOGIN PASSWORD '...' NOSUPERUSER NOBYPASSRLS; ` +
        `then GRANT the required privileges (set DB_RLS_ROLE_CHECK=off to silence).`;

      if (mode === 'error') throw new Error(message);
      this.logger.warn(message);
    } catch (err: any) {
      if (mode === 'error') throw err;
      this.logger.warn(`RLS role check skipped: ${err.message}`);
    }
  }
}

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      extraProviders: [TypeOrmLoggerService],
      inject: [AppConfigService, TypeOrmLoggerService],
      useFactory: async (config: AppConfigService, typeOrmLogger: TypeOrmLoggerService) => {
        const db = config.database;
        await diagnoseDatabaseNetwork(db, new Logger('Database'));

        return {
          ...buildDataSourceOptions(config, typeOrmLogger),
          autoLoadEntities: true,
          migrationsRun: db.migrationsRun,
          retryAttempts: db.retryAttempts,
          retryDelay: db.retryDelayMs,
        };
      },
    }),
  ],
  providers: [TypeOrmLoggerService, DatabaseLifecycle],
  exports: [TypeOrmModule, TypeOrmLoggerService],
})
export class DatabaseModule {}
