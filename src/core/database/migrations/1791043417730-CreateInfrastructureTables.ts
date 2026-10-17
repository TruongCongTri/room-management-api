import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bảng hạ tầng dùng chung:
 *  - audit_logs:    nhật ký kiểm toán bất biến (WORM) - trigger chặn UPDATE / DELETE / TRUNCATE.
 *                   Chỉ AuditTieringService được xóa lô đã lưu trữ sang cold storage, bằng cờ
 *                   giao dịch `SET LOCAL app.audit_tiering = 'on'`.
 *                   Khuyến nghị production: REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM <app_role>
 *                   và chạy job tiering bằng role riêng.
 *  - outbox_events: Transactional Outbox (relay at-least-once qua poller FOR UPDATE SKIP LOCKED).
 *
 * DDL bảng/index được sinh bởi `migration:generate` để khớp tuyệt đối với Entity metadata.
 */
export class CreateInfrastructureTables1791043417730 implements MigrationInterface {
  name = 'CreateInfrastructureTables1791043417730';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- audit_logs ---------------------------------------------------------
    await queryRunner.query(
      `CREATE TYPE "public"."audit_logs_action_enum" AS ENUM('CREATE', 'UPDATE', 'DELETE', 'RESTORE', 'EXECUTE')`,
    );
    await queryRunner.query(
      `CREATE TABLE "audit_logs" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "actor_id" character varying(100) NOT NULL, "actor_email" character varying(255), "department_id" character varying(100), "action" "public"."audit_logs_action_enum" NOT NULL, "resource" character varying(255) NOT NULL, "resource_id" character varying(255) NOT NULL, "diff_snapshot" jsonb, "metadata" jsonb, "trace_id" character varying(128) NOT NULL, "client_ip" character varying(45) NOT NULL, "user_agent" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_1bb179d048bbc581caa3b013439" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_audit_logs_department_created" ON "audit_logs"  ("department_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_audit_logs_actor_created" ON "audit_logs"  ("actor_id", "created_at") `,
    );
    await queryRunner.query(`CREATE INDEX "idx_audit_logs_resource" ON "audit_logs"  ("resource", "resource_id") `);
    await queryRunner.query(
      `CREATE INDEX "idx_audit_logs_tenant_created" ON "audit_logs"  ("tenant_id", "created_at") `,
    );

    // WORM: Write Once, Read Many - chặn sửa/xóa ở tầng database kernel
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION audit_logs_worm_guard() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' AND current_setting('app.audit_tiering', true) = 'on' THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'audit_logs is append-only (WORM): % is not allowed', TG_OP
          USING ERRCODE = 'insufficient_privilege';
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER audit_logs_worm_row
        BEFORE UPDATE OR DELETE ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION audit_logs_worm_guard()
    `);
    await queryRunner.query(`
      CREATE TRIGGER audit_logs_worm_truncate
        BEFORE TRUNCATE ON audit_logs
        FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_worm_guard()
    `);

    // ---- outbox_events ------------------------------------------------------
    await queryRunner.query(
      `CREATE TYPE "public"."outbox_events_status_enum" AS ENUM('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED', 'DEAD_LETTER')`,
    );
    await queryRunner.query(
      `CREATE TABLE "outbox_events" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenant_id" uuid NOT NULL, "aggregate_type" character varying(100) NOT NULL, "aggregate_id" character varying(100) NOT NULL, "event_type" character varying(150) NOT NULL, "payload" jsonb NOT NULL, "status" "public"."outbox_events_status_enum" NOT NULL DEFAULT 'PENDING', "retry_count" integer NOT NULL DEFAULT '0', "max_retries" integer NOT NULL DEFAULT '5', "next_retry_at" TIMESTAMP WITH TIME ZONE, "trace_id" character varying(128) NOT NULL, "traceparent" character varying(64), "actor_id" character varying(100), "last_error" text, "processed_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_6689a16c00d09b8089f6237f1d2" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_outbox_events_aggregate" ON "outbox_events"  ("aggregate_type", "aggregate_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_outbox_events_tenant_created" ON "outbox_events"  ("tenant_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_outbox_events_dispatch" ON "outbox_events"  ("status", "next_retry_at", "created_at") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_outbox_events_dispatch"`);
    await queryRunner.query(`DROP INDEX "public"."idx_outbox_events_tenant_created"`);
    await queryRunner.query(`DROP INDEX "public"."idx_outbox_events_aggregate"`);
    await queryRunner.query(`DROP TABLE "outbox_events"`);
    await queryRunner.query(`DROP TYPE "public"."outbox_events_status_enum"`);

    await queryRunner.query(`DROP TRIGGER IF EXISTS audit_logs_worm_truncate ON audit_logs`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS audit_logs_worm_row ON audit_logs`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS audit_logs_worm_guard()`);
    await queryRunner.query(`DROP INDEX "public"."idx_audit_logs_tenant_created"`);
    await queryRunner.query(`DROP INDEX "public"."idx_audit_logs_resource"`);
    await queryRunner.query(`DROP INDEX "public"."idx_audit_logs_actor_created"`);
    await queryRunner.query(`DROP INDEX "public"."idx_audit_logs_department_created"`);
    await queryRunner.query(`DROP TABLE "audit_logs"`);
    await queryRunner.query(`DROP TYPE "public"."audit_logs_action_enum"`);
  }
}
