/**
 * Nhóm biến: Nghiệp vụ cho thuê & tuân thủ pháp luật Việt Nam (thuế 2026, biểu giá điện EVN, kỳ hóa đơn).
 * Mặc định theo văn bản hiện hành (common/constants/vn-rental.constant.ts); cho phép ghi đè để
 * cập nhật khi Bộ Công Thương điều chỉnh giá điện hoặc đối soát kỳ thuế lịch sử (ngưỡng 100 triệu trước 2026).
 */
import { z } from 'zod';
import { addIssue, envInt, envNumber, envString, ZodRefineCtx } from './env.helpers';
import { EVN_RESIDENTIAL_TIERS, EVN_RULES, RENTAL_OPERATIONS, VN_TAX_2026 } from '../../../common/constants/vn-rental.constant';

/** "1984,2050,2380,2998,3350,3460" → [1984, 2050, ...] (VND/kWh, chưa VAT, theo thứ tự bậc) */
const evnTierPricesSchema = envString(EVN_RESIDENTIAL_TIERS.map((t) => t.priceVnd).join(',')).transform((raw, ctx) => {
  const prices = raw.split(',').map((v) => Number(v.trim()));
  if (prices.length !== EVN_RESIDENTIAL_TIERS.length || prices.some((p) => !Number.isFinite(p) || p <= 0)) {
    ctx.addIssue({
      code: 'custom',
      message: `EVN_TIER_PRICES_VND must list ${EVN_RESIDENTIAL_TIERS.length} positive prices (VND/kWh) separated by commas`,
    });
    return z.NEVER;
  }
  return prices;
});

export const rentalEnvShape = {
  // Thuế cho thuê tài sản (Luật 109/2025/QH15, NĐ 68/2026 & 141/2026/NĐ-CP)
  TAX_EXEMPT_THRESHOLD_VND: envInt(VN_TAX_2026.EXEMPT_THRESHOLD_VND, 0),
  TAX_VAT_RATE_PERCENT: envNumber(VN_TAX_2026.VAT_RATE_PERCENT, 0, 100),
  TAX_PIT_RATE_PERCENT: envNumber(VN_TAX_2026.PIT_RATE_PERCENT, 0, 100),

  // Biểu giá điện sinh hoạt bậc thang EVN
  EVN_TIER_PRICES_VND: evnTierPricesSchema,
  EVN_VAT_RATE_PERCENT: envNumber(EVN_RULES.VAT_RATE_PERCENT, 0, 100),
  EVN_HOUSEHOLD_QUOTA_HEADCOUNT: envInt(EVN_RULES.HOUSEHOLD_QUOTA_HEADCOUNT, 1, 20),

  // Vận hành kỳ hóa đơn
  BILLING_CYCLE_DAY: envInt(RENTAL_OPERATIONS.MONTHLY_BILLING_DAY, 1, 28),
  BILLING_PAYMENT_DUE_DAYS: envInt(5, 1, 31),
  DEPOSIT_MONTHS: envInt(RENTAL_OPERATIONS.STANDARD_DEPOSIT_MONTHS, 0, 12),
};

type RentalEnv = z.infer<z.ZodObject<typeof rentalEnvShape>>;

export function refineRentalEnv(env: RentalEnv, ctx: ZodRefineCtx): void {
  // Biểu giá bậc thang phải không giảm theo bậc
  const prices = env.EVN_TIER_PRICES_VND;
  if (Array.isArray(prices) && prices.some((price, i) => i > 0 && price < prices[i - 1])) {
    addIssue(ctx, 'EVN_TIER_PRICES_VND', 'EVN_TIER_PRICES_VND must be non-decreasing from tier 1 to tier 6');
  }
}
