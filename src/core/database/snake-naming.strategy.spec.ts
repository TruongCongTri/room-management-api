import { SnakeNamingStrategy } from './snake-naming.strategy';

describe('SnakeNamingStrategy (PostgreSQL Standard)', () => {
  let strategy: SnakeNamingStrategy;

  beforeEach(() => {
    strategy = new SnakeNamingStrategy();
  });

  it('should format Entity class names into snake_case table names', () => {
    expect(strategy.tableName('ContractItem')).toBe('contract_item');
    expect(strategy.tableName('MeterReadingRecord')).toBe('meter_reading_record');
    expect(strategy.tableName('UserPaymentTransaction')).toBe('user_payment_transaction');
  });

  it('should respect custom table name when provided', () => {
    expect(strategy.tableName('ContractItem', 'custom_contracts')).toBe('custom_contracts');
  });

  it('should format camelCase property names into snake_case column names', () => {
    expect(strategy.columnName('holdExpiresAt', undefined, [])).toBe('hold_expires_at');
    expect(strategy.columnName('tenantIdNumber', undefined, [])).toBe('tenant_id_number');
    expect(strategy.columnName('createdAt', undefined, [])).toBe('created_at');
  });

  it('should format embedded entity prefixes correctly', () => {
    expect(strategy.columnName('streetName', undefined, ['tenantAddress'])).toBe(
      'tenant_address_street_name',
    );
  });

  it('should format join table and column names cleanly', () => {
    expect(strategy.joinColumnName('contract', 'id')).toBe('contract_id');
    expect(strategy.joinTableName('roles', 'permissions')).toBe('roles_permissions');
  });
});

// npx jest src/core/database/snake-naming.strategy.spec.ts