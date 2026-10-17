/**
 * Điều phối vòng đời của MỌI BullMQ Worker trong ứng dụng (không cần code trong từng Processor):
 *  - Pha 2 Graceful Shutdown (PAUSE_CONSUMERS): worker.pause() ngừng nhận job mới và CHỜ job đang chạy
 *    hoàn tất (giới hạn bởi SHUTDOWN_HOOK_TIMEOUT_MS) trước khi đóng kết nối.
 *  - Chuyển job kiệt sức retry sang Dead-Letter Queue.
 */
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { WorkerHost } from '@nestjs/bullmq';
import { Job, Worker } from 'bullmq';
import { ShutdownRegistry } from '../../../core/shutdown/shutdown.registry';
import { ShutdownPhase } from '../../../core/shutdown/shutdown.interface';
import { DlqMonitorService } from './dlq-monitor.service';

@Injectable()
export class QueueLifecycleService implements OnApplicationBootstrap {
  private readonly logger = new Logger(QueueLifecycleService.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly shutdownRegistry: ShutdownRegistry,
    private readonly dlqMonitor: DlqMonitorService,
  ) {}

  onApplicationBootstrap(): void {
    const workers = this.discoverWorkers();

    for (const worker of workers) {
      worker.on('failed', (job: Job | undefined, error: Error) => {
        if (!job || !this.dlqMonitor.isExhausted(job, error)) return;
        this.dlqMonitor
          .moveToDeadLetter(worker.name, job, error)
          .catch((err: Error) => this.logger.error(`Failed to move job #${job.id} to DLQ: ${err.message}`));
      });
    }

    this.shutdownRegistry.register(
      'BullMQWorkersPause',
      ShutdownPhase.PAUSE_CONSUMERS,
      async () => {
        const active = this.discoverWorkers();
        this.logger.log(`[Shutdown] Pausing ${active.length} BullMQ worker(s) and draining active jobs...`);
        // pause() mặc định chờ các job đang chạy hoàn tất
        await Promise.all(active.map((worker) => worker.pause()));
      },
      20,
    );

    if (workers.length > 0) {
      this.logger.log(`Managing ${workers.length} BullMQ worker(s): ${workers.map((w) => w.name).join(', ')}`);
    }
  }

  private discoverWorkers(): Worker[] {
    return this.discovery
      .getProviders()
      .map((wrapper) => wrapper.instance)
      .filter((instance): instance is WorkerHost => instance instanceof WorkerHost)
      .map((host) => {
        try {
          return host.worker;
        } catch {
          return undefined; // Worker chưa được khởi tạo (processor bị vô hiệu hóa)
        }
      })
      .filter((worker): worker is Worker => !!worker);
  }
}
