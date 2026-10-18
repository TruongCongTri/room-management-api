import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 3 - Contracts (tài liệu 03, mục 3.2 #7-#13 + 3.2b, mục 4 6d - quyết định D8).
 *  - Hợp đồng (nháp → hiệu lực → gia hạn), người ở, lịch sử người đứng tên, gia hạn, thiết bị cho thuê, danh mục dịch vụ,
 *    dịch vụ của hợp đồng, xe, sổ cái tiền cọc - mọi bảng thuộc một tòa nhà (RLS) và tham chiếu cha bằng FK tổng hợp
 *    (building_id, x_id) → cha (building_id, id).
 *  - Kernel: một hợp đồng ACTIVE và một DRAFT mỗi phòng; một người đứng tên ACTIVE mỗi hợp đồng; một người chỉ ở một
 *    phòng; primary_tenant_id = người đứng tên ACTIVE (trigger hoãn tới COMMIT); sổ cái tiền cọc bất biến.
 *  - rooms.current_contract_id → contracts (cùng tòa nhà).
 */
export class CreateContractsTables1792700000000 implements MigrationInterface {
  name = 'CreateContractsTables1792700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "public"."contracts_deposit_status_enum" AS ENUM('PENDING_COLLECTION', 'HELD', 'PARTIALLY_REFUNDED', 'FULLY_REFUNDED', 'FORFEITED')`);
    await queryRunner.query(`CREATE TYPE "public"."contracts_status_enum" AS ENUM('DRAFT', 'ACTIVE', 'CANCELLED', 'TERMINATED', 'EXPIRED')`);
    await queryRunner.query(`CREATE TABLE "contracts" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "building_id" uuid NOT NULL, "contract_code" character varying(50) NOT NULL, "room_id" uuid NOT NULL, "primary_tenant_id" uuid NOT NULL, "start_date" date NOT NULL, "end_date" date NOT NULL, "actual_checkout_date" date, "monthly_room_rent" numeric(12,2) NOT NULL, "deposit_amount" numeric(12,2) NOT NULL, "deposit_status" "public"."contracts_deposit_status_enum" NOT NULL DEFAULT 'PENDING_COLLECTION', "payment_due_day" smallint NOT NULL DEFAULT '5', "registered_evn_quota_headcount" smallint NOT NULL DEFAULT '0', "pccc_commitment_signed" boolean NOT NULL DEFAULT false, "signed_contract_pdf_s3_key" character varying(255), "status" "public"."contracts_status_enum" NOT NULL DEFAULT 'DRAFT', "planned_co_occupants" jsonb, "activated_at" TIMESTAMP WITH TIME ZONE, "cancelled_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "uq_contracts_bld_id" UNIQUE ("building_id", "id"), CONSTRAINT "chk_contracts_active_deposit" CHECK ("status" <> 'ACTIVE' OR "deposit_status" <> 'PENDING_COLLECTION'), CONSTRAINT "chk_contracts_cancelled" CHECK (("cancelled_at" IS NOT NULL) = ("status" = 'CANCELLED')), CONSTRAINT "chk_contracts_activated" CHECK (("activated_at" IS NULL) = ("status" IN ('DRAFT', 'CANCELLED'))), CONSTRAINT "chk_contracts_plan_only_draft" CHECK ("status" = 'DRAFT' OR "planned_co_occupants" IS NULL), CONSTRAINT "chk_contracts_payment_due_day" CHECK ("payment_due_day" BETWEEN 1 AND 28), CONSTRAINT "chk_contracts_quota_headcount" CHECK ("registered_evn_quota_headcount" >= 0), CONSTRAINT "chk_contracts_positive_rent" CHECK ("monthly_room_rent" > 0 AND "deposit_amount" >= 0), CONSTRAINT "chk_contracts_valid_dates" CHECK ("end_date" > "start_date"), CONSTRAINT "PK_2c7b8f3a7b1acdd49497d83d0fb" PRIMARY KEY ("id"))`);
    await queryRunner.query(`CREATE INDEX "IDX_8e9444fd0642cf9fd216349c73" ON "contracts"  ("building_id") `);
    await queryRunner.query(`CREATE UNIQUE INDEX "idx_unique_draft_contract_per_room" ON "contracts"  ("room_id") WHERE "status" = 'DRAFT' AND "deleted_at" IS NULL`);
    await queryRunner.query(`CREATE UNIQUE INDEX "idx_unique_active_contract_per_room" ON "contracts"  ("room_id") WHERE "status" = 'ACTIVE' AND "deleted_at" IS NULL`);
    await queryRunner.query(`CREATE UNIQUE INDEX "idx_contracts_bld_code_unique" ON "contracts"  ("building_id", "contract_code") `);
    await queryRunner.query(`CREATE INDEX "idx_contracts_dates" ON "contracts"  ("building_id", "start_date", "end_date") `);
    await queryRunner.query(`CREATE INDEX "idx_contracts_primary_tenant" ON "contracts"  ("primary_tenant_id") `);
    await queryRunner.query(`CREATE INDEX "idx_contracts_bld_status_room" ON "contracts"  ("building_id", "status", "room_id") `);
    await queryRunner.query(`CREATE TYPE "public"."contract_assets_handover_condition_enum" AS ENUM('GRADE_A_NEW', 'GRADE_B_GOOD', 'GRADE_C_FAIR', 'BROKEN')`);
    await queryRunner.query(`CREATE TYPE "public"."contract_assets_checkout_condition_enum" AS ENUM('GRADE_A_NEW', 'GRADE_B_GOOD', 'GRADE_C_FAIR', 'BROKEN')`);
    await queryRunner.query(`CREATE TABLE "contract_assets" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "building_id" uuid NOT NULL, "contract_id" uuid NOT NULL, "room_asset_id" uuid NOT NULL, "agreed_monthly_fee" numeric(12,2) NOT NULL, "handover_condition" "public"."contract_assets_handover_condition_enum" NOT NULL, "checkout_condition" "public"."contract_assets_checkout_condition_enum", CONSTRAINT "chk_contract_assets_fee" CHECK ("agreed_monthly_fee" >= 0), CONSTRAINT "PK_a3c099bbb535de5a0835096b95f" PRIMARY KEY ("id"))`);
    await queryRunner.query(`CREATE INDEX "IDX_88f2b0730824ef2078cfa1a7f0" ON "contract_assets"  ("building_id") `);
    await queryRunner.query(`CREATE INDEX "idx_contract_assets_room_asset" ON "contract_assets"  ("room_asset_id") `);
    await queryRunner.query(`CREATE UNIQUE INDEX "idx_contract_assets_contract_room_asset" ON "contract_assets"  ("contract_id", "room_asset_id") WHERE "deleted_at" IS NULL`);
    await queryRunner.query(`CREATE TYPE "public"."contract_occupants_role_enum" AS ENUM('PRIMARY_HOLDER', 'CO_OCCUPANT')`);
    await queryRunner.query(`CREATE TYPE "public"."contract_occupants_status_enum" AS ENUM('ACTIVE', 'MOVED_OUT')`);
    await queryRunner.query(`CREATE TYPE "public"."contract_occupants_residence_channel_enum" AS ENUM('CT01', 'FOREIGNER_TEMPORARY_RESIDENCE')`);
    await queryRunner.query(`CREATE TYPE "public"."contract_occupants_residency_status_enum" AS ENUM('PENDING_DECLARATION', 'SUBMITTED', 'REGISTERED', 'DEREGISTRATION_PENDING', 'DEREGISTERED')`);
    await queryRunner.query(`CREATE TABLE "contract_occupants" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "building_id" uuid NOT NULL, "contract_id" uuid NOT NULL, "tenant_id" uuid NOT NULL, "role" "public"."contract_occupants_role_enum" NOT NULL DEFAULT 'CO_OCCUPANT', "status" "public"."contract_occupants_status_enum" NOT NULL DEFAULT 'ACTIVE', "moved_in_at" date NOT NULL, "moved_out_at" date, "succession_order" smallint, "relationship_to_holder" character varying(50), "residence_channel" "public"."contract_occupants_residence_channel_enum" NOT NULL DEFAULT 'CT01', "residency_status" "public"."contract_occupants_residency_status_enum" NOT NULL DEFAULT 'PENDING_DECLARATION', "residence_submitted_at" TIMESTAMP WITH TIME ZONE, "residence_registered_at" TIMESTAMP WITH TIME ZONE, "residence_deregistered_at" TIMESTAMP WITH TIME ZONE, "temporary_stay_valid_until" date, "residence_reference_no" character varying(50), "ct01_document_key" character varying(255), CONSTRAINT "chk_occupants_succession_order" CHECK ("succession_order" IS NULL OR "succession_order" >= 1), CONSTRAINT "chk_occupants_holder_active" CHECK ("role" <> 'PRIMARY_HOLDER' OR "status" = 'ACTIVE'), CONSTRAINT "chk_occupants_move_dates" CHECK ("moved_out_at" IS NULL OR "moved_out_at" >= "moved_in_at"), CONSTRAINT "chk_occupants_move_out_consistent" CHECK (("status" = 'MOVED_OUT') = ("moved_out_at" IS NOT NULL)), CONSTRAINT "PK_f662ee64e97b2f276e2ce1537e0" PRIMARY KEY ("id"))`);
    await queryRunner.query(`CREATE INDEX "IDX_d529fce97ca8f7ed9aab193dbc" ON "contract_occupants"  ("building_id") `);
    await queryRunner.query(`CREATE INDEX "idx_occupants_residence_pending" ON "contract_occupants"  ("building_id", "residency_status") WHERE "residency_status" IN ('PENDING_DECLARATION', 'DEREGISTRATION_PENDING')`);
    await queryRunner.query(`CREATE UNIQUE INDEX "idx_occupants_tenant_one_active" ON "contract_occupants"  ("tenant_id") WHERE "status" = 'ACTIVE' AND "deleted_at" IS NULL`);
    await queryRunner.query(`CREATE UNIQUE INDEX "idx_occupants_one_active_holder" ON "contract_occupants"  ("contract_id") WHERE "role" = 'PRIMARY_HOLDER' AND "status" = 'ACTIVE' AND "deleted_at" IS NULL`);
    await queryRunner.query(`CREATE INDEX "idx_occupants_bld_residency" ON "contract_occupants"  ("building_id", "residency_status") `);
    await queryRunner.query(`CREATE INDEX "idx_occupants_contract_status" ON "contract_occupants"  ("contract_id", "status") `);
    await queryRunner.query(`CREATE TYPE "public"."contract_holder_transfers_reason_enum" AS ENUM('HOLDER_MOVED_OUT', 'MUTUAL_AGREEMENT')`);
    await queryRunner.query(`CREATE TYPE "public"."contract_holder_transfers_selection_enum" AS ENUM('DESIGNATED', 'AUTO_SUCCESSION')`);
    await queryRunner.query(`CREATE TYPE "public"."contract_holder_transfers_deposit_handling_enum" AS ENUM('CARRY_OVER', 'REFUND_AND_RECOLLECT')`);
    await queryRunner.query(`CREATE TABLE "contract_holder_transfers" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "building_id" uuid NOT NULL, "contract_id" uuid NOT NULL, "from_tenant_id" uuid NOT NULL, "to_tenant_id" uuid NOT NULL, "effective_date" date NOT NULL, "reason" "public"."contract_holder_transfers_reason_enum" NOT NULL, "selection" "public"."contract_holder_transfers_selection_enum" NOT NULL, "deposit_handling" "public"."contract_holder_transfers_deposit_handling_enum" NOT NULL, "outstanding_balance" numeric(12,2) NOT NULL DEFAULT '0', "outstanding_balance_assumed_by" character varying(20) NOT NULL, "addendum_no" character varying(50) NOT NULL, "addendum_pdf_key" character varying(255), "approved_by_id" uuid NOT NULL, "notes" text, CONSTRAINT "chk_holder_transfer_assumed_by" CHECK ("outstanding_balance_assumed_by" IN ('OUTGOING_HOLDER', 'INCOMING_HOLDER')), CONSTRAINT "chk_holder_transfer_outstanding" CHECK ("outstanding_balance" >= 0), CONSTRAINT "chk_holder_transfer_distinct" CHECK ("from_tenant_id" <> "to_tenant_id"), CONSTRAINT "PK_71d85969443a5968b59fdc05f4e" PRIMARY KEY ("id"))`);
    await queryRunner.query(`CREATE INDEX "IDX_cdde32b6f6b4aabeba753d56b7" ON "contract_holder_transfers"  ("building_id") `);
    await queryRunner.query(`CREATE UNIQUE INDEX "idx_holder_transfers_bld_addendum_unique" ON "contract_holder_transfers"  ("building_id", "addendum_no") `);
    await queryRunner.query(`CREATE INDEX "idx_holder_transfers_contract_date" ON "contract_holder_transfers"  ("contract_id", "effective_date") `);
    await queryRunner.query(`CREATE TABLE "contract_renewals" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "building_id" uuid NOT NULL, "contract_id" uuid NOT NULL, "previous_end_date" date NOT NULL, "new_end_date" date NOT NULL, "effective_date" date NOT NULL, "previous_monthly_rent" numeric(12,2) NOT NULL, "new_monthly_rent" numeric(12,2) NOT NULL, "deposit_top_up_amount" numeric(12,2) NOT NULL DEFAULT '0', "addendum_no" character varying(50) NOT NULL, "approved_by_id" uuid NOT NULL, "notes" text, CONSTRAINT "chk_renewals_values" CHECK ("new_end_date" > "previous_end_date" AND "new_monthly_rent" > 0 AND "previous_monthly_rent" > 0 AND "deposit_top_up_amount" >= 0 AND "effective_date" = "previous_end_date" + 1), CONSTRAINT "PK_f7817459d0bbd552bc3ce4aedbc" PRIMARY KEY ("id"))`);
    await queryRunner.query(`CREATE INDEX "IDX_256ef929b17897e7682e504646" ON "contract_renewals"  ("building_id") `);
    await queryRunner.query(`CREATE UNIQUE INDEX "idx_renewals_bld_addendum_unique" ON "contract_renewals"  ("building_id", "addendum_no") `);
    await queryRunner.query(`CREATE INDEX "idx_renewals_contract_effective" ON "contract_renewals"  ("contract_id", "effective_date") `);
    await queryRunner.query(`CREATE TYPE "public"."service_catalogs_charge_unit_enum" AS ENUM('PER_ROOM_MONTH', 'PER_PERSON_MONTH', 'PER_VEHICLE_MONTH')`);
    await queryRunner.query(`CREATE TYPE "public"."service_catalogs_vehicle_type_enum" AS ENUM('MOTORBIKE', 'ELECTRIC_BIKE', 'BICYCLE', 'CAR')`);
    await queryRunner.query(`CREATE TABLE "service_catalogs" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "building_id" uuid NOT NULL, "code" character varying(50) NOT NULL, "name" character varying(100) NOT NULL, "charge_unit" "public"."service_catalogs_charge_unit_enum" NOT NULL, "vehicle_type" "public"."service_catalogs_vehicle_type_enum", "default_unit_price" numeric(12,2) NOT NULL, "is_proratable_on_checkout" boolean NOT NULL DEFAULT true, CONSTRAINT "uq_service_catalogs_bld_id" UNIQUE ("building_id", "id"), CONSTRAINT "chk_service_catalogs_vehicle" CHECK (("charge_unit" = 'PER_VEHICLE_MONTH') = ("vehicle_type" IS NOT NULL)), CONSTRAINT "chk_service_catalogs_price" CHECK ("default_unit_price" >= 0), CONSTRAINT "chk_service_catalogs_code" CHECK ("code" ~ '^[A-Z][A-Z0-9_]{1,49}$'), CONSTRAINT "PK_d0f1e6450123096aaae950913c9" PRIMARY KEY ("id"))`);
    await queryRunner.query(`CREATE INDEX "IDX_eabd2e4ea48554811c3135d5ad" ON "service_catalogs"  ("building_id") `);
    await queryRunner.query(`CREATE UNIQUE INDEX "idx_service_catalogs_bld_vehicle_unique" ON "service_catalogs"  ("building_id", "vehicle_type") WHERE "vehicle_type" IS NOT NULL AND "deleted_at" IS NULL`);
    await queryRunner.query(`CREATE UNIQUE INDEX "idx_service_catalogs_bld_code_unique" ON "service_catalogs"  ("building_id", "code") WHERE "deleted_at" IS NULL`);
    await queryRunner.query(`CREATE TYPE "public"."contract_services_charge_unit_enum" AS ENUM('PER_ROOM_MONTH', 'PER_PERSON_MONTH', 'PER_VEHICLE_MONTH')`);
    await queryRunner.query(`CREATE TABLE "contract_services" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "building_id" uuid NOT NULL, "contract_id" uuid NOT NULL, "service_catalog_id" uuid NOT NULL, "service_code" character varying(50) NOT NULL, "charge_unit" "public"."contract_services_charge_unit_enum" NOT NULL, "quantity" smallint NOT NULL DEFAULT '1', "agreed_unit_price" numeric(12,2) NOT NULL, CONSTRAINT "chk_contract_services_values" CHECK ("quantity" >= 1 AND "agreed_unit_price" >= 0), CONSTRAINT "PK_45f045ee7b47452e187cafbd37e" PRIMARY KEY ("id"))`);
    await queryRunner.query(`CREATE INDEX "IDX_ce43bb357818a383ecc43d92fe" ON "contract_services"  ("building_id") `);
    await queryRunner.query(`CREATE UNIQUE INDEX "idx_contract_services_contract_catalog_unique" ON "contract_services"  ("contract_id", "service_catalog_id") WHERE "deleted_at" IS NULL`);
    await queryRunner.query(`CREATE INDEX "idx_contract_services_contract_id" ON "contract_services"  ("contract_id") `);
    await queryRunner.query(`CREATE TYPE "public"."deposit_ledgers_transaction_type_enum" AS ENUM('INITIAL_COLLECTION', 'TOP_UP', 'CHECKOUT_DEDUCTION', 'SURPLUS_REFUND', 'FORFEITURE', 'HOLDER_TRANSFER_CARRY_OVER', 'HOLDER_TRANSFER_REFUND', 'HOLDER_TRANSFER_COLLECTION')`);
    await queryRunner.query(`CREATE TABLE "deposit_ledgers" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "building_id" uuid NOT NULL, "contract_id" uuid NOT NULL, "entry_no" integer NOT NULL, "transaction_type" "public"."deposit_ledgers_transaction_type_enum" NOT NULL, "amount" numeric(12,2) NOT NULL, "balance_after" numeric(12,2) NOT NULL, "counterparty_tenant_id" uuid NOT NULL, "holder_transfer_id" uuid, "recorded_by_id" uuid NOT NULL, "notes" character varying(255), CONSTRAINT "chk_deposit_ledgers_transfer_ref" CHECK (("transaction_type"::text LIKE 'HOLDER_TRANSFER_%') = ("holder_transfer_id" IS NOT NULL)), CONSTRAINT "chk_deposit_ledgers_sign" CHECK (("transaction_type" IN ('INITIAL_COLLECTION', 'TOP_UP', 'HOLDER_TRANSFER_COLLECTION') AND "amount" > 0) OR ("transaction_type" IN ('CHECKOUT_DEDUCTION', 'SURPLUS_REFUND', 'FORFEITURE', 'HOLDER_TRANSFER_REFUND') AND "amount" < 0) OR ("transaction_type" = 'HOLDER_TRANSFER_CARRY_OVER' AND "amount" = 0)), CONSTRAINT "chk_deposit_ledgers_balance" CHECK ("balance_after" >= 0), CONSTRAINT "PK_7031580584c328b2f4b6f98a7c2" PRIMARY KEY ("id"))`);
    await queryRunner.query(`CREATE INDEX "IDX_40654c1b332918491dbe276b96" ON "deposit_ledgers"  ("building_id") `);
    await queryRunner.query(`CREATE UNIQUE INDEX "idx_deposit_ledgers_contract_entry_unique" ON "deposit_ledgers"  ("contract_id", "entry_no") `);
    await queryRunner.query(`CREATE INDEX "idx_deposit_ledgers_contract_created" ON "deposit_ledgers"  ("contract_id", "created_at") `);
    await queryRunner.query(`CREATE TYPE "public"."tenant_vehicles_vehicle_type_enum" AS ENUM('MOTORBIKE', 'ELECTRIC_BIKE', 'BICYCLE', 'CAR')`);
    await queryRunner.query(`CREATE TABLE "tenant_vehicles" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, "version" integer NOT NULL DEFAULT '1', "building_id" uuid NOT NULL, "contract_id" uuid NOT NULL, "owner_tenant_id" uuid NOT NULL, "vehicle_type" "public"."tenant_vehicles_vehicle_type_enum" NOT NULL, "license_plate" character varying(30), "brand_model" character varying(100) NOT NULL, "parking_card_code" character varying(50), "is_active" boolean NOT NULL DEFAULT true, "deactivated_at" date, CONSTRAINT "chk_vehicles_plate" CHECK ("vehicle_type" = 'BICYCLE' OR "license_plate" IS NOT NULL), CONSTRAINT "chk_vehicles_active" CHECK ("is_active" = ("deactivated_at" IS NULL)), CONSTRAINT "PK_ed8bfe0c8d74691ee812fc15aee" PRIMARY KEY ("id"))`);
    await queryRunner.query(`CREATE INDEX "IDX_649da10f72a155c717f7e9823b" ON "tenant_vehicles"  ("building_id") `);
    await queryRunner.query(`CREATE UNIQUE INDEX "idx_vehicles_bld_active_card_unique" ON "tenant_vehicles"  ("building_id", "parking_card_code") WHERE "is_active" AND "parking_card_code" IS NOT NULL AND "deleted_at" IS NULL`);
    await queryRunner.query(`CREATE UNIQUE INDEX "idx_vehicles_bld_active_plate_unique" ON "tenant_vehicles"  ("building_id", "license_plate") WHERE "is_active" AND "license_plate" IS NOT NULL AND "deleted_at" IS NULL`);
    await queryRunner.query(`CREATE INDEX "idx_tenant_vehicles_contract" ON "tenant_vehicles"  ("contract_id") `);
    await queryRunner.query(`ALTER TABLE "room_assets" ADD CONSTRAINT "uq_room_assets_bld_id" UNIQUE ("building_id", "id")`);
    await queryRunner.query(`ALTER TABLE "contracts" ADD CONSTRAINT "fk_contracts_room_same_building" FOREIGN KEY ("room_id", "building_id") REFERENCES "rooms"("id","building_id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "contracts" ADD CONSTRAINT "fk_contracts_holder_same_building" FOREIGN KEY ("primary_tenant_id", "building_id") REFERENCES "tenants"("id","building_id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "rooms" ADD CONSTRAINT "fk_rooms_current_contract_same_building" FOREIGN KEY ("current_contract_id", "building_id") REFERENCES "contracts"("id","building_id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "contract_assets" ADD CONSTRAINT "fk_contract_assets_contract_same_building" FOREIGN KEY ("contract_id", "building_id") REFERENCES "contracts"("id","building_id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "contract_assets" ADD CONSTRAINT "fk_contract_assets_unit_same_building" FOREIGN KEY ("room_asset_id", "building_id") REFERENCES "room_assets"("id","building_id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "contract_occupants" ADD CONSTRAINT "fk_occupants_contract_same_building" FOREIGN KEY ("contract_id", "building_id") REFERENCES "contracts"("id","building_id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "contract_occupants" ADD CONSTRAINT "fk_occupants_tenant_same_building" FOREIGN KEY ("tenant_id", "building_id") REFERENCES "tenants"("id","building_id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "contract_holder_transfers" ADD CONSTRAINT "fk_holder_transfers_contract_same_building" FOREIGN KEY ("contract_id", "building_id") REFERENCES "contracts"("id","building_id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "contract_holder_transfers" ADD CONSTRAINT "fk_holder_transfers_from_same_building" FOREIGN KEY ("from_tenant_id", "building_id") REFERENCES "tenants"("id","building_id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "contract_holder_transfers" ADD CONSTRAINT "fk_holder_transfers_to_same_building" FOREIGN KEY ("to_tenant_id", "building_id") REFERENCES "tenants"("id","building_id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "contract_holder_transfers" ADD CONSTRAINT "fk_holder_transfers_approved_by" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "contract_renewals" ADD CONSTRAINT "fk_renewals_contract_same_building" FOREIGN KEY ("contract_id", "building_id") REFERENCES "contracts"("id","building_id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "contract_renewals" ADD CONSTRAINT "fk_renewals_approved_by" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "contract_services" ADD CONSTRAINT "fk_contract_services_contract_same_building" FOREIGN KEY ("contract_id", "building_id") REFERENCES "contracts"("id","building_id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "contract_services" ADD CONSTRAINT "fk_contract_services_catalog_same_building" FOREIGN KEY ("service_catalog_id", "building_id") REFERENCES "service_catalogs"("id","building_id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "deposit_ledgers" ADD CONSTRAINT "fk_deposit_ledgers_contract_same_building" FOREIGN KEY ("contract_id", "building_id") REFERENCES "contracts"("id","building_id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "deposit_ledgers" ADD CONSTRAINT "fk_deposit_ledgers_counterparty_same_building" FOREIGN KEY ("counterparty_tenant_id", "building_id") REFERENCES "tenants"("id","building_id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "deposit_ledgers" ADD CONSTRAINT "fk_deposit_ledgers_holder_transfer" FOREIGN KEY ("holder_transfer_id") REFERENCES "contract_holder_transfers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "tenant_vehicles" ADD CONSTRAINT "fk_vehicles_contract_same_building" FOREIGN KEY ("contract_id", "building_id") REFERENCES "contracts"("id","building_id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "tenant_vehicles" ADD CONSTRAINT "fk_vehicles_owner_same_building" FOREIGN KEY ("owner_tenant_id", "building_id") REFERENCES "tenants"("id","building_id") ON DELETE RESTRICT ON UPDATE NO ACTION`);

    // Người đứng tên nhất quán: kiểm tra lúc COMMIT, sau khi cả hai dòng (hợp đồng + người ở) đã đổi.
    // Bảng contracts không có cột contract_id → chọn khóa theo TG_TABLE_NAME (NEW.contract_id sẽ lỗi trên contracts).
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION check_contract_primary_holder() RETURNS trigger AS $$
      DECLARE
        v_contract_id uuid;
        v_status text;
        v_primary uuid;
        v_holder uuid;
      BEGIN
        IF TG_TABLE_NAME = 'contracts' THEN v_contract_id := NEW.id; ELSE v_contract_id := NEW.contract_id; END IF;
        SELECT status, primary_tenant_id INTO v_status, v_primary FROM contracts WHERE id = v_contract_id;
        IF v_status IS DISTINCT FROM 'ACTIVE' THEN
          RETURN NULL; -- bản nháp và hợp đồng đã đóng không kiểm tra
        END IF;
        SELECT tenant_id INTO v_holder FROM contract_occupants
         WHERE contract_id = v_contract_id AND role = 'PRIMARY_HOLDER' AND status = 'ACTIVE' AND deleted_at IS NULL;
        IF v_holder IS NULL OR v_holder <> v_primary THEN
          RAISE EXCEPTION 'Contract % must have exactly one active PRIMARY_HOLDER equal to primary_tenant_id', v_contract_id
            USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`CREATE CONSTRAINT TRIGGER trg_contract_primary_holder_consistency
      AFTER INSERT OR UPDATE OF primary_tenant_id, status ON contracts
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_contract_primary_holder()`);
    await queryRunner.query(`CREATE CONSTRAINT TRIGGER trg_occupant_primary_holder_consistency
      AFTER INSERT OR UPDATE OF role, status ON contract_occupants
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_contract_primary_holder()`);

    // Sổ cái tiền cọc chỉ ghi thêm: sửa sai = ghi dòng mới
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION reject_deposit_ledger_change() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'deposit_ledgers is append-only: % is not allowed', TG_OP
          USING ERRCODE = 'insufficient_privilege';
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`CREATE TRIGGER trg_deposit_ledgers_immutable BEFORE UPDATE OR DELETE ON deposit_ledgers
      FOR EACH ROW EXECUTE FUNCTION reject_deposit_ledger_change()`);
    await queryRunner.query(`CREATE TRIGGER trg_deposit_ledgers_immutable_truncate BEFORE TRUNCATE ON deposit_ledgers
      FOR EACH STATEMENT EXECUTE FUNCTION reject_deposit_ledger_change()`);

    await queryRunner.query(`SELECT setup_building_rls('contracts')`);
    await queryRunner.query(`SELECT setup_building_rls('contract_occupants')`);
    await queryRunner.query(`SELECT setup_building_rls('contract_holder_transfers')`);
    await queryRunner.query(`SELECT setup_building_rls('contract_renewals')`);
    await queryRunner.query(`SELECT setup_building_rls('contract_assets')`);
    await queryRunner.query(`SELECT setup_building_rls('service_catalogs')`);
    await queryRunner.query(`SELECT setup_building_rls('contract_services')`);
    await queryRunner.query(`SELECT setup_building_rls('tenant_vehicles')`);
    await queryRunner.query(`SELECT setup_building_rls('deposit_ledgers')`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_deposit_ledgers_immutable_truncate ON deposit_ledgers`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_deposit_ledgers_immutable ON deposit_ledgers`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_occupant_primary_holder_consistency ON contract_occupants`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_contract_primary_holder_consistency ON contracts`);
    // Không còn hợp đồng → phòng đang có người ở / được bản nháp giữ trở lại trống
    await queryRunner.query(`UPDATE rooms SET status = 'AVAILABLE' WHERE current_contract_id IS NOT NULL OR id IN (SELECT room_id FROM contracts WHERE status = 'DRAFT')`);
    await queryRunner.query(`UPDATE rooms SET current_contract_id = NULL WHERE current_contract_id IS NOT NULL`);
    await queryRunner.query(`ALTER TABLE "tenant_vehicles" DROP CONSTRAINT "fk_vehicles_owner_same_building"`);
    await queryRunner.query(`ALTER TABLE "tenant_vehicles" DROP CONSTRAINT "fk_vehicles_contract_same_building"`);
    await queryRunner.query(`ALTER TABLE "deposit_ledgers" DROP CONSTRAINT "fk_deposit_ledgers_holder_transfer"`);
    await queryRunner.query(`ALTER TABLE "deposit_ledgers" DROP CONSTRAINT "fk_deposit_ledgers_counterparty_same_building"`);
    await queryRunner.query(`ALTER TABLE "deposit_ledgers" DROP CONSTRAINT "fk_deposit_ledgers_contract_same_building"`);
    await queryRunner.query(`ALTER TABLE "contract_services" DROP CONSTRAINT "fk_contract_services_catalog_same_building"`);
    await queryRunner.query(`ALTER TABLE "contract_services" DROP CONSTRAINT "fk_contract_services_contract_same_building"`);
    await queryRunner.query(`ALTER TABLE "contract_renewals" DROP CONSTRAINT "fk_renewals_approved_by"`);
    await queryRunner.query(`ALTER TABLE "contract_renewals" DROP CONSTRAINT "fk_renewals_contract_same_building"`);
    await queryRunner.query(`ALTER TABLE "contract_holder_transfers" DROP CONSTRAINT "fk_holder_transfers_approved_by"`);
    await queryRunner.query(`ALTER TABLE "contract_holder_transfers" DROP CONSTRAINT "fk_holder_transfers_to_same_building"`);
    await queryRunner.query(`ALTER TABLE "contract_holder_transfers" DROP CONSTRAINT "fk_holder_transfers_from_same_building"`);
    await queryRunner.query(`ALTER TABLE "contract_holder_transfers" DROP CONSTRAINT "fk_holder_transfers_contract_same_building"`);
    await queryRunner.query(`ALTER TABLE "contract_occupants" DROP CONSTRAINT "fk_occupants_tenant_same_building"`);
    await queryRunner.query(`ALTER TABLE "contract_occupants" DROP CONSTRAINT "fk_occupants_contract_same_building"`);
    await queryRunner.query(`ALTER TABLE "contract_assets" DROP CONSTRAINT "fk_contract_assets_unit_same_building"`);
    await queryRunner.query(`ALTER TABLE "contract_assets" DROP CONSTRAINT "fk_contract_assets_contract_same_building"`);
    await queryRunner.query(`ALTER TABLE "rooms" DROP CONSTRAINT "fk_rooms_current_contract_same_building"`);
    await queryRunner.query(`ALTER TABLE "contracts" DROP CONSTRAINT "fk_contracts_holder_same_building"`);
    await queryRunner.query(`ALTER TABLE "contracts" DROP CONSTRAINT "fk_contracts_room_same_building"`);
    await queryRunner.query(`ALTER TABLE "room_assets" DROP CONSTRAINT "uq_room_assets_bld_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_tenant_vehicles_contract"`);
    await queryRunner.query(`DROP INDEX "public"."idx_vehicles_bld_active_plate_unique"`);
    await queryRunner.query(`DROP INDEX "public"."idx_vehicles_bld_active_card_unique"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_649da10f72a155c717f7e9823b"`);
    await queryRunner.query(`DROP TABLE "tenant_vehicles"`);
    await queryRunner.query(`DROP TYPE "public"."tenant_vehicles_vehicle_type_enum"`);
    await queryRunner.query(`DROP INDEX "public"."idx_deposit_ledgers_contract_created"`);
    await queryRunner.query(`DROP INDEX "public"."idx_deposit_ledgers_contract_entry_unique"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_40654c1b332918491dbe276b96"`);
    await queryRunner.query(`DROP TABLE "deposit_ledgers"`);
    await queryRunner.query(`DROP TYPE "public"."deposit_ledgers_transaction_type_enum"`);
    await queryRunner.query(`DROP INDEX "public"."idx_contract_services_contract_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_contract_services_contract_catalog_unique"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_ce43bb357818a383ecc43d92fe"`);
    await queryRunner.query(`DROP TABLE "contract_services"`);
    await queryRunner.query(`DROP TYPE "public"."contract_services_charge_unit_enum"`);
    await queryRunner.query(`DROP INDEX "public"."idx_service_catalogs_bld_code_unique"`);
    await queryRunner.query(`DROP INDEX "public"."idx_service_catalogs_bld_vehicle_unique"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_eabd2e4ea48554811c3135d5ad"`);
    await queryRunner.query(`DROP TABLE "service_catalogs"`);
    await queryRunner.query(`DROP TYPE "public"."service_catalogs_vehicle_type_enum"`);
    await queryRunner.query(`DROP TYPE "public"."service_catalogs_charge_unit_enum"`);
    await queryRunner.query(`DROP INDEX "public"."idx_renewals_contract_effective"`);
    await queryRunner.query(`DROP INDEX "public"."idx_renewals_bld_addendum_unique"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_256ef929b17897e7682e504646"`);
    await queryRunner.query(`DROP TABLE "contract_renewals"`);
    await queryRunner.query(`DROP INDEX "public"."idx_holder_transfers_contract_date"`);
    await queryRunner.query(`DROP INDEX "public"."idx_holder_transfers_bld_addendum_unique"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_cdde32b6f6b4aabeba753d56b7"`);
    await queryRunner.query(`DROP TABLE "contract_holder_transfers"`);
    await queryRunner.query(`DROP TYPE "public"."contract_holder_transfers_deposit_handling_enum"`);
    await queryRunner.query(`DROP TYPE "public"."contract_holder_transfers_selection_enum"`);
    await queryRunner.query(`DROP TYPE "public"."contract_holder_transfers_reason_enum"`);
    await queryRunner.query(`DROP INDEX "public"."idx_occupants_contract_status"`);
    await queryRunner.query(`DROP INDEX "public"."idx_occupants_bld_residency"`);
    await queryRunner.query(`DROP INDEX "public"."idx_occupants_one_active_holder"`);
    await queryRunner.query(`DROP INDEX "public"."idx_occupants_tenant_one_active"`);
    await queryRunner.query(`DROP INDEX "public"."idx_occupants_residence_pending"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_d529fce97ca8f7ed9aab193dbc"`);
    await queryRunner.query(`DROP TABLE "contract_occupants"`);
    await queryRunner.query(`DROP TYPE "public"."contract_occupants_residency_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."contract_occupants_residence_channel_enum"`);
    await queryRunner.query(`DROP TYPE "public"."contract_occupants_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."contract_occupants_role_enum"`);
    await queryRunner.query(`DROP INDEX "public"."idx_contract_assets_contract_room_asset"`);
    await queryRunner.query(`DROP INDEX "public"."idx_contract_assets_room_asset"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_88f2b0730824ef2078cfa1a7f0"`);
    await queryRunner.query(`DROP TABLE "contract_assets"`);
    await queryRunner.query(`DROP TYPE "public"."contract_assets_checkout_condition_enum"`);
    await queryRunner.query(`DROP TYPE "public"."contract_assets_handover_condition_enum"`);
    await queryRunner.query(`DROP INDEX "public"."idx_contracts_bld_status_room"`);
    await queryRunner.query(`DROP INDEX "public"."idx_contracts_primary_tenant"`);
    await queryRunner.query(`DROP INDEX "public"."idx_contracts_dates"`);
    await queryRunner.query(`DROP INDEX "public"."idx_contracts_bld_code_unique"`);
    await queryRunner.query(`DROP INDEX "public"."idx_unique_active_contract_per_room"`);
    await queryRunner.query(`DROP INDEX "public"."idx_unique_draft_contract_per_room"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_8e9444fd0642cf9fd216349c73"`);
    await queryRunner.query(`DROP TABLE "contracts"`);
    await queryRunner.query(`DROP TYPE "public"."contracts_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."contracts_deposit_status_enum"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS reject_deposit_ledger_change()`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS check_contract_primary_holder()`);
  }
}
