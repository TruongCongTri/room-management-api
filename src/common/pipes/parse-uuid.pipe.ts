/**
 * Kiểm chuẩn tham số Route ID dạng UUID (RFC 9562: v1-v8, gồm v7 sắp xếp theo thời gian của PostgreSQL 18),
 * trả về lỗi chi tiết kèm mã REQ_INVALID_UUID và tên tham số.
 *
 * */

import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { SystemErrorCode } from '../constants/error-codes.constant';

const UUID_ANY_VERSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class ParseUUIDStrictPipe implements PipeTransform<string, string> {
  transform(value: string, metadata: ArgumentMetadata): string {
    const paramName = metadata.data || 'id';

    if (!value || !UUID_ANY_VERSION.test(value)) {
      throw new BadRequestException({
        errorCode: SystemErrorCode.REQ_INVALID_UUID,
        message: `Parameter '${paramName}' must be a valid UUID.`,
        details: { parameter: paramName, value: typeof value === 'string' ? value.slice(0, 64) : value },
      });
    }

    return value.toLowerCase();
  }
}
