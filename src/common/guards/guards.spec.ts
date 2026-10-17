/**
 * Tạo file kiểm thử để kiểm tra:
 *  JwtAuthGuard: Cho phép truy cập khi có decorator @Public() mà không kiểm tra token[cite: 1].
 *  JwtAuthGuard: Ném lỗi UnauthorizedException khi token thiếu hoặc không hợp lệ.
 *  JwtAuthGuard: Tự động nạp user hợp lệ vào RequestContextService qua setUser()[cite: 1].
 *  RolesGuard: Cho phép khi route không yêu cầu roles.
 *  RolesGuard: Ném lỗi ForbiddenException khi user thiếu role yêu cầu.
 *  RolesGuard: Cho phép khi user có role khớp.
 * 
 * */ 

import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { RequestContextService } from '../../core/context/request-context.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { RequestUserContext } from '../../core/context/request-context.model';

describe('Common Guards (Enterprise Auth & RBAC Suite)', () => {
  let reflector: Reflector;
  let contextService: RequestContextService;

  beforeEach(() => {
    reflector = new Reflector();
    contextService = new RequestContextService();
  });

  const createMockContext = (requestData: any): ExecutionContext =>
    ({
      getType: () => 'http',
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => requestData,
      }),
    }) as unknown as ExecutionContext;

  describe('JwtAuthGuard', () => {
    let guard: JwtAuthGuard;
    let tokenService: { extractBearerToken: jest.Mock; verifyAccessToken: jest.Mock };

    const mockUser: RequestUserContext = {
      id: 'usr_validated',
      email: 'pilot@rental.vn',
      roles: ['ROOM_CREW'],
      rules: [],
    };

    const markPublic = (value: boolean) =>
      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockImplementation((key) => (key === IS_PUBLIC_KEY ? value : undefined));

    beforeEach(() => {
      tokenService = {
        extractBearerToken: jest.fn((header?: string) => header?.replace(/^Bearer\s+/i, '') || undefined),
        verifyAccessToken: jest.fn(),
      };
      guard = new JwtAuthGuard(reflector, tokenService as any, contextService);
    });

    it('should allow access immediately if route is marked with @Public()', async () => {
      markPublic(true);

      await expect(guard.canActivate(createMockContext({ headers: {} }))).resolves.toBe(true);
      expect(tokenService.verifyAccessToken).not.toHaveBeenCalled();
    });

    it('should ignore an invalid token on a @Public() route instead of blocking it', async () => {
      markPublic(true);
      tokenService.verifyAccessToken.mockRejectedValue(new UnauthorizedException());
      const request: any = { headers: { authorization: 'Bearer broken' } };

      await expect(guard.canActivate(createMockContext(request))).resolves.toBe(true);
      expect(request.user).toBeUndefined();
    });

    it('should throw UnauthorizedException when the bearer token is missing', async () => {
      markPublic(false);

      await expect(guard.canActivate(createMockContext({ headers: {} }))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should propagate UnauthorizedException when token verification fails', async () => {
      markPublic(false);
      tokenService.verifyAccessToken.mockRejectedValue(new UnauthorizedException('expired'));

      await expect(
        guard.canActivate(createMockContext({ headers: { authorization: 'Bearer expired' } })),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should attach the verified user to request.user and RequestContextService', async () => {
      markPublic(false);
      tokenService.verifyAccessToken.mockResolvedValue(mockUser);
      const setUserSpy = jest.spyOn(contextService, 'setUser');
      const request: any = { headers: { authorization: 'Bearer valid.jwt.token' } };

      await expect(guard.canActivate(createMockContext(request))).resolves.toBe(true);

      expect(tokenService.verifyAccessToken).toHaveBeenCalledWith('valid.jwt.token');
      expect(request.user).toEqual(mockUser);
      expect(setUserSpy).toHaveBeenCalledWith(mockUser);
    });
  });

  describe('RolesGuard', () => {
    let guard: RolesGuard;

    beforeEach(() => {
      guard = new RolesGuard(reflector, contextService);
    });

    it('should allow access if no roles are required on the route', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === ROLES_KEY) return undefined;
        return undefined;
      });

      const context = createMockContext({});
      expect(guard.canActivate(context)).toBe(true);
    });

    it('should throw ForbiddenException if user has no roles assigned', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['ADMIN']);

      const context = createMockContext({
        user: { id: 'usr_no_roles', roles: [] },
      });

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('should throw ForbiddenException if user lacks the required role', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['SUPER_ADMIN']);

      const context = createMockContext({
        user: { id: 'usr_regular', roles: ['AGENT'] },
      });

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('should allow access if user has one of the required roles', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['ADMIN', 'SUPER_ADMIN']);

      const context = createMockContext({
        user: { id: 'usr_admin', roles: ['ADMIN'] },
      });

      expect(guard.canActivate(context)).toBe(true);
    });
  });
});

// npx jest src/common/guards/guards.spec.ts