import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, Query, UseGuards, Req, ParseIntPipe,
} from '@nestjs/common';
import { RolesService } from './roles.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { SavePermissionsDto } from './dto/update-permission.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { User } from '../users/entities/user.entity';
import { Log } from '../logs/log.decorator';

@Controller('roles')
@UseGuards(JwtAuthGuard)
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get()
  @Log('권한 관리', '목록 조회')
  findAll(@Query('search') search?: string) {
    return this.rolesService.findAll(search);
  }

  @Get(':id')
  @Log('권한 관리', '상세 조회')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.rolesService.findOne(id);
  }

  @Post()
  @Log('권한 관리', '생성')
  create(@Body() dto: CreateRoleDto, @Req() req: { user: User }) {
    return this.rolesService.create(dto, req.user.id);
  }

  @Patch(':id')
  @Log('권한 관리', '수정')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateRoleDto) {
    return this.rolesService.update(id, dto);
  }

  @Delete(':id')
  @Log('권한 관리', '삭제')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.rolesService.remove(id);
  }

  // 퍼미션 조회
  @Get(':id/permissions')
  getPermissions(@Param('id', ParseIntPipe) id: number) {
    return this.rolesService.getPermissions(id);
  }

  // 퍼미션 저장
  @Post(':id/permissions')
  @Log('권한 관리', '권한 설정 저장')
  savePermissions(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SavePermissionsDto,
  ) {
    return this.rolesService.savePermissions(id, dto);
  }

  // 권한에 속한 사용자 조회
  @Get(':id/users')
  getRoleUsers(
    @Param('id', ParseIntPipe) id: number,
    @Query('search') search?: string,
  ) {
    return this.rolesService.getRoleUsers(id, search);
  }

  // 권한이 없는 사용자 조회
  @Get(':id/available-users')
  getAvailableUsers(
    @Param('id', ParseIntPipe) id: number,
    @Query('search') search?: string,
  ) {
    return this.rolesService.getAvailableUsers(id, search);
  }

  // 사용자 권한 부여
  @Post(':id/users')
  addUsersToRole(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { userIds: string[] },
  ) {
    return this.rolesService.addUsersToRole(id, body.userIds);
  }

  // 사용자 권한 삭제
  @Delete(':id/users')
  removeUsersFromRole(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { userIds: string[] },
  ) {
    return this.rolesService.removeUsersFromRole(id, body.userIds);
  }
}