/**
 * Phần logic không cần DB của module 1: DTO (chuẩn hóa & biên), RoomAccessGuard, "phòng của tôi", listener realtime,
 * helper. Truy vấn, RLS, cache, khóa và ràng buộc kernel: test/properties.e2e-spec.ts (PostgreSQL thật, role app_user).
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateBuildingDto, CreateRoomDto, QueryRoomsDto, UpdateBuildingDto, UpdateRoomDto } from './dto/properties.dto';
import { AssignRoomAssetDto, CreateAssetDto } from '../assets/dto/assets.dto';
import { RoomAccessGuard } from './guards/room-access.guard';
import { PropertiesService } from './services/properties.service';
import { RoomEventsListener } from './listeners/room-events.listener';
import { assertSomethingToUpdate, isUniqueViolation, vietnamToday } from './properties.helpers';
import { CaslAbilityFactory } from '../../core/access-control/casl-ability.factory';
import { resolveRolePermissions } from '../../core/access-control/rental-permissions';

const ROOM_TYPE = '11111111-1111-4111-8111-111111111111';

async function check<T extends object>(cls: new () => T, plain: Record<string, unknown>) {
  const dto = plainToInstance(cls, plain);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return { dto, fields: errors.map((e) => e.property) };
}

describe('Properties & Assets DTOs', () => {
  const room = { roomNumber: 'p.302', floor: 3, areaSqm: 32.5, roomTypeId: ROOM_TYPE };

  it('should normalise room numbers to upper case so "p.302" and "P.302" are the same room', async () => {
    const { dto, fields } = await check(CreateRoomDto, { ...room, roomNumber: '  p.302 ' });
    expect(fields).toEqual([]);
    expect(dto.roomNumber).toBe('P.302');
  });

  it.each([
    [{ floor: 0 }, 'floor'],
    [{ floor: 31 }, 'floor'],
    [{ floor: 2.5 }, 'floor'],
    [{ areaSqm: 0 }, 'areaSqm'],
    [{ areaSqm: 32.555 }, 'areaSqm'],
    [{ roomNumber: '../302' }, 'roomNumber'],
    [{ roomNumber: 'P 302' }, 'roomNumber'],
    [{ roomNumber: 'A'.repeat(21) }, 'roomNumber'],
    [{ maxOccupants: 0 }, 'maxOccupants'],
    [{ maxOccupants: 21 }, 'maxOccupants'],
    [{ priceOverride: 0 }, 'priceOverride'],
    [{ priceOverride: 6_500_000.5 }, 'priceOverride'],
    [{ roomTypeId: 'not-a-uuid' }, 'roomTypeId'],
  ])('should reject room %p', async (patch, field) => {
    expect((await check(CreateRoomDto, { ...room, ...patch })).fields).toEqual([field]);
  });

  it('should accept the boundaries (floor 1 and 30, 1 VND override, 20 occupants)', async () => {
    for (const patch of [{ floor: 1 }, { floor: 30 }, { priceOverride: 1 }, { maxOccupants: 20 }, { priceOverride: null }]) {
      expect((await check(CreateRoomDto, { ...room, ...patch })).fields).toEqual([]);
    }
  });

  it('should keep "priceOverride: null" (back to base rent) distinct from "not sent"', async () => {
    expect((await check(UpdateRoomDto, { priceOverride: null })).dto.priceOverride).toBeNull();
    expect((await check(UpdateRoomDto, { floor: 2 })).dto.priceOverride).toBeUndefined();
  });

  it('should never accept OCCUPIED as a manual status', async () => {
    expect((await check(UpdateRoomDto, { status: 'OCCUPIED' })).fields).toEqual(['status']);
    for (const status of ['AVAILABLE', 'RESERVED', 'MAINTENANCE']) {
      expect((await check(UpdateRoomDto, { status })).fields).toEqual([]);
    }
  });

  it('should validate building codes, tax codes and VietQR bank data', async () => {
    const base = {
      code: 'bld-hcm-q7-01',
      name: 'Sunrise',
      addressLine: '12 Nguyễn Thị Thập',
      ward: 'Tân Phú',
      district: 'Quận 7',
      landlordTaxCode: '0312345678',
      landlordFullName: 'Nguyễn Văn A',
    };
    const ok = await check(CreateBuildingDto, base);
    expect(ok.fields).toEqual([]);
    expect(ok.dto.code).toBe('BLD-HCM-Q7-01');
    expect((await check(CreateBuildingDto, { ...base, landlordTaxCode: '0312345678-001' })).fields).toEqual([]);
    expect((await check(CreateBuildingDto, { ...base, landlordTaxCode: '031234567' })).fields).toEqual(['landlordTaxCode']);
    expect((await check(CreateBuildingDto, { ...base, bankBinCode: '97043' })).fields).toEqual(['bankBinCode']);
    expect((await check(CreateBuildingDto, { ...base, totalRoomsCapacity: 501 })).fields).toEqual(['totalRoomsCapacity']);
    expect((await check(CreateBuildingDto, { ...base, code: 'X' })).fields).toEqual(['code']);
    // code không đổi được sau khi tạo
    expect((await check(UpdateBuildingDto, { code: 'NEW-CODE' })).fields).toEqual(['code']);
    expect((await check(UpdateBuildingDto, { bankAccountNumber: null })).fields).toEqual([]);
  });

  it('should normalise serial numbers and validate the installation date format', async () => {
    const unit = { roomId: ROOM_TYPE, assetId: ROOM_TYPE, serialNumber: ' dk-2026-001 ' };
    const ok = await check(AssignRoomAssetDto, unit);
    expect(ok.fields).toEqual([]);
    expect(ok.dto.serialNumber).toBe('DK-2026-001');
    expect((await check(AssignRoomAssetDto, { ...unit, serialNumber: 'ab' })).fields).toEqual(['serialNumber']);
    expect((await check(AssignRoomAssetDto, { ...unit, installedDate: '17/10/2026' })).fields).toEqual(['installedDate']);
    expect((await check(AssignRoomAssetDto, { ...unit, installedDate: '2026-02-30' })).fields).toEqual(['installedDate']);
    expect((await check(AssignRoomAssetDto, { ...unit, customMonthlyFee: -1 })).fields).toEqual(['customMonthlyFee']);
    expect((await check(CreateAssetDto, { code: 'ac', name: 'AC', category: 'GADGET', standardMonthlyRentalFee: 0 })).fields).toEqual(['category']);
  });

  it('should default and bound the room list query', async () => {
    const { dto, fields } = await check(QueryRoomsDto, { page: '2', limit: '50', floor: '3', sortOrder: 'desc' });
    expect(fields).toEqual([]);
    expect(dto).toMatchObject({ page: 2, limit: 50, floor: 3, sortBy: 'roomNumber', sortOrder: 'DESC' });
    expect((await check(QueryRoomsDto, { limit: '101' })).fields).toEqual(['limit']);
    expect((await check(QueryRoomsDto, { sortBy: 'tenantName' })).fields).toEqual(['sortBy']);
  });
});

describe('RoomAccessGuard (a tenant sees only the room they live in)', () => {
  const BUILDING = 'b1000000-0000-4000-8000-000000000001';
  const ROOM = 'aaaaaaaa-0000-4000-8000-000000000001';
  const OTHER = 'aaaaaaaa-0000-4000-8000-000000000002';

  const ctxFor = (user: object, roomId: string) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ user, params: { id: roomId } }) }) }) as any;
  const userWith = (roles: string[]) => ({ id: 'u1', roles, rules: resolveRolePermissions(roles), tenantId: BUILDING });

  const guardWith = (scope: object | null) => {
    const selfScope = { resolve: jest.fn().mockResolvedValue(scope) };
    const context = { getBuildingId: () => BUILDING };
    return { guard: new RoomAccessGuard(new CaslAbilityFactory(), selfScope as any, context as any), selfScope };
  };

  it('should let staff with rooms:read:department open any room without looking up occupancy', async () => {
    for (const role of ['LANDLORD', 'PROPERTY_MANAGER', 'ACCOUNTANT', 'GUARD']) {
      const { guard, selfScope } = guardWith(null);
      await expect(guard.canActivate(ctxFor(userWith([role]), OTHER))).resolves.toBe(true);
      expect(selfScope.resolve).not.toHaveBeenCalled();
    }
  });

  it('should let a tenant open their current room and nothing else', async () => {
    const { guard, selfScope } = guardWith({ roomId: ROOM, tenantId: 't', contractId: 'c', occupantRole: 'CO_OCCUPANT' });
    await expect(guard.canActivate(ctxFor(userWith(['TENANT']), ROOM))).resolves.toBe(true);
    await expect(guard.canActivate(ctxFor(userWith(['TENANT']), OTHER))).rejects.toBeInstanceOf(ForbiddenException);
    expect(selfScope.resolve).toHaveBeenCalledWith('u1', BUILDING);
  });

  it('should refuse a tenant who does not live in any room (never moved in, moved out, or module 3 not wired yet)', async () => {
    const { guard } = guardWith(null);
    const error = await guard.canActivate(ctxFor(userWith(['TENANT']), ROOM)).catch((e) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.getResponse().errorCode).toBe('AUTH_FORBIDDEN_RESOURCE');
  });
});

describe('PropertiesService.getMyRoom', () => {
  const build = (scope: object | null) => {
    const service = new PropertiesService(
      {} as any,
      { getBuildingId: () => 'b1' } as any,
      {} as any,
      {} as any,
      {} as any,
      { resolve: jest.fn().mockResolvedValue(scope) } as any,
    );
    const detail = jest.spyOn(service, 'getRoomDetail').mockResolvedValue({ id: 'room-1' } as any);
    return { service, detail };
  };

  it('should return the tenant room detail', async () => {
    const { service, detail } = build({ roomId: 'room-1' });
    await expect(service.getMyRoom({ id: 'u', roles: ['TENANT'], rules: [] })).resolves.toEqual({ id: 'room-1' });
    expect(detail).toHaveBeenCalledWith('room-1');
  });

  it('should answer 404 BIZ_NO_ACTIVE_ROOM to a tenant without a room, and 403 to staff', async () => {
    const tenant = await build(null).service.getMyRoom({ id: 'u', roles: ['TENANT'], rules: [] }).catch((e) => e);
    expect(tenant).toBeInstanceOf(NotFoundException);
    expect(tenant.getResponse().errorCode).toBe('BIZ_NO_ACTIVE_ROOM');
    const staff = await build(null).service.getMyRoom({ id: 'u', roles: ['PROPERTY_MANAGER'], rules: [] }).catch((e) => e);
    expect(staff).toBeInstanceOf(ForbiddenException);
  });
});

describe('RoomEventsListener', () => {
  const event = (tenantId?: string) =>
    ({
      metadata: { tenantId, occurredAt: new Date('2026-10-17T03:00:00Z') },
      payload: { data: { roomId: 'r1', roomNumber: 'P.302', from: 'AVAILABLE', to: 'MAINTENANCE' } },
    }) as any;

  it("should push the change to the building's dashboards only", () => {
    const realtime = { emitToBuilding: jest.fn() };
    new RoomEventsListener(realtime as any).onStatusChanged(event('b1'));
    expect(realtime.emitToBuilding).toHaveBeenCalledWith('b1', 'room.status_changed', {
      roomId: 'r1',
      roomNumber: 'P.302',
      from: 'AVAILABLE',
      to: 'MAINTENANCE',
      occurredAt: new Date('2026-10-17T03:00:00Z'),
    });
  });

  it('should do nothing without WebSocket or without a building (never broadcast to everyone)', () => {
    expect(() => new RoomEventsListener(undefined).onStatusChanged(event('b1'))).not.toThrow();
    const realtime = { emitToBuilding: jest.fn() };
    new RoomEventsListener(realtime as any).onStatusChanged(event(undefined));
    expect(realtime.emitToBuilding).not.toHaveBeenCalled();
  });
});

describe('Properties helpers', () => {
  it('should compute "today" in Vietnam time (UTC+7)', () => {
    expect(vietnamToday(Date.parse('2026-10-17T16:59:59Z'))).toBe('2026-10-17');
    expect(vietnamToday(Date.parse('2026-10-17T17:00:00Z'))).toBe('2026-10-18');
  });

  it('should recognise only the expected unique violation', () => {
    expect(isUniqueViolation({ code: '23505', constraint: 'idx_rooms_bld_number_unique' }, 'idx_rooms_bld_number_unique')).toBe(true);
    expect(isUniqueViolation({ code: '23505', constraint: 'idx_other' }, 'idx_rooms_bld_number_unique')).toBe(false);
    expect(isUniqueViolation({ code: '23503', constraint: 'idx_rooms_bld_number_unique' }, 'idx_rooms_bld_number_unique')).toBe(false);
  });

  it('should treat a body with only "version" as nothing to update', () => {
    expect(() => assertSomethingToUpdate({ version: 3 })).toThrow('Nothing to update.');
    expect(() => assertSomethingToUpdate({ priceOverride: null })).not.toThrow();
  });
});
