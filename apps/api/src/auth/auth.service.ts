import {
  Injectable,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { User } from '../users/entities/user.entity';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { LogsService } from '../logs/logs.service';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly jwtService: JwtService,
    private readonly logsService: LogsService,
  ) {}

  async register(dto: RegisterDto): Promise<{ accessToken: string }> {
    const exists = await this.userRepo.findOne({ where: { email: dto.email } });
    if (exists) throw new ConflictException('이미 사용 중인 이메일입니다.');
    const hashed = await bcrypt.hash(dto.password, 10);
    const user = this.userRepo.create({
      email: dto.email,
      password: hashed,
      fullName: dto.fullName,
    });
    await this.userRepo.save(user);
    return this.issueToken(user);
  }

  async login(dto: LoginDto, ip?: string): Promise<{ accessToken: string }> {
    const user = await this.userRepo
      .createQueryBuilder('user')
      .where(
        '(user.username = :username OR user.email = :username) AND user.isActive = true',
        { username: dto.username },
      )
      .getOne();

    if (!user) throw new UnauthorizedException('아이디 또는 비밀번호가 틀렸습니다.');

    const valid = await bcrypt.compare(dto.password, user.password);
    if (!valid) throw new UnauthorizedException('아이디 또는 비밀번호가 틀렸습니다.');

    // 미승인 계정 차단
    if (!user.isApproved) throw new UnauthorizedException('승인되지 않은 계정입니다.\n관리자에게 문의하세요.');

    // 최근 접속일시 업데이트
    user.lastLoginAt = new Date();
    await this.userRepo.save(user);

    // 로그인 로그 기록
    await this.logsService.record({
      userId: user.id,
      username: user.username ?? user.email,
      fullName: user.fullName,
      ip,
      device: '웹',
      menuName: '로그인',
      action: '로그인',
    }).catch(() => null);

    return this.issueToken(user);
  }

  async getMe(user: User): Promise<Omit<User, 'password'>> {
    const { password: _, ...result } = user;
    return result as Omit<User, 'password'>;
  }

  private issueToken(user: User): { accessToken: string } {
    const payload = { sub: user.id, email: user.email, role: user.role };
    return { accessToken: this.jwtService.sign(payload) };
  }
}