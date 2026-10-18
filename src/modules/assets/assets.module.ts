/** Module 1 - Assets (tài liệu 02, mục 3): danh mục thiết bị / nội thất và đơn vị có serial lắp trong phòng */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Asset } from './entities/asset.entity';
import { RoomAsset } from './entities/room-asset.entity';
import { AssetsController } from './controllers/assets.controller';
import { AssetsService } from './services/assets.service';

@Module({
  imports: [TypeOrmModule.forFeature([Asset, RoomAsset])],
  controllers: [AssetsController],
  providers: [AssetsService],
  exports: [AssetsService],
})
export class AssetsModule {}
