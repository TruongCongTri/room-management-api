import { Injectable, Logger } from '@nestjs/common';
import { Logger as ITypeOrmLogger, QueryRunner } from 'typeorm';
import { RequestContextService } from '../context/request-context.service';
import { AppConfigService } from '../config/app-config.service';

const MAX_QUERY_LOG_LENGTH = 2000;

/**
 * TypeORM Logger gắn traceId/userId cho truy vấn lỗi & truy vấn chậm.
 * Trên production KHÔNG ghi giá trị tham số (có thể chứa PII), chỉ ghi số lượng.
 */
@Injectable()
export class TypeOrmLoggerService implements ITypeOrmLogger {
  private readonly logger = new Logger('TypeORM');
  private readonly slowQueryThresholdMs: number;
  private readonly logParameters: boolean;
  private readonly logAllQueries: boolean;

  constructor(
    private readonly contextService: RequestContextService,
    config: AppConfigService,
  ) {
    this.slowQueryThresholdMs = config.database.slowQueryMs;
    this.logParameters = !config.isProduction;
    this.logAllQueries = config.database.logQueries;
  }

  logQuery(query: string, parameters?: any[], _queryRunner?: QueryRunner): void {
    // Chỉ ghi toàn bộ SQL khi bật DB_LOG_QUERIES (gỡ lỗi cục bộ) để tránh làm ngập log
    if (this.logAllQueries) {
      this.logger.debug(
        `${this.prefix()} SQL: ${this.truncate(query)} -- Params: ${this.formatParams(parameters)}`,
      );
    }
  }

  logQueryError(
    error: string | Error,
    query: string,
    parameters?: any[],
    _queryRunner?: QueryRunner,
  ): void {
    const errorMsg = error instanceof Error ? error.message : error;
    this.logger.error(
      `${this.prefix()} SQL ERROR: ${errorMsg} | SQL: ${this.truncate(query)} | Params: ${this.formatParams(parameters)}`,
    );
  }

  logQuerySlow(time: number, query: string, parameters?: any[], _queryRunner?: QueryRunner): void {
    this.logger.warn(
      `${this.prefix()} SLOW QUERY (${time}ms >= ${this.slowQueryThresholdMs}ms): ${this.truncate(query)} | Params: ${this.formatParams(parameters)}`,
    );
  }

  logSchemaBuild(message: string, _queryRunner?: QueryRunner): void {
    this.logger.log(`Schema Build: ${message}`);
  }

  logMigration(message: string, _queryRunner?: QueryRunner): void {
    this.logger.log(`Migration: ${message}`);
  }

  log(level: 'log' | 'info' | 'warn', message: any, _queryRunner?: QueryRunner): void {
    if (level === 'warn') {
      this.logger.warn(message);
    } else {
      this.logger.log(message);
    }
  }

  private prefix(): string {
    const userId = this.contextService.getUserId();
    return `[${this.contextService.getTraceId()}${userId ? ` user=${userId}` : ''}]`;
  }

  private truncate(query: string): string {
    return query.length > MAX_QUERY_LOG_LENGTH
      ? `${query.slice(0, MAX_QUERY_LOG_LENGTH)}…(${query.length} chars)`
      : query;
  }

  private formatParams(parameters?: any[]): string {
    if (!parameters || parameters.length === 0) return '[]';
    if (!this.logParameters) return `[${parameters.length} redacted]`;
    try {
      return this.truncate(JSON.stringify(parameters));
    } catch {
      return '[Unserializable Parameters]';
    }
  }
}
