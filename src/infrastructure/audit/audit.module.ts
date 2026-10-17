import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLogEntity } from './entities/audit-log.entity';
import { AuditWriterService } from './services/audit-writer.service';
import { AuditViewerService } from './services/audit-viewer.service';
import { AuditTieringService } from './services/audit-tiering.service';
import { AuditViewerController } from './controllers/audit-viewer.controller';
import { AuditEntitySubscriber } from './subscribers/audit-entity.subscriber';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AuditLogEntity])],
  controllers: [AuditViewerController],
  providers: [AuditWriterService, AuditViewerService, AuditTieringService, AuditEntitySubscriber],
  exports: [AuditWriterService, AuditViewerService, AuditTieringService],
})
export class AuditLogModule {}
