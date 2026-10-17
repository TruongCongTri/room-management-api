/**
 * DTO của /auth/* (tài liệu 04, tag Identity & Authentication). Số điện thoại được nhận ở mọi định dạng và
 * chuẩn hóa ở service (400 REQ_VALIDATION_ERROR nếu không phải số di động hợp lệ).
 * Độ dài mật khẩu tối đa được chặn NGAY ở DTO để không băm argon2 các chuỗi khổng lồ (chống DoS);
 * các quy tắc còn lại (độ dài tối thiểu, mật khẩu phổ biến...) trả 422 AUTH_PASSWORD_POLICY_VIOLATION.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { PASSWORD_MAX_LENGTH } from '../domain/password-policy';
import { SELF_SERVICE_OTP_PURPOSES, SelfServiceOtpPurpose } from '../identity.constants';

const OTP_CODE = /^[0-9]{6}$/;

class DeviceInfoDto {
  @ApiPropertyOptional({ maxLength: 100, example: 'ios-7F3A2C' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  deviceId?: string;

  @ApiPropertyOptional({ maxLength: 150, example: 'iPhone 15' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  deviceName?: string;
}

export class LoginDto extends DeviceInfoDto {
  @ApiProperty({ example: '0901 234 567', description: 'Vietnamese or E.164 number, normalised to +84901234567' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  phone: string;

  @ApiProperty({ format: 'password', maxLength: PASSWORD_MAX_LENGTH })
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;
}

export class VerifyLoginOtpDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  challengeId: string;

  @ApiProperty({ example: '482913', pattern: OTP_CODE.source })
  @IsString()
  @Matches(OTP_CODE, { message: 'code must be 6 digits' })
  code: string;

  @ApiPropertyOptional({ maxLength: 100, description: 'Same deviceId as in POST /auth/login' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  deviceId?: string;
}

export class RefreshTokenDto {
  @ApiProperty({ example: '3f0c9a52-6f1e-4d0b-9a77-1c2d3e4f5a6b.r7Hq…' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  refreshToken: string;
}

export class RequestOtpDto {
  @ApiProperty({ example: '0901234567' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  phone: string;

  @ApiProperty({ enum: SELF_SERVICE_OTP_PURPOSES })
  @IsIn(SELF_SERVICE_OTP_PURPOSES)
  purpose: SelfServiceOtpPurpose;
}

export class ActivateAccountDto extends DeviceInfoDto {
  @ApiProperty({ example: '0901234567' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  phone: string;

  @ApiProperty({ pattern: OTP_CODE.source })
  @IsString()
  @Matches(OTP_CODE, { message: 'code must be 6 digits' })
  code: string;

  @ApiProperty({ format: 'password', minLength: 10, maxLength: PASSWORD_MAX_LENGTH })
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  newPassword: string;
}

export class ResetPasswordDto {
  @ApiProperty({ example: '0901234567' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  phone: string;

  @ApiProperty({ pattern: OTP_CODE.source })
  @IsString()
  @Matches(OTP_CODE, { message: 'code must be 6 digits' })
  code: string;

  @ApiProperty({ format: 'password', minLength: 10, maxLength: PASSWORD_MAX_LENGTH })
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  newPassword: string;
}

export class ChangePasswordDto {
  @ApiProperty({ format: 'password', maxLength: PASSWORD_MAX_LENGTH })
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSWORD_MAX_LENGTH)
  currentPassword: string;

  @ApiProperty({ format: 'password', minLength: 10, maxLength: PASSWORD_MAX_LENGTH })
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  newPassword: string;
}
