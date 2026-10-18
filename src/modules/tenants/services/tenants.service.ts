/**
 * Hồ sơ người ở (tài liệu 02, mục 2.1 / 2.1b / 2.2):
 *  - Mỗi người một hồ sơ, số giấy tờ mã hóa + blind index; trùng → 409 kèm id hồ sơ có sẵn (dùng lại khi đổi phòng).
 *  - Quy tắc hồ sơ (domain) chạy trên hồ sơ HOÀN CHỈNH khi tạo và khi sửa.
 *  - Không bao giờ trả số đầy đủ; cột mã hóa chỉ được nạp trong lúc sửa hồ sơ để kiểm tra lại (không trả ra ngoài).
 *  - Mọi truy vấn trong transaction RLS của tòa nhà hiệu lực + lọc building_id tường minh.
 */
import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { RlsService } from '../../../core/multitenancy/rls.service';
import { RequestContextService } from '../../../core/context/request-context.service';
import { RequestUserContext } from '../../../core/context/request-context.model';
import { EncryptionService } from '../../../core/security/encryption/encryption.service';
import { SystemErrorCode } from '../../../common/constants/error-codes.constant';
import { AuditWriterService } from '../../../infrastructure/audit/services/audit-writer.service';
import { AuditAction } from '../../../infrastructure/audit/interfaces/audit.interface';
import { IdDocumentType, residenceChannelFor } from '../../contracts/domain/occupancy.enums';
import { InvalidPhoneNumberError, normalizePhoneNumber } from '../../identity/domain/phone-number';
import { isUniqueViolation, staleVersion, vietnamToday } from '../../properties/properties.helpers';
import { Tenant } from '../entities/tenant.entity';
import { CreateTenantDto, ListTenantsQueryDto, UpdateTenantDto } from '../dto/tenants.dto';
import {
  checkTenantProfile,
  guardianRequirement,
  isMinorOn,
  maskBankAccount,
  maskIdNumber,
  normalizeIdNumber,
  ProfileIssue,
  TenantProfileInput,
  toSearchName,
} from '../domain/tenant-profile.rules';

export const CONSENT_VERSION = 'v2026.1';
const HASH_INDEX = 'idx_tenants_bld_id_hash_unique';

export interface TenantSafeView {
  id: string;
  fullName: string;
  idDocumentType: IdDocumentType;
  idCardMasked: string;
  isMinor: boolean;
  phone: string | null;
  createdAt: Date;
}

export interface TenantDetailView extends TenantSafeView {
  nationality: string;
  gender: string;
  dateOfBirth: string;
  email: string | null;
  idCardIssueDate: string | null;
  idCardIssuePlace: string | null;
  hometownAddress: string;
  permanentAddress: string;
  refundBankName: string | null;
  refundBankAccountMasked: string | null;
  pdplConsentAcceptedAt: Date;
  pdplConsentVersion: string;
  guardian: { id: string; fullName: string } | null;
  hasLogin: boolean;
  /** Nơi người này ĐANG ở (module 3), null = không ở phòng nào của tòa nhà */
  currentOccupancy: CurrentOccupancy | null;
  version: number;
}

export interface CurrentOccupancy {
  occupantId: string;
  contractId: string;
  contractCode: string;
  roomId: string;
  roomNumber: string;
  role: 'PRIMARY_HOLDER' | 'CO_OCCUPANT';
  movedInAt: string;
  residencyStatus: string;
}

@Injectable()
export class TenantsService {
  constructor(
    private readonly rls: RlsService,
    private readonly context: RequestContextService,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditWriterService,
  ) {}

  async create(dto: CreateTenantDto): Promise<TenantDetailView> {
    const today = vietnamToday();
    const idNumber = normalizeIdNumber(dto.idCardNumber);
    const profile: TenantProfileInput = {
      idDocumentType: dto.idDocumentType,
      idCardNumber: idNumber,
      nationality: dto.nationality ?? 'VN',
      gender: dto.gender,
      dateOfBirth: dto.dateOfBirth,
      idCardIssueDate: dto.idCardIssueDate ?? null,
      phone: this.normalizePhone(dto.phone),
      refundBankAccount: dto.refundBankAccount ?? null,
      refundBankName: dto.refundBankName ?? null,
      consentGuardianTenantId: dto.consentGuardianTenantId ?? null,
    };
    this.assertProfile(profile, today);
    if (!dto.pdplConsentAccepted) {
      throw new UnprocessableEntityException({
        errorCode: SystemErrorCode.BIZ_PDPL_CONSENT_REQUIRED,
        message: 'Consent to personal data processing is required (Law 91/2025/QH15).',
        details: [{ field: 'pdplConsentAccepted', issue: 'REQUIRED' }],
      });
    }
    this.assertGuardianRequirement(profile, today);
    const idCardHash = this.encryption.computeBlindIndex(idNumber);

    try {
      return await this.rls.runInTenantContext(async (manager) => {
        if (profile.consentGuardianTenantId) await this.assertValidGuardian(manager, profile.consentGuardianTenantId, today);
        await this.assertNotDuplicate(manager, idCardHash);
        const repo = manager.getRepository(Tenant);
        const saved = await repo.save(
          repo.create({
            fullName: dto.fullName,
            fullNameSearch: toSearchName(dto.fullName),
            idDocumentType: dto.idDocumentType,
            idCardEncrypted: idNumber,
            idCardHash,
            idCardLast4: idNumber.slice(-4),
            idCardIssueDate: profile.idCardIssueDate,
            idCardIssuePlace: dto.idCardIssuePlace ?? null,
            nationality: profile.nationality,
            gender: dto.gender,
            dateOfBirth: dto.dateOfBirth,
            phone: profile.phone,
            email: dto.email ?? null,
            hometownAddress: dto.hometownAddress,
            permanentAddress: dto.permanentAddress,
            refundBankAccountEncrypted: profile.refundBankAccount,
            refundBankAccountLast4: profile.refundBankAccount ? profile.refundBankAccount.slice(-4) : null,
            refundBankName: profile.refundBankName,
            pdplConsentAcceptedAt: new Date(),
            pdplConsentVersion: CONSENT_VERSION,
            consentGuardianTenantId: profile.consentGuardianTenantId,
          }),
        );
        return this.loadDetail(manager, saved.id);
      });
    } catch (err) {
      // Hai người đăng ký cùng số giấy tờ đồng thời → chỉ unique index chặn được
      if (isUniqueViolation(err, HASH_INDEX)) {
        const existingId = await this.rls.runInTenantContext((m) => this.findIdByHash(m, idCardHash));
        throw this.duplicate(existingId);
      }
      throw err;
    }
  }

  list(query: ListTenantsQueryDto) {
    return this.rls.runInTenantContext(async (manager) => {
      const qb = manager.getRepository(Tenant).createQueryBuilder('t').where('t.building_id = :b', { b: this.buildingId() });
      if (query.q) {
        const phone = this.tryPhone(query.q);
        if (phone) qb.andWhere('t.phone = :phone', { phone });
        else qb.andWhere(`t.full_name_search LIKE :name ESCAPE '\\'`, { name: `%${this.escapeLike(toSearchName(query.q))}%` });
      }
      if (query.minor !== undefined) {
        // Ngưỡng 18 tuổi theo giờ Việt Nam: sinh SAU ngày này là trẻ em
        qb.andWhere(query.minor ? 't.date_of_birth > :cutoff' : 't.date_of_birth <= :cutoff', { cutoff: this.adultCutoff() });
      }
      const [rows, total] = await qb
        .orderBy('t.full_name_search', 'ASC')
        .addOrderBy('t.id', 'ASC')
        .skip((query.page - 1) * query.limit)
        .take(query.limit)
        .getManyAndCount();
      const today = vietnamToday();
      return { items: rows.map((t) => this.safeView(t, today)), total, page: query.page, limit: query.limit };
    });
  }

  /** Tra cứu chính xác theo số giấy tờ qua blind index; mỗi lần tra cứu đều được ghi audit (số đã che) */
  async lookup(rawIdNumber: string): Promise<TenantSafeView> {
    const idNumber = normalizeIdNumber(rawIdNumber);
    if (idNumber.length < 6) {
      throw new BadRequestException({
        errorCode: SystemErrorCode.REQ_VALIDATION_ERROR,
        message: 'Validation failed for the submitted payload.',
        details: [{ field: 'idCardNumber', message: 'Too short to be an ID document number' }],
      });
    }
    const idCardHash = this.encryption.computeBlindIndex(idNumber);
    const tenant = await this.rls.runInTenantContext((manager) =>
      manager.getRepository(Tenant).findOne({ where: { buildingId: this.buildingId(), idCardHash } }),
    );
    await this.audit.record({
      resource: 'tenants',
      resourceId: tenant?.id ?? '-',
      action: AuditAction.EXECUTE,
      metadata: { event: 'TENANT_LOOKUP', found: !!tenant, idCardMasked: maskIdNumber(idNumber.slice(-4)) },
    });
    if (!tenant) throw new NotFoundException({ errorCode: SystemErrorCode.RES_NOT_FOUND, message: 'No person with this ID document in this building.' });
    return this.safeView(tenant, vietnamToday());
  }

  getById(id: string): Promise<TenantDetailView> {
    return this.rls.runInTenantContext((manager) => this.loadDetail(manager, id));
  }

  /** Hồ sơ của chính khách thuê đang đăng nhập (liên kết tenants.user_id tạo lúc chuyển đến - module 3) */
  async getMine(user: RequestUserContext): Promise<TenantDetailView> {
    return this.rls.runInTenantContext(async (manager) => {
      const own = await manager.getRepository(Tenant).findOne({ where: { buildingId: this.buildingId(), userId: user.id }, select: { id: true } });
      if (!own) throw new NotFoundException({ errorCode: SystemErrorCode.RES_NOT_FOUND, message: 'No profile is linked to your account in this building.' });
      return this.loadDetail(manager, own.id);
    });
  }

  async update(id: string, dto: UpdateTenantDto): Promise<TenantDetailView> {
    const { version, ...changes } = dto;
    if (Object.values(changes).every((v) => v === undefined)) {
      throw new BadRequestException({
        errorCode: SystemErrorCode.REQ_VALIDATION_ERROR,
        message: 'Nothing to update.',
        details: [{ field: 'body', message: 'Provide at least one field to change' }],
      });
    }
    const today = vietnamToday();
    try {
      return await this.rls.runInTenantContext(async (manager) => {
        const repo = manager.getRepository(Tenant);
        // Số giấy tờ hiện tại được nạp (giải mã) CHỈ để kiểm tra lại hồ sơ sau khi sửa - không bao giờ trả ra ngoài
        const tenant = await repo
          .createQueryBuilder('t')
          .addSelect(['t.idCardEncrypted', 't.refundBankAccountEncrypted'])
          .where('t.id = :id AND t.building_id = :b', { id, b: this.buildingId() })
          .setLock('pessimistic_write')
          .getOne();
        if (!tenant) throw this.notFound();
        if (version !== undefined && version !== tenant.version) throw staleVersion();

        const idNumber = dto.idCardNumber !== undefined ? normalizeIdNumber(dto.idCardNumber) : tenant.idCardEncrypted;
        const refundBankAccount = dto.refundBankAccount !== undefined ? dto.refundBankAccount : (tenant.refundBankAccountEncrypted ?? null);
        const merged: TenantProfileInput = {
          idDocumentType: dto.idDocumentType ?? tenant.idDocumentType,
          idCardNumber: idNumber,
          nationality: dto.nationality ?? tenant.nationality,
          gender: dto.gender ?? tenant.gender,
          dateOfBirth: dto.dateOfBirth ?? tenant.dateOfBirth,
          idCardIssueDate: dto.idCardIssueDate !== undefined ? dto.idCardIssueDate : (tenant.idCardIssueDate ?? null),
          phone: dto.phone !== undefined ? this.normalizePhone(dto.phone) : (tenant.phone ?? null),
          refundBankAccount,
          refundBankName: refundBankAccount === null ? null : dto.refundBankName !== undefined ? dto.refundBankName : (tenant.refundBankName ?? null),
          consentGuardianTenantId: dto.consentGuardianTenantId !== undefined ? dto.consentGuardianTenantId : (tenant.consentGuardianTenantId ?? null),
        };
        this.assertProfile(merged, today);
        // Nguyên nhân gốc trước: người đang giám hộ trẻ khác không thể thành trẻ em (rồi mới tới "trẻ em cần người giám hộ")
        if (isMinorOn(merged.dateOfBirth, today) && (await repo.exists({ where: { buildingId: tenant.buildingId, consentGuardianTenantId: tenant.id } }))) {
          throw this.invalidGuardian('This person is the guardian of a child and cannot become a minor');
        }
        if (merged.consentGuardianTenantId === tenant.id) throw this.invalidGuardian('A person cannot be their own guardian');
        const occupancy = await this.activeOccupancy(manager, tenant);
        if (occupancy?.role === 'PRIMARY_HOLDER' && isMinorOn(merged.dateOfBirth, today)) {
          throw new UnprocessableEntityException({
            errorCode: SystemErrorCode.BIZ_PRIMARY_HOLDER_NOT_ELIGIBLE,
            message: 'This person holds an active contract and must be an adult; transfer the contract first.',
            details: [{ field: 'dateOfBirth', issue: 'UNDERAGE' }],
          });
        }
        this.assertGuardianRequirement(merged, today);
        if (merged.consentGuardianTenantId) await this.assertValidGuardian(manager, merged.consentGuardianTenantId, today);
        // Sửa quốc tịch → kênh khai báo tạm trú của lần ở hiện tại (CT01 / người nước ngoài)
        const channel = residenceChannelFor(merged);
        if (occupancy && channel !== residenceChannelFor(tenant)) {
          await manager.query(`UPDATE contract_occupants SET residence_channel = $2, updated_at = now() WHERE id = $1`, [occupancy.id, channel]);
        }

        if (idNumber !== tenant.idCardEncrypted || merged.idDocumentType !== tenant.idDocumentType) {
          const idCardHash = this.encryption.computeBlindIndex(idNumber);
          await this.assertNotDuplicate(manager, idCardHash, tenant.id);
          tenant.idCardEncrypted = idNumber;
          tenant.idCardHash = idCardHash;
          tenant.idCardLast4 = idNumber.slice(-4);
        }
        if (dto.fullName !== undefined) {
          tenant.fullName = dto.fullName;
          tenant.fullNameSearch = toSearchName(dto.fullName);
        }
        tenant.idDocumentType = merged.idDocumentType;
        tenant.nationality = merged.nationality;
        tenant.gender = merged.gender;
        tenant.dateOfBirth = merged.dateOfBirth;
        tenant.idCardIssueDate = merged.idCardIssueDate ?? null;
        if (dto.idCardIssuePlace !== undefined) tenant.idCardIssuePlace = dto.idCardIssuePlace;
        tenant.phone = merged.phone ?? null;
        if (dto.email !== undefined) tenant.email = dto.email;
        if (dto.hometownAddress !== undefined) tenant.hometownAddress = dto.hometownAddress;
        if (dto.permanentAddress !== undefined) tenant.permanentAddress = dto.permanentAddress;
        tenant.refundBankAccountEncrypted = merged.refundBankAccount ?? null;
        tenant.refundBankAccountLast4 = merged.refundBankAccount ? merged.refundBankAccount.slice(-4) : null;
        tenant.refundBankName = merged.refundBankName ?? null;
        tenant.consentGuardianTenantId = merged.consentGuardianTenantId ?? null;
        await repo.save(tenant);
        return this.loadDetail(manager, tenant.id);
      });
    } catch (err) {
      if (isUniqueViolation(err, HASH_INDEX)) throw this.duplicate(undefined);
      throw err;
    }
  }

  // ---------------------------------------------------------------------------

  private assertProfile(profile: TenantProfileInput, today: string): void {
    const issues: ProfileIssue[] = checkTenantProfile(profile, today);
    if (issues.length) {
      throw new BadRequestException({ errorCode: SystemErrorCode.REQ_VALIDATION_ERROR, message: 'Validation failed for the submitted payload.', details: issues });
    }
  }

  private assertGuardianRequirement(profile: TenantProfileInput, today: string): void {
    const requirement = guardianRequirement(profile, today);
    if (requirement === 'REQUIRED') {
      throw new UnprocessableEntityException({
        errorCode: SystemErrorCode.BIZ_PDPL_CONSENT_REQUIRED,
        message: 'A parent or guardian must give consent for a child.',
        details: [{ field: 'consentGuardianTenantId', issue: 'REQUIRED_FOR_MINOR' }],
      });
    }
    if (requirement === 'FORBIDDEN') throw this.invalidGuardian('Only a minor has a consent guardian');
  }

  /** Lần ở hiện tại của người này (module 3): người đứng tên phải là người thành niên, kênh cư trú theo quốc tịch */
  private async activeOccupancy(manager: EntityManager, tenant: Tenant): Promise<{ id: string; role: string } | undefined> {
    const [occupancy]: Array<{ id: string; role: string }> = await manager.query(
      `SELECT id, role FROM contract_occupants WHERE tenant_id = $1 AND building_id = $2 AND status = 'ACTIVE' AND deleted_at IS NULL`,
      [tenant.id, tenant.buildingId],
    );
    return occupancy;
  }

  /** Người giám hộ: hồ sơ CÙNG tòa nhà, đã thành niên, đã đồng ý (mọi hồ sơ đều có đồng ý khi tạo) */
  private async assertValidGuardian(manager: EntityManager, guardianId: string, today: string): Promise<void> {
    const guardian = await manager.getRepository(Tenant).findOne({ where: { id: guardianId, buildingId: this.buildingId() } });
    if (!guardian) throw this.invalidGuardian('The guardian must be a registered person of this building');
    if (isMinorOn(guardian.dateOfBirth, today)) throw this.invalidGuardian('The guardian must be an adult');
    if (!guardian.pdplConsentAcceptedAt) throw this.invalidGuardian('The guardian has not given consent');
  }

  private async assertNotDuplicate(manager: EntityManager, idCardHash: string, exceptId?: string): Promise<void> {
    const existingId = await this.findIdByHash(manager, idCardHash);
    if (existingId && existingId !== exceptId) throw this.duplicate(existingId);
  }

  private async findIdByHash(manager: EntityManager, idCardHash: string): Promise<string | undefined> {
    const row = await manager.getRepository(Tenant).findOne({ where: { buildingId: this.buildingId(), idCardHash }, select: { id: true }, withDeleted: true });
    return row?.id;
  }

  private async loadDetail(manager: EntityManager, id: string): Promise<TenantDetailView> {
    const tenant = await manager
      .getRepository(Tenant)
      .createQueryBuilder('t')
      .leftJoin('t.consentGuardian', 'g')
      .addSelect(['g.id', 'g.fullName'])
      .where('t.id = :id AND t.building_id = :b', { id, b: this.buildingId() })
      .getOne();
    if (!tenant) throw this.notFound();
    const [occupancy]: CurrentOccupancy[] = await manager.query(
      `SELECT co.id AS "occupantId", c.id AS "contractId", c.contract_code AS "contractCode", r.id AS "roomId", r.room_number AS "roomNumber",
              co.role, to_char(co.moved_in_at, 'YYYY-MM-DD') AS "movedInAt", co.residency_status AS "residencyStatus"
         FROM contract_occupants co
         JOIN contracts c ON c.id = co.contract_id AND c.status = 'ACTIVE'
         JOIN rooms r ON r.id = c.room_id
        WHERE co.tenant_id = $1 AND co.building_id = $2 AND co.status = 'ACTIVE' AND co.deleted_at IS NULL`,
      [tenant.id, tenant.buildingId],
    );
    return {
      ...this.safeView(tenant, vietnamToday()),
      nationality: tenant.nationality,
      gender: tenant.gender,
      dateOfBirth: tenant.dateOfBirth,
      email: tenant.email ?? null,
      idCardIssueDate: tenant.idCardIssueDate ?? null,
      idCardIssuePlace: tenant.idCardIssuePlace ?? null,
      hometownAddress: tenant.hometownAddress,
      permanentAddress: tenant.permanentAddress,
      refundBankName: tenant.refundBankName ?? null,
      refundBankAccountMasked: maskBankAccount(tenant.refundBankAccountLast4),
      pdplConsentAcceptedAt: tenant.pdplConsentAcceptedAt,
      pdplConsentVersion: tenant.pdplConsentVersion,
      guardian: tenant.consentGuardian ? { id: tenant.consentGuardian.id, fullName: tenant.consentGuardian.fullName } : null,
      hasLogin: !!tenant.userId,
      currentOccupancy: occupancy ?? null,
      version: tenant.version,
    };
  }

  private safeView(t: Tenant, today: string): TenantSafeView {
    return {
      id: t.id,
      fullName: t.fullName,
      idDocumentType: t.idDocumentType,
      idCardMasked: maskIdNumber(t.idCardLast4),
      isMinor: isMinorOn(t.dateOfBirth, today),
      phone: t.phone ?? null,
      createdAt: t.createdAt,
    };
  }

  private normalizePhone(phone: string | null | undefined): string | null {
    if (phone === null || phone === undefined || phone.trim() === '') return null;
    try {
      return normalizePhoneNumber(phone);
    } catch (err) {
      if (err instanceof InvalidPhoneNumberError) {
        throw new BadRequestException({
          errorCode: SystemErrorCode.REQ_VALIDATION_ERROR,
          message: 'Validation failed for the submitted payload.',
          details: [{ field: 'phone', message: err.message }],
        });
      }
      throw err;
    }
  }

  /** `q` trông như số điện thoại (>= 8 chữ số, chỉ có số / khoảng trắng / . - + ( )) → tìm theo số đã chuẩn hóa */
  private tryPhone(q: string): string | null {
    if (!/^[+\d\s.\-()]+$/.test(q) || q.replace(/\D/g, '').length < 8) return null;
    try {
      return normalizePhoneNumber(q);
    } catch {
      return null;
    }
  }

  private escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (c) => `\\${c}`);
  }

  /** Ngày sinh muộn nhất để đã đủ 18 tuổi hôm nay (giờ Việt Nam); 29/2 → 1/3 như isAdultOn */
  private adultCutoff(): string {
    const [y, m, d] = vietnamToday().split('-').map(Number);
    const cutoff = new Date(Date.UTC(y - 18, m - 1, d));
    if (cutoff.getUTCMonth() !== m - 1) cutoff.setUTCDate(0); // 29/2 không tồn tại năm đó
    return cutoff.toISOString().slice(0, 10);
  }

  private duplicate(existingId: string | undefined) {
    return new ConflictException({
      errorCode: SystemErrorCode.BIZ_TENANT_ID_CARD_DUPLICATE,
      message: 'This ID document is already registered in this building; reuse the existing profile.',
      details: [{ field: 'idCardNumber', issue: 'DUPLICATE', ...(existingId ? { tenantId: existingId } : {}) }],
    });
  }

  private invalidGuardian(message: string) {
    return new UnprocessableEntityException({
      errorCode: SystemErrorCode.BIZ_TENANT_GUARDIAN_INVALID,
      message,
      details: [{ field: 'consentGuardianTenantId', issue: 'INVALID' }],
    });
  }

  private notFound() {
    return new NotFoundException({ errorCode: SystemErrorCode.RES_NOT_FOUND, message: 'Person not found in this building.' });
  }

  private buildingId(): string {
    return this.context.getBuildingId()!;
  }
}
