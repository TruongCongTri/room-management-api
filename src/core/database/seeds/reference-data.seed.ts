/**
 * Dữ liệu tham chiếu hệ thống (tài liệu 01, mục 4.5). Mọi seed đều idempotent và lấy giá trị từ
 * hằng số trong mã (một nguồn sự thật duy nhất với runtime):
 *  - Vai trò hệ thống: mô tả được cập nhật theo mã (DO UPDATE).
 *  - Ma trận quyền của vai trò hệ thống: ĐỒNG BỘ đúng theo DEFAULT_ROLE_PERMISSIONS - thêm quyền thiếu
 *    và XÓA quyền đã bị gỡ khỏi mã (quyền thừa còn sót lại trong DB là lỗ hổng leo thang đặc quyền).
 *  - Biểu giá EVN / quy định thuế / biểu mẫu: chỉ chèn nếu chưa có (DO NOTHING) - bản ghi lịch sử bất biến,
 *    điều chỉnh giá mới phải thêm bản ghi với ngày hiệu lực mới.
 */
import type { EntityManager } from 'typeorm';
import type { DatabaseSeed } from './seed.interface';
import { DEFAULT_ROLE_PERMISSIONS, RentalRole } from '../../access-control/rental-permissions';
import {
  EVN_RESIDENTIAL_TIERS,
  VN_STATUTORY_FORMS,
  VN_TAX_2026,
} from '../../../common/constants/vn-rental.constant';

const ROLE_DESCRIPTIONS: Record<RentalRole, { name: string; description: string }> = {
  [RentalRole.LANDLORD]: { name: 'Chủ nhà', description: 'Toàn quyền trên các tòa nhà được cấp: tài chính, thuế, thiết lập.' },
  [RentalRole.PROPERTY_MANAGER]: {
    name: 'Quản lý tòa nhà',
    description: 'Quản lý phòng, khách thuê, hợp đồng, chỉ số và tuân thủ trong tòa nhà được phân công.',
  },
  [RentalRole.ACCOUNTANT]: {
    name: 'Kế toán',
    description: 'Hóa đơn, thanh toán, quyết toán tiền cọc, duyệt reset đồng hồ và xuất tờ khai thuế.',
  },
  [RentalRole.GUARD]: { name: 'Bảo vệ', description: 'Chụp ảnh và ghi chỉ số điện nước; không được duyệt reset đồng hồ.' },
  [RentalRole.TENANT]: { name: 'Khách thuê', description: 'Tự phục vụ: xem hợp đồng, hóa đơn và chỉ số của chính mình.' },
};

/** Ngày hiệu lực của biểu giá EVN trong EVN_RESIDENTIAL_TIERS (QĐ 1279/QĐ-BCT) */
export const EVN_TARIFF_EFFECTIVE_FROM = '2025-05-10';
const EVN_LEGAL_BASIS = 'Quyết định 1279/QĐ-BCT ngày 09/05/2025 của Bộ Công Thương';

export const systemRolesSeed: DatabaseSeed = {
  name: 'system-roles',
  async run(manager: EntityManager) {
    for (const role of Object.values(RentalRole)) {
      const { name, description } = ROLE_DESCRIPTIONS[role];
      await manager.query(
        `INSERT INTO system_roles (code, name, description, is_system) VALUES ($1, $2, $3, true)
         ON CONFLICT (code) DO UPDATE
           SET name = EXCLUDED.name, description = EXCLUDED.description, is_system = true, updated_at = now()`,
        [role, name, description],
      );
    }
  },
};

export const rolePermissionsSeed: DatabaseSeed = {
  name: 'role-permissions',
  async run(manager: EntityManager) {
    for (const role of Object.values(RentalRole)) {
      const rules = DEFAULT_ROLE_PERMISSIONS[role];
      for (const rule of rules) {
        await manager.query(
          `INSERT INTO role_permissions (role_code, resource, action, scope, effect) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (role_code, resource, action, scope, effect) DO NOTHING`,
          [role, rule.resource, rule.action, rule.scope, rule.effect],
        );
      }
      // Gỡ quyền không còn trong ma trận của mã (chỉ áp cho vai trò hệ thống)
      await manager.query(
        `DELETE FROM role_permissions rp
          WHERE rp.role_code = $1
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS r(resource text, action text, scope text, effect text)
               WHERE r.resource = rp.resource AND r.action = rp.action AND r.scope = rp.scope AND r.effect = rp.effect
            )`,
        [role, JSON.stringify(rules)],
      );
    }
  },
};

export const evnTariffSeed: DatabaseSeed = {
  name: 'evn-tariff-tiers',
  async run(manager: EntityManager) {
    for (const tier of EVN_RESIDENTIAL_TIERS) {
      await manager.query(
        `INSERT INTO evn_tariff_tiers (effective_from, tier, width_kwh, price_vnd, legal_basis) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (effective_from, tier) DO NOTHING`,
        [EVN_TARIFF_EFFECTIVE_FROM, tier.tier, tier.widthKwh, tier.priceVnd, EVN_LEGAL_BASIS],
      );
    }
  },
};

export const statutoryTaxRulesSeed: DatabaseSeed = {
  name: 'statutory-tax-rules',
  async run(manager: EntityManager) {
    const rules = [
      {
        code: 'RENTAL_PRE_2026',
        effectiveFrom: '2021-08-01',
        effectiveTo: '2025-12-31',
        threshold: VN_TAX_2026.LEGACY_EXEMPT_THRESHOLD_VND,
        pitBase: 'TOTAL_REVENUE',
        legalBasis: 'Thông tư 40/2021/TT-BTC (ngưỡng 100 triệu đồng/năm)',
      },
      {
        code: 'RENTAL_2026',
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
        threshold: VN_TAX_2026.EXEMPT_THRESHOLD_VND,
        pitBase: 'EXCESS_OVER_THRESHOLD',
        legalBasis:
          'Luật Thuế TNCN 109/2025/QH15; Luật Thuế GTGT 48/2024/QH15 (sửa đổi bởi 149/2025/QH15); ' +
          'Nghị định 68/2026/NĐ-CP (sửa đổi bởi 141/2026/NĐ-CP); Nghị quyết 198/2025/QH15 (bãi bỏ lệ phí môn bài)',
      },
    ];
    for (const rule of rules) {
      await manager.query(
        `INSERT INTO statutory_tax_rules
           (code, effective_from, effective_to, exempt_threshold_vnd, vat_rate_percent, pit_rate_percent, pit_base,
            business_license_fee_vnd, legal_basis)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (code) DO NOTHING`,
        [
          rule.code,
          rule.effectiveFrom,
          rule.effectiveTo,
          rule.threshold,
          VN_TAX_2026.VAT_RATE_PERCENT,
          VN_TAX_2026.PIT_RATE_PERCENT,
          rule.pitBase,
          // Lệ phí môn bài: chỉ bãi bỏ từ 2026 (giai đoạn trước do lịch sử thu riêng theo bậc doanh thu)
          rule.effectiveTo ? null : VN_TAX_2026.BUSINESS_LICENSE_FEE_VND,
          rule.legalBasis,
        ],
      );
    }
  },
};

export const statutoryFormsSeed: DatabaseSeed = {
  name: 'statutory-forms',
  async run(manager: EntityManager) {
    const forms = [
      {
        code: VN_STATUTORY_FORMS.TAX_DECLARATION,
        name: 'Tờ khai thuế đối với hoạt động cho thuê bất động sản',
        kind: 'TAX',
        basis: 'Thông tư 18/2026/TT-BTC',
        legacy: false,
      },
      {
        code: VN_STATUTORY_FORMS.TAX_ANNEX,
        name: 'Phụ lục bảng kê chi tiết bất động sản cho thuê',
        kind: 'TAX',
        basis: 'Thông tư 18/2026/TT-BTC',
        legacy: false,
      },
      {
        code: VN_STATUTORY_FORMS.LEGACY_TAX_DECLARATION,
        name: 'Tờ khai thuế đối với cá nhân cho thuê tài sản (mẫu cũ)',
        kind: 'TAX',
        basis: 'Thông tư 40/2021/TT-BTC',
        legacy: true,
      },
      {
        code: VN_STATUTORY_FORMS.RESIDENCE_DECLARATION,
        name: 'Tờ khai thay đổi thông tin cư trú',
        kind: 'RESIDENCE',
        basis: 'Luật Cư trú 2020; Thông tư 66/2023/TT-BCA',
        legacy: false,
      },
    ];
    for (const form of forms) {
      await manager.query(
        `INSERT INTO statutory_forms (code, name, kind, legal_basis, is_legacy) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (code) DO NOTHING`,
        [form.code, form.name, form.kind, form.basis, form.legacy],
      );
    }
  },
};

/** Thứ tự phụ thuộc: vai trò trước ma trận quyền */
export const REFERENCE_DATA_SEEDS: DatabaseSeed[] = [
  systemRolesSeed,
  rolePermissionsSeed,
  evnTariffSeed,
  statutoryTaxRulesSeed,
  statutoryFormsSeed,
];
