export interface ExcelColumnDefinition {
  header: string;
  key: string;
  width?: number;
}

/** Các văn bản pháp lý nền tảng phát hành (tài liệu 01, mục 7.2) */
export enum StatutoryDocumentType {
  /** Hợp đồng thuê nhà ở - Luật Nhà ở 2023, BLDS 2015 (Điều 472-482), Luật PCCC 2024 */
  LEASE_CONTRACT = 'LEASE_CONTRACT',
  /** Biên bản bàn giao phòng, tài sản & chỉ số điện nước */
  HANDOVER_MINUTES = 'HANDOVER_MINUTES',
  /** Tờ khai thay đổi thông tin cư trú CT01 (MỘT tờ khai cho MỖI người ở) - Luật Cư trú 2020, TT 66/2023/TT-BCA */
  RESIDENCE_CT01 = 'RESIDENCE_CT01',
  /** Biên bản thanh lý hợp đồng & quyết toán tiền cọc (trả phòng giữa tháng) */
  CHECKOUT_SETTLEMENT = 'CHECKOUT_SETTLEMENT',
  /** Phụ lục hợp đồng thay đổi người đứng tên (BLDS 2015, Điều 370 - chuyển giao nghĩa vụ cần bên cho thuê đồng ý) */
  HOLDER_TRANSFER_ADDENDUM = 'HOLDER_TRANSFER_ADDENDUM',
}

export interface DocumentParty {
  /** vd: "BÊN CHO THUÊ (Bên A)" */
  label: string;
  /** Các dòng thông tin đã được domain module che/giải mã phù hợp (họ tên, CCCD, địa chỉ...) */
  lines: string[];
}

export interface DocumentTable {
  columns: string[];
  rows: Array<Array<string | number>>;
  /** Tỷ lệ độ rộng từng cột (mặc định chia đều) */
  widths?: number[];
}

export interface DocumentSection {
  heading: string;
  /** Cặp nhãn - giá trị (vd: "Tiền phòng" - "6.500.000 VND") */
  fields?: Array<[label: string, value: string | number]>;
  paragraphs?: string[];
  table?: DocumentTable;
}

/**
 * Nội dung văn bản do domain module dựng sẵn từ entity (Contract, CheckoutSettlement...).
 * Tầng hạ tầng chỉ chịu trách nhiệm trình bày đúng thể thức văn bản hành chính Việt Nam.
 */
export interface StatutoryDocumentPayload {
  type: StatutoryDocumentType;
  /** Số văn bản, vd: "HĐ-2026-P302-0001" */
  documentNo: string;
  title: string;
  subtitle?: string;
  /** Dòng địa danh - ngày tháng ("Hà Nội, ngày 16 tháng 10 năm 2026") dựng từ place + issuedAt */
  place: string;
  issuedAt: Date;
  /** Các dòng "Căn cứ ..." */
  legalBasis?: string[];
  parties?: DocumentParty[];
  sections: DocumentSection[];
  /** Nhãn khối chữ ký, vd: ["BÊN CHO THUÊ", "BÊN THUÊ"] */
  signatures?: string[];
}

export interface RenderedDocument {
  fileKey: string;
  downloadUrl: string;
}
