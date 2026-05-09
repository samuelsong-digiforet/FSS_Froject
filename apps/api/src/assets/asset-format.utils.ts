import * as path from 'path';
import { AssetType } from './entities/asset.entity';

export type AssetInputKind =
  | 'image'
  | 'image_bundle'
  | 'video'
  | 'point_cloud'
  | 'mesh'
  | 'cad'
  | 'archive'
  | 'unknown';

export type AssetContainerKind = 'file' | 'zip' | 'tar' | 'unknown';

export type AssetOutputProfile =
  | 'pointcloud_ply'
  | 'mesh_glb'
  | 'mesh_interop_bundle'
  | 'gaussian_ply'
  | 'nerf_render_bundle';

export interface DetectedInputFormat {
  extension: string;
  kind: AssetInputKind;
  container: AssetContainerKind;
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv']);
const POINT_CLOUD_EXTS = new Set(['.ply', '.pcd', '.las', '.laz', '.xyz', '.pts', '.ptx', '.e57']);
const CAD_EXTS = new Set(['.step', '.stp', '.iges', '.igs', '.brep']);
const MESH_EXTS = new Set(['.glb', '.gltf', '.obj', '.fbx', '.stl', '.dae', '.off', '.abc']);
const ZIP_EXTS = new Set(['.zip']);
const TAR_EXTS = new Set(['.tar', '.gz', '.tgz']);
const DIRECT_POINT_CLOUD_EXTS = new Set(['.ply']);
const DIRECT_MESH_EXTS = new Set(['.glb']);
const DIRECT_GAUSSIAN_EXTS = new Set(['.ply']);
const DIRECT_NERF_EXTS = new Set(['.zip']);

const OUTPUT_PROFILE_BY_TYPE: Record<AssetType, AssetOutputProfile[]> = {
  [AssetType.POINT_CLOUD]: ['pointcloud_ply'],
  [AssetType.NERF]: ['nerf_render_bundle'],
  [AssetType.GAUSSIAN]: ['gaussian_ply'],
  [AssetType.MESH]: ['mesh_glb', 'mesh_interop_bundle'],
};

export function normalizeExtension(fileName: string): string {
  return path.extname(fileName ?? '').toLowerCase();
}

export function detectInputFormat(sourceObject: string): DetectedInputFormat {
  const extension = normalizeExtension(sourceObject);

  if (ZIP_EXTS.has(extension)) {
    return { extension, kind: 'image_bundle', container: 'zip' };
  }
  if (TAR_EXTS.has(extension)) {
    return { extension, kind: 'archive', container: 'tar' };
  }
  if (VIDEO_EXTS.has(extension)) {
    return { extension, kind: 'video', container: 'file' };
  }
  if (POINT_CLOUD_EXTS.has(extension)) {
    return { extension, kind: 'point_cloud', container: 'file' };
  }
  if (CAD_EXTS.has(extension)) {
    return { extension, kind: 'cad', container: 'file' };
  }
  if (MESH_EXTS.has(extension)) {
    return { extension, kind: 'mesh', container: 'file' };
  }
  if (IMAGE_EXTS.has(extension)) {
    return { extension, kind: 'image', container: 'file' };
  }

  return { extension, kind: 'unknown', container: 'unknown' };
}

export function getSupportedOutputProfiles(assetType: AssetType): AssetOutputProfile[] {
  return OUTPUT_PROFILE_BY_TYPE[assetType];
}

export function isSupportedOutputProfile(assetType: AssetType, profile: string): profile is AssetOutputProfile {
  return getSupportedOutputProfiles(assetType).includes(profile as AssetOutputProfile);
}

export function getDefaultOutputProfile(
  assetType: AssetType,
  detectedInput?: DetectedInputFormat,
): AssetOutputProfile {
  switch (assetType) {
    case AssetType.POINT_CLOUD:
      return 'pointcloud_ply';
    case AssetType.NERF:
      return 'nerf_render_bundle';
    case AssetType.GAUSSIAN:
      return 'gaussian_ply';
    case AssetType.MESH:
      if (detectedInput?.kind === 'cad' || detectedInput?.kind === 'image_bundle' || detectedInput?.kind === 'video') {
        return 'mesh_interop_bundle';
      }
      return 'mesh_glb';
    default:
      return 'mesh_glb';
  }
}

export function isSupportedDirectUpload(assetType: AssetType, detectedInput: DetectedInputFormat): boolean {
  switch (assetType) {
    case AssetType.POINT_CLOUD:
      return DIRECT_POINT_CLOUD_EXTS.has(detectedInput.extension);
    case AssetType.MESH:
      return DIRECT_MESH_EXTS.has(detectedInput.extension);
    case AssetType.GAUSSIAN:
      return DIRECT_GAUSSIAN_EXTS.has(detectedInput.extension);
    case AssetType.NERF:
      return DIRECT_NERF_EXTS.has(detectedInput.extension);
    default:
      return false;
  }
}
