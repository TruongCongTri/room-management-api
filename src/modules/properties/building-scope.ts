/**
 * Chạy một khối lệnh trong phạm vi một tòa nhà CỤ THỂ (namespace cache `cache:{buildingId}:*`, RLS
 * `app.current_building_id`) mà vẫn giữ nguyên người dùng, traceId, IP của request hiện tại.
 *
 * Dùng khi tòa nhà đích KHÔNG phải tòa nhà hiệu lực của request:
 *  - website giới thiệu (request ẩn danh, tòa nhà suy ra từ slug);
 *  - chủ nhà cập nhật một tòa nhà khác tòa đang chọn (xóa cache công khai của đúng tòa đó).
 * Không đánh dấu request là tác vụ nền → không mở quyền vượt RLS / TenancySubscriber.
 */
import { RequestContextService } from '../../core/context/request-context.service';
import { RequestContextData } from '../../core/context/request-context.model';

export function runInBuildingScope<T>(context: RequestContextService, buildingId: string, fn: () => T): T {
  const current = context.getStore();
  const scoped: RequestContextData = {
    traceId: current?.traceId ?? `PUBLIC-${buildingId}`,
    clientIp: current?.clientIp ?? 'unknown',
    userAgent: current?.userAgent,
    locale: current?.locale,
    user: current?.user,
    startTime: current?.startTime ?? Date.now(),
    isBackgroundJob: false,
    tenantId: buildingId,
    tenantOverride: buildingId,
    metadata: new Map(current?.metadata ?? []),
  };
  return context.run(scoped, fn);
}
