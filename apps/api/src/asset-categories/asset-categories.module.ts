import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssetCategoriesController } from './asset-categories.controller';
import { AssetCategoriesService } from './asset-categories.service';
import { AssetCategory } from './entities/asset-category.entity';

@Module({
  imports: [TypeOrmModule.forFeature([AssetCategory])],
  controllers: [AssetCategoriesController],
  providers: [AssetCategoriesService],
  exports: [AssetCategoriesService],
})
export class AssetCategoriesModule {}