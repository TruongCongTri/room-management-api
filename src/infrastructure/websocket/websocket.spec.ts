import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { WsJwtGuard } from './guards/ws-jwt.guard';
import { AppEventsGateway, RECONNECT_EVENT } from './gateways/app-events.gateway';
import { RealtimeEmitterService } from './services/realtime-emitter.service';
import { RequestUserContext } from '../../core/context/request-context.model';

describe('RealtimeWebSocketModule (Enterprise Socket.io Suite)', () => {
  let guard: WsJwtGuard;
  let tokenService: { verifyAccessToken: jest.Mock; extractBearerToken: jest.Mock };

  const verifiedUser: RequestUserContext = {
    id: 'usr_ws_1',
    email: 'pilot@landlord.com',
    tenantId: '22222222-2222-4222-8222-222222222222',
    roles: [],
    rules: [],
  };

  beforeEach(() => {
    tokenService = {
      verifyAccessToken: jest.fn(),
      extractBearerToken: jest.fn((header?: string) => header?.replace(/^Bearer\s+/i, '')),
    };
    guard = new WsJwtGuard(tokenService as any);
  });

  const wsContext = (socket: any) =>
    ({ switchToWs: () => ({ getClient: () => socket }) }) as unknown as ExecutionContext;

  it('should authenticate the handshake token (auth.token) and populate socket.data.user', async () => {
    tokenService.verifyAccessToken.mockResolvedValue(verifiedUser);
    const socket: any = { handshake: { auth: { token: 'valid_jwt_token' }, headers: {} }, data: {} };

    await expect(guard.canActivate(wsContext(socket))).resolves.toBe(true);

    expect(tokenService.verifyAccessToken).toHaveBeenCalledWith('valid_jwt_token');
    expect(socket.data.user).toEqual(verifiedUser);
  });

  it('should accept the Authorization header as a fallback', async () => {
    tokenService.verifyAccessToken.mockResolvedValue(verifiedUser);
    const socket: any = { handshake: { headers: { authorization: 'Bearer header_token' } }, data: {} };

    await guard.authenticateSocket(socket);
    expect(tokenService.verifyAccessToken).toHaveBeenCalledWith('header_token');
  });

  it('should reject sockets with invalid or missing tokens', async () => {
    tokenService.verifyAccessToken.mockRejectedValue(new UnauthorizedException());
    const socket: any = { handshake: { auth: { token: 'expired' }, headers: {} }, data: {} };

    await expect(guard.authenticateSocket(socket)).rejects.toThrow(WsException);
    await expect(
      guard.authenticateSocket({ handshake: { headers: {} }, data: {} } as any),
    ).rejects.toThrow(WsException);
  });

  describe('AppEventsGateway', () => {
    it('should join building and user rooms only for authenticated sockets', () => {
      const gateway = new AppEventsGateway(guard);
      const client: any = { id: 's1', data: { user: verifiedUser }, join: jest.fn(), disconnect: jest.fn() };

      gateway.handleConnection(client);

      expect(client.join).toHaveBeenCalledWith(`building:${verifiedUser.tenantId}`);
      expect(client.join).toHaveBeenCalledWith('user:usr_ws_1');
    });

    it('should not place tenant-less users into a shared building room', () => {
      const gateway = new AppEventsGateway(guard);
      const client: any = { id: 's2', data: { user: { ...verifiedUser, tenantId: undefined } }, join: jest.fn() };

      gateway.handleConnection(client);

      expect(client.join).toHaveBeenCalledTimes(1);
      expect(client.join).toHaveBeenCalledWith('user:usr_ws_1');
    });

    it('should notify and disconnect only LOCAL sockets on graceful teardown', async () => {
      const gateway = new AppEventsGateway(guard);
      const local = { emit: jest.fn(), disconnectSockets: jest.fn() };
      gateway.server = { local } as any;

      await gateway.teardown();

      expect(local.emit).toHaveBeenCalledWith(RECONNECT_EVENT, expect.objectContaining({ reason: 'server_shutdown' }));
      expect(local.disconnectSockets).toHaveBeenCalledWith(true);
    });
  });

  describe('RealtimeEmitterService', () => {
    it('should broadcast meter updates to a specific building room', () => {
      const mockServer: any = {
        to: jest.fn().mockReturnThis(),
        emit: jest.fn(),
      };

      const mockGateway = { server: mockServer } as unknown as AppEventsGateway;

      const emitter = new RealtimeEmitterService(mockGateway);
      emitter.emitToBuilding('building_hn', 'meter_reading.submitted', { room: 'P.302' });

      expect(mockServer.to).toHaveBeenCalledWith('building:building_hn');
      expect(mockServer.emit).toHaveBeenCalledWith('meter_reading.submitted', { room: 'P.302' });
    });
  });
});

// npx jest src/infrastructure/websocket/websocket.spec.ts
