import { assetsApi, type Asset, type MeshInteropDownloadFormat } from '@/api/assets';
import { getAssetOutputProfile } from '@/api/assetProfiles';

function getFileExtension(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

function toSafeAssetName(assetName: string): string {
  return assetName.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'asset';
}

export function getAssetDownloadName(assetName: string, objectKey?: string | null): string {
  const safeAssetName = toSafeAssetName(assetName);
  const ext = getFileExtension(objectKey ?? '');
  if (!ext) return safeAssetName;
  return safeAssetName.toLowerCase().endsWith(`.${ext}`) ? safeAssetName : `${safeAssetName}.${ext}`;
}

function getMeshDownloadName(assetName: string, format: MeshInteropDownloadFormat): string {
  const safeAssetName = toSafeAssetName(assetName);
  const ext = format === 'all' ? 'zip' : format;
  return safeAssetName.toLowerCase().endsWith(`.${ext}`) ? safeAssetName : `${safeAssetName}.${ext}`;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function isMeshInteropZipAsset(asset: Asset): boolean {
  return !!asset.outputObject
    && getFileExtension(asset.outputObject) === 'zip'
    && getAssetOutputProfile(asset) === 'mesh_interop_bundle';
}

export function supportsMeshFormatDownload(asset: Asset | null | undefined): boolean {
  if (!asset || asset.type !== 'mesh' || !asset.outputObject) return false;
  return isMeshInteropZipAsset(asset);
}

export async function downloadMeshAssetFormat(asset: Asset, format: MeshInteropDownloadFormat): Promise<void> {
  if (!asset.outputObject) {
    throw new Error('No mesh output file is available.');
  }

  if (!supportsMeshFormatDownload(asset)) {
    throw new Error('This mesh result does not support format selection.');
  }

  const { data } = await assetsApi.downloadMeshArtifact(asset.id, format);
  downloadBlob(data, getMeshDownloadName(asset.name, format));
}
