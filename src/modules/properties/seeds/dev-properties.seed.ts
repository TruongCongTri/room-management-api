/**
 * Dữ liệu mẫu DEVELOPMENT cho module 1 (không chạy trên production / test):
 *  - Tòa A (b1…01): 80 phòng P.101 → P.810 (8 tầng × 10), 3 hạng phòng, danh mục thiết bị và máy lạnh lắp ở tầng 1.
 *  - Tòa B (b2…02) của chủ nhà khác: 5 phòng - kiểm tra cô lập giữa các tòa nhà bằng Postman.
 *  - Website giới thiệu (module 1b): tòa A công khai với slug `sunrise-quan-7`; tòa B KHÔNG công khai.
 * Idempotent (ON CONFLICT DO NOTHING theo khóa nghiệp vụ). Chạy SAU dev-accounts: VALIDATE FK user_building_access
 * khi mọi quyền truy cập đã trỏ tới tòa nhà có thật.
 */
import type { EntityManager } from 'typeorm';
import type { DatabaseSeed } from '../../../core/database/seeds/seed.interface';
import { DEV_BUILDING_A, DEV_BUILDING_B } from '../../identity/seeds/dev-accounts.seed';

const BUILDINGS = [
  { id: DEV_BUILDING_A, code: 'BLD-HCM-Q7-01', name: 'Tòa nhà Sunrise (dev)', district: 'Quận 7', ward: 'Phường Tân Phú', tax: '0312345678', rooms: 80 },
  { id: DEV_BUILDING_B, code: 'BLD-HCM-BT-02', name: 'Tòa nhà Riverside (dev)', district: 'Bình Thạnh', ward: 'Phường 22', tax: '0398765432', rooms: 5 },
];

const ROOM_TYPES = [
  { code: 'STUDIO', name: 'Studio', rent: 6_500_000, area: 28.5, max: 2 },
  { code: '1BR_DELUXE', name: '1BR Deluxe', rent: 8_500_000, area: 38, max: 3 },
  { code: 'DUPLEX', name: 'Duplex', rent: 12_000_000, area: 55, max: 4 },
];

const ASSETS = [
  { code: 'AC_DAIKIN_1_5HP', name: 'Máy lạnh Daikin Inverter 1.5 HP', category: 'APPLIANCE', fee: 300_000, value: 9_500_000 },
  { code: 'FRIDGE_TOSHIBA_180L', name: 'Tủ lạnh Toshiba 180L', category: 'APPLIANCE', fee: 200_000, value: 5_200_000 },
  { code: 'WASHER_ELECTROLUX_8KG', name: 'Máy giặt Electrolux 8kg', category: 'APPLIANCE', fee: 250_000, value: 7_000_000 },
  { code: 'SOFA_BED', name: 'Sofa giường', category: 'FURNITURE', fee: 150_000, value: 4_000_000 },
];

/** P.101…P.810: phòng 01-05 Studio, 06-08 1BR Deluxe, 09-10 Duplex */
function roomPlan(total: number) {
  const rooms: Array<{ number: string; floor: number; type: string }> = [];
  for (let i = 0; i < total; i++) {
    const floor = Math.floor(i / 10) + 1;
    const index = (i % 10) + 1;
    const type = index <= 5 ? 'STUDIO' : index <= 8 ? '1BR_DELUXE' : 'DUPLEX';
    rooms.push({ number: `P.${floor}${String(index).padStart(2, '0')}`, floor, type });
  }
  return rooms;
}

export const devPropertiesSeed: DatabaseSeed = {
  name: 'dev-properties',
  environments: ['development'],
  async run(manager: EntityManager) {
    for (const b of BUILDINGS) {
      await manager.query(
        `INSERT INTO buildings (id, code, name, address_line, ward, district, landlord_tax_code, landlord_full_name,
                                bank_account_number, bank_bin_code, total_rooms_capacity)
         VALUES ($1, $2, $3, '12 Nguyễn Thị Thập', $4, $5, $6, 'Chủ nhà (dev)', '0071000123456', '970436', 80)
         ON CONFLICT (id) DO NOTHING`,
        [b.id, b.code, b.name, b.ward, b.district, b.tax],
      );
      const typeIds = new Map<string, string>();
      for (const t of ROOM_TYPES) {
        await manager.query(
          `INSERT INTO room_types (building_id, code, name, base_monthly_rent, standard_area_sqm, default_max_occupants)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (building_id, code) DO NOTHING`,
          [b.id, t.code, t.name, t.rent, t.area, t.max],
        );
        const [{ id }] = await manager.query(`SELECT id FROM room_types WHERE building_id = $1 AND code = $2`, [b.id, t.code]);
        typeIds.set(t.code, id);
      }
      for (const r of roomPlan(b.rooms)) {
        const t = ROOM_TYPES.find((x) => x.code === r.type)!;
        await manager.query(
          `INSERT INTO rooms (building_id, room_number, floor, area_sqm, max_occupants, room_type_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (building_id, room_number) DO NOTHING`,
          [b.id, r.number, r.floor, t.area, t.max, typeIds.get(r.type), r.number.endsWith('10') && r.floor === 8 ? 'MAINTENANCE' : 'AVAILABLE'],
        );
      }
      for (const a of ASSETS) {
        await manager.query(
          `INSERT INTO assets (building_id, code, name, category, standard_monthly_rental_fee, replacement_value)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (building_id, code) DO NOTHING`,
          [b.id, a.code, a.name, a.category, a.fee, a.value],
        );
      }
      // Máy lạnh cho các phòng tầng 1
      await manager.query(
        `INSERT INTO room_assets (building_id, room_id, asset_id, serial_number, custom_monthly_fee, installed_date)
         SELECT r.building_id, r.id, a.id, $2 || '-' || replace(r.room_number, '.', ''), a.standard_monthly_rental_fee, DATE '2026-01-05'
           FROM rooms r JOIN assets a ON a.building_id = r.building_id AND a.code = 'AC_DAIKIN_1_5HP'
          WHERE r.building_id = $1 AND r.floor = 1
         ON CONFLICT DO NOTHING`,
        [b.id, `DK-${b.code.slice(-2)}`],
      );
    }
    await manager.query(
      `UPDATE buildings SET is_publicly_listed = true, public_slug = 'sunrise-quan-7',
              public_description = 'Căn hộ dịch vụ 80 phòng gần Đại học RMIT và Tôn Đức Thắng, có thang máy, bảo vệ 24/7, giữ xe miễn phí.'
        WHERE id = $1 AND public_slug IS NULL`,
      [DEV_BUILDING_A],
    );
    await manager.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM user_building_access a WHERE NOT EXISTS (SELECT 1 FROM buildings b WHERE b.id = a.building_id))
           AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_user_building_access_building' AND NOT convalidated) THEN
          ALTER TABLE user_building_access VALIDATE CONSTRAINT fk_user_building_access_building;
        END IF;
      END $$`);
  },
};
