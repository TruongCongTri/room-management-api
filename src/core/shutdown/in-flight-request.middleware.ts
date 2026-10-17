import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { GracefulShutdownService } from './graceful-shutdown.service';

/**
 * Đếm số HTTP request đang xử lý để Pha 3 (DRAIN_HTTP) chờ chính xác,
 * đồng thời yêu cầu client đóng keep-alive khi Pod đang tắt.
 */
@Injectable()
export class InFlightRequestMiddleware implements NestMiddleware {
  constructor(private readonly shutdownService: GracefulShutdownService) {}

  use(_req: Request, res: Response, next: NextFunction): void {
    if (this.shutdownService.isShuttingDown()) {
      res.setHeader('Connection', 'close');
    }

    this.shutdownService.trackRequest((done) => {
      res.once('finish', done);
      res.once('close', done);
    });

    next();
  }
}
