import type { Asset, AssetType } from './assets';

export type AssetOutputProfile =
  | 'pointcloud_ply'
  | 'mesh_glb'
  | 'mesh_interop_bundle'
  | 'gaussian_ply'
  | 'nerf_render_bundle';

export type AssetInputKind =
  | 'image'
  | 'image_bundle'
  | 'video'
  | 'point_cloud'
  | 'mesh'
  | 'cad'
  | 'archive'
  | 'unknown';

export interface InputFormatInfo {
  extension: string;
  kind: AssetInputKind;
  container: 'file' | 'zip' | 'tar' | 'unknown';
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv']);
const POINT_CLOUD_EXTS = new Set(['.ply', '.pcd', '.las', '.laz', '.xyz', '.pts', '.ptx', '.e57']);
const CAD_EXTS = new Set(['.step', '.stp', '.iges', '.igs', '.brep']);
const MESH_EXTS = new Set(['.glb', '.gltf', '.obj', '.fbx', '.stl', '.dae', '.off', '.abc']);
const ZIP_EXTS = new Set(['.zip']);
const TAR_EXTS = new Set(['.tar', '.gz', '.tgz']);

export const INPUT_KIND_LABELS: Record<AssetInputKind, string> = {
  image: 'single image',
  image_bundle: 'image bundle',
  video: 'video',
  point_cloud: 'point cloud',
  mesh: 'mesh',
  cad: 'cad',
  archive: 'archive',
  unknown: 'unknown',
};

export const OUTPUT_PROFILE_LABELS: Record<AssetOutputProfile, string> = {
  pointcloud_ply: 'Point Cloud PLY',
  mesh_glb: 'Viewer GLB',
  mesh_interop_bundle: 'Interop ZIP Bundle',
  gaussian_ply: 'Gaussian PLY',
  nerf_render_bundle: 'Render ZIP Bundle',
};

export const OUTPUT_PROFILE_DESCRIPTIONS: Record<AssetOutputProfile, string> = {
  pointcloud_ply: 'Exports a single PLY file for point-cloud tools.',
  mesh_glb: 'Exports a single GLB file optimized for viewer playback.',
  mesh_interop_bundle: 'Exports a ZIP bundle with multiple interoperable mesh formats.',
  gaussian_ply: 'Exports a Gaussian splat PLY result.',
  nerf_render_bundle: 'Exports a ZIP bundle with render.mp4 and extracted PNG frames.',
};

export const OUTPUT_PROFILE_ARTIFACTS: Record<AssetOutputProfile, string[]> = {
  pointcloud_ply: ['output.ply'],
  mesh_glb: ['output.glb'],
  mesh_interop_bundle: ['output.glb', 'output.obj', 'output.stl', 'output.ply', 'output.zip'],
  gaussian_ply: ['output.ply'],
  nerf_render_bundle: ['render.mp4', 'frames/*.png', 'output.zip'],
};

export const OUTPUT_PROFILE_OPTIONS_BY_TYPE: Record<AssetType, AssetOutputProfile[]> = {
  point_cloud: ['pointcloud_ply'],
  nerf: ['nerf_render_bundle'],
  gaussian: ['gaussian_ply'],
  mesh: ['mesh_glb', 'mesh_interop_bundle'],
};

function normalizeExtension(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  return idx >= 0 ? fileName.slice(idx).toLowerCase() : '';
}

export function detectInputFormatFromName(fileName: string): InputFormatInfo {
  const extension = normalizeExtension(fileName);

  if (ZIP_EXTS.has(extension)) return { extension, kind: 'image_bundle', container: 'zip' };
  if (TAR_EXTS.has(extension)) return { extension, kind: 'archive', container: 'tar' };
  if (VIDEO_EXTS.has(extension)) return { extension, kind: 'video', container: 'file' };
  if (POINT_CLOUD_EXTS.has(extension)) return { extension, kind: 'point_cloud', container: 'file' };
  if (CAD_EXTS.has(extension)) return { extension, kind: 'cad', container: 'file' };
  if (MESH_EXTS.has(extension)) return { extension, kind: 'mesh', container: 'file' };
  if (IMAGE_EXTS.has(extension)) return { extension, kind: 'image', container: 'file' };

  return { extension, kind: 'unknown', container: 'unknown' };
}

export function getOutputProfilesForType(assetType: AssetType): AssetOutputProfile[] {
  return OUTPUT_PROFILE_OPTIONS_BY_TYPE[assetType];
}

export function getDefaultOutputProfile(assetType: AssetType, fileName?: string): AssetOutputProfile {
  const detected = fileName ? detectInputFormatFromName(fileName) : undefined;

  switch (assetType) {
    case 'point_cloud':
      return 'pointcloud_ply';
    case 'nerf':
      return 'nerf_render_bundle';
    case 'gaussian':
      return 'gaussian_ply';
    case 'mesh':
      if (detected?.kind === 'cad' || detected?.kind === 'image_bundle' || detected?.kind === 'video') {
        return 'mesh_interop_bundle';
      }
      return 'mesh_glb';
    default:
      return 'mesh_glb';
  }
}

export function getAssetOutputProfile(asset: Asset): AssetOutputProfile {
  const raw = asset.metadata?.outputProfile;
  const options = getOutputProfilesForType(asset.type);
  if (typeof raw === 'string' && options.includes(raw as AssetOutputProfile)) {
    return raw as AssetOutputProfile;
  }
  return getDefaultOutputProfile(asset.type, asset.sourceObject);
}

export function getAssetInputFormat(asset: Asset): InputFormatInfo {
  const rawExtension = typeof asset.metadata?.inputFormat === 'string' ? asset.metadata.inputFormat : undefined;
  const rawKind = typeof asset.metadata?.inputKind === 'string' ? asset.metadata.inputKind as AssetInputKind : undefined;
  const rawContainer = typeof asset.metadata?.inputContainer === 'string'
    ? asset.metadata.inputContainer as InputFormatInfo['container']
    : undefined;

  if (rawExtension || rawKind || rawContainer) {
    return {
      extension: rawExtension ?? detectInputFormatFromName(asset.sourceObject).extension,
      kind: rawKind ?? detectInputFormatFromName(asset.sourceObject).kind,
      container: rawContainer ?? detectInputFormatFromName(asset.sourceObject).container,
    };
  }

  return detectInputFormatFromName(asset.sourceObject);
}
