/**
 * Cache đa tầng dùng chung kết nối Redis của RedisModule (REDIS_CLIENT): local Docker hoặc managed (TLS)
 * đều hoạt động như nhau; REDIS_ENABLED=false → chỉ dùng LRU trong RAM.
 */
import { Global, Module } from '@nestjs/common';
import { RedisCacheService } from './services/redis-cache.service';
import { CacheTagManager } from './services/cache-tag.manager';
import { HttpCacheInterceptor } from './interceptors/http-cache.interceptor';

@Global()
@Module({
  providers: [CacheTagManager, RedisCacheService, HttpCacheInterceptor],
  exports: [RedisCacheService, CacheTagManager, HttpCacheInterceptor],
})
export class CacheModule {}
