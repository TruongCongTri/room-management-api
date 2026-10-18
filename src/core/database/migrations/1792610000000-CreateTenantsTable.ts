import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 2 - Tenants (tài liệu 03, mục 3.2 #6 và mục 4 6c): một hồ sơ cho MỖI người ở.
 *  - Số giấy tờ & tài khoản hoàn cọc mã hóa (cột *_encrypted), blind index id_card_hash duy nhất theo tòa nhà.
 *  - Kernel: người giám hộ cùng tòa nhà (FK tổng hợp), không tự giám hộ, CCCD chỉ cho quốc tịch VN, số điện thoại E.164,
 *    giới tính / quốc tịch / định dạng hash; user_id → users (SET NULL khi tài khoản bị xóa).
 *  - RLS setup_building_rls('tenants').
 */
export class CreateTenantsTable1792610000000 implements MigrationInterface {
  name = 'CreateTenantsTable1792610000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "public"."tenants_id_document_type_enum" AS ENUM('CCCD', 'PASSPORT')`);
    await queryRunner.query(`CREATE TABLE "tenants" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "building_id" uuid NOT NULL, "full_name" character varying(150) NOT NULL, "full_name_search" character varying(150) NOT NULL, "id_document_type" "public"."tenants_id_document_type_enum" NOT NULL DEFAULT 'CCCD', "id_card_encrypted" text NOT NULL, "id_card_hash" character(64) NOT NULL, "id_card_last4" character varying(4) NOT NULL, "id_card_issue_date" date, "id_card_issue_place" character varying(150), "id_document_front_key" character varying(255), "id_document_back_key" character varying(255), "nationality" character(2) NOT NULL DEFAULT 'VN', "gender" character varying(10) NOT NULL, "date_of_birth" date NOT NULL, "phone" character varying(16), "email" character varying(150), "hometown_address" character varying(255) NOT NULL, "permanent_address" character varying(255) NOT NULL, "refund_bank_account_encrypted" text, "refund_bank_account_last4" character varying(4), "refund_bank_name" character varying(100), "pdpl_consent_accepted_at" TIMESTAMP WITH TIME ZONE NOT NULL, "pdpl_consent_version" character varying(30) NOT NULL DEFAULT 'v2026.1', "consent_guardian_tenant_id" uuid, "user_id" uuid, CONSTRAINT "uq_tenants_bld_id" UNIQUE ("building_id", "id"), CONSTRAINT "chk_tenants_phone_e164" CHECK ("phone" IS NULL OR "phone" ~ '^\\+[1-9][0-9]{7,14}$'), CONSTRAINT "chk_tenants_cccd_vietnamese" CHECK ("id_document_type" <> 'CCCD' OR "nationality" = 'VN'), CONSTRAINT "chk_tenants_id_hash" CHECK ("id_card_hash" ~ '^[0-9a-f]{64}$'), CONSTRAINT "chk_tenants_nationality" CHECK ("nationality" ~ '^[A-Z]{2}$'), CONSTRAINT "chk_tenants_gender" CHECK ("gender" IN ('MALE', 'FEMALE')), CONSTRAINT "chk_tenants_guardian_not_self" CHECK ("consent_guardian_tenant_id" IS NULL OR "consent_guardian_tenant_id" <> "id"), CONSTRAINT "PK_53be67a04681c66b87ee27c9321" PRIMARY KEY ("id"))`);
    await queryRunner.query(`CREATE INDEX "IDX_fa499d9e6101b7c6574216577a" ON "tenants"  ("building_id") `);
    await queryRunner.query(`CREATE UNIQUE INDEX "idx_tenants_bld_user_unique" ON "tenants"  ("building_id", "user_id") WHERE "user_id" IS NOT NULL AND "deleted_at" IS NULL`);
    await queryRunner.query(`CREATE INDEX "idx_tenants_bld_name_search" ON "tenants"  ("building_id", "full_name_search") `);
    await queryRunner.query(`CREATE INDEX "idx_tenants_bld_phone" ON "tenants"  ("building_id", "phone") `);
    await queryRunner.query(`CREATE UNIQUE INDEX "idx_tenants_bld_id_hash_unique" ON "tenants"  ("building_id", "id_card_hash") `);
    await queryRunner.query(`ALTER TABLE "tenants" ADD CONSTRAINT "fk_tenants_guardian_same_building" FOREIGN KEY ("consent_guardian_tenant_id", "building_id") REFERENCES "tenants"("id","building_id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "tenants" ADD CONSTRAINT "fk_tenants_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    await queryRunner.query(`SELECT setup_building_rls('tenants')`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tenants" DROP CONSTRAINT "fk_tenants_user"`);
    await queryRunner.query(`ALTER TABLE "tenants" DROP CONSTRAINT "fk_tenants_guardian_same_building"`);
    await queryRunner.query(`DROP INDEX "public"."idx_tenants_bld_id_hash_unique"`);
    await queryRunner.query(`DROP INDEX "public"."idx_tenants_bld_phone"`);
    await queryRunner.query(`DROP INDEX "public"."idx_tenants_bld_name_search"`);
    await queryRunner.query(`DROP INDEX "public"."idx_tenants_bld_user_unique"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_fa499d9e6101b7c6574216577a"`);
    await queryRunner.query(`DROP TABLE "tenants"`);
    await queryRunner.query(`DROP TYPE "public"."tenants_id_document_type_enum"`);
  }
}
