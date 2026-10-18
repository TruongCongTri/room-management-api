/**
 * Hợp đồng mẫu DEVELOPMENT ở tòa A (không chạy trên production / test), chạy SAU dev-tenants:
 *  - Danh mục dịch vụ của tòa A và B: WIFI (theo phòng), SANITATION (theo người), gửi xe theo loại xe.
 *  - Hợp đồng HD-2026/001-P101 đang hiệu lực (01/01 → 31/12/2026): khách thuê dev đứng tên (cư trú REGISTERED),
 *    con gái ở cùng (SUBMITTED), thuê 1 máy lạnh, Wi-Fi + vệ sinh theo người + gửi 1 xe máy, cọc 1 tháng trong sổ cái.
 *  - Người nước ngoài (hộ chiếu) chưa ở phòng nào → thử chuyển đến.
 * Idempotent theo (building_id, contract_code) / (building_id, code).
 */
import type { EntityManager } from 'typeorm';
import type { DatabaseSeed } from '../../../core/database/seeds/seed.interface';
import { DEV_BUILDING_A, DEV_BUILDING_B } from '../../identity/seeds/dev-accounts.seed';

const CATALOG = [
  { code: 'WIFI', name: 'Wi-Fi tốc độ cao', unit: 'PER_ROOM_MONTH', vehicle: null, price: 150000 },
  { code: 'SANITATION', name: 'Vệ sinh & rác', unit: 'PER_PERSON_MONTH', vehicle: null, price: 30000 },
  { code: 'PARKING_MOTORBIKE', name: 'Gửi xe máy', unit: 'PER_VEHICLE_MONTH', vehicle: 'MOTORBIKE', price: 150000 },
  { code: 'PARKING_EBIKE', name: 'Gửi xe điện', unit: 'PER_VEHICLE_MONTH', vehicle: 'ELECTRIC_BIKE', price: 120000 },
  { code: 'PARKING_CAR', name: 'Gửi ô tô', unit: 'PER_VEHICLE_MONTH', vehicle: 'CAR', price: 1200000 },
] as const;

export const DEV_CONTRACT_CODE = 'HD-2026/001-P101';

export const devContractsSeed: DatabaseSeed = {
  name: 'dev-contracts',
  environments: ['development'],
  async run(manager: EntityManager) {
    for (const building of [DEV_BUILDING_A, DEV_BUILDING_B]) {
      for (const c of CATALOG) {
        await manager.query(
          `INSERT INTO service_catalogs (building_id, code, name, charge_unit, vehicle_type, default_unit_price)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (building_id, code) WHERE deleted_at IS NULL DO NOTHING`,
          [building, c.code, c.name, c.unit, c.vehicle, c.price],
        );
      }
    }

    if ((await manager.query(`SELECT 1 FROM contracts WHERE building_id = $1 AND contract_code = $2`, [DEV_BUILDING_A, DEV_CONTRACT_CODE])).length) return;
    const [room] = await manager.query(
      `SELECT r.id, COALESCE(r.price_override, rt.base_monthly_rent) AS rent FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id
        WHERE r.building_id = $1 AND r.room_number = 'P.101' AND r.current_contract_id IS NULL AND r.status = 'AVAILABLE'`,
      [DEV_BUILDING_A],
    );
    const people: Array<{ id: string; id_card_last4: string; user_id: string | null }> = await manager.query(
      `SELECT id, id_card_last4, user_id FROM tenants WHERE building_id = $1 AND id_card_last4 IN ('1234', '4321') AND id_document_type = 'CCCD'`,
      [DEV_BUILDING_A],
    );
    const parent = people.find((p) => p.id_card_last4 === '1234');
    const child = people.find((p) => p.id_card_last4 === '4321');
    if (!room || !parent || !child) return; // dữ liệu nền chưa có / phòng đã được dùng → bỏ qua
    const [recorder] = await manager.query(`SELECT id FROM users WHERE phone_e164 = '+84901000002' AND deleted_at IS NULL`);

    const [{ id: contractId }] = await manager.query(
      `INSERT INTO contracts (building_id, contract_code, room_id, primary_tenant_id, start_date, end_date, monthly_room_rent, deposit_amount,
                              deposit_status, payment_due_day, registered_evn_quota_headcount, pccc_commitment_signed, status, activated_at)
       VALUES ($1, $2, $3, $4, '2026-01-01', '2026-12-31', $5, $5, 'HELD', 5, 1, true, 'ACTIVE', '2026-01-01T09:00:00+07:00') RETURNING id`,
      [DEV_BUILDING_A, DEV_CONTRACT_CODE, room.id, parent.id, room.rent],
    );
    await manager.query(
      `INSERT INTO contract_occupants (building_id, contract_id, tenant_id, role, moved_in_at, residence_channel, residency_status,
                                       residence_submitted_at, residence_registered_at, temporary_stay_valid_until, relationship_to_holder)
       VALUES ($1, $2, $3, 'PRIMARY_HOLDER', '2026-01-01', 'CT01', 'REGISTERED', '2026-01-03', '2026-01-10', '2027-12-31', NULL),
              ($1, $2, $4, 'CO_OCCUPANT', '2026-01-01', 'CT01', 'SUBMITTED', '2026-01-03', NULL, NULL, 'Con')`,
      [DEV_BUILDING_A, contractId, parent.id, child.id],
    );
    await manager.query(`UPDATE rooms SET status = 'OCCUPIED', current_contract_id = $1 WHERE id = $2`, [contractId, room.id]);
    await manager.query(
      `INSERT INTO deposit_ledgers (building_id, contract_id, entry_no, transaction_type, amount, balance_after, counterparty_tenant_id, recorded_by_id)
       VALUES ($1, $2, 1, 'INITIAL_COLLECTION', $3, $3, $4, $5)`,
      [DEV_BUILDING_A, contractId, room.rent, parent.id, recorder?.id ?? parent.id],
    );
    // Một máy lạnh của phòng được thuê theo hợp đồng
    await manager.query(
      `INSERT INTO contract_assets (building_id, contract_id, room_asset_id, agreed_monthly_fee, handover_condition)
       SELECT $1, $2, ra.id, ra.custom_monthly_fee, ra.condition_grade::text::contract_assets_handover_condition_enum FROM room_assets ra
        WHERE ra.room_id = $3 AND ra.deleted_at IS NULL ORDER BY ra.serial_number LIMIT 1`,
      [DEV_BUILDING_A, contractId, room.id],
    );
    await manager.query(
      `INSERT INTO tenant_vehicles (building_id, contract_id, owner_tenant_id, vehicle_type, license_plate, brand_model, parking_card_code)
       VALUES ($1, $2, $3, 'MOTORBIKE', '59-G2 123.45', 'Honda Vision', 'XE-001')`,
      [DEV_BUILDING_A, contractId, parent.id],
    );
    await manager.query(
      `INSERT INTO contract_services (building_id, contract_id, service_catalog_id, service_code, charge_unit, quantity, agreed_unit_price)
       SELECT $1, $2, sc.id, sc.code, sc.charge_unit::text::contract_services_charge_unit_enum,
              CASE sc.code WHEN 'SANITATION' THEN 2 ELSE 1 END, sc.default_unit_price
         FROM service_catalogs sc WHERE sc.building_id = $1 AND sc.code IN ('WIFI', 'SANITATION', 'PARKING_MOTORBIKE') AND sc.deleted_at IS NULL`,
      [DEV_BUILDING_A, contractId],
    );
  },
};
