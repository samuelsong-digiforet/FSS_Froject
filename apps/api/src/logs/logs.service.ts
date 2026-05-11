import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Log } from './log.entity';

export interface RecordLogDto {
  userId?: string;
  username?: string;
  fullName?: string;
  ip?: string;
  device?: string;
  menuName?: string;
  action?: string;
}

@Injectable()
export class LogsService {
  constructor(
    @InjectRepository(Log)
    private readonly logRepo: Repository<Log>,
  ) {}

  async record(dto: RecordLogDto): Promise<void> {
    await this.logRepo.save(this.logRepo.create(dto));
  }

  findAll() {
    return this.logRepo.find({ order: { createdAt: 'DESC' } });
  }
}
