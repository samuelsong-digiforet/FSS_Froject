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

  async findAll(userId: number): Promise<Scene[]> {
    return this.sceneRepo.find({
      where: { userId },
      order: { updatedAt: 'DESC' },
    });
  }

  async findOne(id: number, userId: number): Promise<Scene> {
    const scene = await this.sceneRepo.findOne({ where: { id, userId } });
    if (!scene) throw new NotFoundException('씬을 찾을 수 없습니다.');
    return scene;
  }

  async create(dto: CreateSceneDto, userId: number): Promise<Scene> {
    const scene = this.sceneRepo.create({ ...dto, userId });
    return this.sceneRepo.save(scene);
  }

  async update(id: number, dto: UpdateSceneDto, userId: number): Promise<Scene> {
    const scene = await this.sceneRepo.findOne({ where: { id } });
    if (!scene) throw new NotFoundException('씬을 찾을 수 없습니다.');
    if (scene.userId !== userId) throw new ForbiddenException();
    Object.assign(scene, dto);
    return this.sceneRepo.save(scene);
  }

  async remove(id: number, userId: number): Promise<void> {
    const scene = await this.sceneRepo.findOne({ where: { id, userId } });
    if (!scene) throw new NotFoundException('씬을 찾을 수 없습니다.');
    await this.sceneRepo.remove(scene);
  }
}
