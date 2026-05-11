import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Log } from './log.entity';
import { LogsService } from './logs.service';
import { LogsInterceptor } from './logs.interceptor';

@Module({
  imports: [TypeOrmModule.forFeature([Log])],
  providers: [
    LogsService,
    {
      provide: APP_INTERCEPTOR,
      useClass: LogsInterceptor,
    },
  ],
  exports: [LogsService],
})
export class LogsModule {}
