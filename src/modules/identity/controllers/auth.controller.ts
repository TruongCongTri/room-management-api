/**
 * /auth/* - đăng nhập bằng số điện thoại, OTP, phiên đăng nhập (tài liệu 04, tag Identity & Authentication).
 * Không cần X-Building-ID: tài khoản & phiên là dữ liệu toàn cục.
 * Route công khai đặt @ThrottleSensitive (theo IP) bổ sung cho khóa theo số điện thoại.
 * @SkipAudit: AuthService ghi sự kiện bảo mật tường minh (thành công, thất bại, khóa, thu hồi) thay cho audit HTTP chung.
 */
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../../common/decorators/public.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { SkipAudit } from '../../../common/decorators/skip-audit.decorator';
import { ParseUUIDStrictPipe } from '../../../common/pipes/parse-uuid.pipe';
import { ThrottleSensitive } from '../../../core/security/throttler/throttler.decorators';
import { RequestContextService } from '../../../core/context/request-context.service';
import { RequestUserContext } from '../../../core/context/request-context.model';
import { ApiAudience } from '../../../infrastructure/swagger/api-audience.decorator';
import { AuthService } from '../services/auth.service';
import { SessionClientInfo } from '../services/session.service';
import {
  ActivateAccountDto,
  ChangePasswordDto,
  LoginDto,
  RefreshTokenDto,
  RequestOtpDto,
  ResetPasswordDto,
  VerifyLoginOtpDto,
} from '../dto/auth.dto';

@ApiTags('Identity & Authentication')
@ApiAudience('admin', 'guard', 'external')
@SkipAudit()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly context: RequestContextService,
  ) {}

  @Public()
  @ThrottleSensitive()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in with phone number and password (202 + OTP challenge for finance roles)' })
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(dto.phone, dto.password, dto, this.client());
    if (result.kind === 'MFA_REQUIRED') {
      res.status(HttpStatus.ACCEPTED);
      return result.challenge;
    }
    return result.tokens;
  }

  @Public()
  @ThrottleSensitive()
  @Post('login/mfa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete a finance-role login with the OTP' })
  verifyLoginMfa(@Body() dto: VerifyLoginOtpDto) {
    return this.auth.verifyLoginMfa(dto.challengeId, dto.code, { deviceId: dto.deviceId }, this.client());
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange a refresh token for a new token pair (rotation, reuse detection)' })
  refresh(@Body() dto: RefreshTokenDto) {
    return this.auth.refresh(dto.refreshToken, this.client());
  }

  @Public()
  @ThrottleSensitive()
  @Post('otp/request')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Send an OTP to activate an account or reset a password (always 202)' })
  requestOtp(@Body() dto: RequestOtpDto) {
    return this.auth.requestOtp(dto.phone, dto.purpose, this.client());
  }

  @Public()
  @ThrottleSensitive()
  @Post('activate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Activate an account with the OTP and choose a password (signs the user in)' })
  activate(@Body() dto: ActivateAccountDto) {
    return this.auth.activate(dto.phone, dto.code, dto.newPassword, dto, this.client());
  }

  @Public()
  @ThrottleSensitive()
  @Post('password/reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Reset a forgotten password with the OTP (signs out every device)' })
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
    await this.auth.resetPassword(dto.phone, dto.code, dto.newPassword);
  }

  @ApiBearerAuth()
  @ThrottleSensitive()
  @Post('password/change')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Change the password (keeps this session, revokes the others)' })
  async changePassword(@CurrentUser() user: RequestUserContext, @Body() dto: ChangePasswordDto): Promise<void> {
    await this.auth.changePassword(user, dto.currentPassword, dto.newPassword);
  }

  @ApiBearerAuth()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Sign out of the current session' })
  async logout(@CurrentUser() user: RequestUserContext): Promise<void> {
    await this.auth.logout(user);
  }

  @ApiBearerAuth()
  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Sign out of every device' })
  async logoutAll(@CurrentUser() user: RequestUserContext): Promise<void> {
    await this.auth.logoutAll(user);
  }

  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({ summary: 'Profile, roles, buildings, permissions and (tenants) current room' })
  me(@CurrentUser() user: RequestUserContext) {
    return this.auth.me(user);
  }

  @ApiBearerAuth()
  @Get('sessions')
  @ApiOperation({ summary: 'List my active sessions (devices)' })
  sessions(@CurrentUser() user: RequestUserContext) {
    return this.auth.listSessions(user);
  }

  @ApiBearerAuth()
  @Delete('sessions/:sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Sign out one of my devices' })
  async revokeSession(
    @CurrentUser() user: RequestUserContext,
    @Param('sessionId', ParseUUIDStrictPipe) sessionId: string,
  ): Promise<void> {
    await this.auth.revokeSession(user, sessionId);
  }

  private client(): SessionClientInfo {
    return { ipAddress: this.context.getClientIp(), userAgent: this.context.getUserAgent() ?? null };
  }
}
