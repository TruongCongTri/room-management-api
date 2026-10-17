/**
 * Khởi tạo https.Agent an toàn cho các đối tác yêu cầu Mutual TLS:   
 * 
 * */ 
import { Agent } from 'https';
import { readFileSync, existsSync } from 'fs';
import { MtlsConfig } from '../interfaces/http-client.interface';

export class MtlsAgentFactory {
  static createAgent(config: MtlsConfig): Agent {
    const cert = this.resolveContentOrPath(config.cert);
    const key = this.resolveContentOrPath(config.key);
    const ca = config.ca ? this.resolveContentOrPath(config.ca) : undefined;

    return new Agent({
      cert,
      key,
      ca,
      passphrase: config.passphrase,
      rejectUnauthorized: config.rejectUnauthorized ?? true,
      keepAlive: true,
      timeout: 30000,
    });
  }

  private static resolveContentOrPath(value: string): string | Buffer {
    if (existsSync(value)) {
      return readFileSync(value);
    }
    return value; // Chuỗi thô (PEM string nạp từ biến môi trường)
  }
}