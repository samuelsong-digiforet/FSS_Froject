import { Module, Global } from '@nestjs/common';
import { StorageService } from './storage.service';

@Global() // 전체 모듈에서 주입 가능
export class StorageModule {
  static forRoot() {
    return {
      module: StorageModule,
      providers: [StorageService],
      exports: [StorageService],
    };
  }
}