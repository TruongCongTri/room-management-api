/**
 * OpenAPI / Swagger:
 *  - Bật/tắt và đường dẫn theo cấu hình (SWAGGER_ENABLED, SWAGGER_PATH); mặc định tắt trên production.
 *  - Tài liệu tách theo cổng (tài liệu 04, mục 1.1): /api/docs (internal, đầy đủ),
 *    /api/docs/admin, /api/docs/guard, /api/docs/external.
 *  - JSON spec cho sinh SDK tự động: /api/docs-json, /api/docs/admin-json, ...
 *  - Header dùng chung: Bearer JWT, X-Building-ID (RLS), Idempotency-Key (khai báo theo route bằng @Idempotent).
 */
import { INestApplication, Logger } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { AppConfigService } from '../../core/config/app-config.service';
import { BUILDING_HEADER } from '../../core/multitenancy/tenancy.constants';
import { API_AUDIENCE_EXTENSION, ApiAudienceType, PUBLISHED_API_AUDIENCES } from './api-audience.decorator';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

const PORTAL_TITLES: Record<(typeof PUBLISHED_API_AUDIENCES)[number], string> = {
  admin: 'Admin & Accounting Portal',
  guard: 'Guard Metering Mobile App',
  external: 'Tenant Self-Service & Webhooks',
  public: 'Public Listing (portfolio website)',
};

/** Lọc tài liệu chỉ giữ operation dành cho audience (operation không gắn audience = internal) */
export function filterDocumentByAudience(document: OpenAPIObject, audience: ApiAudienceType): OpenAPIObject {
  const paths: OpenAPIObject['paths'] = {};
  for (const [path, item] of Object.entries(document.paths)) {
    const filtered: Record<string, unknown> = {};
    for (const method of HTTP_METHODS) {
      const operation = (item as Record<string, any>)[method];
      if (!operation) continue;
      const audiences: ApiAudienceType[] = operation[API_AUDIENCE_EXTENSION] ?? ['internal'];
      if (audiences.includes(audience)) filtered[method] = operation;
    }
    if (Object.keys(filtered).length > 0) {
      paths[path] = { ...(item as object), ...filtered } as OpenAPIObject['paths'][string];
      for (const method of HTTP_METHODS) {
        if (!(method in filtered)) delete (paths[path] as Record<string, unknown>)[method];
      }
    }
  }
  return { ...document, paths };
}

export class SwaggerConfigHelper {
  static setup(app: INestApplication, config: AppConfigService): void {
    const { enabled, path } = config.swagger;
    if (!enabled) return;

    const builder = new DocumentBuilder()
      .setTitle('Flat Rental Management API')
      .setDescription(
        'Backoffice, guard metering and tenant self-service API for the 80-room flat rental platform: ' +
          'rooms, leases, deposit escrow, manual meter readings, prorated checkout and 2026 Vietnam tax / residency compliance.',
      )
      .setVersion(config.app.version)
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
      .addGlobalParameters({
        name: BUILDING_HEADER,
        in: 'header',
        required: false,
        description:
          'Building UUID for PostgreSQL RLS isolation (defaults to the building in the token; ' +
          'must be one of the buildings assigned to the account)',
        schema: { type: 'string', format: 'uuid' },
      })
      .addTag('Properties', 'Buildings, room types, 80-room directory & vacancy summary')
      .addTag('Tenants', 'Tenant profiles, encrypted CCCD & PDPL consent')
      .addTag('Contracts', 'Leases, co-occupants, vehicles & 1-month deposit escrow')
      .addTag('Metering', 'Guard meter photos & manual electricity / water readings')
      .addTag('Billing', 'Monthly invoices, VietQR payments & prorated checkout settlement')
      .addTag('Compliance', '2026 tax (01/BĐS), residency CT01 & PCCC fire safety');

    const document = SwaggerModule.createDocument(app, builder.build());
    const options = { swaggerOptions: { persistAuthorization: true } };

    SwaggerModule.setup(path, app, document, { ...options, jsonDocumentUrl: `${path}-json` });
    for (const audience of PUBLISHED_API_AUDIENCES) {
      const portal = filterDocumentByAudience(document, audience);
      portal.info = { ...portal.info, title: `${document.info.title} — ${PORTAL_TITLES[audience]}` };
      SwaggerModule.setup(`${path}/${audience}`, app, portal, {
        ...options,
        jsonDocumentUrl: `${path}/${audience}-json`,
      });
    }

    new Logger('Swagger').log(
      `OpenAPI docs available at /${path} (${PUBLISHED_API_AUDIENCES.map((a) => `/${path}/${a}`).join(', ')})`,
    );
  }
}
