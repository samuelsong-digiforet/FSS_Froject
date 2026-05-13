import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Res,
  UploadedFile,
  UseInterceptors,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StorageService } from '../storage/storage.service';

@Controller('uploads')
export class UploadsController {
  constructor(private readonly storage: StorageService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 2048 * 1024 * 1024 }, // 2GB
      fileFilter: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
        const allowedExts = [
          // 이미지
          'jpg', 'jpeg', 'png', 'webp', 'tiff', 'bmp',
          // 영상
          'mp4', 'mov', 'avi', 'mkv',
          // 3D 메쉬
          'glb', 'gltf', 'obj', 'fbx', 'stl', 'dae', 'abc',
          // CAD
          'step', 'stp', 'iges', 'igs',
          // 포인트 클라우드
          'ply', 'pcd', 'las', 'laz', 'xyz', 'pts', 'ptx', 'e57',
          // 압축 (이미지 셋 - 3DGS/NeRF용)
          'zip', 'tar', 'gz',
          // 기타
          'bin',
        ];
        if (allowedExts.includes(ext) || file.mimetype === 'application/octet-stream') {
          cb(null, true);
        } else {
          cb(new BadRequestException(`허용되지 않는 파일 형식: .${ext}`), false);
        }
      },
    }),
  )
  async uploadFile(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('파일이 없습니다.');
    // multer가 originalname을 Latin-1로 잘못 디코딩하므로 UTF-8로 재해석
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const objectName = `uploads/${uuidv4()}/${originalName}`;
    await this.storage.upload(objectName, file.buffer, file.mimetype);
    const url = await this.storage.getPresignedUrl(objectName);
    return { objectName, originalName, size: file.size, mimetype: file.mimetype, url };
  }

  // 파일 직접 스트리밍 (CORS 없이 브라우저에서 바로 접근)
  @Get('stream/:objectName(*)')
  async streamFile(
    @Param('objectName') objectName: string,
    @Res() res: Response,
  ) {
    const ext = path.extname(objectName).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.glb': 'model/gltf-binary',
      '.gltf': 'model/gltf+json',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.ply': 'application/octet-stream',
      '.pcd': 'application/octet-stream',
      '.obj': 'model/obj',
      '.fbx': 'application/octet-stream',
      '.stl': 'model/stl',
      '.las': 'application/octet-stream',
      '.laz': 'application/octet-stream',
      '.zip': 'application/zip',
      '.splat': 'application/octet-stream',
    };
    const contentType = mimeMap[ext] ?? 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    const filename = path.basename(objectName);
    res.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    const stat = await this.storage.statObject(objectName);
    if (stat?.size) res.setHeader('Content-Length', stat.size);
    const stream = await this.storage.getObjectStream(objectName);
    stream.pipe(res);
  }

  @Get(':objectName(*)')
  @UseGuards(JwtAuthGuard)
  async getUrl(@Param('objectName') objectName: string) {
    const url = await this.storage.getPresignedUrl(objectName);
    return { url };
  }

  @Delete(':objectName(*)')
  @UseGuards(JwtAuthGuard)
  async deleteFile(@Param('objectName') objectName: string) {
    await this.storage.delete(objectName);
    return { message: '삭제 완료' };
  }
}