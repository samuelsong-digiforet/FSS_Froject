import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as unzipper from 'unzipper';
import type { Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Asset, AssetStatus, AssetType } from './entities/asset.entity';
import { CreateAssetDto } from './dto/create-asset.dto';
import { CreateAssetObbVersionDto } from './dto/create-asset-obb-version.dto';
import { UpdateAssetObbVersionDto } from './dto/update-asset-obb-version.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';
import { StorageService } from '../storage/storage.service';
import { ConversionProducer } from '../queue/conversion.producer';
import {
  detectInputFormat,
  getDefaultOutputProfile,
  isSupportedDirectUpload,
  isSupportedOutputProfile,
} from './asset-format.utils';

type AssetObb = {
  center: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
};

type AssetObbVersion = {
  id: string;
  description: string;
  createdAt: string;
  obb: AssetObb;
  sceneObject?: string;
};

const MAX_OBB_VERSIONS = 50;
const MESH_INTEROP_DOWNLOADS = {
  glb: { entryPath: 'output.glb', contentType: 'model/gltf-binary' },
  obj: { entryPath: 'output.obj', contentType: 'model/obj' },
  stl: { entryPath: 'output.stl', contentType: 'model/stl' },
  ply: { entryPath: 'output.ply', contentType: 'application/octet-stream' },
} as const;

type MeshInteropDownloadFormat = keyof typeof MESH_INTEROP_DOWNLOADS;

@Injectable()
export class AssetsService {
  constructor(
    @InjectRepository(Asset)
    private readonly assetRepo: Repository<Asset>,
    private readonly storage: StorageService,
    private readonly conversionProducer: ConversionProducer,
  ) {}

  async create(dto: CreateAssetDto, userId: string): Promise<Asset> {
    const { outputProfile: requestedOutputProfile, uploadMode = 'convert', ...assetDto } = dto;
    const detectedInput = detectInputFormat(assetDto.sourceObject);
    if (uploadMode !== 'direct' && requestedOutputProfile && !isSupportedOutputProfile(assetDto.type, requestedOutputProfile)) {
      throw new BadRequestException(`Unsupported output profile '${requestedOutputProfile}' for asset type '${assetDto.type}'`);
    }

    if (uploadMode === 'direct' && !isSupportedDirectUpload(assetDto.type, detectedInput)) {
      throw new BadRequestException(`일반 업로드는 ${assetDto.type} 타입에서 ${detectedInput.extension || '알 수 없는 형식'} 파일을 지원하지 않습니다.`);
    }

    const outputProfile = uploadMode === 'direct'
      ? getDefaultOutputProfile(assetDto.type, detectedInput)
      : (requestedOutputProfile ?? getDefaultOutputProfile(assetDto.type, detectedInput));
    const asset = this.assetRepo.create({
      ...assetDto,
      userId,
      ...(uploadMode === 'direct' ? {
        status: AssetStatus.DONE,
        progress: 100,
        outputObject: assetDto.sourceObject,
      } : {}),
      metadata: {
        inputFormat: detectedInput.extension || null,
        inputKind: detectedInput.kind,
        inputContainer: detectedInput.container,
        outputProfile,
        uploadMode,
      },
    });
    const saved = await this.assetRepo.save(asset);

    if (uploadMode === 'direct') {
      return saved;
    }

    try {
      const job = await this.conversionProducer.addConversionJob({
        assetId: saved.id,
        assetType: saved.type,
        sourceObject: saved.sourceObject,
        outputProfile,
        userId,
      });
      await this.assetRepo.update(saved.id, { jobId: job });
      console.log(`[Queue] Job added for asset: ${saved.id}`);
    } catch (err) {
      console.error('[Queue] Failed to add job:', err);
    }

    return saved;
  }

  async findAll(userId: string, categoryId?: number): Promise<(Asset & { url: string; previewUrl?: string })[]> {
    const where: Record<string, unknown> = { userId };
    if (categoryId) where.categoryId = categoryId;
    const assets = await this.assetRepo.find({
      where,
      relations: ['category'],
      order: { createdAt: 'DESC' },
    });

    return Promise.all(
      assets.map(async (asset) => {
        const url = await this.storage.getPresignedUrl(asset.sourceObject);
        const previewUrl = asset.previewObject
          ? await this.storage.getPresignedUrl(asset.previewObject)
          : undefined;
        return { ...asset, url, previewUrl };
      }),
    );
  }

  async findOne(id: string, userId: string): Promise<Asset & { url: string; previewUrl?: string; outputUrl?: string }> {
    const asset = await this.assetRepo.findOne({ where: { id, userId } });
    if (!asset) throw new NotFoundException('Asset not found');

    const url = await this.storage.getPresignedUrl(asset.sourceObject);
    const previewUrl = asset.previewObject
      ? await this.storage.getPresignedUrl(asset.previewObject)
      : undefined;

    let outputUrl: string | undefined;
    if (asset.status === AssetStatus.DONE && asset.outputObject) {
      outputUrl = await this.storage.getPresignedUrl(asset.outputObject);
    }

    return { ...asset, url, previewUrl, outputUrl };
  }

  async getObbVersions(id: string, userId: string): Promise<AssetObbVersion[]> {
    const asset = await this.assetRepo.findOne({ where: { id, userId } });
    if (!asset) throw new NotFoundException('Asset not found');

    return this.readObbVersions(asset.metadata);
  }

  async update(id: string, dto: UpdateAssetDto, userId: string): Promise<Asset> {
    const asset = await this.assetRepo.findOne({ where: { id } });
    if (!asset) throw new NotFoundException('Asset not found');
    if (asset.userId !== userId) throw new ForbiddenException('Forbidden');

    const {
      calibrationScale,
      calibrationReferenceLength,
      calibrationMeasuredLength,
      representativeSceneObject,
      ...restDto
    } = dto;

    Object.assign(asset, restDto);

    if (
      calibrationScale !== undefined ||
      calibrationReferenceLength !== undefined ||
      calibrationMeasuredLength !== undefined ||
      representativeSceneObject !== undefined
    ) {
      const nextMetadata: Record<string, unknown> = {
        ...(asset.metadata ?? {}),
        ...(calibrationScale !== undefined ? { calibrationScale } : {}),
        ...(calibrationReferenceLength !== undefined ? { calibrationReferenceLength } : {}),
        ...(calibrationMeasuredLength !== undefined ? { calibrationMeasuredLength } : {}),
        ...(representativeSceneObject ? { representativeSceneObject } : {}),
      };
      if (representativeSceneObject === null) delete nextMetadata.representativeSceneObject;
      asset.metadata = nextMetadata;
    }

    return this.assetRepo.save(asset);
  }

  async createObbVersion(id: string, userId: string, dto: CreateAssetObbVersionDto): Promise<Asset> {
    const asset = await this.assetRepo.findOne({ where: { id, userId } });
    if (!asset) throw new NotFoundException('Asset not found');

    const metadata = this.asMetadataRecord(asset.metadata);
    const nextObb: AssetObb = {
      center: [...dto.center] as [number, number, number],
      rotation: [...dto.rotation] as [number, number, number],
      scale: [...dto.scale] as [number, number, number],
    };

    const nextVersion: AssetObbVersion = {
      id: randomUUID(),
      description: dto.description?.trim() ?? '',
      createdAt: new Date().toISOString(),
      obb: nextObb,
      ...(dto.sceneObject ? { sceneObject: dto.sceneObject } : {}),
    };

    const existingVersions = this.readObbVersions(metadata);

    asset.metadata = {
      ...metadata,
      obbParams: nextObb,
      obbVersions: [nextVersion, ...existingVersions].slice(0, MAX_OBB_VERSIONS),
    };

    return this.assetRepo.save(asset);
  }

  async updateObbVersion(
    id: string,
    userId: string,
    versionId: string,
    dto: UpdateAssetObbVersionDto,
  ): Promise<Asset> {
    const asset = await this.assetRepo.findOne({ where: { id, userId } });
    if (!asset) throw new NotFoundException('Asset not found');

    const metadata = this.asMetadataRecord(asset.metadata);
    const versions = this.readObbVersions(metadata);
    const targetIndex = versions.findIndex((version) => version.id === versionId);
    if (targetIndex < 0) throw new NotFoundException('OBB version not found');

    const prevVersion = versions[targetIndex];
    const nextObb: AssetObb = {
      center: [...dto.center] as [number, number, number],
      rotation: [...dto.rotation] as [number, number, number],
      scale: [...dto.scale] as [number, number, number],
    };
    const nextVersion: AssetObbVersion = {
      ...prevVersion,
      description: dto.description?.trim() ?? '',
      obb: nextObb,
    };
    const currentObb = this.normalizeObb(metadata.obbParams);

    asset.metadata = {
      ...metadata,
      ...(targetIndex === 0 || this.sameObb(currentObb, prevVersion.obb) ? { obbParams: nextObb } : {}),
      obbVersions: versions.map((version, index) => (index === targetIndex ? nextVersion : version)),
    };

    return this.assetRepo.save(asset);
  }

  async removeObbVersion(id: string, userId: string, versionId: string): Promise<Asset> {
    const asset = await this.assetRepo.findOne({ where: { id, userId } });
    if (!asset) throw new NotFoundException('Asset not found');

    const metadata = this.asMetadataRecord(asset.metadata);
    const versions = this.readObbVersions(metadata);
    const nextVersions = versions.filter((version) => version.id !== versionId);
    if (nextVersions.length === versions.length) throw new NotFoundException('OBB version not found');

    asset.metadata = {
      ...metadata,
      obbVersions: nextVersions,
    };

    return this.assetRepo.save(asset);
  }

  async resumeStage2(
    id: string,
    userId: string,
    params: { obbCenter?: number[]; obbRotation?: number[]; obbScale?: number[]; previewCenter?: number[]; previewBounds?: number[] },
  ): Promise<Asset> {
    const asset = await this.assetRepo.findOne({ where: { id, userId } });
    if (!asset) throw new NotFoundException('Asset not found');
    if (asset.status !== AssetStatus.AWAITING_CROP) {
      throw new BadRequestException('Only assets waiting for crop selection can resume stage 2');
    }

    const metadata = (asset.metadata ?? {}) as Record<string, unknown>;
    const colmapObject = typeof metadata.colmapObject === 'string' ? metadata.colmapObject : undefined;
    if (!colmapObject) throw new BadRequestException('COLMAP result was not found');

    const detectedInput = detectInputFormat(asset.sourceObject);
    const outputProfile = typeof metadata.outputProfile === 'string' && isSupportedOutputProfile(asset.type, metadata.outputProfile)
      ? metadata.outputProfile
      : getDefaultOutputProfile(asset.type, detectedInput);

    const fallbackPreviewCenter = Array.isArray(metadata.previewCenter)
      ? metadata.previewCenter as number[]
      : undefined;
    const previewCenter = params.previewCenter ?? fallbackPreviewCenter;
    const fallbackPreviewBounds = Array.isArray(metadata.previewBounds)
      ? metadata.previewBounds as number[]
      : undefined;
    const previewBounds = params.previewBounds ?? fallbackPreviewBounds;

    const hasCrop = params.obbCenter || params.obbRotation || params.obbScale;
    const obbParams = hasCrop ? {
      center: params.obbCenter ?? [0, 0, 0],
      rotation: params.obbRotation ?? [0, 0, 0],
      scale: params.obbScale ?? [1, 1, 1],
      ...(previewCenter ? { previewCenter } : {}),
      ...(previewBounds ? { previewBounds } : {}),
    } : undefined;

    const job = await this.conversionProducer.addStage2Job({
      assetId: id,
      assetType: asset.type,
      colmapObject,
      outputProfile,
      obbParams,
      userId,
    });

    await this.assetRepo.update(id, {
      status: AssetStatus.PROCESSING,
      progress: 55,
      jobId: job,
      metadata: {
        ...metadata,
        inputFormat: metadata.inputFormat ?? detectedInput.extension ?? null,
        inputKind: metadata.inputKind ?? detectedInput.kind,
        inputContainer: metadata.inputContainer ?? detectedInput.container,
        outputProfile,
        ...(previewCenter ? { previewCenter } : {}),
        ...(previewBounds ? { previewBounds } : {}),
        obbParams,
      },
    } as Partial<Asset>);

    return this.assetRepo.findOne({ where: { id } }) as Promise<Asset>;
  }

  async rename(id: string, userId: string, name: string): Promise<Asset> {
    const asset = await this.assetRepo.findOne({ where: { id, userId } });
    if (!asset) throw new NotFoundException('Asset not found');
    asset.name = name.trim();
    return this.assetRepo.save(asset);
  }

  async toggleApproval(id: string, userId: string): Promise<Asset> {
    const asset = await this.assetRepo.findOne({ where: { id, userId } });
    if (!asset) throw new NotFoundException('Asset not found');
    asset.approved = !asset.approved;
    return this.assetRepo.save(asset);
  }


  // NeRF ZIP에서 프레임 목록을 추출하여 반환 (sorted)
  // 결과를 in-memory 캐싱하여 반복 요청 시 ZIP을 다시 스캔하지 않음
  private readonly nerfFrameCache = new Map<string, string[]>();

  async getNerfFramePaths(id: string, userId: string): Promise<string[]> {
    const cached = this.nerfFrameCache.get(id);
    if (cached) return cached;

    const asset = await this.assetRepo.findOne({ where: { id, userId } });
    if (!asset || asset.type !== 'nerf' || !asset.outputObject) {
      throw new NotFoundException('NeRF 에셋 또는 출력물을 찾을 수 없습니다.');
    }

    const zipStream = await this.storage.getObjectStream(asset.outputObject);
    const paths: string[] = [];

    await new Promise<void>((resolve, reject) => {
      zipStream
        .pipe(unzipper.Parse())
        .on('entry', (entry: unzipper.Entry) => {
          if (/^frames\/render_\d+\.png$/i.test(entry.path)) {
            paths.push(entry.path);
          }
          entry.autodrain();
        })
        .on('finish', resolve)
        .on('error', reject);
    });

    paths.sort();
    this.nerfFrameCache.set(id, paths);
    return paths;
  }

  async streamNerfFrame(id: string, userId: string, framePath: string, res: Response): Promise<void> {
    const asset = await this.assetRepo.findOne({ where: { id, userId } });
    if (!asset || asset.type !== 'nerf' || !asset.outputObject) {
      throw new NotFoundException('NeRF 에셋 또는 출력물을 찾을 수 없습니다.');
    }

    const zipStream = await this.storage.getObjectStream(asset.outputObject);
    let found = false;

    await new Promise<void>((resolve, reject) => {
      const parseStream = unzipper.Parse();

      parseStream.on('entry', (entry: unzipper.Entry) => {
        if (!found && entry.path === framePath) {
          found = true;
          res.setHeader('Content-Type', 'image/png');
          res.setHeader('Cache-Control', 'public, max-age=3600');
          entry
            .pipe(res)
            .on('finish', () => {
              zipStream.destroy();
              resolve();
            })
            .on('error', reject);
        } else {
          entry.autodrain();
        }
      });

      parseStream.on('finish', () => {
        if (!found) reject(new NotFoundException(`프레임을 찾을 수 없습니다: ${framePath}`));
        else resolve();
      });
      parseStream.on('error', reject);

      zipStream.pipe(parseStream);
    });
  }

  async streamOutputArtifact(id: string, userId: string, format: string, res: Response): Promise<void> {
    const asset = await this.assetRepo.findOne({ where: { id, userId } });
    if (!asset) throw new NotFoundException('Asset not found');

    const normalizedFormat = String(format ?? '').toLowerCase();
    const isAll = normalizedFormat === 'all';
    const isMeshFormat = normalizedFormat in MESH_INTEROP_DOWNLOADS;
    if (!isAll && !isMeshFormat) {
      throw new BadRequestException('Unsupported download format');
    }

    const metadata = this.asMetadataRecord(asset.metadata);
    const outputProfile = typeof metadata.outputProfile === 'string' ? metadata.outputProfile : undefined;
    if (
      asset.type !== AssetType.MESH ||
      outputProfile !== 'mesh_interop_bundle' ||
      !asset.outputObject ||
      !asset.outputObject.toLowerCase().endsWith('.zip')
    ) {
      throw new BadRequestException('Format-select download is only available for mesh interop bundles');
    }

    const safeBaseName = this.getDownloadBaseName(asset.name);

    if (isAll) {
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', this.getAttachmentHeader(`${safeBaseName}.zip`));
      res.setHeader('Cache-Control', 'no-store');

      const stat = await this.storage.statObject(asset.outputObject);
      if (stat?.size) res.setHeader('Content-Length', stat.size);

      const stream = await this.storage.getObjectStream(asset.outputObject);
      await new Promise<void>((resolve, reject) => {
        stream
          .pipe(res)
          .on('finish', resolve)
          .on('error', reject);
      });
      return;
    }

    const download = MESH_INTEROP_DOWNLOADS[normalizedFormat as MeshInteropDownloadFormat];
    const zipStream = await this.storage.getObjectStream(asset.outputObject);
    let found = false;

    await new Promise<void>((resolve, reject) => {
      const parseStream = unzipper.Parse();

      parseStream.on('entry', (entry: unzipper.Entry) => {
        if (!found && entry.path.toLowerCase() === download.entryPath) {
          found = true;
          res.setHeader('Content-Type', download.contentType);
          res.setHeader('Content-Disposition', this.getAttachmentHeader(`${safeBaseName}.${normalizedFormat}`));
          res.setHeader('Cache-Control', 'no-store');
          entry
            .pipe(res)
            .on('finish', () => {
              zipStream.destroy();
              resolve();
            })
            .on('error', reject);
        } else {
          entry.autodrain();
        }
      });

      parseStream.on('finish', () => {
        if (!found) reject(new NotFoundException(`Artifact not found: ${download.entryPath}`));
        else resolve();
      });
      parseStream.on('error', reject);

      zipStream.pipe(parseStream);
    });
  }

  async remove(id: string, userId: string): Promise<void> {
    const asset = await this.assetRepo.findOne({ where: { id, userId } });
    if (!asset) throw new NotFoundException('Asset not found');

    if (asset.jobId) {
      await this.conversionProducer.cancelJob(asset.jobId).catch(() => null);
    }

    await this.storage.delete(asset.sourceObject).catch(() => null);
    if (asset.previewObject) await this.storage.delete(asset.previewObject).catch(() => null);
    if (asset.outputObject) await this.storage.delete(asset.outputObject).catch(() => null);

    await this.assetRepo.remove(asset);
  }

  private asMetadataRecord(metadata: Asset['metadata'] | null | undefined): Record<string, unknown> {
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      return metadata as Record<string, unknown>;
    }

    return {};
  }

  private readObbVersions(metadata: Asset['metadata'] | null | undefined): AssetObbVersion[] {
    const raw = this.asMetadataRecord(metadata).obbVersions;
    if (!Array.isArray(raw)) return [];

    return raw
      .map((item) => this.normalizeObbVersion(item))
      .filter((item): item is AssetObbVersion => !!item)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  private normalizeObbVersion(value: unknown): AssetObbVersion | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

    const record = value as Record<string, unknown>;
    const obb = this.normalizeObb(record.obb);
    if (!obb) return null;

    const id = typeof record.id === 'string' && record.id.trim().length > 0 ? record.id : randomUUID();
    const description = typeof record.description === 'string' ? record.description : '';
    const createdAtRaw = typeof record.createdAt === 'string' ? record.createdAt : '';
    const createdAt = Number.isNaN(new Date(createdAtRaw).getTime())
      ? new Date(0).toISOString()
      : new Date(createdAtRaw).toISOString();

    const sceneObject = typeof record.sceneObject === 'string' && record.sceneObject.trim().length > 0
      ? record.sceneObject
      : undefined;

    return {
      id,
      description,
      createdAt,
      obb,
      ...(sceneObject ? { sceneObject } : {}),
    };
  }

  private normalizeObb(value: unknown): AssetObb | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

    const record = value as Record<string, unknown>;
    const center = this.normalizeTriplet(record.center);
    const rotation = this.normalizeTriplet(record.rotation);
    const scale = this.normalizeTriplet(record.scale);
    if (!center || !rotation || !scale) return null;

    return {
      center,
      rotation,
      scale,
    };
  }

  private normalizeTriplet(value: unknown): [number, number, number] | null {
    if (!Array.isArray(value) || value.length < 3) return null;

    const next = value.slice(0, 3).map((item) => Number(item));
    if (next.some((item) => !Number.isFinite(item))) return null;

    return [next[0], next[1], next[2]];
  }

  private sameObb(a: AssetObb | null, b: AssetObb | null): boolean {
    if (!a || !b) return false;

    return (
      a.center.every((value, index) => value === b.center[index]) &&
      a.rotation.every((value, index) => value === b.rotation[index]) &&
      a.scale.every((value, index) => value === b.scale[index])
    );
  }

  private getDownloadBaseName(name: string): string {
    return name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'asset';
  }

  private getAttachmentHeader(filename: string): string {
    return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
  }
}
