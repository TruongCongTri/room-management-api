/**
 * Danh mục khóa nhạy cảm cần che giấu theo Luật BVDLCN 91/2025/QH15, NĐ 13/2023/NĐ-CP và PCI-DSS.
 * Pino redact không hỗ trợ đệ quy, nên mỗi khóa được che ở gốc, độ sâu 1 và độ sâu 2.
 */
export const SENSITIVE_KEYS = [
  // Authentication & Secrets
  'password',
  'newPassword',
  'oldPassword',
  'confirmPassword',
  'secret',
  'clientSecret',
  'apiKey',
  'accessToken',
  'refreshToken',
  'token',
  'otp',
  'authorization',

  // PCI-DSS: Payment & Banking
  'creditCardNumber',
  'cardNumber',
  'pan',
  'cvv',
  'cvc',
  'pin',
  'bankAccount',
  'bankAccountNumber',
  'refundBankAccount',

  // PII khách thuê: CCCD / Hộ chiếu (bản rõ, bản mã AES và blind index đều không được ra log)
  'idCardNumber',
  'idCardEncrypted',
  'idCardHash',
  'citizenId',
  'passportNumber',
  'passportEncrypted',
  'identityCardNumber',
  'taxCode',
  'dateOfBirth',
] as const;

const HTTP_REDACTION_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["refresh-token"]',
  'res.headers["set-cookie"]',
  // Query string có thể mang token (link reset password, magic link)
  'req.query.token',
  'req.query.accessToken',
  'req.query.refreshToken',
  'req.query.apiKey',
];

export const SENSITIVE_REDACTION_PATHS: string[] = [
  ...HTTP_REDACTION_PATHS,
  ...SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
];

export const REDACTION_CENSOR = '[REDACTED]';

/** Endpoint hạ tầng không cần ghi access log (giảm nhiễu & chi phí lưu trữ) */
export const AUTO_LOGGING_IGNORED_PATHS = [/^\/health/, /^\/metrics/];
