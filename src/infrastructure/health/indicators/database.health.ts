// Kiểm tra khả năng thực thi truy vấn của PostgreSQL Master & Replica qua DataSource, đo lường chính xác độ trễ kết nối:

import { Injectable } from '@nestjs/common';
import { HealthIndicatorResult } from '@nestjs/terminus';
import { DataSource, ReplicationMode } from 'typeorm';

@Injectable()
export class DatabaseHealthIndicator {
  constructor(private readonly dataSource: DataSource) {}

  async isHealthy(key = 'database'): Promise<HealthIndicatorResult> {
    if (!this.dataSource.isInitialized) {
      return { [key]: { status: 'down', message: 'TypeORM DataSource is not initialized.' } };
    }

    const hasReplica = !!(this.dataSource.options as { replication?: unknown }).replication;
    const master = await this.ping('master');
    const replica = hasReplica ? await this.ping('slave') : undefined;

    const status = master.ok && (replica?.ok ?? true) ? 'up' : 'down';
    return {
      [key]: {
        status,
        latencyMs: master.latencyMs,
        ...(master.error ? { message: master.error } : {}),
        ...(replica
          ? { replica: { status: replica.ok ? 'up' : 'down', latencyMs: replica.latencyMs, message: replica.error } }
          : {}),
      },
    };
  }

  private async ping(mode: ReplicationMode): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const startTime = Date.now();
    const runner = this.dataSource.createQueryRunner(mode);
    try {
      // Thực thi truy vấn kiểm tra kết nối tới Database Kernel
      await runner.query('SELECT 1');
      return { ok: true, latencyMs: Date.now() - startTime };
    } catch (err: any) {
      return { ok: false, latencyMs: Date.now() - startTime, error: err.message };
    } finally {
      await runner.release().catch(() => undefined);
    }
  }
}
