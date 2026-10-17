import { ExecutionContext, CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import { DeprecationInterceptor } from './deprecation.interceptor';

describe('VersioningModule (RFC 8594 Suite)', () => {
  it('should attach Deprecation, Sunset, and Link headers when endpoint is deprecated', (done) => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue({
      sunsetDate: '2026-12-31T00:00:00Z',
      alternativePath: '/api/v2/rooms',
    });

    const mockResponse: any = {
      setHeader: jest.fn(),
    };

    const context = {
      getType: () => 'http',
      getHandler: () => () => {},
      getClass: () => class {},
      switchToHttp: () => ({
        getResponse: () => mockResponse,
      }),
    } as unknown as ExecutionContext;

    const callHandler: CallHandler = { handle: () => of({ ok: true }) };
    const interceptor = new DeprecationInterceptor(reflector);

    interceptor.intercept(context, callHandler).subscribe({
      complete: () => {
        expect(mockResponse.setHeader).toHaveBeenCalledWith('Deprecation', 'true');
        expect(mockResponse.setHeader).toHaveBeenCalledWith('Sunset', expect.any(String));
        expect(mockResponse.setHeader).toHaveBeenCalledWith(
          'Link',
          '</api/v2/rooms>; rel="successor-version"',
        );
        done();
      },
    });
  });
});

// npx jest src/core/versioning/versioning.spec.ts 