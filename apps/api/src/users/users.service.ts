import {
  Injectable,
  NotFoundException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like, Between, IsNull, Not } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  async findAll(query: {
    search?: string;
    dateType?: 'created' | 'login';
    startDate?: string;
    endDate?: string;
    approval?: 'all' | 'approved' | 'unapproved';
  }): Promise<{ total: number; items: User[] }> {
    const qb = this.userRepo.createQueryBuilder('user')
      .leftJoinAndSelect('user.createdBy', 'createdBy')
      .where('user.isActive = true');

    // 승인 여부 필터
    if (query.approval === 'approved') {
      qb.andWhere('user.isApproved = true');
    } else if (query.approval === 'unapproved') {
      qb.andWhere('user.isApproved = false');
    }

    // 날짜 필터
    if (query.startDate && query.endDate) {
      const col = query.dateType === 'login' ? 'user.lastLoginAt' : 'user.createdAt';
      qb.andWhere(`${col} BETWEEN :start AND :end`, {
        start: query.startDate,
        end: query.endDate + 'T23:59:59',
      });
    }

    // 검색어
    if (query.search) {
      qb.andWhere(
        '(user.username ILIKE :s OR user.fullName ILIKE :s OR user.email ILIKE :s OR user.department ILIKE :s OR user.position ILIKE :s)',
        { s: `%${query.search}%` },
      );
    }

    qb.orderBy('user.createdAt', 'DESC');
    const [items, total] = await qb.getManyAndCount();
    return { total, items };
  }

  async findOne(id: number): Promise<User> {
    const user = await this.userRepo.findOne({
      where: { id, isActive: true },
      relations: ['createdBy', 'updatedBy'],
    });
    if (!user) throw new NotFoundException('회원을 찾을 수 없습니다.');
    return user;
  }

  async create(dto: CreateUserDto, creatorId: number): Promise<User> {
    const exists = await this.userRepo.findOne({ where: { username: dto.username } });
    if (exists) throw new ConflictException('이미 사용 중인 아이디입니다.');

    const emailExists = await this.userRepo.findOne({ where: { email: dto.email } });
    if (emailExists) throw new ConflictException('이미 사용 중인 이메일입니다.');

    const hashed = await bcrypt.hash(dto.password, 10);
    const user = this.userRepo.create({
      ...dto,
      password: hashed,
      createdById: creatorId,
    });
    return this.userRepo.save(user);
  }

  async update(id: number, dto: UpdateUserDto, updaterId: number): Promise<User> {
    const user = await this.findOne(id);
    Object.assign(user, dto);
    user.updatedById = updaterId;
    return this.userRepo.save(user);
  }

  async remove(id: number): Promise<void> {
    const user = await this.findOne(id);
    user.isActive = false; // 소프트 딜리트
    await this.userRepo.save(user);
  }

  async changePassword(id: number, dto: ChangePasswordDto): Promise<void> {
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) throw new NotFoundException('회원을 찾을 수 없습니다.');

    const valid = await bcrypt.compare(dto.currentPassword, user.password);
    if (!valid) throw new UnauthorizedException('현재 비밀번호가 일치하지 않습니다.');

    user.password = await bcrypt.hash(dto.newPassword, 10);
    await this.userRepo.save(user);
  }
}