/**
 * Import TRƯỚC AppModule trong identity.e2e-spec.ts:
 *  - Nới giới hạn throttle theo IP (mọi request e2e đến từ 127.0.0.1) để kiểm thử KHÓA THEO SỐ ĐIỆN THOẠI;
 *    bản thân throttler đã được kiểm thử trong supporting-modules.e2e-spec.ts.
 *  - Bật AUTH_OTP_DEBUG_ECHO để đọc mã OTP từ response như khi kiểm thử bằng Postman.
 */
process.env.THROTTLE_LIMIT = '10000';
process.env.THROTTLE_SENSITIVE_LIMIT = '10000';
process.env.AUTH_OTP_DEBUG_ECHO = 'true';
