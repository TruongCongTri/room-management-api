/**
 * Chặn route của tính năng chưa bật cho user/tenant hiện tại (404: không để lộ endpoint chưa phát hành).
 * Đăng ký toàn cục sau JwtAuthGuard để canary theo user hoạt động; chỉ kích hoạt với @RequireFeature().
 */
import { CanActivate, ExecutionContext, Injectable, NotFoundException, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FeatureFlagService } from './feature-flag.service';
import { SystemErrorCode } from '../../common/constants/error-codes.constant';

export const FEATURE_FLAG_METADATA = 'feature_flag:required';

/**
 * @example
 * @Post('qr-payments')
 * @RequireFeature('new_vnpay_qr_gateway')
 */
export const RequireFeature = (flagKey: string) => SetMetadata(FEATURE_FLAG_METADATA, flagKey);

@Injectable()
export class FeatureFlagGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly featureFlags: FeatureFlagService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const flagKey = this.reflector.getAllAndOverride<string>(FEATURE_FLAG_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!flagKey || this.featureFlags.isEnabled(flagKey)) return true;

    throw new NotFoundException({
      errorCode: SystemErrorCode.RES_FEATURE_DISABLED,
      message: `Feature '${flagKey}' is not enabled.`,
    });
  }
}
