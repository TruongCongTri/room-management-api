/**
 * Tạo test suite kiểm tra:

Path Traversal Defense: Loại bỏ ../ và ký tự đặc biệt khỏi file name.

Content-Type Whitelist: Chặn đứng các định dạng nguy hiểm (ví dụ: application/x-sh, text/javascript).

Presigned Upload URL: Sinh URL ký số và Object Key chuẩn phân tầng buildings/{buildingId}/...[cite: 1].

Buffer Upload & Direct Operations: Gọi đúng S3 SDK commands (PutObjectCommand, DeleteObjectCommand).
 * 
 * */ 

import { S3StorageService, S3_CLIENT } from './services/s3-storage.service';
import { Test } from '@nestjs/testing';
import { buildPublicObjectUrl } from './services/storage-url.signer';
import { FileSanitizerUtil } from './utils/file-sanitizer.util';
import { FileVisibility } from './interfaces/storage.interface';
import { RequestContextService } from '../../core/context/request-context.service';
import { AppConfigService } from '../../core/config/app-config.service';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

jest.mock('@aws-sdk/s3-request-presigner');
const mockedGetSignedUrl = getSignedUrl as jest.MockedFunction<typeof getSignedUrl>;

describe('StorageModule (Enterprise S3 & MinIO Suite)', () => {
  describe('FileSanitizerUtil', () => {
    it('should sanitize unsafe filenames and prevent path traversal', () => {
      const maliciousName = '../../../../etc/passwd';
      const cleanName = FileSanitizerUtil.sanitizeFileName(maliciousName);

      expect(cleanName).toBe('passwd');
      expect(cleanName).not.toContain('..');
    });

    it('should reject unpermitted MIME types', () => {
      expect(() => {
        FileSanitizerUtil.validateContentType('application/x-msdownload'); // .exe
      }).toThrow(/Content-Type '.*' is not permitted/i);
    });

    it('should construct building-isolated object keys', () => {
      const key = FileSanitizerUtil.buildObjectKey(
        'tenant_vietnam',
        FileVisibility.PRIVATE,
        'passports',
        'customer_passport.pdf',
      );

      expect(key.startsWith('buildings/tenant_vietnam/private/passports/')).toBe(true);
      expect(key.endsWith('_customer_passport.pdf')).toBe(true);
    });
  });

  describe('S3StorageService DI wiring', () => {
    it('should receive AppConfigService through Nest DI (STORAGE_ENABLED=false is honoured)', async () => {
      const config = { storage: { enabled: false, bucket: 'room-management' } } as unknown as AppConfigService;
      const moduleRef = await Test.createTestingModule({
        providers: [
          S3StorageService,
          { provide: S3_CLIENT, useValue: {} },
          { provide: AppConfigService, useValue: config },
          RequestContextService,
        ],
      }).compile();

      expect(moduleRef.get(S3StorageService).isEnabled).toBe(false);
    });
  });

  describe('S3StorageService', () => {
    let storageService: S3StorageService;
    let mockS3Client: jest.Mocked<S3Client>;
    let contextService: RequestContextService;
    let mockConfig: AppConfigService;

    beforeEach(() => {
      mockS3Client = {
        send: jest.fn(),
      } as unknown as jest.Mocked<S3Client>;

      contextService = new RequestContextService();
      jest.spyOn(contextService, 'getTenantId').mockReturnValue('building_hcm');
      jest.spyOn(contextService, 'getUserId').mockReturnValue('usr_lead_1');
      jest.spyOn(contextService, 'getTraceId').mockReturnValue('TRACE-STORE-777');

      mockConfig = {} as AppConfigService;

      mockedGetSignedUrl.mockResolvedValue('https://s3.amazonaws.com/presigned-url-mock');

      storageService = new S3StorageService(mockS3Client, mockConfig, contextService);
    });

    it('should generate a presigned upload URL with building isolation metadata', async () => {
      const result = await storageService.generatePresignedUploadUrl({
        fileName: 'invoice_invoice.pdf',
        contentType: 'application/pdf',
        category: 'invoices',
        visibility: FileVisibility.PRIVATE,
      });

      expect(result.uploadUrl).toBe('https://s3.amazonaws.com/presigned-url-mock');
      expect(result.fileKey).toContain('buildings/building_hcm/private/invoices/');
      expect(result.expiresInSeconds).toBe(900);
      expect(mockedGetSignedUrl).toHaveBeenCalledWith(
        mockS3Client,
        expect.any(PutObjectCommand),
        { expiresIn: 900 },
      );
    });

    it('should upload buffer directly using PutObjectCommand', async () => {
      mockS3Client.send.mockResolvedValue({} as never);

      const buffer = Buffer.from('PDF_STREAM_CONTENT');
      const result = await storageService.uploadBuffer(buffer, 'report.xlsx', {
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        visibility: FileVisibility.PUBLIC,
      });

      expect(result.fileKey).toContain('buildings/building_hcm/public/reports/');
      expect(mockS3Client.send).toHaveBeenCalledWith(expect.any(PutObjectCommand));
    });

    it('should delete file using DeleteObjectCommand', async () => {
      mockS3Client.send.mockResolvedValue({} as never);

      const targetKey = 'buildings/building_hcm/private/invoices/test.pdf';
      await storageService.deleteFile(targetKey);

      expect(mockS3Client.send).toHaveBeenCalledWith(expect.any(DeleteObjectCommand));
    });

    it('should reject a disguised executable (extension does not match Content-Type)', async () => {
      await expect(
        storageService.generatePresignedUploadUrl({ fileName: 'invoice.pdf.exe', contentType: 'application/pdf' }),
      ).rejects.toThrow(/does not match Content-Type/);
    });

    it('should sign Content-Length and refuse files above the configured limit', async () => {
      const limited = new S3StorageService(
        mockS3Client,
        { storage: { enabled: true, bucket: 'b', maxUploadBytes: 1000 } } as any,
        contextService,
      );

      const ok = await limited.generatePresignedUploadUrl({
        fileName: 'photo.png',
        contentType: 'image/png',
        contentLength: 900,
      });
      expect(ok.requiredHeaders).toEqual({ 'Content-Type': 'image/png', 'Content-Length': '900' });

      await expect(
        limited.generatePresignedUploadUrl({ fileName: 'photo.png', contentType: 'image/png', contentLength: 5000 }),
      ).rejects.toThrow(/File size must be between/);
    });

    it('should write deterministic archive keys to the cold bucket', async () => {
      mockS3Client.send.mockResolvedValue({} as never);
      const archiving = new S3StorageService(
        mockS3Client,
        { storage: { enabled: true, bucket: 'hot', coldBucket: 'cold-archive' } } as any,
        contextService,
      );

      await archiving.putArchiveObject('audit-archive/2025/01/01/a.ndjson.gz', Buffer.from('x'), {
        contentType: 'application/x-ndjson',
        contentEncoding: 'gzip',
      });

      const command = mockS3Client.send.mock.calls[0][0] as PutObjectCommand;
      expect(command.input).toEqual(
        expect.objectContaining({ Bucket: 'cold-archive', Key: 'audit-archive/2025/01/01/a.ndjson.gz' }),
      );
    });

    it('should refuse operations when storage is disabled', async () => {
      const disabled = new S3StorageService(mockS3Client, { storage: { enabled: false } } as any, contextService);
      await expect(disabled.deleteFile('k')).rejects.toThrow(/disabled/);
    });
  });

  describe('buildPublicObjectUrl', () => {
    it('should support CDN, MinIO (path-style) and AWS virtual-hosted URLs', () => {
      const key = 'buildings/t1/public/room-photos/2026/10/ab_photo 1.png';
      expect(buildPublicObjectUrl({ bucket: 'b', region: 'r', publicBaseUrl: 'https://cdn.example.com/' }, key)).toBe(
        'https://cdn.example.com/buildings/t1/public/room-photos/2026/10/ab_photo%201.png',
      );
      expect(
        buildPublicObjectUrl({ bucket: 'b', region: 'r', endpoint: 'http://localhost:9000', forcePathStyle: true }, key),
      ).toBe('http://localhost:9000/b/buildings/t1/public/room-photos/2026/10/ab_photo%201.png');
      expect(buildPublicObjectUrl({ bucket: 'b', region: 'ap-southeast-1' }, 'k.png')).toBe(
        'https://b.s3.ap-southeast-1.amazonaws.com/k.png',
      );
    });
  });
});

// npx jest src/infrastructure/storage/storage.spec.ts