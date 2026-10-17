/**
 * Hiện thực hóa thuật toán xác suất XFetch (Probabilistic Early Expiration) chống sập cache diện rộng (Cache Stampede):
 * 
 * */ 

/**
 * Thuật toán XFetch: Đánh giá xem có nên làm mới cache sớm trước khi key hết hạn hay không
 * @param expiresAt Epoch timestamp hết hạn (ms)
 * @param delta Thời gian tính toán giá trị (ms)
 * @param beta Hệ số chủ động (beta > 0, beta càng lớn càng chủ động làm mới sớm)
 */
export function shouldRecomputeWithXFetch(
  expiresAt: number,
  delta: number,
  beta = 1.0,
): boolean {
  const now = Date.now();
  if (now >= expiresAt) {
    return true; // Key đã thực sự hết hạn
  }

  // Delta * beta * -ln(rand) >= (expiresAt - now)
  const rand = Math.random();
  // Tránh ln(0) = -Infinity
  const safeRand = rand === 0 ? 0.00001 : rand;
  const earlyExpiryThreshold = -(delta * beta * Math.log(safeRand));

  return earlyExpiryThreshold >= expiresAt - now;
}