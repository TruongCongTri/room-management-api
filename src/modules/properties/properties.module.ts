/**
 * Module 1 - Properties (tài liệu 02, mục 3): tòa nhà, hạng phòng, 80 phòng, thống kê phòng trống, chi tiết phòng
 * (khách thuê: chỉ phòng mình đang ở).
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Building } from './entities/building.entity';
import { RoomType } from './entities/room-type.entity';
import { Room } from './entities/room.entity';
import { PropertiesController } from './controllers/properties.controller';
import { PublicListingController } from './controllers/public-listing.controller';
import { PublicListingService } from './services/public-listing.service';
import { BuildingsService } from './services/buildings.service';
import { RoomTypesService } from './services/room-types.service';
import { PropertiesService } from './services/properties.service';
import { RoomAccessGuard } from './guards/room-access.guard';
import { RoomEventsListener } from './listeners/room-events.listener';

@Module({
  imports: [TypeOrmModule.forFeature([Building, RoomType, Room])],
  controllers: [PropertiesController, PublicListingController],
  providers: [BuildingsService, RoomTypesService, PropertiesService, PublicListingService, RoomAccessGuard, RoomEventsListener],
  exports: [BuildingsService, PropertiesService],
})
export class PropertiesModule {}
