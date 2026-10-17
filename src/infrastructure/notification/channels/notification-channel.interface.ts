/**
 * Giao diện chuẩn hóa cho các Adapter kênh thông báo:   
 * 
 * */ 

import {
  NotificationChannel,
  NotificationRecipient,
  ChannelDeliveryResult,
} from '../interfaces/notification.interface';

export interface RenderedPayload {
  subject?: string;
  content: string;
  attachments?: any[];
}

export interface NotificationChannelAdapter {
  readonly channelType: NotificationChannel;
  send(
    recipient: NotificationRecipient,
    payload: RenderedPayload,
  ): Promise<ChannelDeliveryResult>;
}