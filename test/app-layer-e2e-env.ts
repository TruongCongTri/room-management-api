/**
 * Import TRƯỚC AppModule trong properties-app-layer.e2e-spec.ts (giới hạn throttle được đọc lúc nạp decorator):
 * nới throttle theo IP - file này gửi nhiều request ghi liên tiếp từ một địa chỉ.
 */
process.env.THROTTLE_LIMIT = '10000';
process.env.THROTTLE_SENSITIVE_LIMIT = '10000';
