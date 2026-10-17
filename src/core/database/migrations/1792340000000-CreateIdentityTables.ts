import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 0 - Identity (tài liệu 03, mục 3.0): đăng nhập bằng số điện thoại, vai trò, quyền truy cập tòa nhà
 * và phiên đăng nhập (refresh token xoay vòng). Bảng TOÀN CỤC, không RLS: đăng nhập diễn ra TRƯỚC khi chọn tòa nhà.
 *
 *  - users.phone_e164 duy nhất trong các tài khoản còn sống (xóa mềm giải phóng số điện thoại).
 *  - Tài khoản ACTIVE bắt buộc có mật khẩu; phiên bị thu hồi bắt buộc có lý do (và ngược lại).
 *  - FK user_building_access → buildings được thêm ở migration Properties (module 1), khi bảng buildings tồn tại.
 *  - tenants.user_id + idx_tenants_bld_user_unique được thêm ở migration Tenants (module 2).
 *  - audit_logs.actor_email → actor_label: người thực hiện được ghi bằng số điện thoại ĐÃ CHE, không còn email.
 */
export class CreateIdentityTables1792340000000 implements MigrationInterface {
  name = 'CreateIdentityTables1792340000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."users_status_enum" AS ENUM('PENDING_ACTIVATION', 'ACTIVE', 'DISABLED')`,
    );
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        "version" integer NOT NULL DEFAULT 1,
        "phone_e164" character varying(16) NOT NULL,
        "phone_verified_at" TIMESTAMP WITH TIME ZONE,
        "full_name" character varying(150) NOT NULL,
        "password_hash" character varying(255),
        "password_changed_at" TIMESTAMP WITH TIME ZONE,
        "status" "public"."users_status_enum" NOT NULL DEFAULT 'PENDING_ACTIVATION',
        "last_login_at" TIMESTAMP WITH TIME ZONE,
        "preferred_locale" character varying(10) NOT NULL DEFAULT 'vi-VN',
        CONSTRAINT "PK_users" PRIMARY KEY ("id"),
        CONSTRAINT "chk_users_phone_e164" CHECK ("phone_e164" ~ '^\\+[1-9][0-9]{7,14}$'),
        CONSTRAINT "chk_users_active_has_password" CHECK ("status" <> 'ACTIVE' OR "password_hash" IS NOT NULL)
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_users_phone_unique" ON "users" ("phone_e164") WHERE "deleted_at" IS NULL`,
    );

    await queryRunner.query(`
      CREATE TABLE "user_roles" (
        "user_id" uuid NOT NULL,
        "role_code" character varying(50) NOT NULL,
        "granted_by" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_user_roles" PRIMARY KEY ("user_id", "role_code"),
        CONSTRAINT "FK_user_roles_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_user_roles_role" FOREIGN KEY ("role_code") REFERENCES "system_roles"("code")
      )`);
    await queryRunner.query(`CREATE INDEX "idx_user_roles_role" ON "user_roles" ("role_code")`);

    await queryRunner.query(`
      CREATE TABLE "user_building_access" (
        "user_id" uuid NOT NULL,
        "building_id" uuid NOT NULL,
        "granted_by" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_user_building_access" PRIMARY KEY ("user_id", "building_id"),
        CONSTRAINT "FK_user_building_access_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_user_building_access_building" ON "user_building_access" ("building_id")`,
    );

    await queryRunner.query(`
      CREATE TYPE "public"."auth_sessions_revoked_reason_enum" AS ENUM(
        'LOGOUT', 'LOGOUT_ALL', 'ROTATION_REUSE_DETECTED', 'PASSWORD_CHANGED', 'PASSWORD_RESET',
        'ACCESS_REDUCED', 'ACCOUNT_DISABLED', 'REVOKED_BY_USER'
      )`);
    await queryRunner.query(`
      CREATE TABLE "auth_sessions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "refresh_token_hash" character(64) NOT NULL,
        "previous_refresh_token_hash" character(64),
        "rotation_count" integer NOT NULL DEFAULT 0,
        "device_id" character varying(100),
        "device_name" character varying(150),
        "user_agent" text,
        "ip_address" character varying(45) NOT NULL,
        "mfa_verified_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "last_used_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "idle_expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "absolute_expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "revoked_at" TIMESTAMP WITH TIME ZONE,
        "revoked_reason" "public"."auth_sessions_revoked_reason_enum",
        CONSTRAINT "PK_auth_sessions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_auth_sessions_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "chk_sessions_expiry" CHECK ("absolute_expires_at" > "created_at" AND "idle_expires_at" <= "absolute_expires_at"),
        CONSTRAINT "chk_sessions_revocation" CHECK (("revoked_at" IS NULL) = ("revoked_reason" IS NULL))
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_auth_sessions_user_active" ON "auth_sessions" ("user_id", "last_used_at") WHERE "revoked_at" IS NULL`,
    );

    await queryRunner.query(`ALTER TABLE "audit_logs" RENAME COLUMN "actor_email" TO "actor_label"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "audit_logs" RENAME COLUMN "actor_label" TO "actor_email"`);
    await queryRunner.query(`DROP TABLE "auth_sessions"`);
    await queryRunner.query(`DROP TYPE "public"."auth_sessions_revoked_reason_enum"`);
    await queryRunner.query(`DROP TABLE "user_building_access"`);
    await queryRunner.query(`DROP TABLE "user_roles"`);
    await queryRunner.query(`DROP TABLE "users"`);
    await queryRunner.query(`DROP TYPE "public"."users_status_enum"`);
  }
}
