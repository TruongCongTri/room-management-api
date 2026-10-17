/**
 * Các câu lệnh Lua Script thực thi nguyên tử (Atomic Execution) trên Redis engine:
 * 
 * */ 

/**
 * LUA SCRIPT: Giải phóng khóa an toàn (Safe Release)
 * Chỉ xóa key nếu giá trị hiện tại trùng khớp với token của phiên làm việc này.
 * Tránh trường hợp Pod A xóa nhầm lock của Pod B khi Pod A bị trễ quá TTL.
 */
export const SAFE_RELEASE_LUA = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

/**
 * LUA SCRIPT: Gia hạn khóa an toàn (Safe Extend / Heartbeat)
 * Chỉ cập nhật lại PEXPIRE nếu giá trị hiện tại trùng khớp với token của phiên này.
 */
export const SAFE_EXTEND_LUA = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("pexpire", KEYS[1], ARGV[2])
  else
    return 0
  end
`;