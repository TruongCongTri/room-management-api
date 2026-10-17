import type { Config } from 'jest';
import { pathsToModuleNameMapper } from 'ts-jest';
import ts from 'typescript';

// Path aliases từ tsconfig.json
const { config: tsconfig } = ts.readConfigFile('./tsconfig.json', ts.sys.readFile);
const paths = tsconfig?.compilerOptions?.paths ?? {};

/**
 * NestJS 12 phát hành dạng ESM thuần ("type": "module"). Jest được chạy với
 * `node --experimental-vm-modules` (xem script `test` trong package.json) để nạp các gói ESM
 * trong node_modules NGUYÊN BẢN (require(esm)), không cần transform hay mock thủ công từng file dùng import.meta.
 */
const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  roots: ['<rootDir>/src'],
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  moduleNameMapper: pathsToModuleNameMapper(paths, { prefix: '<rootDir>/' }),
  collectCoverageFrom: ['src/**/*.(t|j)s', '!src/**/*.spec.ts', '!src/main.ts', '!src/instrumentation.ts'],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
};

export default config;
