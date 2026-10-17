/**
 * Khuôn mẫu phản hồi chuẩn quốc tế cho toàn bộ API của hệ thống:
 * 
 * */ 

export interface ApiResponseEnvelope<T> {
  success: true;
  statusCode: number;
  data: T;
  meta: {
    traceId: string;
    timestamp: string;
    durationMs: number;
    pagination?: {
      page: number;
      limit: number;
      totalItems: number;
      totalPages: number;
      hasNextPage: boolean;
      hasPreviousPage: boolean;
    };
  };
}