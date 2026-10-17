/**
 * Xác thực access token dùng chung cho HTTP (JwtAuthGuard) và WebSocket handshake (WsJwtGuard):
 *  - Ghim thuật toán (chống tấn công "alg: none" / nhầm lẫn HS256 ↔ RS256), kiểm tra issuer/audience.
 *  - Xác thực cấu trúc claims → RequestUserContext.
 *  - Bổ sung ma trận quyền từ cache khi token không nhúng sẵn `rules`.
 */
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import { AppConfigService } from '../../config/app-config.service';
import { RequestUserContext } from '../../context/request-context.model';
import { UserPermissionResolver } from '../../access-control/user-permission.resolver';
import { SystemErrorCode } from '../../../common/constants/error-codes.constant';
import { AccessTokenInput, accessTokenClaimsSchema } from './jwt.claims';

const BEARER_PREFIX = /^Bearer\s+(.+)$/i;

@Injectable()
export class JwtTokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly config: AppConfigService,
    private readonly permissionResolver: UserPermissionResolver,
  ) {}

  extractBearerToken(header: string | string[] | undefined): string | undefined {
    const value = Array.isArray(header) ? header[0] : header;
    const match = value?.match(BEARER_PREFIX);
    return match?.[1]?.trim() || undefined;
  }

  /**
   * Xác thực chữ ký + thời hạn + cấu trúc claims. Ném UnauthorizedException kèm errorCode
   * (AUTH_TOKEN_EXPIRED / AUTH_TOKEN_INVALID) để client biết khi nào cần refresh token.
   */
  async verifyAccessToken(token: string): Promise<RequestUserContext> {
    let payload: unknown;
    try {
      payload = await this.jwtService.verifyAsync(token);
    } catch (err: any) {
      const expired = err?.name === 'TokenExpiredError';
      throw new UnauthorizedException({
        errorCode: expired ? SystemErrorCode.AUTH_TOKEN_EXPIRED : SystemErrorCode.AUTH_TOKEN_INVALID,
        message: expired ? 'Access token has expired.' : 'Access token is invalid.',
      });
    }

    const parsed = accessTokenClaimsSchema.safeParse(payload);
    if (!parsed.success) {
      throw new UnauthorizedException({
        errorCode: SystemErrorCode.AUTH_TOKEN_INVALID,
        message: 'Access token claims are malformed.',
      });
    }

    const claims = parsed.data;
    if (claims.typ === 'refresh') {
      throw new UnauthorizedException({
        errorCode: SystemErrorCode.AUTH_TOKEN_INVALID,
        message: 'Refresh tokens cannot be used to access the API.',
      });
    }

    const buildingId = claims.buildingId ?? claims.tenantId;
    return {
      id: claims.sub,
      email: claims.email,
      tenantId: buildingId,
      buildingIds: claims.buildingIds,
      departmentId: claims.departmentId,
      roles: claims.roles,
      rules: claims.rules ?? (await this.permissionResolver.resolve(claims.sub, buildingId, claims.roles)),
    };
  }

  /**
   * Phát hành access token với cùng thuật toán / issuer / audience mà guard xác thực
   * (dùng bởi module auth và bộ kiểm thử e2e).
   */
  signAccessToken(input: AccessTokenInput, expiresIn?: string): Promise<string> {
    const jwt = this.config.security.jwt;
    if (!jwt.signKey) {
      throw new Error('JWT signing key is not configured (JWT_SECRET for HS*, JWT_PRIVATE_KEY for RS*/ES*).');
    }
    return this.jwtService.signAsync(
      { ...input, roles: input.roles ?? [], typ: 'access', jti: input.jti ?? randomUUID() },
      {
        expiresIn: (expiresIn ?? jwt.expiresIn) as any,
        ...(jwt.algorithm.startsWith('HS') ? { secret: jwt.signKey } : { privateKey: jwt.signKey }),
      },
    );
  }
}
