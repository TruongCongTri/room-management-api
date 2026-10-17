/**
 * Điều phối tuần tự 5 pha tắt ứng dụng và kích hoạt Watchdog Timer bảo vệ process.
 *
 * Trình tự NestJS khi app.close(): onModuleDestroy → beforeApplicationShutdown
 * → đóng HTTP server → onApplicationShutdown.
 *  - Pha 1-3 chạy trong beforeApplicationShutdown (HTTP server vẫn mở để phục vụ request dở dang).
 *  - Pha 4-5 chạy trong onApplicationShutdown (HTTP server đã đóng).
 */
import {
  Injectable,
  Logger,
  BeforeApplicationShutdown,
  OnApplicationShutdown,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ShutdownRegistry } from './shutdown.registry';
import { ShutdownPhase } from './shutdown.interface';
import { AppConfigService } from '../config/app-config.service';

const TERMINATION_SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
const IN_FLIGHT_POLL_MS = 50;

@Injectable()
export class GracefulShutdownService
  implements
    OnApplicationBootstrap,
    BeforeApplicationShutdown,
    OnApplicationShutdown
{
  private readonly logger = new Logger(GracefulShutdownService.name);
  private isShuttingDownState = false;
  private watchdog?: NodeJS.Timeout;
  private inFlightRequests = 0;

  // Không readonly để test có thể rút ngắn thời gian chờ
  private trafficDrainWaitMs: number;
  private hookTimeoutMs: number;
  private watchdogTimeoutMs: number;

  private readonly onSignal = (signal: NodeJS.Signals) =>
    this.markShuttingDown(signal);

  constructor(
    private readonly registry: ShutdownRegistry,
    config: AppConfigService,
  ) {
    const { drainDelayMs, hookTimeoutMs, timeoutMs } = config.shutdown;
    this.trafficDrainWaitMs = drainDelayMs;
    this.hookTimeoutMs = hookTimeoutMs;
    this.watchdogTimeoutMs = timeoutMs;
  }

  /**
   * Bật cờ shutting-down NGAY khi nhận tín hiệu (trước cả onModuleDestroy của các module khác)
   * để Readiness Probe trả 503 sớm nhất có thể.
   */
  onApplicationBootstrap(): void {
    for (const signal of TERMINATION_SIGNALS) {
      process.prependListener(signal, this.onSignal);
    }
  }

  /**
   * Cờ trạng thái để HealthController / Readiness Probe trả về 503 Service Unavailable
   */
  isShuttingDown(): boolean {
    return this.isShuttingDownState;
  }

  getInFlightRequestCount(): number {
    return this.inFlightRequests;
  }

  /**
   * Được gọi bởi InFlightRequestMiddleware cho mỗi HTTP request
   */
  trackRequest(onDone: (cb: () => void) => void): void {
    this.inFlightRequests++;
    let finished = false;
    onDone(() => {
      if (finished) return;
      finished = true;
      this.inFlightRequests--;
    });
  }

  /**
   * Kích hoạt ngay khi nhận tín hiệu SIGTERM / SIGINT từ OS / Kubernetes
   */
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.markShuttingDown(signal);

    // PHA 1: TRAFFIC DRAIN (Đợi Load Balancer / K8s Ingress gỡ Pod khỏi Endpoint)
    this.logger.log(
      `[Shutdown:Phase 1] Draining traffic. Holding for ${this.trafficDrainWaitMs}ms...`,
    );
    await this.executePhaseHooks(ShutdownPhase.DRAIN_TRAFFIC, signal);
    await this.sleep(this.trafficDrainWaitMs);

    // PHA 2: PAUSE CONSUMERS (Tạm dừng BullMQ, Message Queue, WebSockets)
    this.logger.log('[Shutdown:Phase 2] Pausing queue consumers and socket connections...');
    await this.executePhaseHooks(ShutdownPhase.PAUSE_CONSUMERS, signal);

    // PHA 3: IN-FLIGHT HTTP (Chờ các request HTTP đang chạy dở dang)
    this.logger.log(
      `[Shutdown:Phase 3] Awaiting ${this.inFlightRequests} in-flight HTTP request(s)...`,
    );
    await this.executePhaseHooks(ShutdownPhase.DRAIN_HTTP, signal);
    await this.waitForInFlightRequests();
  }

  /**
   * Kích hoạt khi NestJS đã đóng HTTP server
   */
  async onApplicationShutdown(signal?: string): Promise<void> {
    // PHA 4: FLUSH BUFFERS (Đẩy toàn bộ Log / Trace buffers về ELK/Loki)
    this.logger.log('[Shutdown:Phase 4] Flushing logging and distributed tracing buffers...');
    await this.executePhaseHooks(ShutdownPhase.FLUSH_BUFFERS, signal);

    // PHA 5: CLOSE RESOURCES (Đóng kết nối Database, Redis, Lock)
    this.logger.log('[Shutdown:Phase 5] Closing persistent connections and pools...');
    await this.executePhaseHooks(ShutdownPhase.RELEASE_POOLS, signal);

    for (const sig of TERMINATION_SIGNALS) {
      process.removeListener(sig, this.onSignal);
    }
    if (this.watchdog) clearTimeout(this.watchdog);

    this.logger.log('[Shutdown] All 5 decommissioning phases completed. Process exiting cleanly.');
  }

  private markShuttingDown(signal?: string): void {
    if (this.isShuttingDownState) return;
    this.isShuttingDownState = true;
    this.logger.warn(
      `[Shutdown] Received '${signal ?? 'shutdown'}'. Readiness set to NOT READY; starting coordinated shutdown...`,
    );
    this.armWatchdogTimer();
  }

  /**
   * Thực thi toàn bộ hooks đã đăng ký trong một pha cụ thể.
   * Mỗi hook có timeout riêng; lỗi/treo của một hook không chặn các hook còn lại.
   */
  private async executePhaseHooks(phase: ShutdownPhase, signal?: string): Promise<void> {
    for (const hook of this.registry.getHooksForPhase(phase)) {
      let timer: NodeJS.Timeout | undefined;
      try {
        this.logger.debug(`[Shutdown:${phase}] Executing clean-up hook '${hook.name}'...`);
        await Promise.race([
          Promise.resolve().then(() => hook.handler(signal)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`timed out after ${this.hookTimeoutMs}ms`)),
              this.hookTimeoutMs,
            );
          }),
        ]);
      } catch (err: any) {
        this.logger.error(
          `[Shutdown:${phase}] Error in hook '${hook.name}': ${err?.message}`,
          err?.stack,
        );
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }

  private async waitForInFlightRequests(): Promise<void> {
    const deadline = Date.now() + this.hookTimeoutMs;
    while (this.inFlightRequests > 0 && Date.now() < deadline) {
      await this.sleep(IN_FLIGHT_POLL_MS);
    }
    if (this.inFlightRequests > 0) {
      this.logger.warn(
        `[Shutdown:Phase 3] ${this.inFlightRequests} request(s) still running after ${this.hookTimeoutMs}ms; continuing shutdown.`,
      );
    }
  }

  /**
   * Watchdog Timer phòng ngừa treo tiến trình (phải nhỏ hơn terminationGracePeriodSeconds)
   */
  private armWatchdogTimer(): void {
    if (this.watchdog) return;
    this.watchdog = setTimeout(() => {
      this.logger.error(
        `[Shutdown:Watchdog] Graceful shutdown exceeded threshold (${this.watchdogTimeoutMs}ms). Forcing process exit.`,
      );
      process.exit(1);
    }, this.watchdogTimeoutMs);

    // Cho phép event loop thoát tự nhiên nếu shutdown hoàn tất trước timeout
    this.watchdog.unref();
  }

  private sleep(ms: number): Promise<void> {
    return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
  }
}
