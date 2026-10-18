import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 1 - Properties & Assets (tài liệu 03, mục 3.1): buildings (toàn cục), room_types, rooms, assets, room_assets
 * (theo tòa nhà, RLS).
 *
 * Bảo đảm ở tầng kernel (đúng cả khi SQL thô bỏ qua ứng dụng):
 *  - FK tổng hợp (building_id, …) → UNIQUE (building_id, id): phòng chỉ dùng hạng phòng CÙNG tòa; đơn vị thiết bị chỉ
 *    nằm ở phòng / thuộc danh mục CÙNG tòa.
 *  - CHECK cho tầng, diện tích, sức chứa, giá, phí; serial duy nhất trong các đơn vị CÒN lắp (unique một phần).
 *  - Covering index một phần idx_rooms_available_covering (INCLUDE) cho tra cứu phòng trống (Mandate #1).
 *  - RLS setup_building_rls() cho 4 bảng theo tòa nhà.
 *  - FK user_building_access → buildings tạo NOT VALID: quyền truy cập tạo trước khi có bảng buildings (module 0) không
 *    chặn migration và không bị xóa; mọi dòng MỚI đều được kiểm tra. Tự VALIDATE khi không còn dòng mồ côi.
 *  - rooms.current_contract_id: FK tới contracts được thêm ở migration Contracts (module 3).
 */
export class CreatePropertyAndAssetTables1792430000000 implements MigrationInterface {
  name = 'CreatePropertyAndAssetTables1792430000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "public"."buildings_electricity_billing_mode_enum" AS ENUM('EVN_TIERED_QUOTA', 'EVN_TIER_3_FLAT')`);
    await queryRunner.query(`CREATE TABLE "buildings" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "code" character varying(30) NOT NULL, "name" character varying(150) NOT NULL, "address_line" character varying(255) NOT NULL, "ward" character varying(100) NOT NULL, "district" character varying(100) NOT NULL, "city" character varying(100) NOT NULL DEFAULT 'Thành phố Hồ Chí Minh', "landlord_tax_code" character varying(30) NOT NULL, "landlord_full_name" character varying(150) NOT NULL, "bank_account_number" character varying(50), "bank_bin_code" character varying(20), "total_rooms_capacity" smallint NOT NULL DEFAULT '80', "electricity_billing_mode" "public"."buildings_electricity_billing_mode_enum" NOT NULL DEFAULT 'EVN_TIERED_QUOTA', "default_water_rate_per_m3" numeric(10,2) NOT NULL DEFAULT '25000', CONSTRAINT "chk_buildings_values" CHECK ("total_rooms_capacity" BETWEEN 1 AND 500 AND "default_water_rate_per_m3" >= 0), CONSTRAINT "PK_bc65c1acce268c383e41a69003a" PRIMARY KEY ("id"))`);
    await queryRunner.query(`CREATE UNIQUE INDEX "idx_buildings_code_unique" ON "buildings"  ("code") `);
    await queryRunner.query(`CREATE INDEX "idx_buildings_tax_code" ON "buildings"  ("landlord_tax_code") `);
    await queryRunner.query(`CREATE TABLE "room_types" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "building_id" uuid NOT NULL, "code" character varying(50) NOT NULL, "name" character varying(100) NOT NULL, "base_monthly_rent" numeric(12,2) NOT NULL, "standard_area_sqm" numeric(6,2) NOT NULL, "default_max_occupants" smallint NOT NULL DEFAULT '2', CONSTRAINT "uq_room_types_bld_id" UNIQUE ("building_id", "id"), CONSTRAINT "chk_room_types_values" CHECK ("base_monthly_rent" > 0 AND "standard_area_sqm" > 0 AND "default_max_occupants" BETWEEN 1 AND 20), CONSTRAINT "PK_b6e1d0a9b67d4b9fbff9c35ab69" PRIMARY KEY ("id"))`);
    await queryRunner.query(`CREATE INDEX "IDX_0ca37f7f0c09f769f89810ce97" ON "room_types"  ("building_id") `);
    await queryRunner.query(`CREATE UNIQUE INDEX "idx_room_types_bld_code_unique" ON "room_types"  ("building_id", "code") `);
    await queryRunner.query(`CREATE TYPE "public"."rooms_status_enum" AS ENUM('AVAILABLE', 'RESERVED', 'OCCUPIED', 'MAINTENANCE')`);
    await queryRunner.query(`CREATE TABLE "rooms" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "building_id" uuid NOT NULL, "room_number" character varying(20) NOT NULL, "floor" smallint NOT NULL, "area_sqm" numeric(6,2) NOT NULL, "max_occupants" smallint NOT NULL DEFAULT '2', "room_type_id" uuid NOT NULL, "price_override" numeric(12,2), "status" "public"."rooms_status_enum" NOT NULL DEFAULT 'AVAILABLE', "current_contract_id" uuid, CONSTRAINT "uq_rooms_bld_id" UNIQUE ("building_id", "id"), CONSTRAINT "chk_rooms_price_override" CHECK ("price_override" IS NULL OR "price_override" > 0), CONSTRAINT "chk_rooms_max_occupants" CHECK ("max_occupants" BETWEEN 1 AND 20), CONSTRAINT "chk_rooms_area" CHECK ("area_sqm" > 0), CONSTRAINT "chk_rooms_floor" CHECK ("floor" BETWEEN 1 AND 30), CONSTRAINT "PK_0368a2d7c215f2d0458a54933f2" PRIMARY KEY ("id"))`);
    await queryRunner.query(`CREATE INDEX "IDX_0bc4b2db31e5f4a2f03c88f19d" ON "rooms"  ("building_id") `);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_rooms_current_contract" ON "rooms"  ("current_contract_id") WHERE "current_contract_id" IS NOT NULL`);
    await queryRunner.query(`CREATE UNIQUE INDEX "idx_rooms_bld_number_unique" ON "rooms"  ("building_id", "room_number") `);
    await queryRunner.query(`CREATE INDEX "idx_rooms_bld_floor_status" ON "rooms"  ("building_id", "floor", "status") `);
    await queryRunner.query(`CREATE INDEX "idx_rooms_bld_status_type" ON "rooms"  ("building_id", "status", "room_type_id") `);
    await queryRunner.query(`CREATE TYPE "public"."room_assets_condition_grade_enum" AS ENUM('GRADE_A_NEW', 'GRADE_B_GOOD', 'GRADE_C_FAIR', 'BROKEN')`);
    await queryRunner.query(`CREATE TABLE "room_assets" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "building_id" uuid NOT NULL, "room_id" uuid NOT NULL, "asset_id" uuid NOT NULL, "serial_number" character varying(100) NOT NULL, "condition_grade" "public"."room_assets_condition_grade_enum" NOT NULL DEFAULT 'GRADE_A_NEW', "custom_monthly_fee" numeric(12,2) NOT NULL, "installed_date" date NOT NULL, CONSTRAINT "chk_room_assets_fee" CHECK ("custom_monthly_fee" >= 0), CONSTRAINT "PK_3d80470a7e85886687776c0b744" PRIMARY KEY ("id"))`);
    await queryRunner.query(`CREATE INDEX "IDX_4d0330b5f7aaf59ffa3f2bd4c7" ON "room_assets"  ("building_id") `);
    await queryRunner.query(`CREATE UNIQUE INDEX "idx_room_assets_bld_serial_unique" ON "room_assets"  ("building_id", "serial_number") WHERE "deleted_at" IS NULL`);
    await queryRunner.query(`CREATE INDEX "idx_room_assets_room_id" ON "room_assets"  ("room_id") `);
    await queryRunner.query(`CREATE TYPE "public"."assets_category_enum" AS ENUM('APPLIANCE', 'FURNITURE')`);
    await queryRunner.query(`CREATE TABLE "assets" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "building_id" uuid NOT NULL, "code" character varying(50) NOT NULL, "name" character varying(150) NOT NULL, "category" "public"."assets_category_enum" NOT NULL, "standard_monthly_rental_fee" numeric(12,2) NOT NULL, "replacement_value" numeric(12,2) NOT NULL DEFAULT '0', CONSTRAINT "uq_assets_bld_id" UNIQUE ("building_id", "id"), CONSTRAINT "chk_assets_values" CHECK ("standard_monthly_rental_fee" >= 0 AND "replacement_value" >= 0), CONSTRAINT "PK_da96729a8b113377cfb6a62439c" PRIMARY KEY ("id"))`);
    await queryRunner.query(`CREATE INDEX "IDX_9b11a37f42e2e7130bda07c575" ON "assets"  ("building_id") `);
    await queryRunner.query(`CREATE UNIQUE INDEX "idx_assets_bld_code_unique" ON "assets"  ("building_id", "code") `);
    await queryRunner.query(`ALTER TABLE "rooms" ADD CONSTRAINT "fk_rooms_building" FOREIGN KEY ("building_id") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "rooms" ADD CONSTRAINT "fk_rooms_room_type_same_building" FOREIGN KEY ("room_type_id", "building_id") REFERENCES "room_types"("id","building_id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "room_assets" ADD CONSTRAINT "fk_room_assets_room_same_building" FOREIGN KEY ("room_id", "building_id") REFERENCES "rooms"("id","building_id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "room_assets" ADD CONSTRAINT "fk_room_assets_asset_same_building" FOREIGN KEY ("asset_id", "building_id") REFERENCES "assets"("id","building_id") ON DELETE RESTRICT ON UPDATE NO ACTION`);

    await queryRunner.query(`
      CREATE INDEX "idx_rooms_available_covering" ON "rooms" ("building_id", "room_type_id", "floor")
      INCLUDE ("room_number", "price_override")
      WHERE "status" = 'AVAILABLE' AND "deleted_at" IS NULL`);

    for (const table of ['room_types', 'rooms', 'assets', 'room_assets']) {
      await queryRunner.query(`SELECT setup_building_rls($1)`, [table]);
    }

    await queryRunner.query(`
      ALTER TABLE "user_building_access" ADD CONSTRAINT "fk_user_building_access_building"
      FOREIGN KEY ("building_id") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE NO ACTION NOT VALID`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM user_building_access a WHERE NOT EXISTS (SELECT 1 FROM buildings b WHERE b.id = a.building_id)
        ) THEN
          ALTER TABLE user_building_access VALIDATE CONSTRAINT fk_user_building_access_building;
        END IF;
      END $$`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user_building_access" DROP CONSTRAINT "fk_user_building_access_building"`);
    await queryRunner.query(`DROP INDEX "public"."idx_rooms_available_covering"`);
    await queryRunner.query(`ALTER TABLE "room_assets" DROP CONSTRAINT "fk_room_assets_asset_same_building"`);
    await queryRunner.query(`ALTER TABLE "room_assets" DROP CONSTRAINT "fk_room_assets_room_same_building"`);
    await queryRunner.query(`ALTER TABLE "rooms" DROP CONSTRAINT "fk_rooms_room_type_same_building"`);
    await queryRunner.query(`ALTER TABLE "rooms" DROP CONSTRAINT "fk_rooms_building"`);
    await queryRunner.query(`DROP INDEX "public"."idx_assets_bld_code_unique"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_9b11a37f42e2e7130bda07c575"`);
    await queryRunner.query(`DROP TABLE "assets"`);
    await queryRunner.query(`DROP TYPE "public"."assets_category_enum"`);
    await queryRunner.query(`DROP INDEX "public"."idx_room_assets_room_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_room_assets_bld_serial_unique"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_4d0330b5f7aaf59ffa3f2bd4c7"`);
    await queryRunner.query(`DROP TABLE "room_assets"`);
    await queryRunner.query(`DROP TYPE "public"."room_assets_condition_grade_enum"`);
    await queryRunner.query(`DROP INDEX "public"."idx_rooms_bld_status_type"`);
    await queryRunner.query(`DROP INDEX "public"."idx_rooms_bld_floor_status"`);
    await queryRunner.query(`DROP INDEX "public"."idx_rooms_bld_number_unique"`);
    await queryRunner.query(`DROP INDEX "public"."uq_rooms_current_contract"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_0bc4b2db31e5f4a2f03c88f19d"`);
    await queryRunner.query(`DROP TABLE "rooms"`);
    await queryRunner.query(`DROP TYPE "public"."rooms_status_enum"`);
    await queryRunner.query(`DROP INDEX "public"."idx_room_types_bld_code_unique"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_0ca37f7f0c09f769f89810ce97"`);
    await queryRunner.query(`DROP TABLE "room_types"`);
    await queryRunner.query(`DROP INDEX "public"."idx_buildings_tax_code"`);
    await queryRunner.query(`DROP INDEX "public"."idx_buildings_code_unique"`);
    await queryRunner.query(`DROP TABLE "buildings"`);
    await queryRunner.query(`DROP TYPE "public"."buildings_electricity_billing_mode_enum"`);
  }
}
