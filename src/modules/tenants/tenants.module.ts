/** Module 2 - Tenants (tài liệu 02, mục 2.1 / 2.1b): một hồ sơ cho mỗi người ở, số giấy tờ mã hóa + blind index */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Tenant } from './entities/tenant.entity';
import { TenantsController } from './controllers/tenants.controller';
import { TenantsService } from './services/tenants.service';

@Module({
  imports: [TypeOrmModule.forFeature([Tenant])],
  controllers: [TenantsController],
  providers: [TenantsService],
  exports: [TenantsService],
})
export class TenantsModule {}
