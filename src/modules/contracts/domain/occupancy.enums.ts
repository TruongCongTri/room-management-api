/**
 * Mô hình cư trú của một phòng: nhiều người ở chung, MỘT người đứng tên hợp đồng (PRIMARY_HOLDER).
 * Dùng chung cho entity ContractOccupant / Tenant (tài liệu 03) và chính sách kế nhiệm (occupancy.policy.ts).
 */

/** Giấy tờ định danh của từng người ở (bắt buộc cho mọi người, kể cả trẻ em) */
export enum IdDocumentType {
  /** Thẻ Căn cước / CCCD, hoặc số định danh cá nhân 12 số của trẻ em chưa được cấp thẻ */
  CCCD = 'CCCD',
  /** Người nước ngoài: khai báo tạm trú theo Luật 47/2014/QH13 (sửa đổi), không dùng mẫu CT01 */
  PASSPORT = 'PASSPORT',
}

export enum OccupantRole {
  /** Người đứng tên hợp đồng - chủ thể ký hợp đồng, nhận hóa đơn, chịu trách nhiệm tiền cọc */
  PRIMARY_HOLDER = 'PRIMARY_HOLDER',
  CO_OCCUPANT = 'CO_OCCUPANT',
}

export enum OccupancyStatus {
  ACTIVE = 'ACTIVE',
  MOVED_OUT = 'MOVED_OUT',
}

/** Vòng đời đăng ký cư trú của TỪNG người (Luật Cư trú 2020, TT 66/2023/TT-BCA) */
export enum ResidencyStatus {
  /** Mới chuyển đến: cần lập CT01 (hoặc khai báo tạm trú người nước ngoài) */
  PENDING_DECLARATION = 'PENDING_DECLARATION',
  SUBMITTED = 'SUBMITTED',
  /** Công an phường đã xác nhận - được tính vào định mức điện EVN */
  REGISTERED = 'REGISTERED',
  /** Đã chuyển đi: cần làm thủ tục xóa đăng ký tạm trú */
  DEREGISTRATION_PENDING = 'DEREGISTRATION_PENDING',
  DEREGISTERED = 'DEREGISTERED',
}

/** Kênh khai báo cư trú suy ra từ loại giấy tờ */
export enum ResidenceChannel {
  CT01 = 'CT01',
  FOREIGNER_TEMPORARY_RESIDENCE = 'FOREIGNER_TEMPORARY_RESIDENCE',
}

/** Xử lý 1 tháng tiền cọc khi đổi người đứng tên */
export enum HolderTransferDepositHandling {
  /** Mặc định: tiền cọc ở lại hợp đồng, người mới tiếp nhận (các bên tự thanh toán với nhau, ghi trong phụ lục) */
  CARRY_OVER = 'CARRY_OVER',
  /** Hoàn cọc cho người đứng tên cũ và thu cọc mới từ người kế nhiệm */
  REFUND_AND_RECOLLECT = 'REFUND_AND_RECOLLECT',
}

export const residenceChannelFor = (type: IdDocumentType): ResidenceChannel =>
  type === IdDocumentType.PASSPORT ? ResidenceChannel.FOREIGNER_TEMPORARY_RESIDENCE : ResidenceChannel.CT01;
