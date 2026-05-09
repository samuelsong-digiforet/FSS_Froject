import { Injectable, OnApplicationBootstrap, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserRole } from '../users/entities/user.entity';

@Injectable()
export class SeederService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SeederService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.seedAdmin();
  }

  private async seedAdmin(): Promise<void> {
    const exists = await this.userRepo.findOne({ where: { username: 'admin' } });
    if (exists) return;

    // bcrypt.hash('12345678', 10) 으로 생성한 해시값
    const ADMIN_PASSWORD_HASH =
      '$2b$10$29IYB0PkrbrspA/TvuDmfOkzXs0DJVbJSpaUF16K5QQpcmQSrXnSy';

    const admin = this.userRepo.create({
      username: 'admin',
      email: 'admin@fss.local',
      password: ADMIN_PASSWORD_HASH,
      fullName: '관리자',
      role: UserRole.ADMIN,
      isActive: true,
      isApproved: true,
    });

    await this.userRepo.save(admin);
    this.logger.log('Admin account created (username: admin)');
  }
}
