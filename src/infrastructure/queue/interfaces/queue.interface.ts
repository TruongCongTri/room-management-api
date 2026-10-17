/**
 * Cấu trúc chuẩn hóa gói tin Job Data:
 * */
export interface QueueJobMetadata {
  traceId: string;
  tenantId: string;
  actorId?: string;
  actorEmail?: string;
  locale?: string;
  enqueuedAt: string;
  /** W3C Trace Context để span của worker nối tiếp distributed trace của request gốc */
  traceparent?: string;
  tracestate?: string;
}

export interface EnvelopedJobPayload<T = any> {
  metadata: QueueJobMetadata;
  payload: T;
}

export interface DeadLetterRecord<T = any> {
  originalQueue: string;
  originalJobId: string;
  jobName: string;
  failedReason: string;
  stackTrace?: string;
  attemptsMade: number;
  exhaustedAt: string;
  jobData: EnvelopedJobPayload<T>;
}
