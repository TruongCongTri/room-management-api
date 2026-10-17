/**
 * Nạp & xác thực cấu hình bên ngoài NestJS DI (TypeORM CLI, migration runner, seeder).
 * Dùng đúng schema và thứ tự file .env như AppConfigModule để CLI không bao giờ lệch cấu hình với ứng dụng.
 */
import type { ConfigService } from '@nestjs/config';
import { AppConfigService } from './app-config.service';
import { EnvConfig, validateEnv } from './env.schema';
import { loadEnvFiles } from './env-loader';

export { loadEnvFiles } from './env-loader';

/**
 * ConfigService tối giản chỉ đọc cấu hình ĐÃ xác thực. Không dùng `new ConfigService(validated)`:
 * khi khởi tạo thủ công, ConfigService ưu tiên process.env THÔ trước giá trị đã xác thực
 * (vd: REDIS_ENABLED='false' là chuỗi truthy, DB_POOL_MAX là chuỗi thay vì số).
 */
export function configServiceFrom(validated: EnvConfig): ConfigService<EnvConfig, true> {
  return { get: (key: keyof EnvConfig) => validated[key] } as unknown as ConfigService<EnvConfig, true>;
}

export function loadAppConfig(): AppConfigService {
  loadEnvFiles();
  return new AppConfigService(configServiceFrom(validateEnv(process.env)));
}
