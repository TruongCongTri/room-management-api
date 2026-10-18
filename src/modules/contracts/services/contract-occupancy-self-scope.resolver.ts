/**
 * Resolver thật của OCCUPANCY_SELF_SCOPE (tài liệu 02, mục 2.0.2 / 5.5.5): hồ sơ của người dùng trong tòa nhà
 * (tenants.user_id) → dòng người ở ACTIVE → hợp đồng ACTIVE → phòng. Không có chuỗi đó → null (fail-closed).
 * Chạy trong phạm vi RLS của đúng tòa nhà được hỏi; kết quả được OccupancySelfScopeService cache và xóa khi chuyển đến /
 * chuyển đi / đổi người đứng tên.
 */
import { Injectable } from '@nestjs/common';
import { RlsService } from '../../../core/multitenancy/rls.service';
import { RequestContextService } from '../../../core/context/request-context.service';
import { OccupancySelfScope, OccupancySelfScopeResolver, SelfScopeOccupantRole } from '../../../core/access-control/occupancy-self-scope';
import { runInBuildingScope } from '../../properties/building-scope';

@Injectable()
export class ContractOccupancySelfScopeResolver implements OccupancySelfScopeResolver {
  constructor(
    private readonly rls: RlsService,
    private readonly context: RequestContextService,
  ) {}

  resolve(userId: string, buildingId: string): Promise<OccupancySelfScope | null> {
    return runInBuildingScope(this.context, buildingId, () =>
      this.rls.runInTenantContext(async (manager) => {
        const rows: Array<{ tenant_id: string; contract_id: string; room_id: string; room_number: string; role: SelfScopeOccupantRole }> = await manager.query(
          `SELECT t.id AS tenant_id, c.id AS contract_id, c.room_id, r.room_number, co.role
             FROM tenants t
             JOIN contract_occupants co ON co.tenant_id = t.id AND co.status = 'ACTIVE' AND co.deleted_at IS NULL
             JOIN contracts c ON c.id = co.contract_id AND c.status = 'ACTIVE' AND c.deleted_at IS NULL
             JOIN rooms r ON r.id = c.room_id
            WHERE t.building_id = $1 AND t.user_id = $2 AND t.deleted_at IS NULL
            LIMIT 1`,
          [buildingId, userId],
        );
        const row = rows[0];
        return row
          ? { tenantId: row.tenant_id, contractId: row.contract_id, roomId: row.room_id, roomNumber: row.room_number, occupantRole: row.role }
          : null;
      }),
    );
  }
}
