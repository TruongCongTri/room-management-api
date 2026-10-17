/**
 * API tra cứu audit log. JwtAuthGuard và PermissionsGuard đã được đăng ký toàn cục (AppModule),
 * service áp phạm vi OWN / DEPARTMENT / GLOBAL ở tầng SQL.
 *
 * */

import { Controller, Get, Query } from '@nestjs/common';
import { AuditViewerService, AUDIT_RESOURCE } from '../services/audit-viewer.service';
import { ScopedAuditQueryDto } from '../interfaces/audit.interface';
import { RequirePermissions } from '../../../core/access-control/permission.decorator';
import { Action, Scope } from '../../../core/access-control/access-control.types';

@Controller('audit-logs')
export class AuditViewerController {
  constructor(private readonly viewerService: AuditViewerService) {}

  @Get()
  @RequirePermissions({
    resource: AUDIT_RESOURCE,
    action: Action.READ,
    scope: Scope.OWN, // Tối thiểu phải có quyền đọc của chính mình
  })
  async getAuditLogs(@Query() query: ScopedAuditQueryDto) {
    return this.viewerService.queryLogs(query);
  }
}
