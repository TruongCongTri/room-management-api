import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './env.schema';
import { AppConfigService } from './app-config.service';
import { ENV_FILE_PATHS } from './env-files';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      // Biến môi trường thật (K8s ConfigMap/Secret) luôn ưu tiên hơn file .env
      envFilePath: ENV_FILE_PATHS,
      // ConfigService chỉ đọc cấu hình ĐÃ xác thực, không rơi về process.env thô
      skipProcessEnv: true,
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService, ConfigModule],
})
export class AppConfigModule {}
