/**
 * Xác minh chữ ký HMAC SHA-256 + timestamp (chống replay) của webhook ingress trên RAW BODY
 * (NestFactory.create(..., { rawBody: true })): chữ ký được tính trên đúng các byte đối tác gửi,
 * không phải JSON đã parse rồi serialize lại (thứ tự khóa / khoảng trắng khác → sai chữ ký).
 */
import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { WebhookSigner } from '../security/webhook-signer';
import { WebhookVerificationOptions } from '../interfaces/webhook.interface';
import { WEBHOOK_CONSTANTS, WEBHOOK_VERIFY_METADATA_KEY } from '../constants/webhook.constants';
import { AppConfigService } from '../../../core/config/app-config.service';

@Injectable()
export class WebhookSignatureGuard implements CanActivate {
  private readonly logger = new Logger(WebhookSignatureGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Optional() private readonly config?: AppConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<WebhookVerificationOptions>(WEBHOOK_VERIFY_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!options) {
      return true; // Không gắn decorator thì cho phép đi qua
    }

    const request = context.switchToHttp().getRequest<Request>();

    const sigHeaderName = options.signatureHeader || WEBHOOK_CONSTANTS.DEFAULT_SIGNATURE_HEADER;
    const timeHeaderName = options.timestampHeader || WEBHOOK_CONSTANTS.DEFAULT_TIMESTAMP_HEADER;

    const signature = request.headers[sigHeaderName.toLowerCase()] as string | undefined;
    const timestamp = request.headers[timeHeaderName.toLowerCase()] as string | undefined;

    if (!signature || !timestamp) {
      throw new UnauthorizedException(
        `Missing required webhook authentication headers: '${sigHeaderName}' or '${timeHeaderName}'.`,
      );
    }

    const rawBody: Buffer | undefined = (request as any).rawBody;
    if (!rawBody) {
      this.logger.warn(
        'rawBody is unavailable (enable NestFactory rawBody: true); verifying against re-serialized JSON may fail.',
      );
    }
    const rawPayload = rawBody ? rawBody.toString('utf8') : JSON.stringify(request.body ?? '');

    if (!rawPayload) {
      throw new BadRequestException('Webhook payload body is missing or unparseable.');
    }

    const secret = typeof options.secret === 'function' ? await options.secret(request) : options.secret;
    if (!secret) {
      throw new UnauthorizedException('Webhook secret could not be resolved for this request.');
    }

    const tolerance =
      options.toleranceSeconds ?? this.config?.webhook.toleranceSeconds ?? WEBHOOK_CONSTANTS.DEFAULT_TOLERANCE_SECONDS;

    if (!WebhookSigner.verify(rawPayload, secret, signature, timestamp, tolerance)) {
      throw new UnauthorizedException(
        'Webhook signature verification failed or timestamp is expired (Replay protection).',
      );
    }

    return true;
  }
}
