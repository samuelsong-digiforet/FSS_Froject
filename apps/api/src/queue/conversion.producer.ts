import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { CONVERSION_QUEUE } from './queue.module';

export interface ConversionJobData {
  assetId: string;
  assetType: string;
  sourceObject: string;
  outputProfile?: string;
  userId: string;
}

export interface Stage2JobData {
  assetId: string;
  assetType: string;
  colmapObject: string;
  outputProfile?: string;
  obbParams?: { center: number[]; rotation: number[]; scale: number[]; previewCenter?: number[]; previewBounds?: number[] };
  userId: string;
  stage: 'stage2';
}


@Injectable()
export class ConversionProducer {
  constructor(
    @InjectQueue(CONVERSION_QUEUE)
    private readonly queue: Queue,
  ) {}

  async addConversionJob(data: ConversionJobData): Promise<string> {
    const job = await this.queue.add('convert', data, {
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 50,
    });
    return String(job.id);
  }

  async addStage2Job(data: Omit<Stage2JobData, 'stage'>): Promise<string> {
    const job = await this.queue.add('convert', { ...data, stage: 'stage2' }, {
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 50,
    });
    return String(job.id);
  }

  async cancelJob(jobId: string): Promise<void> {
    try {
      const job = await this.queue.getJob(jobId);
      if (job) await job.remove();
    } catch { /* ignore */ }
  }
}
