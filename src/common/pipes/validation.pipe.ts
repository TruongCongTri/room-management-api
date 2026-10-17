/**
 * Bảo vệ Mass Assignment, ép kiểu tự động và làm phẳng cấu trúc lỗi phức tạp của class-validator:
 * 
 * */ 
import {
  Injectable,
  ValidationPipe,
  ValidationError,
  BadRequestException,
} from '@nestjs/common';
import { SystemErrorCode } from '../constants/error-codes.constant';

@Injectable()
export class CustomValidationPipe extends ValidationPipe {
  constructor() {
    super({
      // 1. Chống Mass Assignment: Tự động loại bỏ các trường không được khai báo trong DTO
      whitelist: true,
      // 2. Chặn đứng request nếu gửi kèm trường lạ ngoài DTO
      forbidNonWhitelisted: true,
      // 3. Tự động ép kiểu (Coercion) dữ liệu nguyên thủy theo type khai báo trong DTO
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
      // 4. Chuẩn hóa định dạng danh sách lỗi trả về đồng nhất với RFC 7807
      exceptionFactory: (validationErrors: ValidationError[] = []) => {
        const flattenedErrors = this.flattenErrors(validationErrors);
        return new BadRequestException({
          errorCode: SystemErrorCode.REQ_VALIDATION_ERROR,
          message: 'Validation failed for the submitted payload.',
          details: flattenedErrors,
        });
      },
    });
  }

  /**
   * Đệ quy làm phẳng cây lỗi (nested DTO errors) thành mảng { field, message }
   */
  private flattenErrors(
    errors: ValidationError[],
    parentPath = '',
  ): Array<{ field: string; message: string }> {
    const result: Array<{ field: string; message: string }> = [];

    for (const error of errors) {
      const currentPath = parentPath
        ? `${parentPath}.${error.property}`
        : error.property;

      if (error.constraints) {
        for (const message of Object.values(error.constraints)) {
          result.push({
            field: currentPath,
            message,
          });
        }
      }

      if (error.children && error.children.length > 0) {
        result.push(...this.flattenErrors(error.children, currentPath));
      }
    }

    return result;
  }
}