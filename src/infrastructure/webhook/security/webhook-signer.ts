import { createHmac, timingSafeEqual } from 'crypto';
import { WEBHOOK_CONSTANTS } from '../constants/webhook.constants';

export class WebhookSigner {
  /**
   * Tạo chữ ký số HMAC SHA-256 từ timestamp và payload string
   */
  static sign(payload: string, secret: string, timestamp: number): string {
    const signaturePayload = `${timestamp}.${payload}`;
    const hmac = createHmac(WEBHOOK_CONSTANTS.HMAC_ALGORITHM, secret)
      .update(signaturePayload)
      .digest('hex');

    return `${WEBHOOK_CONSTANTS.SIGNATURE_PREFIX}${hmac}`;
  }

  /**
   * Xác thực tính hợp lệ của chữ ký và kiểm tra giới hạn thời gian (Replay Attack defense)
   */
  static verify(
    payload: string,
    secret: string,
    signatureHeader: string,
    timestampHeader: string | number,
    toleranceSeconds: number = WEBHOOK_CONSTANTS.DEFAULT_TOLERANCE_SECONDS, // Khai báo rõ ': number'
  ): boolean {
    const timestamp = Number(timestampHeader);
    if (isNaN(timestamp)) {
      return false;
    }

    const currentTimeSeconds = Math.floor(Date.now() / 1000);
    const eventTimeSeconds = timestamp > 1e11 ? Math.floor(timestamp / 1000) : timestamp;

    if (Math.abs(currentTimeSeconds - eventTimeSeconds) > toleranceSeconds) {
      return false;
    }

    const expectedSignature = this.sign(payload, secret, timestamp);
    const cleanReceived = signatureHeader.trim();

    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
    const receivedBuffer = Buffer.from(cleanReceived, 'utf8');

    if (expectedBuffer.length !== receivedBuffer.length) {
      return false;
    }

    return timingSafeEqual(expectedBuffer, receivedBuffer);
  }
}