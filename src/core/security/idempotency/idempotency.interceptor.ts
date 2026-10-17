/**
 * Interceptor chặn request trùng lặp (đăng ký toàn cục, chỉ kích hoạt trên route có @Idempotent()):
 *  - Key được cô lập theo tenant + user (hoặc IP nếu ẩn danh): hai client khác nhau dùng
 *    cùng một giá trị key không bao giờ nhận nhầm kết quả của nhau.
 *  - Fingerprint SHA-256 từ Method + Path + Body (đã chuẩn hóa thứ tự khóa).
 *  - COMPLETED: trả về ngay response đã lưu mà không gọi xuống Controller.
 *  - IN_PROGRESS: 409 Conflict.
 *  - Khác payload: 422 Unprocessable Entity chống làm sai lệch giao dịch.
 */
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, of, from } from 'rxjs';
import { catchError, concatMap, defaultIfEmpty } from 'rxjs/operators';
import { createHash } from 'crypto';
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_PATTERN,
  IDEMPOTENT_METADATA_KEY,
} from './idempotency.constants';
import { IdempotentOptions } from './idempotency.interface';
import { SystemErrorCode } from '../../../common/constants/error-codes.constant';
import { IdempotencyStorageService } from './idempotency-storage.service';

const DEFAULT_TTL_SECONDS = 86400;
const DEFAULT_LOCK_SECONDS = 60;

/** JSON ổn định: sắp xếp khóa để {a,b} và {b,a} cho cùng fingerprint */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value as object)
    .filter((k) => (value as any)[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as any)[k])}`);
  return `{${entries.join(',')}}`;
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly storageService: IdempotencyStorageService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    // Chỉ áp dụng cho HTTP Request
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const options = this.reflector.getAllAndOverride<IdempotentOptions>(IDEMPOTENT_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Nếu endpoint không bật decorator @Idempotent(), bỏ qua
    if (!options) {
      return next.handle();
    }

    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();

    const rawKey = req.headers?.[IDEMPOTENCY_KEY_HEADER];
    const idempotencyKey: string | undefined = Array.isArray(rawKey) ? rawKey[0] : rawKey;

    // 1. Kiểm tra sự tồn tại và định dạng của Header
    if (!idempotencyKey) {
      if (options.required !== false) {
        throw new BadRequestException({
          errorCode: SystemErrorCode.REQ_MISSING_IDEMPOTENCY_KEY,
          message: `Header '${IDEMPOTENCY_KEY_HEADER}' is mandatory for this sensitive operation.`,
        });
      }
      return next.handle();
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new BadRequestException({
        errorCode: SystemErrorCode.REQ_MISSING_IDEMPOTENCY_KEY,
        message: `Header '${IDEMPOTENCY_KEY_HEADER}' must be 8-128 characters of [A-Za-z0-9_-:.].`,
      });
    }

    const scopedKey = this.buildScopedKey(req, idempotencyKey);
    const fingerprint = this.buildFingerprint(req);

    // 2. Kiểm tra bản ghi hiện hành trong Cache
    const existing = await this.storageService.getRecord(scopedKey);
    if (existing) {
      return this.replayOrReject(existing, fingerprint, res);
    }

    // 3. Lấy khóa nguyên tử cho chu kỳ xử lý mới
    const acquired = await this.storageService.acquireLock(
      scopedKey,
      fingerprint,
      options.lockTimeoutSeconds ?? DEFAULT_LOCK_SECONDS,
    );
    if (!acquired) {
      // Một request song song vừa giành được khóa giữa bước 2 và 3
      const raced = await this.storageService.getRecord(scopedKey);
      if (raced) return this.replayOrReject(raced, fingerprint, res);
      throw new ConflictException(
        'Concurrent request detected with the same Idempotency-Key. Operation rejected.',
      );
    }

    // 4. Chạy Handler: lưu kết quả (đã await) trước khi trả response; lỗi thì giải phóng khóa
    return next.handle().pipe(
      defaultIfEmpty(undefined),
      concatMap((responseBody) =>
        from(
          this.storageService
            .markCompleted(
              scopedKey,
              fingerprint,
              res.statusCode || 200,
              responseBody ?? null,
              options.ttlSeconds ?? DEFAULT_TTL_SECONDS,
            )
            .then(() => responseBody),
        ),
      ),
      catchError(async (err) => {
        await this.storageService.releaseLock(scopedKey, fingerprint).catch(() => undefined);
        throw err;
      }),
    );
  }

  private replayOrReject(
    record: { status: string; fingerprint: string; statusCode?: number; response?: unknown },
    fingerprint: string,
    res: any,
  ): Observable<unknown> {
    // Đối soát Fingerprint: Chống tái sử dụng cùng key cho payload khác
    if (record.fingerprint !== fingerprint) {
      throw new UnprocessableEntityException({
        errorCode: SystemErrorCode.REQ_IDEMPOTENCY_PAYLOAD_MISMATCH,
        message: 'Idempotency-Key mismatch: The provided key was previously used with different request parameters.',
      });
    }

    // Request trước đang được xử lý -> Chặn race condition bằng 409 Conflict
    if (record.status === 'IN_PROGRESS') {
      throw new ConflictException(
        'A transaction with this Idempotency-Key is currently being processed. Please wait and retry.',
      );
    }

    // Đã hoàn tất thành công -> Trả thẳng kết quả từ Cache
    res.setHeader('X-Cache-Lookup', 'HIT-IDEMPOTENT');
    if (record.statusCode) {
      res.status(record.statusCode);
    }
    return of(record.response);
  }

  private buildScopedKey(req: any, idempotencyKey: string): string {
    const user = req.user as { id?: string; tenantId?: string } | undefined;
    const tenant = user?.tenantId ?? '-';
    const principal = user?.id ? `u:${user.id}` : `ip:${req.ip ?? 'unknown'}`;
    return `${tenant}:${principal}:${idempotencyKey}`;
  }

  private buildFingerprint(req: any): string {
    const path = `${req.baseUrl || ''}${req.path || req.url || ''}`;
    const payload = `${req.method}:${path}:${canonicalJson(req.body ?? {})}`;
    return createHash('sha256').update(payload).digest('hex');
  }
}
