import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  HttpException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import * as path from 'path';
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

type GenerationQuality = 'fast' | 'normal' | 'precise';

const MAX_OBB_VERSIONS = 50;
const DEFAULT_GENERATION_QUALITY: GenerationQuality = 'fast';
const FACTORY_FSS_CATEGORY_NAME = 'etc';
const GENERATION_QUALITIES = new Set<GenerationQuality>(['fast', 'normal', 'precise']);
const REGENERATABLE_TYPES = new Set<AssetType>([
  AssetType.POINT_CLOUD,
  AssetType.NERF,
  AssetType.GAUSSIAN,
  AssetType.MESH,
]);
const BUSY_REGENERATION_STATUSES = new Set<AssetStatus>([
  AssetStatus.PENDING,
  AssetStatus.PROCESSING,
  AssetStatus.AWAITING_CROP,
]);
const MESH_INTEROP_DOWNLOADS = {
  glb: { entryPath: 'output.glb', contentType: 'model/gltf-binary' },
  obj: { entryPath: 'output.obj', contentType: 'model/obj' },
  stl: { entryPath: 'output.stl', contentType: 'model/stl' },
  ply: { entryPath: 'output.ply', contentType: 'application/octet-stream' },
} as const;

type MeshInteropDownloadFormat = keyof typeof MESH_INTEROP_DOWNLOADS;

@Injectable()
export class AssetsService {
  private readonly logger = new Logger(AssetsService.name);

  constructor(
    @InjectRepository(Asset)
    private readonly assetRepo: Repository<Asset>,
    private readonly storage: StorageService,
    private readonly conversionProducer: ConversionProducer,
    private readonly config: ConfigService,
  ) {}

  async create(dto: CreateAssetDto, userId: number): Promise<Asset> {
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
    const generationQuality = DEFAULT_GENERATION_QUALITY;
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
        generationQuality,
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
        qualityPreset: generationQuality,
        userId,
      });
      await this.assetRepo.update(saved.id, { jobId: job });
      console.log(`[Queue] Job added for asset: ${saved.id}`);
    } catch (err) {
      console.error('[Queue] Failed to add job:', err);
    }

    return saved;
  }

  async findAll(userId: number, categoryId?: number): Promise<(Asset & { url: string; previewUrl?: string })[]> {
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

  async findOneByUuid(uuid: string, userId: number): Promise<Asset & { url: string; previewUrl?: string; outputUrl?: string }> {
    const asset = await this.assetRepo.findOne({ where: { uuid, userId } });
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

  async findOne(id: number, userId: number): Promise<Asset & { url: string; previewUrl?: string; outputUrl?: string }> {
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

  async getObbVersions(id: number, userId: number): Promise<AssetObbVersion[]> {
    const asset = await this.assetRepo.findOne({ where: { id, userId } });
    if (!asset) throw new NotFoundException('Asset not found');

    return this.readObbVersions(asset.metadata);
  }

  async update(id: number, dto: UpdateAssetDto, userId: number): Promise<Asset> {
    const asset = await this.assetRepo.findOne({ where: { id } });
    if (!asset) throw new NotFoundException('Asset not found');
    if (asset.userId !== userId) throw new ForbiddenException('Forbidden');

    const {
      calibrationScale,
      calibrationReferenceLength,
      calibrationMeasuredLength,
      representativeSceneObject,
      volumeRenderingAccuracy,
      gdtAnnotations,
      vraPoints,
      ...restDto
    } = dto;

    Object.assign(asset, restDto);

    if (
      calibrationScale !== undefined ||
      calibrationReferenceLength !== undefined ||
      calibrationMeasuredLength !== undefined ||
      representativeSceneObject !== undefined ||
      volumeRenderingAccuracy !== undefined ||
      gdtAnnotations !== undefined ||
      vraPoints !== undefined
    ) {
      const nextMetadata: Record<string, unknown> = {
        ...(asset.metadata ?? {}),
        ...(calibrationScale !== undefined ? { calibrationScale } : {}),
        ...(calibrationReferenceLength !== undefined ? { calibrationReferenceLength } : {}),
        ...(calibrationMeasuredLength !== undefined ? { calibrationMeasuredLength } : {}),
        ...(representativeSceneObject ? { representativeSceneObject } : {}),
        ...(volumeRenderingAccuracy !== undefined ? { volumeRenderingAccuracy } : {}),
        ...(gdtAnnotations !== undefined
          ? {
              gdtAnnotations: gdtAnnotations.map((item) => ({
                id: item.id,
                position: [...item.position] as [number, number, number],
                type: item.type,
                tolerance: item.tolerance,
              })),
            }
          : {}),
        ...(vraPoints !== undefined
          ? {
              vraPoints: vraPoints.map((item) => ({
                measured: item.measured,
                actual: item.actual,
                ...(item.p1 !== undefined ? { p1: item.p1 } : {}),
                ...(item.p2 !== undefined ? { p2: item.p2 } : {}),
              })),
            }
          : {}),
      };
      if (representativeSceneObject === null) delete nextMetadata.representativeSceneObject;
      asset.metadata = nextMetadata;
    }

    return this.assetRepo.save(asset);
  }

  async createObbVersion(id: number, userId: number, dto: CreateAssetObbVersionDto): Promise<Asset> {
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
    id: number,
    userId: number,
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

  async removeObbVersion(id: number, userId: number, versionId: string): Promise<Asset> {
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
    id: number,
    userId: number,
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
    const generationQuality = this.normalizeGenerationQuality(metadata.generationQuality) ?? DEFAULT_GENERATION_QUALITY;

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
      qualityPreset: generationQuality,
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
        generationQuality,
        ...(previewCenter ? { previewCenter } : {}),
        ...(previewBounds ? { previewBounds } : {}),
        obbParams,
      },
    } as Partial<Asset>);

    return this.assetRepo.findOne({ where: { id } }) as Promise<Asset>;
  }

  async regenerate(id: number, userId: number, requestedQuality: GenerationQuality): Promise<Asset> {
    const asset = await this.assetRepo.findOne({ where: { id, userId } });
    if (!asset) throw new NotFoundException('Asset not found');
    if (!REGENERATABLE_TYPES.has(asset.type)) {
      throw new BadRequestException('This asset type does not support quality regeneration');
    }
    if (BUSY_REGENERATION_STATUSES.has(asset.status)) {
      throw new BadRequestException('The asset is already being processed');
    }

    const qualityPreset = this.normalizeGenerationQuality(requestedQuality);
    if (!qualityPreset) throw new BadRequestException('Unsupported generation quality');

    const metadata = this.asMetadataRecord(asset.metadata);
    if (this.isDirectUploadAsset(asset, metadata)) {
      throw new BadRequestException('Direct-uploaded assets do not support regeneration');
    }

    const detectedInput = detectInputFormat(asset.sourceObject);
    const outputProfile = typeof metadata.outputProfile === 'string' && isSupportedOutputProfile(asset.type, metadata.outputProfile)
      ? metadata.outputProfile
      : getDefaultOutputProfile(asset.type, detectedInput);
    const colmapObject = typeof metadata.colmapObject === 'string' ? metadata.colmapObject : undefined;
    const previewCenter = this.normalizeTriplet(metadata.previewCenter);
    const previewBounds = this.normalizeTriplet(metadata.previewBounds);
    const savedObb = this.normalizeObb(metadata.obbParams);
    const obbParams = savedObb ? {
      center: savedObb.center,
      rotation: savedObb.rotation,
      scale: savedObb.scale,
      ...(previewCenter ? { previewCenter } : {}),
      ...(previewBounds ? { previewBounds } : {}),
    } : undefined;

    const job = colmapObject
      ? await this.conversionProducer.addStage2Job({
          assetId: id,
          assetType: asset.type,
          colmapObject,
          outputProfile,
          qualityPreset,
          obbParams,
          userId,
        })
      : await this.conversionProducer.addConversionJob({
          assetId: id,
          assetType: asset.type,
          sourceObject: asset.sourceObject,
          outputProfile,
          qualityPreset,
          userId,
        });

    await this.assetRepo.update(id, {
      status: AssetStatus.PROCESSING,
      progress: colmapObject ? 55 : 0,
      jobId: job,
      errorMessage: null,
      metadata: {
        ...metadata,
        inputFormat: metadata.inputFormat ?? detectedInput.extension ?? null,
        inputKind: metadata.inputKind ?? detectedInput.kind,
        inputContainer: metadata.inputContainer ?? detectedInput.container,
        outputProfile,
        generationQuality: qualityPreset,
        generationQualityRequestedAt: new Date().toISOString(),
      },
    } as Partial<Asset>);

    return this.assetRepo.findOne({ where: { id } }) as Promise<Asset>;
  }

  async cloneWithQuality(id: number, userId: number, requestedQuality: GenerationQuality): Promise<Asset> {
    const source = await this.assetRepo.findOne({ where: { id, userId } });
    if (!source) throw new NotFoundException('Asset not found');
    if (!REGENERATABLE_TYPES.has(source.type)) {
      throw new BadRequestException('This asset type does not support quality cloning');
    }

    const qualityPreset = this.normalizeGenerationQuality(requestedQuality);
    if (!qualityPreset) throw new BadRequestException('Unsupported generation quality');

    const sourceMetadata = this.asMetadataRecord(source.metadata);
    if (this.isDirectUploadAsset(source, sourceMetadata)) {
      throw new BadRequestException('Direct-uploaded assets do not support cloning');
    }

    const TYPE_SUFFIX: Record<string, string> = {
      gaussian: 'to 3DGS',
      nerf: 'to NeRF',
      point_cloud: 'to P.C',
      mesh: 'to mesh',
    };
    const QUALITY_LABELS: Record<GenerationQuality, string> = {
      fast: '빠름',
      normal: '보통',
      precise: '정밀',
    };

    const typeSuffix = TYPE_SUFFIX[source.type] ?? '';
    const baseName = source.name.replace(/ to (3DGS|NeRF|P\.C|mesh)$/, '').trim();
    const cloneName = `${baseName} ${typeSuffix}`.trim();
    const cloneDescription = `생성 품질 : ${QUALITY_LABELS[qualityPreset]}`;

    const detectedInput = detectInputFormat(source.sourceObject);
    const outputProfile = typeof sourceMetadata.outputProfile === 'string' && isSupportedOutputProfile(source.type, sourceMetadata.outputProfile)
      ? sourceMetadata.outputProfile
      : getDefaultOutputProfile(source.type, detectedInput);
    const colmapObject = typeof sourceMetadata.colmapObject === 'string' ? sourceMetadata.colmapObject : undefined;
    const previewCenter = this.normalizeTriplet(sourceMetadata.previewCenter);
    const previewBounds = this.normalizeTriplet(sourceMetadata.previewBounds);
    const savedObb = this.normalizeObb(sourceMetadata.obbParams);
    const obbParams = savedObb ? {
      center: savedObb.center,
      rotation: savedObb.rotation,
      scale: savedObb.scale,
      ...(previewCenter ? { previewCenter } : {}),
      ...(previewBounds ? { previewBounds } : {}),
    } : undefined;

    const clone = this.assetRepo.create({
      name: cloneName,
      description: cloneDescription,
      type: source.type,
      status: AssetStatus.PENDING,
      progress: colmapObject ? 55 : 0,
      sourceObject: source.sourceObject,
      previewObject: source.previewObject ?? undefined,
      categoryId: source.categoryId ?? undefined,
      userId,
      approved: false,
      metadata: {
        ...sourceMetadata,
        outputProfile,
        generationQuality: qualityPreset,
        generationQualityRequestedAt: new Date().toISOString(),
      },
    });
    const saved = await this.assetRepo.save(clone);

    try {
      const job = colmapObject
        ? await this.conversionProducer.addStage2Job({
            assetId: saved.id,
            assetType: saved.type,
            colmapObject,
            outputProfile,
            qualityPreset,
            obbParams,
            userId,
          })
        : await this.conversionProducer.addConversionJob({
            assetId: saved.id,
            assetType: saved.type,
            sourceObject: saved.sourceObject,
            outputProfile,
            qualityPreset,
            userId,
          });
      await this.assetRepo.update(saved.id, {
        status: colmapObject ? AssetStatus.PROCESSING : AssetStatus.PENDING,
        jobId: job,
      });
    } catch (err) {
      console.error('[Queue] Failed to add clone job:', err);
    }

    return this.assetRepo.findOne({ where: { id: saved.id } }) as Promise<Asset>;
  }

  async rename(id: number, userId: number, name: string): Promise<Asset> {
    const asset = await this.assetRepo.findOne({ where: { id, userId } });
    if (!asset) throw new NotFoundException('Asset not found');
    asset.name = name.trim();
    return this.assetRepo.save(asset);
  }

  async toggleApproval(id: number, userId: number): Promise<Asset> {
    const asset = await this.assetRepo.findOne({ where: { id, userId } });
    if (!asset) throw new NotFoundException('Asset not found');
    asset.approved = !asset.approved;
    return this.assetRepo.save(asset);
  }


  // NeRF ZIP에서 프레임 목록을 추출하여 반환 (sorted)
  // 결과를 in-memory 캐싱하여 반복 요청 시 ZIP을 다시 스캔하지 않음
  private readonly nerfFrameCache = new Map<number, string[]>();

  async getNerfFramePaths(id: number, userId: number): Promise<string[]> {
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

  async streamNerfFrame(id: number, userId: number, framePath: string, res: Response): Promise<void> {
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

  async streamOutputArtifact(id: number, userId: number, format: string, res: Response): Promise<void> {
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

      const targetExt = `.${normalizedFormat}`;
      parseStream.on('entry', (entry: unzipper.Entry) => {
        const entryName = entry.path.toLowerCase();
        const matchExact = entryName === download.entryPath;
        const matchExt = !matchExact && entryName.endsWith(targetExt) && !entryName.includes('/');
        if (!found && (matchExact || matchExt)) {
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

  async cancelJob(id: number, userId: number): Promise<Asset> {
    const asset = await this.assetRepo.findOne({ where: { id, userId } });
    if (!asset) throw new NotFoundException('Asset not found');

    if (asset.jobId) {
      await this.conversionProducer.cancelJob(asset.jobId).catch(() => null);
    }

    await this.assetRepo.update(id, {
      status: AssetStatus.FAILED,
      errorMessage: '사용자가 작업을 중지했습니다.',
    } as Partial<Asset>);

    return this.assetRepo.findOne({ where: { id } }) as Promise<Asset>;
  }

  async exportToExternal(
    assetIds: number[],
    userId: number,
  ): Promise<{ id: number; externalId: number; status: 'created' | 'updated' }[]> {
    const tenantSchema = 'factory_love';
    const dtApiUrl = this.config.get<string>('FACTORY_API_URL');
    const fssApiKey = this.config.get<string>('FSS_API_KEY');

    if (!dtApiUrl || !fssApiKey) {
      throw new ServiceUnavailableException(
        '디지털 트윈 전송 서버 설정이 준비되지 않았습니다. 관리자에게 문의해주세요.',
      );
    }

    try {
      const results: { id: number; externalId: number; status: 'created' | 'updated' }[] = [];

      for (const assetId of assetIds) {
        const asset = await this.assetRepo.findOne({
          where: { id: assetId, userId },
        });
        if (!asset) throw new NotFoundException(`Asset not found: ${assetId}`);
        if (asset.status !== AssetStatus.DONE) {
          throw new BadRequestException(`완료되지 않은 에셋은 전송할 수 없습니다: ${assetId}`);
        }
        if (!asset.outputObject) {
          throw new BadRequestException(`전송할 결과 파일이 없습니다: ${assetId}`);
        }
        if (!asset.approved) {
          throw new BadRequestException(`승인되지 않은 에셋은 전송할 수 없습니다: ${assetId}`);
        }

        const stat = await this.storage.statObject(asset.outputObject);
        const fileSize = String(stat.size);
        const fileExt = this.getObjectExtension(asset.outputObject);
        const previewExt = asset.previewObject && asset.previewObject !== asset.outputObject
          ? this.getObjectExtension(asset.previewObject)
          : null;
        const assetMeta = this.asMetadataRecord(asset.metadata);

        const modelKey = path.posix.join(tenantSchema, 'fss', String(assetId), `model.${fileExt}`);
        const previewKey = previewExt && asset.previewObject && asset.previewObject !== asset.outputObject
          ? path.posix.join(tenantSchema, 'fss', String(assetId), `preview.${previewExt}`)
          : null;

        await this.storage.copyToExternal(asset.outputObject, modelKey);
        if (previewKey && asset.previewObject) {
          await this.storage.copyToExternal(asset.previewObject, previewKey);
        }

        let coverKey = previewKey ?? modelKey;
        let stripKey = previewKey ?? modelKey;

        if (fileExt === 'glb' || fileExt === 'ply') {
          try {
            const res = await fetch(`${dtApiUrl}/asset/fss-generate-thumbnail`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-fss-api-key': fssApiKey },
              body: JSON.stringify({ modelKey, fileExt }),
            });
            if (res.ok) {
              const json = await res.json() as { data: { coverKey: string; stripKey: string } };
              coverKey = json.data.coverKey;
              stripKey = json.data.stripKey;
              this.logger.log(`[Thumbnail generated] assetId=${assetId} coverKey=${coverKey}`);
            } else {
              const body = await res.text().catch(() => '');
              this.logger.warn(`[Thumbnail generation failed] assetId=${assetId} status=${res.status} body=${body}`);
            }
          } catch (error) {
            this.logger.warn(`[Thumbnail generation API error] assetId=${assetId} error=${error}`);
          }
        }

        const pushPayload = (withExternalId: boolean) => JSON.stringify({
          schemaName: tenantSchema,
          ...(withExternalId && asset.externalId ? { externalAssetId: asset.externalId } : {}),
          name: asset.name,
          description: asset.description ?? undefined,
          categoryName: FACTORY_FSS_CATEGORY_NAME,
          modelKey,
          coverKey,
          stripKey,
          fileExt,
          fileSize,
          meta: Object.keys(assetMeta).length > 0 ? assetMeta : undefined,
          isApprove: false,
        });

        let pushRes = await fetch(`${dtApiUrl}/asset/fss-push`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-fss-api-key': fssApiKey },
          body: pushPayload(true),
        });

        if (pushRes.status === 404 && asset.externalId) {
          this.logger.warn(`[fss-push] externalId=${asset.externalId} not found in D.T, retrying as new asset`);
          await this.assetRepo.update(assetId, { externalId: null });
          asset.externalId = null;
          pushRes = await fetch(`${dtApiUrl}/asset/fss-push`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-fss-api-key': fssApiKey },
            body: pushPayload(false),
          });
        }

        if (!pushRes.ok) {
          const body = await pushRes.text().catch(() => '');
          throw new Error(`D.T fss-push 실패: status=${pushRes.status} body=${body}`);
        }

        const pushJson = await pushRes.json() as { data: { assetId: number; status: 'created' | 'updated' } };
        const externalId = pushJson.data.assetId;
        const exportStatus = pushJson.data.status;

        if (exportStatus === 'created' || asset.externalId !== externalId) {
          await this.assetRepo.update(assetId, { externalId });
        }

        results.push({ id: assetId, externalId, status: exportStatus });
      }

      return results;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`Digital twin export failed: ${detail}`, error instanceof Error ? error.stack : undefined);

      throw new ServiceUnavailableException(this.getExternalExportFailureMessage(detail));
    }
  }

  private getExternalExportFailureMessage(detail: string): string {
    const lowerDetail = detail.toLowerCase();
    const isConnectionIssue =
      lowerDetail.includes('ext_db_host') ||
      lowerDetail.includes('ext_s3_endpoint') ||
      lowerDetail.includes('econnrefused') ||
      lowerDetail.includes('enotfound') ||
      lowerDetail.includes('getaddrinfo') ||
      lowerDetail.includes('timed out') ||
      lowerDetail.includes('timeout') ||
      lowerDetail.includes('fetch failed') ||
      lowerDetail.includes('socket hang up');

    if (isConnectionIssue) {
      return '현재 디지털 트윈 서버에 연결할 수 없어 전송할 수 없습니다. 잠시 후 다시 시도해주세요.';
    }

    return '디지털 트윈 전송 중 서버 연결 오류가 발생했습니다. 잠시 후 다시 시도해주세요.';
  }

  async remove(id: number, userId: number): Promise<void> {
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

  private isDirectUploadAsset(asset: Asset, metadata = this.asMetadataRecord(asset.metadata)): boolean {
    if (metadata.uploadMode === 'direct') return true;
    if (metadata.uploadMode === 'convert') return false;

    return asset.status === AssetStatus.DONE && !!asset.outputObject && asset.outputObject === asset.sourceObject;
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

  private normalizeGenerationQuality(value: unknown): GenerationQuality | null {
    return typeof value === 'string' && GENERATION_QUALITIES.has(value as GenerationQuality)
      ? value as GenerationQuality
      : null;
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

  private getObjectExtension(objectName: string): string {
    return path.extname(objectName).replace('.', '').toLowerCase() || 'bin';
  }

  private getDownloadBaseName(name: string): string {
    return name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'asset';
  }

  private getAttachmentHeader(filename: string): string {
    return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
  }
}
