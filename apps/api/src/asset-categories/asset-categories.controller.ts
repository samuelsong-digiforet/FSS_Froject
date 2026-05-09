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
import { AssetCategoriesService } from './asset-categories.service';
import { CreateAssetCategoryDto } from './dto/create-asset-category.dto';
import { UpdateAssetCategoryDto } from './dto/update-asset-category.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Log } from '../logs/log.decorator';
import { User } from '../users/entities/user.entity';

@Controller('asset-categories')
@UseGuards(JwtAuthGuard)
export class AssetCategoriesController {
  constructor(private readonly service: AssetCategoriesService) {}

  @Get()
  @Log('에셋 카테고리 관리', '목록 조회')
  findAll(
    @Query('search') search?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.findAll({
      search,
      startDate,
      endDate,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
    });
  }

  @Get(':id')
  @Log('에셋 카테고리 관리', '상세 조회')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Post()
  @Log('에셋 카테고리 관리', '생성')
  create(@Body() dto: CreateAssetCategoryDto, @Req() req: { user: User }) {
    return this.service.create(dto, req.user.id);
  }

  @Patch(':id')
  @Log('에셋 카테고리 관리', '수정')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateAssetCategoryDto,
    @Req() req: { user: User },
  ) {
    return this.service.update(id, dto, req.user.id);
  }

  @Delete(':id')
  @Log('에셋 카테고리 관리', '삭제')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}