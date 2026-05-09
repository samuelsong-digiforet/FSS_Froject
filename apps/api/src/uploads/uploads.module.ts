import { Module } from '@nestjs/common';
import { UploadsController } from './uploads.controller';
import { StorageService } from '../storage/storage.service';

@Module({
  providers: [StorageService],
  controllers: [UploadsController],
})
export class UploadsModule {}