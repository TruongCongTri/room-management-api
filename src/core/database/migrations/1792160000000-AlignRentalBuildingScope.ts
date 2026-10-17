import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Chuyển khóa cô lập dữ liệu từ "tenant" chung chung sang TÒA NHÀ của nền tảng cho thuê phòng
 * (tài liệu 03-Database, mục 3.4 & 4):
 *  - audit_logs / outbox_events: tenant_id → building_id (NULL cho sự kiện hệ thống, thay cho UUID 0000...).
 *  - Đổi tên index & trigger WORM theo đặc tả (idx_outbox_poll_pending, trg_audit_logs_immutable...).
 *  - Hàm setup_building_rls(table): policy tenant_isolation_policy theo building_id +
 *    biến phiên app.current_building_id; tự áp cho các bảng nghiệp vụ đã tồn tại.
 */
const BUILDING_SCOPED_TABLES = [
  'room_types',
  'rooms',
  'assets',
  'room_assets',
  'tenants',
  'contracts',
  'contract_occupants',
  'tenant_vehicles',
  'deposit_ledgers',
  'meter_readings',
  'invoices',
  'payment_transactions',
  'checkout_settlements',
  'pccc_compliance_logs',
];

const SYSTEM_SENTINEL = '00000000-0000-0000-0000-000000000000';

export class AlignRentalBuildingScope1792160000000 implements MigrationInterface {
  name = 'AlignRentalBuildingScope1792160000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- audit_logs ---------------------------------------------------------
    await queryRunner.query(`ALTER TABLE "audit_logs" RENAME COLUMN "tenant_id" TO "building_id"`);
    await queryRunner.query(`ALTER TABLE "audit_logs" ALTER COLUMN "building_id" DROP NOT NULL`);
    // Trigger WORM chặn UPDATE: tạm tắt trong transaction của migration để chuẩn hóa sentinel → NULL
    await queryRunner.query(`ALTER TABLE "audit_logs" DISABLE TRIGGER audit_logs_worm_row`);
    await queryRunner.query(`UPDATE "audit_logs" SET "building_id" = NULL WHERE "building_id" = $1`, [SYSTEM_SENTINEL]);
    await queryRunner.query(`ALTER TABLE "audit_logs" ENABLE TRIGGER audit_logs_worm_row`);
    await queryRunner.query(`ALTER TRIGGER audit_logs_worm_row ON "audit_logs" RENAME TO trg_audit_logs_immutable`);
    await queryRunner.query(`ALTER TRIGGER audit_logs_worm_truncate ON "audit_logs" RENAME TO trg_audit_logs_immutable_truncate`);

    await queryRunner.query(`ALTER INDEX "idx_audit_logs_tenant_created" RENAME TO "idx_audit_bld_created"`);
    await queryRunner.query(`ALTER INDEX "idx_audit_logs_actor_created" RENAME TO "idx_audit_actor_created_desc"`);
    await queryRunner.query(`ALTER INDEX "idx_audit_logs_department_created" RENAME TO "idx_audit_department_created"`);
    await queryRunner.query(`DROP INDEX "public"."idx_audit_logs_resource"`);
    await queryRunner.query(
      `CREATE INDEX "idx_audit_bld_resource" ON "audit_logs" ("building_id", "resource", "resource_id")`,
    );
    await queryRunner.query(`CREATE INDEX "idx_audit_created_tiering" ON "audit_logs" ("created_at")`);

    // ---- outbox_events ------------------------------------------------------
    await queryRunner.query(`ALTER TABLE "outbox_events" RENAME COLUMN "tenant_id" TO "building_id"`);
    await queryRunner.query(`ALTER TABLE "outbox_events" ALTER COLUMN "building_id" DROP NOT NULL`);
    await queryRunner.query(`UPDATE "outbox_events" SET "building_id" = NULL WHERE "building_id" = $1`, [SYSTEM_SENTINEL]);
    await queryRunner.query(`ALTER INDEX "idx_outbox_events_dispatch" RENAME TO "idx_outbox_poll_pending"`);
    await queryRunner.query(`ALTER INDEX "idx_outbox_events_tenant_created" RENAME TO "idx_outbox_bld_created"`);
    await queryRunner.query(`ALTER INDEX "idx_outbox_events_aggregate" RENAME TO "idx_outbox_aggregate"`);

    // ---- Row-Level Security theo tòa nhà -----------------------------------
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION setup_building_rls(target_table TEXT)
      RETURNS VOID AS $$
      BEGIN
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', target_table);
        -- FORCE: áp cả với table owner (role của connection pool không thể vô tình bypass)
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', target_table);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_policy ON %I;', target_table);
        EXECUTE format('
          CREATE POLICY tenant_isolation_policy ON %I
          AS PERMISSIVE
          FOR ALL
          TO PUBLIC
          USING (
            current_setting(''app.bypass_rls'', true) = ''on''
            OR building_id = NULLIF(current_setting(''app.current_building_id'', true), '''')::uuid
          )
          WITH CHECK (
            current_setting(''app.bypass_rls'', true) = ''on''
            OR building_id = NULLIF(current_setting(''app.current_building_id'', true), '''')::uuid
          );
        ', target_table);
      END;
      $$ LANGUAGE plpgsql;
    `);

    // Bảng nghiệp vụ do migration của từng domain module tạo; áp policy cho bảng nào đã có cột building_id
    await queryRunner.query(
      `
      DO $$
      DECLARE tbl text;
      BEGIN
        FOREACH tbl IN ARRAY $1::text[] LOOP
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = tbl AND column_name = 'building_id'
          ) THEN
            PERFORM setup_building_rls(tbl);
          END IF;
        END LOOP;
      END $$;
    `.replace('$1::text[]', `ARRAY[${BUILDING_SCOPED_TABLES.map((t) => `'${t}'`).join(', ')}]`),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of BUILDING_SCOPED_TABLES) {
      await queryRunner.query(`
        DO $$
        BEGIN
          IF to_regclass('${table}') IS NOT NULL THEN
            DROP POLICY IF EXISTS tenant_isolation_policy ON "${table}";
            ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY;
            ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY;
          END IF;
        END $$;
      `);
    }
    await queryRunner.query(`DROP FUNCTION IF EXISTS setup_building_rls(TEXT)`);

    await queryRunner.query(`ALTER INDEX "idx_outbox_aggregate" RENAME TO "idx_outbox_events_aggregate"`);
    await queryRunner.query(`ALTER INDEX "idx_outbox_bld_created" RENAME TO "idx_outbox_events_tenant_created"`);
    await queryRunner.query(`ALTER INDEX "idx_outbox_poll_pending" RENAME TO "idx_outbox_events_dispatch"`);
    await queryRunner.query(`UPDATE "outbox_events" SET "building_id" = $1 WHERE "building_id" IS NULL`, [SYSTEM_SENTINEL]);
    await queryRunner.query(`ALTER TABLE "outbox_events" ALTER COLUMN "building_id" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "outbox_events" RENAME COLUMN "building_id" TO "tenant_id"`);

    await queryRunner.query(`DROP INDEX "public"."idx_audit_created_tiering"`);
    await queryRunner.query(`DROP INDEX "public"."idx_audit_bld_resource"`);
    await queryRunner.query(`CREATE INDEX "idx_audit_logs_resource" ON "audit_logs" ("resource", "resource_id")`);
    await queryRunner.query(`ALTER INDEX "idx_audit_department_created" RENAME TO "idx_audit_logs_department_created"`);
    await queryRunner.query(`ALTER INDEX "idx_audit_actor_created_desc" RENAME TO "idx_audit_logs_actor_created"`);
    await queryRunner.query(`ALTER INDEX "idx_audit_bld_created" RENAME TO "idx_audit_logs_tenant_created"`);

    await queryRunner.query(`ALTER TRIGGER trg_audit_logs_immutable_truncate ON "audit_logs" RENAME TO audit_logs_worm_truncate`);
    await queryRunner.query(`ALTER TRIGGER trg_audit_logs_immutable ON "audit_logs" RENAME TO audit_logs_worm_row`);
    await queryRunner.query(`ALTER TABLE "audit_logs" DISABLE TRIGGER audit_logs_worm_row`);
    await queryRunner.query(`UPDATE "audit_logs" SET "building_id" = $1 WHERE "building_id" IS NULL`, [SYSTEM_SENTINEL]);
    await queryRunner.query(`ALTER TABLE "audit_logs" ENABLE TRIGGER audit_logs_worm_row`);
    await queryRunner.query(`ALTER TABLE "audit_logs" ALTER COLUMN "building_id" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "audit_logs" RENAME COLUMN "building_id" TO "tenant_id"`);
  }
}
