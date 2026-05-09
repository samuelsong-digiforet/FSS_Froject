import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Scene } from './entities/scene.entity';
import { CreateSceneDto } from './dto/create-scene.dto';
import { UpdateSceneDto } from './dto/update-scene.dto';

@Injectable()
export class ScenesService {
  constructor(
    @InjectRepository(Scene)
    private readonly sceneRepo: Repository<Scene>,
  ) {}

  async findAll(userId: string): Promise<Scene[]> {
    return this.sceneRepo.find({
      where: { userId },
      order: { updatedAt: 'DESC' },
    });
  }

  async findOne(id: string, userId: string): Promise<Scene> {
    const scene = await this.sceneRepo.findOne({ where: { id, userId } });
    if (!scene) throw new NotFoundException('씬을 찾을 수 없습니다.');
    return scene;
  }

  async create(dto: CreateSceneDto, userId: string): Promise<Scene> {
    const scene = this.sceneRepo.create({ ...dto, userId });
    return this.sceneRepo.save(scene);
  }

  async update(id: string, dto: UpdateSceneDto, userId: string): Promise<Scene> {
    const scene = await this.sceneRepo.findOne({ where: { id } });
    if (!scene) throw new NotFoundException('씬을 찾을 수 없습니다.');
    if (scene.userId !== userId) throw new ForbiddenException();
    Object.assign(scene, dto);
    return this.sceneRepo.save(scene);
  }

  async remove(id: string, userId: string): Promise<void> {
    const scene = await this.sceneRepo.findOne({ where: { id, userId } });
    if (!scene) throw new NotFoundException('씬을 찾을 수 없습니다.');
    await this.sceneRepo.remove(scene);
  }
}
