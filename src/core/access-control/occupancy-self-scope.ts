/**
 * "Phòng của tôi" - phạm vi OWN của khách thuê (tài liệu 02, mục 2.0.2):
 * khách thuê chỉ xem được phòng mình ĐANG ở. Phạm vi này được SUY RA từ việc ở thực tế
 * (contract_occupants ACTIVE của hợp đồng ACTIVE), không bao giờ lưu trên tài khoản.
 *
 * ContractsModule (module 3) cung cấp resolver thật:
 *   { provide: OCCUPANCY_SELF_SCOPE, useClass: ContractOccupancySelfScopeResolver }
 * Chưa có resolver → luôn trả null (fail-closed: khách thuê không xem được phòng nào).
 *
 * Kết quả được cache `auth:self-scope:{buildingId}:{userId}` (300 s) và bị xóa khi người ở chuyển đến /
 * chuyển đi / đổi người đứng tên / trả phòng (evict) → chuyển đi là mất quyền ngay.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';

export type SelfScopeOccupantRole = 'PRIMARY_HOLDER' | 'CO_OCCUPANT';

export interface OccupancySelfScope {
  tenantId: string;
  contractId: string;
  roomId: string;
  roomNumber?: string;
  occupantRole: SelfScopeOccupantRole;
}

export interface OccupancySelfScopeResolver {
  /** Phòng người dùng đang ở trong tòa nhà, hoặc null (chưa từng ở / đã chuyển đi / không có hồ sơ khách thuê) */
  resolve(userId: string, buildingId: string): Promise<OccupancySelfScope | null>;
}

export const OCCUPANCY_SELF_SCOPE = Symbol('OCCUPANCY_SELF_SCOPE');

export const SELF_SCOPE_CACHE_TTL_SEC = 300;
const NONE = 'none';

@Injectable()
export class OccupancySelfScopeService {
  private readonly logger = new Logger(OccupancySelfScopeService.name);
  private resolver?: OccupancySelfScopeResolver | null;

  constructor(
    private readonly moduleRef: ModuleRef,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis | null,
  ) {}

  async resolve(userId: string, buildingId: string | undefined): Promise<OccupancySelfScope | null> {
    if (!buildingId) return null;
    const resolver = this.getResolver();
    if (!resolver) return null;

    const key = this.key(buildingId, userId);
    const cached = await this.readCache(key);
    if (cached !== undefined) return cached;

    const scope = await resolver.resolve(userId, buildingId);
    await this.redis?.set(key, scope ? JSON.stringify(scope) : NONE, 'EX', SELF_SCOPE_CACHE_TTL_SEC).catch((err) => {
      this.logger.warn(`Self-scope cache write failed: ${err.message}`);
    });
    return scope;
  }

  /** Gọi khi người ở chuyển đến / chuyển đi / đổi người đứng tên / trả phòng */
  async evict(userId: string, buildingId: string): Promise<void> {
    await this.redis?.del(this.key(buildingId, userId));
  }

  private async readCache(key: string): Promise<OccupancySelfScope | null | undefined> {
    if (!this.redis) return undefined;
    try {
      const raw = await this.redis.get(key);
      if (raw === null) return undefined;
      return raw === NONE ? null : (JSON.parse(raw) as OccupancySelfScope);
    } catch (err: any) {
      this.logger.warn(`Self-scope cache read failed: ${err.message}`);
      return undefined;
    }
  }

  private getResolver(): OccupancySelfScopeResolver | null {
    if (this.resolver !== undefined) return this.resolver;
    try {
      this.resolver = this.moduleRef.get<OccupancySelfScopeResolver>(OCCUPANCY_SELF_SCOPE, { strict: false });
    } catch {
      this.resolver = null;
    }
    return this.resolver;
  }

  private key(buildingId: string, userId: string): string {
    return `auth:self-scope:${buildingId}:${userId}`;
  }
}
