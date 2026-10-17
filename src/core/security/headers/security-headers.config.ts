/**
 * Cấu hình tập trung cho Helmet và CORS Whitelist chuẩn Enterprise.
 */
import { HelmetOptions } from 'helmet';
import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

export const helmetSecurityConfig: HelmetOptions = {
  // Chống Clickjacking bằng X-Frame-Options: DENY
  frameguard: { action: 'deny' },

  // Chặn MIME-type sniffing (X-Content-Type-Options: nosniff)
  noSniff: true,

  // Ép buộc HTTPS với HTTP Strict Transport Security (HSTS) thời hạn 1 năm
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },

  // Ẩn thông tin công nghệ máy chủ
  hidePoweredBy: true,

  // Content Security Policy (CSP) chặt chẽ cho JSON API (không phục vụ HTML)
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      baseUri: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'none'"],
      objectSrc: ["'none'"],
    },
  },

  crossOriginResourcePolicy: { policy: 'same-site' },

  // Giới hạn truyền thông tin Referrer
  referrerPolicy: { policy: 'no-referrer' },
};

/**
 * CSP nới lỏng CHỈ cho trang Swagger UI (tài nguyên swagger-ui-dist do chính ứng dụng phục vụ);
 * các route API vẫn dùng CSP 'none' nghiêm ngặt ở trên.
 */
export const swaggerHelmetConfig: HelmetOptions = {
  ...helmetSecurityConfig,
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
    },
  },
};

type OriginMatcher = (origin: string) => boolean;

/**
 * Biên dịch một mục whitelist thành hàm so khớp. Hỗ trợ:
 *  - Origin chính xác:      https://app.rental.vn
 *  - Wildcard subdomain:    *.rental.vn  (chỉ https, mọi cấp subdomain, không gồm apex)
 *  - Regex tường minh:      /^https:\/\/[a-z0-9-]+\.rental\.vn$/
 */
export function compileOriginMatcher(entry: string): OriginMatcher {
  const value = entry.trim();

  if (value.length > 2 && value.startsWith('/') && value.endsWith('/')) {
    const regex = new RegExp(value.slice(1, -1));
    return (origin) => regex.test(origin);
  }

  if (value.startsWith('*.')) {
    const rootDomain = value.slice(2).toLowerCase();
    return (origin) => {
      try {
        const url = new URL(origin);
        return url.protocol === 'https:' && url.hostname.endsWith(`.${rootDomain}`);
      } catch {
        return false;
      }
    };
  }

  const normalized = value.replace(/\/+$/, '').toLowerCase();
  return (origin) => origin.toLowerCase() === normalized;
}

/**
 * Cấu hình CORS Whitelist kiểm soát nghiêm ngặt theo regex và origin nội bộ
 */
export function buildCorsConfig(allowedOrigins: string[]): CorsOptions {
  const allowAll = allowedOrigins.includes('*');
  const matchers = allowedOrigins.filter((o) => o !== '*').map(compileOriginMatcher);

  return {
    origin: (origin, callback) => {
      // Request server-to-server / cURL không gửi header Origin: CORS không áp dụng
      if (!origin) return callback(null, true);

      // Chỉ cho phép '*' ngoài production (env.schema chặn ở production)
      if (allowAll) return callback(null, true);

      // Origin không hợp lệ: không trả header CORS (browser tự chặn), tránh biến thành lỗi 500
      callback(null, matchers.some((match) => match(origin)));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Accept-Language',
      'Idempotency-Key',
      'X-Correlation-Id',
      'X-Request-Id',
      'X-Tenant-Id',
      // W3C Trace Context từ frontend có RUM / OpenTelemetry Web
      'traceparent',
      'tracestate',
      'baggage',
    ],
    exposedHeaders: [
      'X-Correlation-Id',
      'Content-Disposition',
      'Retry-After',
      'X-Cache-Lookup',
      // RFC 9745 / RFC 8594: client nhận biết lộ trình ngừng hỗ trợ API
      'Deprecation',
      'Sunset',
      'Link',
    ],
    credentials: true,
    maxAge: 86400, // Cache preflight response trong 24h
  };
}
