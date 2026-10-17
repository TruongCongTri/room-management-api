import { Injectable, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { Response } from 'express';
import { ExcelColumnDefinition } from '../interfaces/document.interface';

@Injectable()
export class ExcelStreamService {
  private readonly logger = new Logger(ExcelStreamService.name);

  /**
   * Stream trực tiếp dữ liệu Excel ra HTTP Response mà không giữ toàn bộ mảng dữ liệu trong RAM
   */
  async streamToResponse<T>(
    res: Response,
    fileName: string,
    sheetName: string,
    columns: ExcelColumnDefinition[],
    dataCursor: AsyncIterable<T[]> | T[][],
  ): Promise<void> {
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(fileName)}.xlsx"`,
    );

    // Khởi tạo WorkbookWriter ở chế độ streaming
    const workbookWriter = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
      useSharedStrings: false, // Tiết kiệm RAM tối đa cho tập dữ liệu lớn
    });

    const worksheet = workbookWriter.addWorksheet(sheetName);
    worksheet.columns = columns.map((col) => ({
      header: col.header,
      key: col.key,
      width: col.width || 20,
    }));

    let totalRows = 0;

    for await (const chunk of dataCursor) {
      for (const row of chunk) {
        worksheet.addRow(row).commit(); // Commit từng row để giải phóng bộ nhớ đệm
        totalRows++;
      }
    }

    worksheet.commit();
    await workbookWriter.commit();

    this.logger.debug(`[ExcelStream] Successfully streamed ${totalRows} rows to response.`);
  }
}