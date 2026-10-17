/**
 * Khai báo danh mục kênh, người nhận và cấu trúc phản hồi:  
 * */

export enum NotificationChannel {
  EMAIL = 'EMAIL',
  SMS = 'SMS',
  TELEGRAM = 'TELEGRAM',
  PUSH = 'PUSH',
  ZALO = 'ZALO',
}

export interface NotificationRecipient {
  email?: string;
  phone?: string;
  telegramChatId?: string;
  zaloUserId?: string;
  deviceTokens?: string[];
  name?: string;
}

export interface NotificationPayload {
  templateName?: string;
  context?: Record<string, any>;
  subject?: string;
  content?: string;
  znsTemplateId?: string;
  attachments?: Array<{
    filename: string;
    content: Buffer | string;
    contentType?: string;
  }>;
}

export interface SendNotificationOptions {
  channels: NotificationChannel[];
  recipient: NotificationRecipient;
  payload: NotificationPayload;
  priority?: 'low' | 'normal' | 'high';
}

export interface ChannelDeliveryResult {
  channel: NotificationChannel;
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface NotificationDispatchResult {
  success: boolean;
  results: ChannelDeliveryResult[];
}
