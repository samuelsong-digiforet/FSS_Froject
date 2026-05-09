import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { Asset } from './entities/asset.entity';
import { AssetCategory } from '../asset-categories/entities/asset-category.entity';
import { StorageService } from '../storage/storage.service';
import { ConversionProducer } from '../queue/conversion.producer';
import { CONVERSION_QUEUE } from '../queue/queue.module';

@Module({
  imports: [TypeOrmModule.forFeature([Asset, AssetCategory]), BullModule.registerQueue({ name: CONVERSION_QUEUE })],
  providers: [AssetsService, StorageService, ConversionProducer],
  controllers: [AssetsController],
  exports: [AssetsService],
})
export class AssetsModule {}
