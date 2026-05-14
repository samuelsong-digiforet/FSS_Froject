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
  Res,
  ParseIntPipe,
} from '@nestjs/common';
import type { Response } from 'express';
import { AssetsService } from './assets.service';
import { CreateAssetDto } from './dto/create-asset.dto';
import { ExportAssetsDto } from './dto/export-assets.dto';
import { CreateAssetObbVersionDto } from './dto/create-asset-obb-version.dto';
import { RegenerateAssetDto } from './dto/regenerate-asset.dto';
import { UpdateAssetObbVersionDto } from './dto/update-asset-obb-version.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { User } from '../users/entities/user.entity';
import { Log } from '../logs/log.decorator';

@Controller('assets')
@UseGuards(JwtAuthGuard)
export class AssetsController {
  constructor(private readonly assetsService: AssetsService) {}

  @Post()
  @Log('에셋 관리', '생성')
  create(@Body() dto: CreateAssetDto, @Req() req: { user: User }) {
    return this.assetsService.create(dto, req.user.id);
  }

  @Post('export')
  @Log('Asset Management', 'Export to Digital Twin')
  exportToExternal(@Body() dto: ExportAssetsDto, @Req() req: { user: User }) {
    return this.assetsService.exportToExternal(dto.assetIds, req.user.id);
  }

  @Get()
  @Log('에셋 관리', '목록 조회')
  findAll(@Req() req: { user: User }, @Query('categoryId') categoryId?: string) {
    return this.assetsService.findAll(req.user.id, categoryId ? Number(categoryId) : undefined);
  }

  @Get('uuid/:uuid')
  @Log('에셋 관리', 'UUID 상세 조회')
  findOneByUuid(@Param('uuid') uuid: string, @Req() req: { user: User }) {
    return this.assetsService.findOneByUuid(uuid, req.user.id);
  }

  @Get(':id')
  @Log('에셋 관리', '상세 조회')
  findOne(@Param('id', ParseIntPipe) id: number, @Req() req: { user: User }) {
    return this.assetsService.findOne(id, req.user.id);
  }

  @Get(':id/versions')
  @Log('에셋 관리', '버전 목록 조회')
  getObbVersions(@Param('id', ParseIntPipe) id: number, @Req() req: { user: User }) {
    return this.assetsService.getObbVersions(id, req.user.id);
  }

  @Patch(':id')
  @Log('에셋 관리', '수정')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateAssetDto,
    @Req() req: { user: User },
  ) {
    return this.assetsService.update(id, dto, req.user.id);
  }

  @Post(':id/versions')
  @Log('에셋 관리', '버전 저장')
  createObbVersion(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateAssetObbVersionDto,
    @Req() req: { user: User },
  ) {
    return this.assetsService.createObbVersion(id, req.user.id, dto);
  }

  @Patch(':id/versions/:versionId')
  @Log('Asset Management', 'Update OBB Version')
  updateObbVersion(
    @Param('id', ParseIntPipe) id: number,
    @Param('versionId') versionId: string,
    @Body() dto: UpdateAssetObbVersionDto,
    @Req() req: { user: User },
  ) {
    return this.assetsService.updateObbVersion(id, req.user.id, versionId, dto);
  }

  @Delete(':id/versions/:versionId')
  @Log('Asset Management', 'Delete OBB Version')
  removeObbVersion(
    @Param('id', ParseIntPipe) id: number,
    @Param('versionId') versionId: string,
    @Req() req: { user: User },
  ) {
    return this.assetsService.removeObbVersion(id, req.user.id, versionId);
  }

  @Patch(':id/rename')
  @Log('에셋 관리', '이름 변경')
  rename(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { name: string },
    @Req() req: { user: User },
  ) {
    return this.assetsService.rename(id, req.user.id, body.name);
  }

  @Patch(':id/approval')
  @Log('에셋 관리', '승인 토글')
  toggleApproval(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: { user: User },
  ) {
    return this.assetsService.toggleApproval(id, req.user.id);
  }

  @Post(':id/resume')
  @Log('에셋 관리', 'Stage2 재개')
  resumeStage2(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { obbCenter?: number[]; obbRotation?: number[]; obbScale?: number[]; previewCenter?: number[]; previewBounds?: number[] },
    @Req() req: { user: User },
  ) {
    return this.assetsService.resumeStage2(id, req.user.id, body);
  }

  @Post(':id/regenerate')
  @Log('Asset Management', 'Regenerate Asset Quality')
  regenerate(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RegenerateAssetDto,
    @Req() req: { user: User },
  ) {
    return this.assetsService.regenerate(id, req.user.id, dto.qualityPreset);
  }

  @Post(':id/clone')
  @Log('에셋 관리', '품질 복사본 생성')
  cloneWithQuality(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RegenerateAssetDto,
    @Req() req: { user: User },
  ) {
    return this.assetsService.cloneWithQuality(id, req.user.id, dto.qualityPreset);
  }

  @Get(':id/nerf-frames')
  @Log('에셋 관리', 'NeRF 프레임 목록')
  getNerfFrames(@Param('id', ParseIntPipe) id: number, @Req() req: { user: User }) {
    return this.assetsService.getNerfFramePaths(id, req.user.id).then((paths) => ({
      count: paths.length,
      paths,
    }));
  }

  @Get(':id/nerf-frame')
  @Log('에셋 관리', 'NeRF 프레임 스트리밍')
  async getNerfFrame(
    @Param('id', ParseIntPipe) id: number,
    @Query('path') framePath: string,
    @Req() req: { user: User },
    @Res() res: Response,
  ) {
    await this.assetsService.streamNerfFrame(id, req.user.id, framePath, res);
  }

  @Get(':id/download')
  @Log('Asset Management', 'Download Output Artifact')
  async downloadArtifact(
    @Param('id', ParseIntPipe) id: number,
    @Query('format') format: string,
    @Req() req: { user: User },
    @Res() res: Response,
  ) {
    await this.assetsService.streamOutputArtifact(id, req.user.id, format, res);
  }

  @Post(':id/cancel')
  @Log('에셋 관리', '작업 중지')
  cancelJob(@Param('id', ParseIntPipe) id: number, @Req() req: { user: User }) {
    return this.assetsService.cancelJob(id, req.user.id);
  }

  @Delete(':id')
  @Log('에셋 관리', '삭제')
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: { user: User }) {
    return this.assetsService.remove(id, req.user.id);
  }
}
