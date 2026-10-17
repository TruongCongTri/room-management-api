/**
 * Tạo test suite kiểm tra đầy đủ 4 năng lực cốt lõi theo tài liệu kiến trúc:
 *  Diff Calculation: Tính toán chính xác trường thay đổi và che dấu trường nhạy cảm ([REDACTED]).
 *  Immutable Ingestion: Ghi nhận bản ghi audit kèm đầy đủ traceId, actorId, diffSnapshot.
 *  Scoped Retrieval: Phân quyền tra cứu chính xác theo 3 cấp độ (GLOBAL, DEPARTMENT, OWN).
 *  Hot/Cold Tiering: Quét bản ghi cũ hơn 90 ngày và chuyển vùng lưu trữ
 * 
 * */ 

import { DataSource, Repository } from 'typeorm';
import { calculateEntityDiff } from './utils/diff-calculator.util';
import { AuditWriterService } from './services/audit-writer.service';
import { AuditViewerService } from './services/audit-viewer.service';
import { AuditTieringService } from './services/audit-tiering.service';
import { AuditAction } from './interfaces/audit.interface';
import { AuditLogEntity } from './entities/audit-log.entity';
import { RequestContextService } from '../../core/context/request-context.service';
import { CaslAbilityFactory } from '../../core/access-control/casl-ability.factory';
import { Action, Scope, PermissionEffect } from '../../core/access-control/access-control.types';
import { AuditEntitySubscriber } from './subscribers/audit-entity.subscriber';
import { Auditable } from './decorators/auditable.decorator';
import { EncryptionTransformer } from '../../core/security/encryption/encryption.transformer';

describe('AuditLogModule (Enterprise Audit Architecture)', () => {
  describe('Diff Calculation & Masking', () => {
    it('should calculate field differences and redact sensitive password values', () => {
      const oldObj = {
        contractCode: 'VN100',
        price: 1000,
        password: 'old_secret_pwd',
        updatedAt: new Date('2026-01-01'),
      };
      const newObj = {
        contractCode: 'VN100',
        price: 1500, // Đổi giá
        password: 'new_secret_pwd', // Đổi pass
        updatedAt: new Date('2026-01-02'), // Ignored
      };

      const diff = calculateEntityDiff(oldObj, newObj);

      expect(diff).toEqual({
        price: { from: 1000, to: 1500 },
        password: { from: '[REDACTED]', to: '[REDACTED]' },
      });
      expect(diff?.updatedAt).toBeUndefined();
    });
  });

  describe('AuditWriterService (Immutable Ingestion)', () => {
    let service: AuditWriterService;
    let mockDataSource: jest.Mocked<DataSource>;
    let mockRepo: jest.Mocked<Repository<AuditLogEntity>>;
    let contextService: RequestContextService;

    beforeEach(() => {
      contextService = new RequestContextService();
      jest.spyOn(contextService, 'getTraceId').mockReturnValue('TRACE-AUDIT-999');
      jest.spyOn(contextService, 'getClientIp').mockReturnValue('10.0.0.5');

      mockRepo = {
        create: jest.fn().mockImplementation((dto) => dto),
        save: jest.fn().mockResolvedValue({ id: 'audit_uuid_1' }),
      } as unknown as jest.Mocked<Repository<AuditLogEntity>>;

      mockDataSource = {
        getRepository: jest.fn().mockReturnValue(mockRepo),
      } as unknown as jest.Mocked<DataSource>;

      service = new AuditWriterService(mockDataSource, contextService);
    });

    it('should save immutable audit log with full actor context', async () => {
      jest.spyOn(contextService, 'getCurrentUser').mockReturnValue({
        id: 'usr_actor_42',
        email: 'manager@rental.vn',
        tenantId: 'building_hn',
        departmentId: 'dep_OPERATIONS',
        roles: ['PROPERTY_MANAGER'],
        rules: [],
      });

      await service.record({
        resource: 'contracts',
        resourceId: 'ct_777',
        action: AuditAction.UPDATE,
        diffSnapshot: { monthlyRoomRent: { from: '6000000', to: '6500000' } },
      });

      expect(mockRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          buildingId: 'building_hn',
          actorId: 'usr_actor_42',
          actorEmail: 'manager@rental.vn',
          departmentId: 'dep_OPERATIONS',
          resource: 'contracts',
          resourceId: 'ct_777',
          action: AuditAction.UPDATE,
          traceId: 'TRACE-AUDIT-999',
          clientIp: '10.0.0.5',
        }),
      );
    });
  });

  describe('AuditViewerService (Scoped Retrieval)', () => {
    let viewerService: AuditViewerService;
    let mockQueryBuilder: any;
    let mockDataSource: jest.Mocked<DataSource>;
    let contextService: RequestContextService;
    let abilityFactory: CaslAbilityFactory;

    beforeEach(() => {
      contextService = new RequestContextService();
      abilityFactory = new CaslAbilityFactory();

      mockQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[{ id: 'log_1' }], 1]),
      };

      mockDataSource = {
        getRepository: jest.fn().mockReturnValue({
          createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
        }),
      } as unknown as jest.Mocked<DataSource>;

      viewerService = new AuditViewerService(mockDataSource, contextService, abilityFactory);
    });

    it('should restrict query to OWN actorId for users with OWN scope only', async () => {
      jest.spyOn(contextService, 'getCurrentUser').mockReturnValue({
        id: 'usr_employee',
        email: 'emp@rental.vn',
        tenantId: 'tenant_vn',
        roles: ['STAFF'],
        rules: [
          {
            resource: 'audit',
            action: Action.READ,
            scope: Scope.OWN,
            effect: PermissionEffect.GRANT,
          },
        ],
      });

      await viewerService.queryLogs({});

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'log.actorId = :userId',
        { userId: 'usr_employee' },
      );
    });

    it('should restrict query to the assigned building for users with DEPARTMENT scope', async () => {
      jest.spyOn(contextService, 'getCurrentUser').mockReturnValue({
        id: 'usr_pm',
        email: 'pm@rental.vn',
        tenantId: 'building_hn',
        roles: ['PROPERTY_MANAGER'],
        rules: [
          {
            resource: 'audit',
            action: Action.READ,
            scope: Scope.DEPARTMENT,
            effect: PermissionEffect.GRANT,
          },
        ],
      });

      await viewerService.queryLogs({});

      expect(mockQueryBuilder.where).toHaveBeenCalledWith('log.buildingId = :buildingId', { buildingId: 'building_hn' });
      expect(mockQueryBuilder.andWhere).not.toHaveBeenCalledWith('log.actorId = :userId', expect.anything());
    });

    it('should let GLOBAL scope read every building assigned in the token, and nothing else', async () => {
      jest.spyOn(contextService, 'getCurrentUser').mockReturnValue({
        id: 'usr_landlord',
        email: 'landlord@rental.vn',
        tenantId: 'building_hn',
        buildingIds: ['building_hn', 'building_dn'],
        roles: ['LANDLORD'],
        rules: [{ resource: 'all', action: Action.MANAGE, scope: Scope.GLOBAL, effect: PermissionEffect.GRANT }],
      });

      await viewerService.queryLogs({});
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('log.buildingId IN (:...buildingIds)', {
        buildingIds: ['building_hn', 'building_dn'],
      });

      await expect(viewerService.queryLogs({ buildingId: 'building_other' })).rejects.toThrow(
        'The requested building is not assigned to your account.',
      );
    });
  });

  describe('AuditTieringService (Hot/Cold Archiving)', () => {
    const oldRows = [
      { id: '00000000-0000-4000-8000-000000000001', created_at: new Date('2025-01-01T00:00:00Z'), action: 'UPDATE' },
      { id: '00000000-0000-4000-8000-000000000002', created_at: new Date('2025-01-02T00:00:00Z'), action: 'DELETE' },
    ];

    const buildService = (manager: any, storage: any, storageEnabled = true) => {
      const dataSource = { transaction: jest.fn((fn: any) => fn(manager)) } as unknown as DataSource;
      const config: any = {
        audit: { hotRetentionDays: 90, tieringBatchSize: 1000 },
        storage: { enabled: storageEnabled },
      };
      return new AuditTieringService(dataSource, config, storage);
    };

    it('should never purge hot rows when object storage is disabled', async () => {
      const manager = { query: jest.fn() };
      const result = await buildService(manager, {}, false).executeTiering();

      expect(result.archivedCount).toBe(0);
      expect(manager.query).not.toHaveBeenCalled();
    });

    it('should upload a gzip NDJSON archive BEFORE deleting rows (WORM flag set locally)', async () => {
      const calls: string[] = [];
      const manager = {
        query: jest.fn(async (sql: string) => {
          calls.push(sql.trim().split(/\s+/).slice(0, 2).join(' '));
          return sql.startsWith('SELECT *') ? oldRows : [];
        }),
      };
      const storage = {
        putArchiveObject: jest.fn(async () => {
          calls.push('UPLOAD');
        }),
      };

      const result = await buildService(manager, storage).executeTiering();

      expect(result).toEqual({ archivedCount: 2, batches: 1 });
      expect(storage.putArchiveObject).toHaveBeenCalledWith(
        expect.stringMatching(/^audit-archive\/2025\/01\/01\/audit-logs-.+\.ndjson\.gz$/),
        expect.any(Buffer),
        expect.objectContaining({ contentEncoding: 'gzip' }),
      );
      expect(calls).toEqual(['SELECT *', 'UPLOAD', 'SELECT set_config($1,', 'DELETE FROM']);
      expect(manager.query).toHaveBeenCalledWith('SELECT set_config($1, $2, true)', ['app.audit_tiering', 'on']);
    });

    it('should not delete anything when the upload fails', async () => {
      const manager = { query: jest.fn(async (sql: string) => (sql.startsWith('SELECT *') ? oldRows : [])) };
      const storage = { putArchiveObject: jest.fn().mockRejectedValue(new Error('S3 unavailable')) };

      await expect(buildService(manager, storage).executeTiering()).rejects.toThrow('S3 unavailable');
      expect(manager.query).not.toHaveBeenCalledWith(expect.stringContaining('DELETE'), expect.anything());
    });
  });

  describe('AuditEntitySubscriber (@Auditable CDC)', () => {
    const writer = { recordInTransaction: jest.fn().mockResolvedValue(undefined) };
    const dataSource: any = { subscribers: [] };
    const subscriber = new AuditEntitySubscriber(dataSource, writer as any);

    @Auditable({ resource: 'contracts' })
    class Contract {}
    class OutboxRow {}

    const metadataFor = (target: any) =>
      ({
        target,
        tableName: 'contracts',
        primaryColumns: [{ getEntityValue: (e: any) => e.id }],
        columns: [
          { propertyName: 'passportNumber', transformer: new EncryptionTransformer({} as any) },
          { propertyName: 'price', transformer: undefined },
        ],
      }) as any;

    beforeEach(() => writer.recordInTransaction.mockClear());

    it('should register itself on the DataSource', () => {
      expect(dataSource.subscribers).toContain(subscriber);
    });

    it('should record UPDATE diffs in the same transaction and redact encrypted (FLE) columns', async () => {
      const manager = {};
      await subscriber.afterUpdate({
        metadata: metadataFor(Contract),
        manager,
        databaseEntity: { id: 'bk_1', price: 100, passportNumber: 'B1234567' },
        entity: { id: 'bk_1', price: 120, passportNumber: 'C7654321' },
      } as any);

      expect(writer.recordInTransaction).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          resource: 'contracts',
          resourceId: 'bk_1',
          action: AuditAction.UPDATE,
          diffSnapshot: {
            price: { from: 100, to: 120 },
            passportNumber: { from: '[REDACTED]', to: '[REDACTED]' },
          },
        }),
      );
    });

    it('should ignore entities without @Auditable()', async () => {
      await subscriber.afterInsert({ metadata: metadataFor(OutboxRow), manager: {}, entity: { id: 'x' } } as any);
      expect(writer.recordInTransaction).not.toHaveBeenCalled();
    });
  });
});
