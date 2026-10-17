/**
 * Kết xuất văn bản pháp lý tiếng Việt bằng pdfkit (hợp đồng thuê, biên bản bàn giao, CT01, thanh lý cọc):
 *  - Thể thức văn bản: Quốc hiệu - Tiêu ngữ, số văn bản, địa danh & ngày tháng, "Căn cứ ...",
 *    các bên, nội dung theo Điều, bảng kê và khối chữ ký.
 *  - Font Unicode nhúng (PDF_FONT_PATH, vd NotoSans-Regular.ttf / Times New Roman) để hiển thị đúng
 *    tiếng Việt có dấu; 14 font chuẩn của PDF (Helvetica) chỉ hỗ trợ WinAnsi → tự bỏ dấu.
 *  - renderAndUpload(): đẩy thẳng lên Object Storage (PRIVATE) và trả Presigned URL ngắn hạn,
 *    không ghi file rác vào filesystem của Pod.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { existsSync } from 'fs';
import PDFDocument from 'pdfkit';
import {
  DocumentSection,
  DocumentTable,
  RenderedDocument,
  StatutoryDocumentPayload,
  StatutoryDocumentType,
} from '../interfaces/document.interface';
import { AppConfigService } from '../../../core/config/app-config.service';
import { S3StorageService } from '../../storage/services/s3-storage.service';
import { FileVisibility } from '../../storage/interfaces/storage.interface';
import { STORAGE_CATEGORIES } from '../../storage/utils/file-sanitizer.util';
import { VN_BUSINESS_TIMEZONE } from '../../../common/constants/vn-rental.constant';

const REGULAR_FONT = 'AppRegular';
const BOLD_FONT = 'AppBold';
const PAGE_MARGIN = 56;
const SIGNATURE_BLOCK_HEIGHT = 90;

/** Thư mục lưu trữ theo loại văn bản */
const CATEGORY_BY_TYPE: Record<StatutoryDocumentType, string> = {
  [StatutoryDocumentType.LEASE_CONTRACT]: STORAGE_CATEGORIES.SIGNED_CONTRACTS,
  [StatutoryDocumentType.HANDOVER_MINUTES]: STORAGE_CATEGORIES.HANDOVER_MINUTES,
  [StatutoryDocumentType.RESIDENCE_CT01]: STORAGE_CATEGORIES.RESIDENCE_FORMS,
  [StatutoryDocumentType.CHECKOUT_SETTLEMENT]: STORAGE_CATEGORIES.SETTLEMENTS,
  [StatutoryDocumentType.HOLDER_TRANSFER_ADDENDUM]: STORAGE_CATEGORIES.CONTRACT_ADDENDA,
};

interface Fonts {
  regular: string;
  bold: string;
  /** Chuẩn hóa văn bản theo font hiện có (bỏ dấu khi không có font Unicode) */
  t: (text: string | number) => string;
}

@Injectable()
export class PdfGeneratorService {
  private readonly logger = new Logger(PdfGeneratorService.name);
  private readonly fontPath?: string;
  private readonly boldFontPath?: string;

  constructor(
    @Optional() config?: AppConfigService,
    @Optional() private readonly storage?: S3StorageService,
  ) {
    const pdf = config?.pdf;
    this.fontPath = pdf?.fontPath && existsSync(pdf.fontPath) ? pdf.fontPath : undefined;
    this.boldFontPath = pdf?.boldFontPath && existsSync(pdf.boldFontPath) ? pdf.boldFontPath : this.fontPath;

    if (pdf?.fontPath && !this.fontPath) {
      this.logger.warn(`PDF_FONT_PATH '${pdf.fontPath}' does not exist; falling back to Helvetica (no Vietnamese diacritics).`);
    }
  }

  /**
   * Kết xuất văn bản pháp lý thành Buffer (đính kèm email hoặc lưu Object Storage)
   */
  async renderStatutoryPdf(data: StatutoryDocumentPayload): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        margin: PAGE_MARGIN,
        size: 'A4',
        info: { Title: `${data.title} ${data.documentNo}`, Subject: data.type },
      });
      const buffers: Buffer[] = [];

      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => {
        const pdfData = Buffer.concat(buffers);
        this.logger.debug(`[PdfGenerator] Rendered ${data.type} ${data.documentNo} (${pdfData.length} bytes)`);
        resolve(pdfData);
      });
      doc.on('error', reject);

      try {
        this.layout(doc, data);
        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Kết xuất và lưu văn bản vào Object Storage (PRIVATE), trả về key + URL tải có thời hạn
   */
  async renderAndUpload(data: StatutoryDocumentPayload): Promise<RenderedDocument> {
    if (!this.storage) {
      throw new Error('Object storage is not available for PDF upload.');
    }
    const buffer = await this.renderStatutoryPdf(data);
    const fileName = `${data.type.toLowerCase()}-${stripDiacritics(data.documentNo)}.pdf`;
    const { fileKey } = await this.storage.uploadBuffer(buffer, fileName, {
      contentType: 'application/pdf',
      category: CATEGORY_BY_TYPE[data.type],
      visibility: FileVisibility.PRIVATE,
    });
    const downloadUrl = await this.storage.generatePresignedDownloadUrl(fileKey, {
      responseContentDisposition: `attachment; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
    });
    return { fileKey, downloadUrl };
  }

  private layout(doc: PDFKit.PDFDocument, data: StatutoryDocumentPayload): void {
    const unicode = !!this.fontPath;
    if (unicode) {
      doc.registerFont(REGULAR_FONT, this.fontPath!);
      doc.registerFont(BOLD_FONT, this.boldFontPath!);
    }
    const fonts: Fonts = {
      regular: unicode ? REGULAR_FONT : 'Helvetica',
      bold: unicode ? BOLD_FONT : 'Helvetica-Bold',
      // Không có font Unicode → bỏ dấu tiếng Việt thay vì in ký tự lỗi
      t: (text) => (unicode ? String(text) : stripDiacritics(String(text))),
    };
    const { regular, bold, t } = fonts;

    // Quốc hiệu - Tiêu ngữ
    doc.font(bold).fontSize(12).text(t('CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM'), { align: 'center' });
    doc.text(t('Độc lập - Tự do - Hạnh phúc'), { align: 'center' });
    doc.font(regular).fontSize(10).text('---------------', { align: 'center' });
    doc.moveDown(0.5);
    doc.text(t(`Số: ${data.documentNo}`), { align: 'left' });
    doc.text(t(`${data.place}, ${formatVietnameseDate(data.issuedAt)}`), { align: 'right' });
    doc.moveDown();

    doc.font(bold).fontSize(15).text(t(data.title.toUpperCase()), { align: 'center' });
    if (data.subtitle) doc.font(regular).fontSize(11).text(t(data.subtitle), { align: 'center' });
    doc.moveDown();

    for (const basis of data.legalBasis ?? []) {
      doc.font(regular).fontSize(10).text(t(`- ${basis}`));
    }
    if (data.legalBasis?.length) doc.moveDown(0.5);

    for (const party of data.parties ?? []) {
      doc.font(bold).fontSize(11).text(t(party.label));
      for (const line of party.lines) doc.font(regular).fontSize(10).text(t(line), { indent: 12 });
      doc.moveDown(0.5);
    }

    data.sections.forEach((section, index) => this.renderSection(doc, section, index + 1, fonts));

    if (data.signatures?.length) this.renderSignatures(doc, data.signatures, fonts);
  }

  private renderSection(doc: PDFKit.PDFDocument, section: DocumentSection, order: number, fonts: Fonts): void {
    const { regular, bold, t } = fonts;
    doc.font(bold).fontSize(11).text(t(`Điều ${order}. ${section.heading}`));
    for (const [label, value] of section.fields ?? []) {
      doc.font(regular).fontSize(10).text(t(`${label}: ${value}`), { indent: 12 });
    }
    for (const paragraph of section.paragraphs ?? []) {
      doc.font(regular).fontSize(10).text(t(paragraph), { indent: 12, align: 'justify' });
    }
    if (section.table) this.renderTable(doc, section.table, fonts);
    doc.moveDown(0.5);
  }

  private renderTable(doc: PDFKit.PDFDocument, table: DocumentTable, fonts: Fonts): void {
    const { regular, bold, t } = fonts;
    const usable = doc.page.width - PAGE_MARGIN * 2;
    const weights = table.widths?.length === table.columns.length ? table.widths : table.columns.map(() => 1);
    const total = weights.reduce((sum, w) => sum + w, 0);
    const widths = weights.map((w) => (usable * w) / total);

    const drawRow = (cells: Array<string | number>, font: string) => {
      doc.font(font).fontSize(9);
      const heights = cells.map((cell, i) => doc.heightOfString(t(cell), { width: widths[i] - 6 }));
      const rowHeight = Math.max(...heights) + 6;
      if (doc.y + rowHeight > doc.page.height - PAGE_MARGIN) doc.addPage();
      const top = doc.y;
      let x = PAGE_MARGIN;
      cells.forEach((cell, i) => {
        doc.rect(x, top, widths[i], rowHeight).stroke();
        doc.text(t(cell), x + 3, top + 3, { width: widths[i] - 6 });
        x += widths[i];
      });
      doc.x = PAGE_MARGIN;
      doc.y = top + rowHeight;
    };

    doc.moveDown(0.3);
    drawRow(table.columns, bold);
    for (const row of table.rows) drawRow(row, regular);
    doc.moveDown(0.5);
  }

  private renderSignatures(doc: PDFKit.PDFDocument, labels: string[], fonts: Fonts): void {
    const { regular, bold, t } = fonts;
    doc.moveDown();
    if (doc.y + SIGNATURE_BLOCK_HEIGHT > doc.page.height - PAGE_MARGIN) doc.addPage();
    const top = doc.y;
    const width = (doc.page.width - PAGE_MARGIN * 2) / labels.length;
    labels.forEach((label, i) => {
      const x = PAGE_MARGIN + i * width;
      doc.font(bold).fontSize(11).text(t(label), x, top, { width, align: 'center' });
      doc.font(regular).fontSize(9).text(t('(Ký, ghi rõ họ tên)'), x, top + 16, { width, align: 'center' });
    });
    doc.x = PAGE_MARGIN;
    doc.y = top + SIGNATURE_BLOCK_HEIGHT;
  }
}

/** Ngày tháng theo thể thức văn bản: "ngày 16 tháng 10 năm 2026" (giờ Việt Nam) */
export function formatVietnameseDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: VN_BUSINESS_TIMEZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `ngày ${get('day')} tháng ${get('month')} năm ${get('year')}`;
}

/** "Hợp đồng thuê nhà" → "Hop dong thue nha" (fallback khi không có font Unicode) */
export function stripDiacritics(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}
