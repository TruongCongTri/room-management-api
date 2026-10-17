/**
 * Phân định 5 pha dừng hệ thống theo đúng chuỗi phụ thuộc hạ tầng:   
 * */ 
export enum ShutdownPhase {
  /**
   * PHA 1: Chuyển Readiness Probe sang FAILED, đợi K8s Ingress/ALB gỡ Pod khỏi Endpoint
   */
  DRAIN_TRAFFIC = 'DRAIN_TRAFFIC',

  /**
   * PHA 2: Dừng nhận job mới từ Queue (BullMQ) và đóng cổng kết nối thời gian thực (WebSocket)
   */
  PAUSE_CONSUMERS = 'PAUSE_CONSUMERS',

  /**
   * PHA 3: Chờ các HTTP Request đang thực thi dở dang (In-flight requests) hoàn tất
   */
  DRAIN_HTTP = 'DRAIN_HTTP',

  /**
   * PHA 4: Đẩy toàn bộ log và metric/trace còn đọng trong buffer sang ELK/Loki/Jaeger
   */
  FLUSH_BUFFERS = 'FLUSH_BUFFERS',

  /**
   * PHA 5: Giải phóng an toàn các kết nối tài nguyên nền tảng (PostgreSQL Pools, Redis Connections)
   */
  RELEASE_POOLS = 'RELEASE_POOLS',
}

export type ShutdownHandlerFn = (signal?: string) => Promise<void> | void;

export interface RegisteredShutdownHook {
  name: string;
  phase: ShutdownPhase;
  order: number; // Ưu tiên chạy trước (số nhỏ hơn chạy trước)
  handler: ShutdownHandlerFn;
}