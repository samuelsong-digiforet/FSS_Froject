import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Log } from './log.entity';

export interface RecordLogDto {
  userId?: number;
  username?: string;
  fullName?: string;
  ip?: string;
  device?: string;
  menuName?: string;
  action?: string;
}

export interface FindAllLogsDto {
  search?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
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

  async findAll(dto: FindAllLogsDto = {}) {
    const { search, startDate, endDate } = dto;
    const page = normalizePositiveInt(dto.page, 1);
    const limit = Math.min(normalizePositiveInt(dto.limit, 20), 100);

    const qb = this.logRepo.createQueryBuilder('log');

    if (search) {
      qb.andWhere(
        '(log.username ILIKE :search OR log.fullName ILIKE :search OR log.menuName ILIKE :search OR log.action ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    if (startDate) {
      qb.andWhere('log.accessedAt >= :startDate', { startDate: new Date(startDate) });
    }

    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      qb.andWhere('log.accessedAt <= :endDate', { endDate: end });
    }

    qb.orderBy('log.accessedAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [items, total] = await qb.getManyAndCount();

    return { items, total, page, limit };
  }
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value as number));
}
