/**
 * Ký & xác thực token THẬT (jsonwebtoken) với đúng options mà SecurityModule đăng ký:
 * HS256 có/không issuer-audience, RS256 bằng public key, hết hạn, sai cấu trúc claims, refresh token.
 */
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { generateKeyPairSync } from 'crypto';
import { JwtTokenService } from './jwt-token.service';
import { buildJwtOptions } from '../security.module';
import { validateEnv } from '../../config/env.schema';
import { configServiceFrom } from '../../config/load-config';
import { AppConfigService } from '../../config/app-config.service';

const BASE_ENV = {
  NODE_ENV: 'test',
  DB_MASTER_HOST: 'localhost',
  DB_MASTER_USER: 'postgres',
  DB_MASTER_PASSWORD: 'postgres',
  DB_NAME: 'db',
  ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  BLIND_INDEX_PEPPER: 'test-blind-index-pepper-with-at-least-32-characters',
  JWT_SECRET: 'unit-test-jwt-secret-with-at-least-32-chars',
  JWT_REFRESH_SECRET: 'unit-test-refresh-secret-with-at-least-32-chars',
};

const TENANT = '11111111-1111-4111-8111-111111111111';

function createService(env: Record<string, string> = {}, rules: any[] = []) {
  const config = new AppConfigService(configServiceFrom(validateEnv({ ...BASE_ENV, ...env })));
  const resolver = { resolve: jest.fn().mockResolvedValue(rules) };
  const jwtService = new JwtService(buildJwtOptions(config));
  return { service: new JwtTokenService(jwtService, config, resolver as any), jwtService, resolver };
}

describe('JwtTokenService', () => {
  it('should sign and verify an HS256 access token without issuer/audience configured', async () => {
    const { service } = createService();
    const token = await service.signAccessToken({ sub: 'usr_1', email: 'a@b.c', tenantId: TENANT, roles: ['GUARD'], rules: [] });

    await expect(service.verifyAccessToken(token)).resolves.toEqual({
      id: 'usr_1',
      email: 'a@b.c',
      tenantId: TENANT,
      buildingIds: undefined,
      departmentId: undefined,
      roles: ['GUARD'],
      rules: [],
    });
  });

  it('should accept the buildingId / buildingIds claims (landlord managing several buildings)', async () => {
    const OTHER = '33333333-3333-4333-8333-333333333333';
    const { service } = createService();
    const token = await service.signAccessToken({
      sub: 'usr_landlord',
      email: 'landlord@rental.vn',
      buildingId: TENANT,
      buildingIds: [TENANT, OTHER],
      roles: ['LANDLORD'],
      rules: [],
    });

    await expect(service.verifyAccessToken(token)).resolves.toEqual(
      expect.objectContaining({ tenantId: TENANT, buildingIds: [TENANT, OTHER] }),
    );
  });

  it('should enforce issuer and audience when configured', async () => {
    const { service } = createService({ JWT_ISSUER: 'https://auth.rental.vn', JWT_AUDIENCE: 'room-management-api' });
    const other = createService({ JWT_ISSUER: 'https://evil.example', JWT_AUDIENCE: 'room-management-api' }).service;

    const token = await service.signAccessToken({ sub: 'usr_1', email: 'a@b.c' });
    await expect(service.verifyAccessToken(token)).resolves.toEqual(expect.objectContaining({ id: 'usr_1' }));

    const foreign = await other.signAccessToken({ sub: 'usr_1', email: 'a@b.c' });
    await expect(service.verifyAccessToken(foreign)).rejects.toThrow(UnauthorizedException);
  });

  it('should verify RS256 tokens with the public key (asymmetric, auth service holds the private key)', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const { service } = createService({
      JWT_ALGORITHM: 'RS256',
      JWT_PUBLIC_KEY: publicKey,
      JWT_PRIVATE_KEY: privateKey,
    });

    const token = await service.signAccessToken({ sub: 'usr_rs', email: 'rs@b.c' });
    await expect(service.verifyAccessToken(token)).resolves.toEqual(expect.objectContaining({ id: 'usr_rs' }));

    // Tấn công nhầm lẫn thuật toán: token HS256 ký bằng public key phải bị từ chối
    const hs = createService().jwtService;
    const forged = await hs.signAsync({ sub: 'x', email: 'x@y.z' }, { secret: publicKey, algorithm: 'HS256' });
    await expect(service.verifyAccessToken(forged)).rejects.toThrow(UnauthorizedException);
  });

  it('should report AUTH_TOKEN_EXPIRED for expired tokens', async () => {
    const { service } = createService();
    const token = await service.signAccessToken({ sub: 'usr_1', email: 'a@b.c' }, '-10s');

    await expect(service.verifyAccessToken(token)).rejects.toMatchObject({
      response: expect.objectContaining({ errorCode: 'AUTH_TOKEN_EXPIRED' }),
    });
  });

  it('should reject validly signed tokens with malformed claims or refresh-token type', async () => {
    const { service, jwtService } = createService();

    const noEmail = await jwtService.signAsync({ sub: 'usr_1' });
    await expect(service.verifyAccessToken(noEmail)).rejects.toMatchObject({
      response: expect.objectContaining({ message: 'Access token claims are malformed.' }),
    });

    const badTenant = await jwtService.signAsync({ sub: 'usr_1', email: 'a@b.c', tenantId: 'not-a-uuid' });
    await expect(service.verifyAccessToken(badTenant)).rejects.toThrow(UnauthorizedException);

    const refresh = await jwtService.signAsync({ sub: 'usr_1', email: 'a@b.c', typ: 'refresh' });
    await expect(service.verifyAccessToken(refresh)).rejects.toMatchObject({
      response: expect.objectContaining({ message: 'Refresh tokens cannot be used to access the API.' }),
    });
  });

  it('should resolve permission rules from the cache/loader when the token does not embed them', async () => {
    const rules = [{ resource: 'invoices', action: 'read', scope: 'own', effect: 'GRANT' }];
    const { service, resolver } = createService({}, rules);
    const token = await service.signAccessToken({ sub: 'usr_lean', email: 'a@b.c', tenantId: TENANT, roles: ['TENANT'] });

    await expect(service.verifyAccessToken(token)).resolves.toEqual(expect.objectContaining({ rules }));
    expect(resolver.resolve).toHaveBeenCalledWith('usr_lean', TENANT, ['TENANT']);
  });

  it('should extract bearer tokens case-insensitively', () => {
    const { service } = createService();
    expect(service.extractBearerToken('bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(service.extractBearerToken('Basic dXNlcjpwYXNz')).toBeUndefined();
    expect(service.extractBearerToken(undefined)).toBeUndefined();
  });
});
