import * as THREE from 'three';

import { assetsApi, type Asset, type MeshInteropDownloadFormat } from '@/api/assets';
import { getAssetOutputProfile } from '@/api/assetProfiles';

const SUPPORTED_MESH_SOURCE_EXTENSIONS = new Set(['glb', 'obj', 'stl', 'ply']);
const ZIP_HEADER_LOCAL = 0x04034b50;
const ZIP_HEADER_CENTRAL = 0x02014b50;
const ZIP_HEADER_END = 0x06054b50;
const ZIP_VERSION = 20;
const ZIP_STORE_METHOD = 0;
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }

  return table;
})();

type MeshDownloadEntry = {
  blob: Blob;
  name: string;
};

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
  if (isMeshInteropZipAsset(asset)) return true;
  return SUPPORTED_MESH_SOURCE_EXTENSIONS.has(getFileExtension(asset.outputObject));
}

async function fetchAssetBlob(objectKey: string): Promise<Blob> {
  const token = localStorage.getItem('token');
  const headers: HeadersInit = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(assetsApi.getStreamUrl(objectKey), { headers });
  if (!response.ok) {
    throw new Error(`Mesh source download failed: HTTP ${response.status}`);
  }

  return await response.blob();
}

function copyArrayBuffer(value: ArrayBuffer | ArrayBufferView | unknown, errorMessage: string): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    const copy = new Uint8Array(value.byteLength);
    copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return copy.buffer;
  }
  throw new Error(errorMessage);
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

async function loadMeshGroup(blob: Blob, extension: string): Promise<THREE.Group> {
  switch (extension) {
    case 'glb': {
      const arrayBuffer = await blob.arrayBuffer();
      const mod = await import('three/addons/loaders/GLTFLoader.js').catch(
        () => import('three/examples/jsm/loaders/GLTFLoader.js'),
      );
      const loader = new mod.GLTFLoader();
      return await new Promise<THREE.Group>((resolve, reject) => {
        loader.parse(
          arrayBuffer,
          '',
          (gltf: { scene?: THREE.Group }) => {
            if (!gltf.scene) {
              reject(new Error('GLB scene could not be loaded.'));
              return;
            }
            resolve(gltf.scene);
          },
          (error: unknown) => reject(error),
        );
      });
    }
    case 'obj': {
      const text = await blob.text();
      const mod = await import('three/addons/loaders/OBJLoader.js').catch(
        () => import('three/examples/jsm/loaders/OBJLoader.js'),
      );
      const loader = new mod.OBJLoader();
      return loader.parse(text);
    }
    case 'stl': {
      const arrayBuffer = await blob.arrayBuffer();
      const mod = await import('three/addons/loaders/STLLoader.js').catch(
        () => import('three/examples/jsm/loaders/STLLoader.js'),
      );
      const loader = new mod.STLLoader();
      const geometry = loader.parse(arrayBuffer);
      if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
      const group = new THREE.Group();
      group.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xd1d5db })));
      return group;
    }
    case 'ply': {
      const arrayBuffer = await blob.arrayBuffer();
      const mod = await import('three/addons/loaders/PLYLoader.js').catch(
        () => import('three/examples/jsm/loaders/PLYLoader.js'),
      );
      const loader = new mod.PLYLoader();
      const geometry = loader.parse(arrayBuffer);
      if (!geometry.getAttribute('normal') && geometry.getAttribute('position')) geometry.computeVertexNormals();
      const group = new THREE.Group();
      group.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xd1d5db })));
      return group;
    }
    default:
      throw new Error('Unsupported mesh source format.');
  }
}

function cloneSceneForExport(source: THREE.Group): THREE.Group {
  const cloned = source.clone(true);
  cloned.updateMatrixWorld(true);
  return cloned;
}

async function exportGlb(root: THREE.Group): Promise<Blob> {
  const mod = await import('three/addons/exporters/GLTFExporter.js').catch(
    () => import('three/examples/jsm/exporters/GLTFExporter.js'),
  );
  const exporter = new mod.GLTFExporter();
  const result = await new Promise<ArrayBuffer>((resolve, reject) => {
    exporter.parse(
      cloneSceneForExport(root),
      (value: ArrayBuffer | ArrayBufferView | unknown) => {
        try {
          resolve(copyArrayBuffer(value, 'GLB export failed.'));
        } catch (error) {
          reject(error);
        }
      },
      (error: unknown) => reject(error),
      { binary: true },
    );
  });
  return new Blob([result], { type: 'model/gltf-binary' });
}

async function exportObj(root: THREE.Group): Promise<Blob> {
  const mod = await import('three/addons/exporters/OBJExporter.js').catch(
    () => import('three/examples/jsm/exporters/OBJExporter.js'),
  );
  const exporter = new mod.OBJExporter();
  return new Blob([exporter.parse(cloneSceneForExport(root))], { type: 'text/plain;charset=utf-8' });
}

async function exportStl(root: THREE.Group): Promise<Blob> {
  const mod = await import('three/addons/exporters/STLExporter.js').catch(
    () => import('three/examples/jsm/exporters/STLExporter.js'),
  );
  const exporter = new mod.STLExporter();
  const result = exporter.parse(cloneSceneForExport(root), { binary: true });
  return new Blob([copyArrayBuffer(result, 'STL export failed.')], { type: 'model/stl' });
}

function exportPly(root: THREE.Group): Blob {
  const vertices: number[] = [];
  const faces: number[] = [];
  let vertexOffset = 0;

  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const geometry = child.geometry.clone();
    geometry.applyMatrix4(child.matrixWorld);
    const positions = geometry.getAttribute('position');
    if (!positions) return;

    for (let index = 0; index < positions.count; index += 1) {
      vertices.push(positions.getX(index), positions.getY(index), positions.getZ(index));
    }

    if (geometry.index) {
      for (let index = 0; index < geometry.index.count; index += 3) {
        faces.push(
          geometry.index.getX(index) + vertexOffset,
          geometry.index.getX(index + 1) + vertexOffset,
          geometry.index.getX(index + 2) + vertexOffset,
        );
      }
    } else {
      for (let index = 0; index < positions.count; index += 3) {
        faces.push(index + vertexOffset, index + 1 + vertexOffset, index + 2 + vertexOffset);
      }
    }

    vertexOffset += positions.count;
  });

  if (vertices.length === 0) {
    throw new Error('No mesh data is available for PLY export.');
  }

  const vertexCount = vertices.length / 3;
  const faceCount = faces.length / 3;
  const header = [
    'ply',
    'format binary_little_endian 1.0',
    `element vertex ${vertexCount}`,
    'property float x',
    'property float y',
    'property float z',
    `element face ${faceCount}`,
    'property list uchar int vertex_indices',
    'end_header',
    '',
  ].join('\n');

  const headerBytes = new TextEncoder().encode(header);
  const vertexBytes = new ArrayBuffer(vertexCount * 12);
  const vertexView = new DataView(vertexBytes);
  for (let index = 0; index < vertices.length; index += 1) {
    vertexView.setFloat32(index * 4, vertices[index], true);
  }

  const faceBytes = new ArrayBuffer(faceCount * 13);
  const faceView = new DataView(faceBytes);
  for (let index = 0; index < faceCount; index += 1) {
    const offset = index * 13;
    faceView.setUint8(offset, 3);
    faceView.setInt32(offset + 1, faces[index * 3], true);
    faceView.setInt32(offset + 5, faces[index * 3 + 1], true);
    faceView.setInt32(offset + 9, faces[index * 3 + 2], true);
  }

  return new Blob([headerBytes, vertexBytes, faceBytes], { type: 'application/octet-stream' });
}

async function exportMeshFormat(root: THREE.Group, format: Exclude<MeshInteropDownloadFormat, 'all'>): Promise<Blob> {
  switch (format) {
    case 'glb':
      return exportGlb(root);
    case 'obj':
      return exportObj(root);
    case 'stl':
      return exportStl(root);
    case 'ply':
      return exportPly(root);
    default:
      throw new Error('Unsupported mesh download format.');
  }
}

function crc32(data: Uint8Array): number {
  let value = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    value = CRC32_TABLE[(value ^ data[index]) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function getDosDateTime(date: Date): { date: number; time: number } {
  const year = Math.max(date.getFullYear(), 1980);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  return {
    date: ((year - 1980) << 9) | (month << 5) | day,
    time: (hours << 11) | (minutes << 5) | seconds,
  };
}

async function buildZip(entries: MeshDownloadEntry[]): Promise<Blob> {
  const encoder = new TextEncoder();
  const parts: ArrayBuffer[] = [];
  const centralDirectory: ArrayBuffer[] = [];
  const timestamp = getDosDateTime(new Date());
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = new Uint8Array(await entry.blob.arrayBuffer());
    const checksum = crc32(data);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, ZIP_HEADER_LOCAL, true);
    localView.setUint16(4, ZIP_VERSION, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, ZIP_STORE_METHOD, true);
    localView.setUint16(10, timestamp.time, true);
    localView.setUint16(12, timestamp.date, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, ZIP_HEADER_CENTRAL, true);
    centralView.setUint16(4, ZIP_VERSION, true);
    centralView.setUint16(6, ZIP_VERSION, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, ZIP_STORE_METHOD, true);
    centralView.setUint16(12, timestamp.time, true);
    centralView.setUint16(14, timestamp.date, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);

    parts.push(toArrayBuffer(localHeader), toArrayBuffer(data));
    centralDirectory.push(toArrayBuffer(centralHeader));
    offset += localHeader.length + data.length;
  }

  const centralSize = centralDirectory.reduce((total, record) => total + record.byteLength, 0);
  const endHeader = new Uint8Array(22);
  const endView = new DataView(endHeader.buffer);
  endView.setUint32(0, ZIP_HEADER_END, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);

  return new Blob([...parts, ...centralDirectory, toArrayBuffer(endHeader)], { type: 'application/zip' });
}

async function buildMeshDownloadEntries(asset: Asset, sourceBlob: Blob, sourceExtension: string): Promise<MeshDownloadEntry[]> {
  const scene = await loadMeshGroup(sourceBlob, sourceExtension);
  scene.updateMatrixWorld(true);

  const downloadFormats: Exclude<MeshInteropDownloadFormat, 'all'>[] = ['glb', 'obj', 'stl', 'ply'];

  return await Promise.all(downloadFormats.map(async (format) => ({
    blob: sourceExtension === format ? sourceBlob : await exportMeshFormat(scene, format),
    name: getMeshDownloadName(asset.name, format),
  })));
}

export async function downloadMeshAssetFormat(asset: Asset, format: MeshInteropDownloadFormat): Promise<void> {
  if (!asset.outputObject) {
    throw new Error('No mesh output file is available.');
  }

  if (!supportsMeshFormatDownload(asset)) {
    throw new Error('This mesh result does not support format selection.');
  }

  if (isMeshInteropZipAsset(asset)) {
    const { data } = await assetsApi.downloadMeshArtifact(asset.id, format);
    downloadBlob(data, getMeshDownloadName(asset.name, format));
    return;
  }

  const sourceExtension = getFileExtension(asset.outputObject);
  const sourceBlob = await fetchAssetBlob(asset.outputObject);

  if (format !== 'all' && sourceExtension === format) {
    downloadBlob(sourceBlob, getMeshDownloadName(asset.name, format));
    return;
  }

  if (format === 'all') {
    const entries = await buildMeshDownloadEntries(asset, sourceBlob, sourceExtension);
    const archive = await buildZip(entries);
    downloadBlob(archive, getMeshDownloadName(asset.name, 'all'));
    return;
  }

  const scene = await loadMeshGroup(sourceBlob, sourceExtension);
  scene.updateMatrixWorld(true);
  const converted = await exportMeshFormat(scene, format);
  downloadBlob(converted, getMeshDownloadName(asset.name, format));
}
