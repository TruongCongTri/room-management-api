import { SetMetadata, CustomDecorator } from '@nestjs/common';

export const SKIP_ENVELOPE_KEY = 'http:skip_envelope';

/**
 * Trả nguyên dữ liệu của handler, không bọc Envelope chuẩn
 * (health probe theo chuẩn Terminus, webhook ACK theo định dạng đối tác yêu cầu, file download...).
 */
export const SkipEnvelope = (): CustomDecorator<string> => SetMetadata(SKIP_ENVELOPE_KEY, true);
