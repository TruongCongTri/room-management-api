/**
 * Thông báo SAU COMMIT cho người ở (outbox → AppEventPublisher, tài liệu 01 mục Notification):
 *  - `occupant.moved_in`: người lớn vừa được tạo tài khoản khách thuê lúc chuyển đến (PENDING_ACTIVATION) nhận SMS
 *    ACCOUNT_INVITATION → tự kích hoạt bằng OTP (POST /auth/otp/request + /auth/activate).
 *  - `contract.primary_holder_changed`: người đứng tên mới, người cũ và người đang ở nhận PRIMARY_HOLDER_CHANGED.
 * Đọc dữ liệu trong phạm vi RLS của đúng tòa nhà của sự kiện; gửi lỗi chỉ ghi log (không ảnh hưởng nghiệp vụ đã commit).
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RlsService } from '../../../core/multitenancy/rls.service';
import { RequestContextService } from '../../../core/context/request-context.service';
import { DOMAIN_EVENTS } from '../../../infrastructure/events/constants/event.constants';
import { OutboxDomainEvent } from '../../../infrastructure/outbox/relays/outbox-relays';
import { NotificationDispatcherService } from '../../../infrastructure/notification/services/notification-dispatcher.service';
import { NotificationChannel } from '../../../infrastructure/notification/interfaces/notification.interface';
import { NOTIFICATION_TEMPLATES } from '../../../infrastructure/notification/templates/template-renderer.service';
import { runInBuildingScope } from '../../properties/building-scope';

interface Recipient {
  phone: string;
  name: string;
}

@Injectable()
export class ContractNotificationsListener {
  private readonly logger = new Logger(ContractNotificationsListener.name);

  constructor(
    private readonly rls: RlsService,
    private readonly context: RequestContextService,
    private readonly notifications: NotificationDispatcherService,
  ) {}

  @OnEvent(DOMAIN_EVENTS.OCCUPANT.MOVED_IN)
  async onMovedIn(event: OutboxDomainEvent): Promise<void> {
    const buildingId = event.metadata.tenantId;
    const { tenantId } = event.payload.data as { tenantId: string };
    if (!buildingId || !tenantId) return;
    const rows = await this.read(buildingId, (q) =>
      q(
        `SELECT u.phone_e164 AS phone, u.full_name AS name FROM tenants t JOIN users u ON u.id = t.user_id
          WHERE t.id = $1 AND t.building_id = $2 AND u.status = 'PENDING_ACTIVATION' AND u.deleted_at IS NULL`,
        [tenantId, buildingId],
      ),
    );
    for (const r of rows) {
      await this.send(buildingId, r, NOTIFICATION_TEMPLATES.ACCOUNT_INVITATION, { user: { name: r.name, roleLabel: 'khách thuê' } });
    }
  }

  @OnEvent(DOMAIN_EVENTS.CONTRACT.PRIMARY_HOLDER_CHANGED)
  async onHolderChanged(event: OutboxDomainEvent): Promise<void> {
    const buildingId = event.metadata.tenantId;
    const { transferId } = event.payload.data as { transferId: string };
    if (!buildingId || !transferId) return;
    const [info] = await this.read(buildingId, (q) =>
      q(
        `SELECT to_char(h.effective_date, 'DD/MM/YYYY') AS "effectiveDate", h.contract_id AS "contractId", c.contract_code AS "code",
                r.room_number AS "roomNumber", f.full_name AS "fromName", n.full_name AS "toName", f.phone AS "fromPhone"
           FROM contract_holder_transfers h
           JOIN contracts c ON c.id = h.contract_id
           JOIN rooms r ON r.id = c.room_id
           JOIN tenants f ON f.id = h.from_tenant_id
           JOIN tenants n ON n.id = h.to_tenant_id
          WHERE h.id = $1 AND h.building_id = $2`,
        [transferId, buildingId],
      ),
    );
    if (!info) return;
    const occupants: Recipient[] = await this.read(buildingId, (q) =>
      q(
        `SELECT t.phone, t.full_name AS name FROM contract_occupants co JOIN tenants t ON t.id = co.tenant_id
          WHERE co.contract_id = $1 AND co.status = 'ACTIVE' AND co.deleted_at IS NULL AND t.phone IS NOT NULL`,
        [info.contractId],
      ),
    );
    const recipients = [...occupants, ...(info.fromPhone ? [{ phone: info.fromPhone, name: info.fromName }] : [])];
    const unique = [...new Map(recipients.map((r) => [r.phone, r])).values()];
    for (const r of unique) {
      await this.send(buildingId, r, NOTIFICATION_TEMPLATES.PRIMARY_HOLDER_CHANGED, {
        room: { number: info.roomNumber },
        contract: { code: info.code },
        transfer: { effectiveDate: info.effectiveDate, newHolderName: info.toName, previousHolderName: info.fromName, addendumUrl: '' },
      });
    }
  }

  private read(buildingId: string, fn: (q: (sql: string, params: unknown[]) => Promise<any[]>) => Promise<any[]>): Promise<any[]> {
    return runInBuildingScope(this.context, buildingId, () => this.rls.runInTenantContext((manager) => fn((sql, params) => manager.query(sql, params))));
  }

  private async send(buildingId: string, to: Recipient, templateName: string, context: Record<string, unknown>): Promise<void> {
    try {
      await runInBuildingScope(this.context, buildingId, () =>
        this.notifications.dispatch({ channels: [NotificationChannel.SMS], recipient: { phone: to.phone, name: to.name }, payload: { templateName, context } }),
      );
    } catch (err: any) {
      this.logger.warn(`${templateName} could not be sent: ${err.message}`);
    }
  }
}
