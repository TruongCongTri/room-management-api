/**
 * Thứ tự nạp file .env (file đứng trước thắng khi trùng biến; biến môi trường thật luôn thắng):
 *   .env.<NODE_ENV>.local → .env.local → .env.<NODE_ENV> → .env
 * Dùng chung cho AppConfigModule, TypeORM CLI, migration runner và OpenTelemetry bootstrap.
 */
const nodeEnv = process.env.NODE_ENV || 'development';

export const ENV_FILE_PATHS = [
  `.env.${nodeEnv}.local`,
  '.env.local',
  `.env.${nodeEnv}`,
  '.env',
];
