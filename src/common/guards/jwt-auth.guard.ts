/**
 * Xác thực Bearer access token cho mọi route HTTP (đăng ký toàn cục, chạy ĐẦU TIÊN trong chuỗi guard),
 * kiểm tra metadata @Public() và đẩy RequestUserContext vào request.user + RequestContextService.
 *
 * Không phụ thuộc Passport strategy: xác thực qua JwtTokenService (thuật toán được ghim, claims được kiểm tra).
 * Route @Public() vẫn nhận diện user nếu client gửi token hợp lệ (rate limit theo user, cá nhân hóa),
 * token không hợp lệ trên route công khai bị bỏ qua thay vì chặn request.
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { RequestContextService } from '../../core/context/request-context.service';
import { RequestUserContext } from '../../core/context/request-context.model';
import { JwtTokenService } from '../../core/security/jwt/jwt-token.service';
import { SystemErrorCode } from '../constants/error-codes.constant';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokenService: JwtTokenService,
    private readonly contextService: RequestContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // WebSocket xác thực ở handshake (WsJwtGuard), RPC không dùng Bearer HTTP
    if (context.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest();
    const token = this.tokenService.extractBearerToken(request.headers?.authorization);

    if (isPublic) {
      if (token) {
        await this.tokenService
          .verifyAccessToken(token)
          .then((user) => this.attachUser(request, user))
          .catch(() => undefined);
      }
      return true;
    }

    if (!token) {
      throw new UnauthorizedException({
        errorCode: SystemErrorCode.AUTH_UNAUTHORIZED,
        message: 'Authentication token is missing.',
      });
    }

    this.attachUser(request, await this.tokenService.verifyAccessToken(token));
    return true;
  }

  private attachUser(request: any, user: RequestUserContext): void {
    request.user = user;
    // Đồng bộ ngay vào AsyncLocalStorage để guard phía sau (Throttler, Permissions) và mọi tầng bên dưới dùng được
    this.contextService.setUser(user);
  }
}
