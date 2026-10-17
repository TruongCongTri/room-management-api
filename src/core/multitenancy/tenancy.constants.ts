/**
 * Phạm vi cô lập dữ liệu (discriminator) của nền tảng là TÒA NHÀ: cột `building_id`,
 * biến phiên RLS `app.current_building_id` và header `X-Building-ID`.
 * ("Tenant" trong nghiệp vụ là KHÁCH THUÊ - không nhầm với khái niệm multi-tenant.)
 */
export const BUILDING_HEADER = 'x-building-id';

// Biến phiên RLS trong PostgreSQL Engine (truy xuất qua current_setting)
export const RLS_CURRENT_BUILDING_VAR = 'app.current_building_id';
export const RLS_BYPASS_VAR = 'app.bypass_rls';

/** UUID bất kỳ phiên bản (v1-v8, bao gồm v7 time-ordered) theo RFC 9562 */
export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
