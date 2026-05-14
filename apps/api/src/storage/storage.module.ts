import { Module, Global } from '@nestjs/common';
import { StorageService } from './storage.service';

@Global() // 전체 모듈에서 주입 가능
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {
}
