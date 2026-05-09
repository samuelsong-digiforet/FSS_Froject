import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Scene } from './entities/scene.entity';
import { ScenesService } from './scenes.service';
import { ScenesController } from './scenes.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Scene])],
  providers: [ScenesService],
  controllers: [ScenesController],
})
export class ScenesModule {}
