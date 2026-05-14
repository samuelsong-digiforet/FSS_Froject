import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AssetCategory } from './entities/asset-category.entity';
import { CreateAssetCategoryDto } from './dto/create-asset-category.dto';
import { UpdateAssetCategoryDto } from './dto/update-asset-category.dto';

@Injectable()
export class AssetCategoriesService {
  constructor(
    @InjectRepository(AssetCategory)
    private readonly categoryRepo: Repository<AssetCategory>,
  ) {}

  async findAll(query: {
    search?: string;
    startDate?: string;
    endDate?: string;
    page?: number;
    limit?: number;
  }): Promise<{ total: number; items: AssetCategory[] }> {
    const page = normalizePositiveInt(query.page, 1);
    const limit = Math.min(normalizePositiveInt(query.limit, 20), 100);

    const qb = this.categoryRepo.createQueryBuilder('cat')
      .leftJoinAndSelect('cat.createdBy', 'createdBy')
      .leftJoinAndSelect('cat.updatedBy', 'updatedBy')
      .where('cat.isActive = true')
      .orderBy('cat.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (query.search) {
      qb.andWhere('cat.name ILIKE :s', { s: `%${query.search}%` });
    }

    if (query.startDate && query.endDate) {
      qb.andWhere('cat.createdAt BETWEEN :start AND :end', {
        start: query.startDate,
        end: query.endDate + 'T23:59:59',
      });
    }

    const [items, total] = await qb.getManyAndCount();
    return { total, items };
  }

  async findOne(id: number): Promise<AssetCategory> {
    const cat = await this.categoryRepo.findOne({
      where: { id, isActive: true },
      relations: ['createdBy', 'updatedBy'],
    });
    if (!cat) throw new NotFoundException('카테고리를 찾을 수 없습니다.');
    return cat;
  }

  async create(dto: CreateAssetCategoryDto, userId: number): Promise<AssetCategory> {
    const exists = await this.categoryRepo.findOne({ where: { name: dto.name } });
    if (exists) throw new ConflictException('이미 존재하는 카테고리명입니다.');
    const cat = this.categoryRepo.create({ ...dto, createdById: userId });
    return this.categoryRepo.save(cat);
  }

  async update(id: number, dto: UpdateAssetCategoryDto, userId: number): Promise<AssetCategory> {
    const cat = await this.findOne(id);
    if (dto.name && dto.name !== cat.name) {
      const exists = await this.categoryRepo.findOne({ where: { name: dto.name } });
      if (exists) throw new ConflictException('이미 존재하는 카테고리명입니다.');
    }
    Object.assign(cat, dto);
    cat.updatedById = userId;
    return this.categoryRepo.save(cat);
  }

  async remove(id: number): Promise<void> {
    const cat = await this.findOne(id);
    cat.isActive = false;
    await this.categoryRepo.save(cat);
  }
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value as number));
}
