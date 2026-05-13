import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  Req,
  ParseIntPipe,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { User } from './entities/user.entity';
import { Log } from '../logs/log.decorator';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @Log('회원 관리', '목록 조회')
  findAll(
    @Query('search') search?: string,
    @Query('dateType') dateType?: 'created' | 'login',
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('approval') approval?: 'all' | 'approved' | 'unapproved',
  ) {
    return this.usersService.findAll({ search, dateType, startDate, endDate, approval });
  }

  @Get(':id')
  @Log('회원 관리', '상세 조회')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.usersService.findOne(id);
  }

  @Post()
  @Log('회원 관리', '생성')
  create(@Body() dto: CreateUserDto, @Req() req: { user: User }) {
    return this.usersService.create(dto, req.user.id);
  }

  @Patch(':id')
  @Log('회원 관리', '수정')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateUserDto,
    @Req() req: { user: User },
  ) {
    return this.usersService.update(id, dto, req.user.id);
  }

  @Delete(':id')
  @Log('회원 관리', '삭제')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.usersService.remove(id);
  }

  @Patch(':id/password')
  @Log('회원 관리', '비밀번호 변경')
  changePassword(@Param('id', ParseIntPipe) id: number, @Body() dto: ChangePasswordDto) {
    return this.usersService.changePassword(id, dto);
  }
}
