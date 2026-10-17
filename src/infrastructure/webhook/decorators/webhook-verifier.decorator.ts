import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { WebhookVerificationOptions } from '../interfaces/webhook.interface';
import { WEBHOOK_VERIFY_METADATA_KEY } from '../constants/webhook.constants';
import { WebhookSignatureGuard } from '../guards/webhook-signature.guard';
import { Public } from '../../../common/decorators/public.decorator';

/**
 * Bảo vệ route nhận webhook bằng chữ ký HMAC thay cho JWT:
 *  - đánh dấu @Public() (đối tác không có access token của người dùng),
 *  - gắn WebhookSignatureGuard xác minh chữ ký + timestamp.
 *
 * @example
 * @Post('vnpay/ipn')
 * @VerifyWebhookSignature({ secret: (req) => vault.secretFor('vnpay'), signatureHeader: 'x-vnpay-signature' })
 * handleIpn(@Body() dto: VnpayIpnDto) { ... }
 */
export const VerifyWebhookSignature = (options: WebhookVerificationOptions) =>
  applyDecorators(
    SetMetadata(WEBHOOK_VERIFY_METADATA_KEY, options),
    Public(),
    UseGuards(WebhookSignatureGuard),
  );
