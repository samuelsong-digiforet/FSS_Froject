import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like } from 'typeorm';
import { Role } from './entities/role.entity';
import { RolePermission } from './entities/role-permission.entity';
import { User } from '../users/entities/user.entity';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { SavePermissionsDto } from './dto/update-permission.dto';

@Injectable()
export class RolesService {
  constructor(
    @InjectRepository(Role)
    private readonly roleRepo: Repository<Role>,
    @InjectRepository(RolePermission)
    private readonly permRepo: Repository<RolePermission>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  async findAll(search?: string): Promise<{ total: number; items: Role[] }> {
    const where = search ? { name: Like(`%${search}%`) } : {};
    const [items, total] = await this.roleRepo.findAndCount({
      where,
      relations: ['createdBy'],
      order: { id: 'DESC' },
    });
    return { total, items };
  }

  async findOne(id: number): Promise<Role> {
    const role = await this.roleRepo.findOne({
      where: { id },
      relations: ['createdBy'],
    });
    if (!role) throw new NotFoundException('권한을 찾을 수 없습니다.');
    return role;
  }

  async create(dto: CreateRoleDto, userId: string): Promise<Role> {
    const exists = await this.roleRepo.findOne({ where: { name: dto.name } });
    if (exists) throw new ConflictException('이미 존재하는 권한명입니다.');
    const role = this.roleRepo.create({ name: dto.name, createdById: userId });
    return this.roleRepo.save(role);
  }

  async update(id: number, dto: UpdateRoleDto): Promise<Role> {
    const role = await this.findOne(id);
    const exists = await this.roleRepo.findOne({ where: { name: dto.name } });
    if (exists && exists.id !== id) throw new ConflictException('이미 존재하는 권한명입니다.');
    role.name = dto.name;
    return this.roleRepo.save(role);
  }

  async remove(id: number): Promise<void> {
    const role = await this.findOne(id);
    await this.roleRepo.remove(role);
  }

  // 퍼미션 조회
  async getPermissions(roleId: number): Promise<RolePermission[]> {
    return this.permRepo.find({ where: { roleId } });
  }

  // 퍼미션 저장 (upsert)
  async savePermissions(roleId: number, dto: SavePermissionsDto): Promise<RolePermission[]> {
    await this.findOne(roleId); // 존재 확인

    for (const p of dto.permissions) {
      const existing = await this.permRepo.findOne({
        where: { roleId, menuKey: p.menuKey },
      });
      if (existing) {
        Object.assign(existing, p);
        await this.permRepo.save(existing);
      } else {
        const newPerm = this.permRepo.create({ roleId, ...p });
        await this.permRepo.save(newPerm);
      }
    }
    return this.getPermissions(roleId);
  }

  // 권한에 속한 사용자 조회
  async getRoleUsers(roleId: number, search?: string): Promise<User[]> {
    await this.findOne(roleId);
    const qb = this.userRepo.createQueryBuilder('user')
      .where('user.roleId = :roleId', { roleId })
      .andWhere('user.isActive = true');

    if (search) {
      qb.andWhere(
        '(user.email ILIKE :s OR user.fullName ILIKE :s OR user.department ILIKE :s OR user.position ILIKE :s)',
        { s: `%${search}%` },
      );
    }
    return qb.getMany();
  }

  // 권한이 없는 사용자 조회 (추가 팝업용)
  async getAvailableUsers(roleId: number, search?: string): Promise<User[]> {
    await this.findOne(roleId);
    const qb = this.userRepo.createQueryBuilder('user')
      .where('(user.roleId != :roleId OR user.roleId IS NULL)', { roleId })
      .andWhere('user.isActive = true');

    if (search) {
      qb.andWhere(
        '(user.email ILIKE :s OR user.fullName ILIKE :s OR user.department ILIKE :s OR user.position ILIKE :s)',
        { s: `%${search}%` },
      );
    }
    return qb.getMany();
  }

  // 사용자에게 권한 부여
  async addUsersToRole(roleId: number, userIds: string[]): Promise<void> {
    await this.findOne(roleId);
    await this.userRepo
      .createQueryBuilder()
      .update()
      .set({ roleId })
      .whereInIds(userIds)
      .execute();
  }

  // 사용자 권한 삭제
  async removeUsersFromRole(roleId: number, userIds: string[]): Promise<void> {
    await this.findOne(roleId);
    await this.userRepo
      .createQueryBuilder()
      .update()
      .set({ roleId: null as any })
      .where('id IN (:...userIds) AND roleId = :roleId', { userIds, roleId })
      .execute();
  }
}