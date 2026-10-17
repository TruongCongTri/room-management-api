/**
 * Chuyển đổi chuỗi ngày từ Query / Params thành Date, kiểm tra nghiêm ngặt:
 *  - Chỉ chấp nhận YYYY-MM-DD hoặc ISO 8601 đầy đủ (không nhận "05/06/2026", "tomorrow"...).
 *  - Chặn ngày không có thật: JavaScript tự "tràn" 2026-02-30 thành 2026-03-02, pipe này từ chối.
 *  - YYYY-MM-DD được hiểu là 00:00 UTC của ngày đó (không phụ thuộc múi giờ máy chủ).
 *
 * */

import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { SystemErrorCode } from '../constants/error-codes.constant';

export interface ParseDatePipeOptions {
  required?: boolean;
}

const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function isRealCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

@Injectable()
export class ParseDatePipe implements PipeTransform<string | undefined, Date | undefined> {
  constructor(private readonly options: ParseDatePipeOptions = { required: true }) {}

  transform(value: string | undefined, metadata: ArgumentMetadata): Date | undefined {
    const paramName = metadata.data || 'date';

    if (value === undefined || value === null || value === '') {
      if (this.options.required) {
        throw new BadRequestException({
          errorCode: SystemErrorCode.REQ_VALIDATION_ERROR,
          message: `Query parameter '${paramName}' is mandatory.`,
        });
      }
      return undefined;
    }

    const invalid = () =>
      new BadRequestException({
        errorCode: SystemErrorCode.REQ_INVALID_DATE_RANGE,
        message: `Parameter '${paramName}' must be a valid ISO 8601 date (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ssZ) (received: '${String(value).slice(0, 40)}').`,
        details: { parameter: paramName },
      });

    const match = ISO_DATE_TIME.exec(String(value).trim());
    if (!match) throw invalid();

    const [, year, month, day, hour = '0', minute = '0', second = '0'] = match;
    if (
      !isRealCalendarDate(Number(year), Number(month), Number(day)) ||
      Number(hour) > 23 ||
      Number(minute) > 59 ||
      Number(second) > 59
    ) {
      throw invalid();
    }

    // Chỉ có ngày → nửa đêm UTC; có giờ nhưng thiếu múi giờ → coi là UTC để kết quả nhất quán giữa các Pod
    const normalized = match[4] === undefined ? `${year}-${month}-${day}T00:00:00Z` : match[8] ? value : `${value}Z`;
    const parsedDate = new Date(normalized);
    if (Number.isNaN(parsedDate.getTime())) throw invalid();

    return parsedDate;
  }
}
