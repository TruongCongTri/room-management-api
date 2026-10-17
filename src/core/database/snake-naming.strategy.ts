import { DefaultNamingStrategy, NamingStrategyInterface } from 'typeorm';

export class SnakeNamingStrategy extends DefaultNamingStrategy implements NamingStrategyInterface {
  private toSnakeCase(str: string): string {
    return str
      .replace(/([a-z\d])([A-Z])/g, '$1_$2')
      .replace(/([A-Z]+)([A-Z][a-z\d]+)/g, '$1_$2')
      .toLowerCase();
  }

  tableName(className: string, customName?: string): string {
    return customName ? customName : this.toSnakeCase(className);
  }

  columnName(propertyName: string, customName: string | undefined, embeddedPrefixes: string[]): string {
    const formattedPrefixes = embeddedPrefixes.map((p) => this.toSnakeCase(p)).join('_');
    const baseColumn = customName ? customName : this.toSnakeCase(propertyName);
    return formattedPrefixes ? `${formattedPrefixes}_${baseColumn}` : baseColumn;
  }

  relationName(propertyName: string): string {
    return this.toSnakeCase(propertyName);
  }

  joinColumnName(relationName: string, referencedColumnName: string): string {
    return this.toSnakeCase(`${relationName}_${referencedColumnName}`);
  }

  joinTableName(firstTableName: string, secondTableName: string): string {
    return this.toSnakeCase(`${firstTableName}_${secondTableName}`);
  }

  joinTableColumnName(tableName: string, propertyName: string, columnName?: string): string {
    return this.toSnakeCase(`${tableName}_${columnName ? columnName : propertyName}`);
  }
}