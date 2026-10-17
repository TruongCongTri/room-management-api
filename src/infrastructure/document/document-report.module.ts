import { Global, Module } from '@nestjs/common';
import { ExcelStreamService } from './services/excel-stream.service';
import { PdfGeneratorService } from './services/pdf-generator.service';

@Global()
@Module({
  providers: [ExcelStreamService, PdfGeneratorService],
  exports: [ExcelStreamService, PdfGeneratorService],
})
export class DocumentReportModule {}