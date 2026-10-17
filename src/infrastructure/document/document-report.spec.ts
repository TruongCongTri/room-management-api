import { formatVietnameseDate, PdfGeneratorService, stripDiacritics } from './services/pdf-generator.service';
import { StatutoryDocumentPayload, StatutoryDocumentType } from './interfaces/document.interface';

const settlementPayload = (overrides: Partial<StatutoryDocumentPayload> = {}): StatutoryDocumentPayload => ({
  type: StatutoryDocumentType.CHECKOUT_SETTLEMENT,
  documentNo: 'TL-2026-P302-0001',
  title: 'Biên bản thanh lý hợp đồng và quyết toán tiền cọc',
  place: 'Hà Nội',
  issuedAt: new Date('2026-10-16T03:00:00.000Z'),
  legalBasis: ['Căn cứ Bộ luật Dân sự số 91/2015/QH13 (Điều 328 - Đặt cọc)', 'Căn cứ Luật Nhà ở số 27/2023/QH15'],
  parties: [
    { label: 'BÊN CHO THUÊ (Bên A)', lines: ['Ông Nguyễn Văn A'] },
    { label: 'BÊN THUÊ (Bên B)', lines: ['Bà Trần Thị B - CCCD: ********1234'] },
  ],
  sections: [
    {
      heading: 'Thời gian lưu trú thực tế',
      fields: [
        ['Ngày trả phòng', '16/10/2026'],
        ['Số ngày ở / số ngày trong tháng', '16 / 31'],
      ],
    },
    {
      heading: 'Bảng quyết toán',
      table: {
        columns: ['Khoản mục', 'Số tiền (VND)'],
        widths: [3, 1],
        rows: [
          ['Tiền phòng (prorated)', '3.354.839'],
          ['Điện 120 kWh', '285.600'],
          ['Trừ tiền cọc 1 tháng', '-6.500.000'],
        ],
      },
      paragraphs: ['Bên A hoàn trả Bên B số tiền còn lại trong vòng 03 ngày làm việc.'],
    },
  ],
  signatures: ['BÊN CHO THUÊ', 'BÊN THUÊ'],
  ...overrides,
});

describe('DocumentReportModule (Statutory PDF & Excel Suite)', () => {
  let pdfService: PdfGeneratorService;

  beforeEach(() => {
    pdfService = new PdfGeneratorService();
  });

  it('should render a valid PDF for a checkout & deposit settlement statement', async () => {
    const pdfBuffer = await pdfService.renderStatutoryPdf(settlementPayload());

    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.length).toBeGreaterThan(500);
    expect(pdfBuffer.toString('utf-8', 0, 5)).toBe('%PDF-'); // PDF magic header
  });

  it('should paginate long annex tables (e.g. 80-room appliance handover list)', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => [`Thiết bị #${i + 1}`, `SN-${i}`, 'GRADE_A_NEW']);
    const pdfBuffer = await pdfService.renderStatutoryPdf(
      settlementPayload({
        type: StatutoryDocumentType.HANDOVER_MINUTES,
        sections: [{ heading: 'Danh mục tài sản bàn giao', table: { columns: ['Tài sản', 'Số serial', 'Tình trạng'], rows } }],
      }),
    );
    expect(pdfBuffer.toString('latin1').match(/\/Type \/Page\b/g)?.length).toBeGreaterThan(1);
  });

  it('should strip Vietnamese diacritics when no Unicode font is configured', () => {
    expect(stripDiacritics('Hợp đồng thuê nhà - Đà Nẵng')).toBe('Hop dong thue nha - Da Nang');
  });

  it('should format statutory dates in Vietnam time', () => {
    // 2026-10-15T18:00Z = 01:00 ngày 16/10 giờ Việt Nam
    expect(formatVietnameseDate(new Date('2026-10-15T18:00:00.000Z'))).toBe('ngày 16 tháng 10 năm 2026');
  });

  it('should upload the rendered document to the private settlements folder and return a presigned URL', async () => {
    const storage = {
      uploadBuffer: jest
        .fn()
        .mockResolvedValue({ fileKey: 'buildings/b1/private/settlements/2026/10/x_checkout_settlement-TL-2026-P302-0001.pdf' }),
      generatePresignedDownloadUrl: jest.fn().mockResolvedValue('https://s3/presigned'),
    } as any;
    const service = new PdfGeneratorService(undefined, storage);

    const result = await service.renderAndUpload(settlementPayload());

    expect(storage.uploadBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      'checkout_settlement-TL-2026-P302-0001.pdf',
      expect.objectContaining({ contentType: 'application/pdf', visibility: 'private', category: 'settlements' }),
    );
    expect(result.downloadUrl).toBe('https://s3/presigned');
  });
});

// npx jest src/infrastructure/document/document-report.spec.ts
