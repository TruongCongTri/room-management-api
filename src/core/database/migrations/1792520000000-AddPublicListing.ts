import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 1b - Website giới thiệu (tài liệu 03, mục 4 6b; tài liệu 04, mục 1.5):
 *  - buildings.is_publicly_listed / public_slug / public_description: tòa nhà CHỦ ĐỘNG công khai, địa chỉ bằng slug.
 *    Kernel chặn: slug sai định dạng, slug trùng (unique một phần), bật công khai mà không có slug.
 *  - rooms.is_publicly_listed (mặc định true): ẩn từng phòng khỏi /public/*.
 */
export class AddPublicListing1792520000000 implements MigrationInterface {
  name = 'AddPublicListing1792520000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "buildings" ADD "is_publicly_listed" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "buildings" ADD "public_slug" character varying(80)`);
    await queryRunner.query(`ALTER TABLE "buildings" ADD "public_description" text`);
    await queryRunner.query(`ALTER TABLE "rooms" ADD "is_publicly_listed" boolean NOT NULL DEFAULT true`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_buildings_public_slug_unique" ON "buildings" ("public_slug") WHERE "public_slug" IS NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "buildings" ADD CONSTRAINT "chk_buildings_listed_has_slug" CHECK (NOT "is_publicly_listed" OR "public_slug" IS NOT NULL)`,
    );
    await queryRunner.query(
      `ALTER TABLE "buildings" ADD CONSTRAINT "chk_buildings_public_slug" CHECK ("public_slug" IS NULL OR "public_slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "buildings" DROP CONSTRAINT "chk_buildings_public_slug"`);
    await queryRunner.query(`ALTER TABLE "buildings" DROP CONSTRAINT "chk_buildings_listed_has_slug"`);
    await queryRunner.query(`DROP INDEX "public"."idx_buildings_public_slug_unique"`);
    await queryRunner.query(`ALTER TABLE "rooms" DROP COLUMN "is_publicly_listed"`);
    await queryRunner.query(`ALTER TABLE "buildings" DROP COLUMN "public_description"`);
    await queryRunner.query(`ALTER TABLE "buildings" DROP COLUMN "public_slug"`);
    await queryRunner.query(`ALTER TABLE "buildings" DROP COLUMN "is_publicly_listed"`);
  }
}
