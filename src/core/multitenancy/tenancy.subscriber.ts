/**
 * TypeORM Subscriber tự động hóa ở tầng ứng dụng (lớp phòng thủ thứ nhất, RLS là lớp thứ hai):
 *  tự động gán buildingId (tòa nhà hiệu lực của request) cho các bản ghi mới
 *  và ngăn chặn ghi / sửa / xóa chéo dữ liệu giữa các tòa nhà.
 *
 * Subscriber tự đăng ký vào DataSource (autoLoadEntities không nạp subscriber,
 * và @EventSubscriber() sẽ khởi tạo class KHÔNG có dependency injection).
 */
import {
  DataSource,
  EntityMetadata,
  EntitySubscriberInterface,
  InsertEvent,
  UpdateEvent,
  RemoveEvent,
  SoftRemoveEvent,
} from 'typeorm';
import { Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { RequestContextService } from '../context/request-context.service';
import { BuildingScopedEntity } from './tenant-base.entity';

type BuildingScoped = { buildingId?: string | null };

@Injectable()
export class TenancySubscriber implements EntitySubscriberInterface {
  constructor(
    private readonly contextService: RequestContextService,
    dataSource?: DataSource,
  ) {
    if (dataSource && !dataSource.subscribers.includes(this)) {
      dataSource.subscribers.push(this);
    }
  }

  /**
   * Chỉ áp cho entity kế thừa BuildingScopedEntity (xác định theo class trong metadata của TypeORM, vì
   * repository.insert() truyền object thường). Bảng hạ tầng (audit_logs, outbox_events) có building_id
   * nullable cho sự kiện hệ thống nên KHÔNG thuộc phạm vi kiểm soát này.
   */
  private isBuildingScoped(entity: unknown, metadata?: EntityMetadata): entity is BuildingScoped {
    if (!entity || typeof entity !== 'object') return false;
    const target = metadata?.target;
    if (typeof target === 'function') {
      return target === BuildingScopedEntity || target.prototype instanceof BuildingScopedEntity;
    }
    return entity instanceof BuildingScopedEntity || 'buildingId' in entity;
  }

  /**
   * Request đặc quyền (SUPER_ADMIN / SYSTEM / worker nền) được phép thao tác chéo tòa nhà có kiểm soát
   */
  private canBypass(): boolean {
    return this.contextService.isBackgroundJob() || this.contextService.isPrivileged();
  }

  /**
   * Tự động inject building_id trước khi INSERT vào DB (chỉ dùng tòa nhà ĐÃ XÁC THỰC)
   */
  beforeInsert(event: InsertEvent<any>): void {
    const entity = event.entity;
    if (!this.isBuildingScoped(entity, event.metadata)) return;

    const activeBuildingId = this.contextService.getBuildingId();

    if (!entity.buildingId) {
      if (!activeBuildingId) {
        throw new UnauthorizedException(
          'Building context is required to create building-scoped entities.',
        );
      }
      entity.buildingId = activeBuildingId;
      return;
    }

    if (entity.buildingId !== activeBuildingId && !this.canBypass()) {
      // Ngăn chặn việc gửi body cố ý gán sang tòa nhà khác
      throw new ForbiddenException('Cross-building resource creation is prohibited.');
    }
  }

  /**
   * Bảo vệ trước khi UPDATE
   */
  beforeUpdate(event: UpdateEvent<any>): void {
    const entity = event.entity;
    if (!this.isBuildingScoped(entity, event.metadata)) return;

    const persistedBuildingId = (event.databaseEntity as BuildingScoped | undefined)?.buildingId;

    // Ngăn chặn đổi giá trị cột building_id (bỏ qua partial update không mang buildingId)
    if (
      persistedBuildingId &&
      entity.buildingId !== undefined &&
      entity.buildingId !== persistedBuildingId
    ) {
      throw new ForbiddenException(
        'Modifying building_id of an existing entity is strictly forbidden.',
      );
    }

    const activeBuildingId = this.contextService.getBuildingId();
    if (
      persistedBuildingId &&
      activeBuildingId &&
      persistedBuildingId !== activeBuildingId &&
      !this.canBypass()
    ) {
      throw new ForbiddenException('Cannot modify entities belonging to another building.');
    }
  }

  /**
   * Bảo vệ trước khi DELETE (cứng hoặc mềm)
   */
  beforeRemove(event: RemoveEvent<any>): void {
    this.assertSameBuildingOnDelete(event.databaseEntity ?? event.entity, event.metadata);
  }

  beforeSoftRemove(event: SoftRemoveEvent<any>): void {
    this.assertSameBuildingOnDelete(event.databaseEntity ?? event.entity, event.metadata);
  }

  private assertSameBuildingOnDelete(target: unknown, metadata?: EntityMetadata): void {
    if (!this.isBuildingScoped(target, metadata) || !target.buildingId) return;

    const activeBuildingId = this.contextService.getBuildingId();
    if (activeBuildingId && target.buildingId !== activeBuildingId && !this.canBypass()) {
      throw new ForbiddenException('Cannot delete entities belonging to another building.');
    }
  }
}
