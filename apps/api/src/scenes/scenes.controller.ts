import { Controller, Get, Post, Patch, Delete, Param, Body, UseGuards, Req } from '@nestjs/common';
import { ScenesService } from './scenes.service';
import { CreateSceneDto } from './dto/create-scene.dto';
import { UpdateSceneDto } from './dto/update-scene.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { User } from '../users/entities/user.entity';

@Controller('scenes')
@UseGuards(JwtAuthGuard)
export class ScenesController {
  constructor(private readonly scenesService: ScenesService) {}

  @Get()
  findAll(@Req() req: { user: User }) {
    return this.scenesService.findAll(req.user.id);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: { user: User }) {
    return this.scenesService.findOne(id, req.user.id);
  }

  @Post()
  create(@Body() dto: CreateSceneDto, @Req() req: { user: User }) {
    return this.scenesService.create(dto, req.user.id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateSceneDto, @Req() req: { user: User }) {
    return this.scenesService.update(id, dto, req.user.id);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: { user: User }) {
    return this.scenesService.remove(id, req.user.id);
  }
}
