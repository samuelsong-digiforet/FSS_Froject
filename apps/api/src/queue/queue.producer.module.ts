import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConversionProducer } from './conversion.producer';
import { CONVERSION_QUEUE } from './queue.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: CONVERSION_QUEUE }),
  ],
  providers: [ConversionProducer],
  exports: [ConversionProducer],
})
export class QueueProducerModule {}