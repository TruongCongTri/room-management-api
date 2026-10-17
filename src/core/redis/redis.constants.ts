/** Injection token cho ioredis client dùng chung (giá trị null khi REDIS_ENABLED=false) */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
