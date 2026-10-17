/**
 * Khóa phân tán của nghiệp vụ cho thuê (tài liệu 01, mục 4.3). DistributedLockService tự thêm
 * tiền tố `lock:{buildingId|global}:` nên các hàm dưới đây chỉ dựng phần định danh nghiệp vụ.
 */
export const LOCK_KEYS = {
  /** Ngăn hai quản lý kích hoạt hợp đồng trên cùng một phòng */
  roomContract: (roomId: string) => `room:contract:${roomId}`,
  /** Ngăn trả phòng giữa tháng và cập nhật chỉ số chạy song song trên cùng hợp đồng */
  checkoutContract: (contractId: string) => `checkout:contract:${contractId}`,
  /**
   * Thay đổi người ở / chuyển người đứng tên: CỐ Ý dùng chung khóa với trả phòng để hai thao tác
   * không bao giờ chạy song song (vd: chuyển quyền đứng tên đúng lúc người cuối cùng làm thủ tục trả phòng).
   */
  contractOccupancy: (contractId: string) => `checkout:contract:${contractId}`,
  /** Ngăn hai lần ghi chỉ số cho cùng phòng trong cùng kỳ */
  meterReading: (roomId: string, billingMonth: string) => `meter:${roomId}:${billingMonth}`,
  /** Chỉ một Pod chạy kỳ hóa đơn 80 phòng cho một tòa nhà / tháng (YYYYMM) */
  monthlyBilling: (buildingId: string, yyyymm: string) => `cron:billing:${buildingId}:${yyyymm}`,
  /** Ghi nhận thanh toán từ webhook ngân hàng theo mã giao dịch (chống double-credit) */
  paymentTransaction: (bankTransactionId: string) => `payment:${bankTransactionId}`,
} as const;
