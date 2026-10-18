/**
 * /public/* - website giới thiệu, KHÔNG cần đăng nhập (tài liệu 04, mục 1.5):
 * @Public, giới hạn theo IP, công tắc ngắt `public_listing`, Cache-Control + ETag cho trình duyệt / CDN.
 */
import { Controller, Get, Param, Query, UseInterceptors } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../common/decorators/public.decorator';
import { RequireFeature } from '../../../core/feature-flag/feature-flag.guard';
import { FEATURE_FLAGS } from '../../../core/feature-flag/feature-flags.constant';
import { ThrottlePublic, ThrottleSearch } from '../../../core/security/throttler/throttler.decorators';
import { ApiAudience } from '../../../infrastructure/swagger/api-audience.decorator';
import { PublicCacheControl, PublicCacheControlInterceptor } from '../../../infrastructure/cache/interceptors/public-cache-control.interceptor';
import { PublicListingService } from '../services/public-listing.service';
import { PublicAssetQueryDto, PublicRoomQueryDto } from '../dto/public-listing.dto';

@ApiTags('Public Listing')
@ApiAudience('public')
@Public()
@ThrottlePublic()
@RequireFeature(FEATURE_FLAGS.PUBLIC_LISTING)
@UseInterceptors(PublicCacheControlInterceptor)
@PublicCacheControl(60)
@Controller('public/buildings')
export class PublicListingController {
  constructor(private readonly listing: PublicListingService) {}

  @Get()
  @ApiOperation({ summary: 'Published buildings with their price range and free rooms' })
  buildings() {
    return this.listing.listBuildings();
  }

  @Get(':slug')
  @ApiOperation({ summary: 'One published building' })
  building(@Param('slug') slug: string) {
    return this.listing.getBuilding(slug);
  }

  @Get(':slug/room-types')
  @ApiOperation({ summary: 'Room types with base rent and free rooms' })
  roomTypes(@Param('slug') slug: string) {
    return this.listing.getRoomTypes(slug);
  }

  @Get(':slug/floors')
  @ApiOperation({ summary: 'Floors with their room numbers and free rooms' })
  floors(@Param('slug') slug: string) {
    return this.listing.getFloors(slug);
  }

  @Get(':slug/rooms')
  @ThrottleSearch()
  @ApiOperation({ summary: 'Search published rooms' })
  rooms(@Param('slug') slug: string, @Query() query: PublicRoomQueryDto) {
    return this.listing.searchRooms(slug, query);
  }

  @Get(':slug/rooms/:roomNumber')
  @ApiOperation({ summary: 'One room by its number, with equipment' })
  room(@Param('slug') slug: string, @Param('roomNumber') roomNumber: string) {
    return this.listing.getRoom(slug, roomNumber);
  }

  @Get(':slug/vacancies')
  @ApiOperation({ summary: 'Free rooms per room type' })
  vacancies(@Param('slug') slug: string) {
    return this.listing.getVacancies(slug);
  }

  @Get(':slug/assets')
  @ApiOperation({ summary: 'Equipment & furniture offered, with standard monthly fees' })
  assets(@Param('slug') slug: string, @Query() query: PublicAssetQueryDto) {
    return this.listing.getAssets(slug, query.category);
  }
}
