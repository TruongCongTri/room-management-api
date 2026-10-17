import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bảng danh mục tham chiếu TOÀN CỤC (không thuộc tòa nhà nào → không áp RLS), do DatabaseSeeder nạp
 * (tài liệu 01, mục 4.5):
 *  - system_roles / role_permissions: 5 vai trò hệ thống & ma trận `<resource>:<action>:<scope>`.
 *  - evn_tariff_tiers: biểu giá điện sinh hoạt bậc thang theo ngày hiệu lực (giữ lịch sử để tính lại kỳ cũ).
 *  - statutory_tax_rules: ngưỡng & thuế suất cho thuê tài sản theo giai đoạn (2026: 1 tỷ, trước 2026: 100 triệu).
 *  - statutory_forms: mẫu tờ khai nhà nước (01/BĐS, 01/BK-BĐS, 01/TTS, CT01).
 */
export class CreateReferenceDataTables1792250000000 implements MigrationInterface {
  name = 'CreateReferenceDataTables1792250000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "system_roles" (
        "code" character varying(50) NOT NULL,
        "name" character varying(100) NOT NULL,
        "description" text,
        "is_system" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_system_roles" PRIMARY KEY ("code")
      )`);

    await queryRunner.query(`
      CREATE TABLE "role_permissions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "role_code" character varying(50) NOT NULL,
        "resource" character varying(50) NOT NULL,
        "action" character varying(20) NOT NULL,
        "scope" character varying(20) NOT NULL,
        "effect" character varying(10) NOT NULL DEFAULT 'GRANT',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_role_permissions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_role_permissions_role" FOREIGN KEY ("role_code") REFERENCES "system_roles"("code") ON DELETE CASCADE,
        CONSTRAINT "chk_role_permissions_scope" CHECK ("scope" IN ('own', 'department', 'global')),
        CONSTRAINT "chk_role_permissions_effect" CHECK ("effect" IN ('GRANT', 'DENY'))
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_role_permissions_unique" ON "role_permissions" ("role_code", "resource", "action", "scope", "effect")`,
    );

    await queryRunner.query(`
      CREATE TABLE "evn_tariff_tiers" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "effective_from" date NOT NULL,
        "tier" smallint NOT NULL,
        "width_kwh" integer,
        "price_vnd" integer NOT NULL,
        "legal_basis" character varying(200) NOT NULL,
        CONSTRAINT "PK_evn_tariff_tiers" PRIMARY KEY ("id"),
        CONSTRAINT "chk_evn_tier_range" CHECK ("tier" BETWEEN 1 AND 6),
        CONSTRAINT "chk_evn_tier_values" CHECK ("price_vnd" > 0 AND ("width_kwh" IS NULL OR "width_kwh" > 0))
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_evn_tariff_effective_tier" ON "evn_tariff_tiers" ("effective_from", "tier")`,
    );

    await queryRunner.query(`
      CREATE TABLE "statutory_tax_rules" (
        "code" character varying(50) NOT NULL,
        "effective_from" date NOT NULL,
        "effective_to" date,
        "exempt_threshold_vnd" bigint NOT NULL,
        "vat_rate_percent" numeric(5,2) NOT NULL,
        "pit_rate_percent" numeric(5,2) NOT NULL,
        -- TOTAL_REVENUE: TNCN trên toàn bộ doanh thu khi vượt ngưỡng (trước 2026);
        -- EXCESS_OVER_THRESHOLD: TNCN chỉ trên phần vượt ngưỡng (Luật 109/2025/QH15)
        "pit_base" character varying(30) NOT NULL,
        -- NULL: lệ phí theo bậc doanh thu của giai đoạn cũ, không mô hình hóa ở đây; 0 từ 2026
        "business_license_fee_vnd" bigint,
        "legal_basis" text NOT NULL,
        CONSTRAINT "PK_statutory_tax_rules" PRIMARY KEY ("code"),
        CONSTRAINT "chk_tax_rule_pit_base" CHECK ("pit_base" IN ('TOTAL_REVENUE', 'EXCESS_OVER_THRESHOLD')),
        CONSTRAINT "chk_tax_rule_period" CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from")
      )`);

    await queryRunner.query(`
      CREATE TABLE "statutory_forms" (
        "code" character varying(20) NOT NULL,
        "name" character varying(255) NOT NULL,
        "kind" character varying(20) NOT NULL,
        "legal_basis" text NOT NULL,
        "is_legacy" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_statutory_forms" PRIMARY KEY ("code"),
        CONSTRAINT "chk_statutory_forms_kind" CHECK ("kind" IN ('TAX', 'RESIDENCE'))
      )`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "statutory_forms"`);
    await queryRunner.query(`DROP TABLE "statutory_tax_rules"`);
    await queryRunner.query(`DROP INDEX "public"."idx_evn_tariff_effective_tier"`);
    await queryRunner.query(`DROP TABLE "evn_tariff_tiers"`);
    await queryRunner.query(`DROP INDEX "public"."idx_role_permissions_unique"`);
    await queryRunner.query(`DROP TABLE "role_permissions"`);
    await queryRunner.query(`DROP TABLE "system_roles"`);
  }
}
