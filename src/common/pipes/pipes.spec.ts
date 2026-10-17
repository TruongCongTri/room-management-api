/**
 * Tạo test suite kiểm tra:
 *  CustomValidationPipe: Chặn các thuộc tính không hợp lệ (forbidNonWhitelisted), ép kiểu tự động và làm phẳng lỗi lồng nhau.   
 *  ParseDatePipe: Chuyển đổi thành công chuỗi ngày hợp lệ, ném BadRequestException khi chuỗi sai định dạng.
 *  ParseUUIDStrictPipe: Cho phép chuỗi UUID v4 hợp lệ đi qua, chặn chuỗi sai định dạng kèm đúng mã lỗi REQ_INVALID_UUID.
 * 
 * */ 

import { ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { IsNotEmpty, IsString, ValidateNested, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import { CustomValidationPipe } from './validation.pipe';
import { ParseDatePipe } from './parse-date.pipe';
import { ParseUUIDStrictPipe } from './parse-uuid.pipe';
import { SystemErrorCode } from '../constants/error-codes.constant';

// Các DTO mẫu để kiểm thử CustomValidationPipe
class AddressDto {
  @IsNotEmpty()
  @IsString()
  street: string;
}

class CreateUserDto {
  @IsNotEmpty()
  @MinLength(3)
  username: string;

  @ValidateNested()
  @Type(() => AddressDto)
  address: AddressDto;
}

describe('Common Pipes (Enterprise Validation Suite)', () => {
  describe('CustomValidationPipe', () => {
    let pipe: CustomValidationPipe;
    const metadata: ArgumentMetadata = {
      type: 'body',
      metatype: CreateUserDto,
    };

    beforeEach(() => {
      pipe = new CustomValidationPipe();
    });

    it('should validate and transform a valid payload successfully', async () => {
      const validPayload = {
        username: 'alice',
        address: { street: '123 Le Loi' },
      };

      const result = await pipe.transform(validPayload, metadata);
      expect(result).toBeInstanceOf(CreateUserDto);
      expect(result.username).toBe('alice');
      expect(result.address.street).toBe('123 Le Loi');
    });

    it('should throw BadRequestException when non-whitelisted properties are present', async () => {
      const payloadWithExtra = {
        username: 'alice',
        address: { street: '123 Le Loi' },
        isAdmin: true, // Trường ngoài DTO
      };

      await expect(pipe.transform(payloadWithExtra, metadata)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should flatten nested validation errors into clean field and message objects', async () => {
      const invalidPayload = {
        username: 'al', // < 3 ký tự
        address: { street: '' }, // rỗng
      };

      try {
        await pipe.transform(invalidPayload, metadata);
        fail('Should have thrown BadRequestException');
      } catch (err: any) {
        expect(err).toBeInstanceOf(BadRequestException);
        const res = err.getResponse();
        expect(res.errorCode).toBe(SystemErrorCode.REQ_VALIDATION_ERROR);
        expect(res.details).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ field: 'username' }),
            expect.objectContaining({ field: 'address.street' }),
          ]),
        );
      }
    });
  });

  describe('ParseDatePipe', () => {
    let requiredPipe: ParseDatePipe;
    let optionalPipe: ParseDatePipe;
    const metadata: ArgumentMetadata = { type: 'query', data: 'departureDate' };

    beforeEach(() => {
      requiredPipe = new ParseDatePipe({ required: true });
      optionalPipe = new ParseDatePipe({ required: false });
    });

    it('should parse valid ISO date string into a Date object', () => {
      const dateStr = '2026-10-15T08:30:00.000Z';
      const result = requiredPipe.transform(dateStr, metadata);

      expect(result).toBeInstanceOf(Date);
      expect(result?.toISOString()).toBe(dateStr);
    });

    it('should return undefined when value is omitted and required is false', () => {
      const result = optionalPipe.transform(undefined, metadata);
      expect(result).toBeUndefined();
    });

    it('should throw BadRequestException when value is omitted and required is true', () => {
      expect(() => requiredPipe.transform(undefined, metadata)).toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException when string is an invalid date', () => {
      expect(() => requiredPipe.transform('not-a-real-date', metadata)).toThrow(
        BadRequestException,
      );
    });

    it('should reject dates that do not exist instead of rolling over (2026-02-30)', () => {
      expect(() => requiredPipe.transform('2026-02-30', metadata)).toThrow(BadRequestException);
      expect(() => requiredPipe.transform('2026-13-01', metadata)).toThrow(BadRequestException);
      expect(() => requiredPipe.transform('2026-10-15T25:00:00Z', metadata)).toThrow(BadRequestException);
    });

    it('should accept leap days and interpret YYYY-MM-DD as midnight UTC', () => {
      expect(requiredPipe.transform('2028-02-29', metadata)?.toISOString()).toBe('2028-02-29T00:00:00.000Z');
      expect(() => requiredPipe.transform('2027-02-29', metadata)).toThrow(BadRequestException);
    });

    it('should reject ambiguous non-ISO formats', () => {
      expect(() => requiredPipe.transform('15/10/2026', metadata)).toThrow(BadRequestException);
    });
  });

  describe('ParseUUIDStrictPipe', () => {
    let pipe: ParseUUIDStrictPipe;
    const metadata: ArgumentMetadata = { type: 'param', data: 'contractId' };

    beforeEach(() => {
      pipe = new ParseUUIDStrictPipe();
    });

    it('should allow valid UUID v4 format', () => {
      const validUuid = '123e4567-e89b-42d3-a456-426614174000';
      const result = pipe.transform(validUuid, metadata);

      expect(result).toBe(validUuid);
    });

    it('should throw BadRequestException with REQ_INVALID_UUID for malformed UUID', () => {
      try {
        pipe.transform('invalid-uuid-123', metadata);
        fail('Should have thrown BadRequestException');
      } catch (err: any) {
        expect(err).toBeInstanceOf(BadRequestException);
        const res = err.getResponse();
        expect(res.errorCode).toBe(SystemErrorCode.REQ_INVALID_UUID);
        expect(res.details.parameter).toBe('contractId');
      }
    });
  });
});

// npx jest src/common/pipes/pipes.spec.ts