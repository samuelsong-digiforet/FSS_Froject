import api from './auth';

export type AssetType = 'point_cloud' | 'nerf' | 'gaussian' | 'mesh';
export type AssetStatus =
  | 'pending'
  | 'processing'
  | 'awaiting_crop'
  | 'done'
  | 'failed'
  | 'gpu_required';
export type AssetUploadMode = 'direct' | 'convert';
export type MeshInteropDownloadFormat = 'glb' | 'obj' | 'stl' | 'ply' | 'all';
export type GenerationQuality = 'fast' | 'normal' | 'precise';

export interface AssetObb {
  center: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

export interface AssetObbVersion {
  id: string;
  description: string;
  createdAt: string;
  obb: AssetObb;
  sceneObject?: string;
}

export interface AssetMetadata extends Record<string, unknown> {
  obbParams?: AssetObb;
  obbVersions?: AssetObbVersion[];
  representativeSceneObject?: string;
  uploadMode?: AssetUploadMode;
  generationQuality?: GenerationQuality;
  psnr?: number;
  ssim?: number;
  volumeRenderingAccuracy?: number;
}

export interface Asset {
  id: string;
  uuid: string;
  name: string;
  approved: boolean;
  description?: string;
  type: AssetType;
  status: AssetStatus;
  progress: number;
  sourceObject: string;
  previewObject?: string; // 1단계 fly PLY 경로
  outputObject?: string; // 2단계 풀 변환 결과 경로
  errorMessage?: string;
  metadata?: AssetMetadata;
  userId: string;
  categoryId?: number;
  category?: { id: number; name: string };
  createdAt: string;
  updatedAt: string;
  // API 응답에 포함되는 presigned URL
  url?: string;
  previewUrl?: string;
  outputUrl?: string;
}

// 변환 타입별 허용 파일 포맷
export const ASSET_TYPE_FORMATS: Record<AssetType, { exts: string[]; desc: string }> = {
  point_cloud: {
    exts: ['ply', 'pcd', 'las', 'laz', 'xyz', 'pts', 'e57', 'zip', 'mp4', 'mov'],
    desc: '포인트 클라우드 파일 (PLY, LAS 등) 또는 이미지 ZIP / 영상',
  },
  mesh: {
    exts: ['ply', 'glb', 'gltf', 'obj', 'fbx', 'stl', 'dae', 'step', 'stp', 'iges', 'igs', 'brep', 'zip', 'mp4', 'mov'],
    desc: '3D 메시 / CAD / 포인트 클라우드 파일 (PLY, GLB, OBJ, STEP 등) 또는 이미지 ZIP / 영상',
  },
  gaussian: {
    exts: ['zip', 'mp4', 'mov'],
    desc: '이미지 폴더 ZIP 또는 영상 파일 (ZIP, MP4, MOV)',
  },
  nerf: {
    exts: ['zip', 'mp4', 'mov'],
    desc: '이미지 폴더 ZIP 또는 영상 파일 (ZIP, MP4, MOV)',
  },
};

export const assetsApi = {
  getAll: (params?: { categoryId?: number }) => api.get<Asset[]>('/assets', { params }),
  getOne: (id: string) => api.get<Asset>(`/assets/${id}`),
  getOneByUuid: (uuid: string) => api.get<Asset>(`/assets/uuid/${uuid}`),
  create: (data: {
    name: string;
    description?: string;
    type: AssetType;
    sourceObject: string;
    categoryId?: number;
    outputProfile?: string;
    uploadMode?: AssetUploadMode;
  }) => api.post<Asset>('/assets', data),
  update: (
    id: string,
    data: {
      name?: string;
      description?: string;
      previewObject?: string;
      outputObject?: string;
      categoryId?: number | null;
      approved?: boolean;
      calibrationScale?: number;
      calibrationReferenceLength?: number;
      calibrationMeasuredLength?: number;
      representativeSceneObject?: string | null;
      volumeRenderingAccuracy?: number;
    },
  ) => api.patch<Asset>(`/assets/${id}`, data),
  remove: (id: string) => api.delete(`/assets/${id}`),
  getVersions: (id: string) => api.get<AssetObbVersion[]>(`/assets/${id}/versions`),
  createVersion: (id: string, data: AssetObb & { description?: string; sceneObject?: string }) =>
    api.post<Asset>(`/assets/${id}/versions`, data),
  updateVersion: (id: string, versionId: string, data: AssetObb & { description?: string }) =>
    api.patch<Asset>(`/assets/${id}/versions/${versionId}`, data),
  removeVersion: (id: string, versionId: string) => api.delete<Asset>(`/assets/${id}/versions/${versionId}`),
  resumeStage2: (
    id: string,
    params: {
      obbCenter?: number[];
      obbRotation?: number[];
      obbScale?: number[];
      previewCenter?: number[];
      previewBounds?: number[];
    },
  ) => api.post<Asset>(`/assets/${id}/resume`, params),
  regenerate: (id: string, qualityPreset: GenerationQuality) =>
    api.post<Asset>(`/assets/${id}/regenerate`, { qualityPreset }),
  clone: (id: string, qualityPreset: GenerationQuality) =>
    api.post<Asset>(`/assets/${id}/clone`, { qualityPreset }),
  downloadMeshArtifact: (id: string, format: MeshInteropDownloadFormat) =>
    api.get<Blob>(`/assets/${id}/download`, { params: { format }, responseType: 'blob' }),
  rename: (id: string, name: string) => api.patch<Asset>(`/assets/${id}/rename`, { name }),
  toggleApproval: (id: string) => api.patch<Asset>(`/assets/${id}/approval`),
  getStreamUrl: (objectName: string): string => `/api/uploads/stream/${objectName}`,
  getNerfFrames: (id: string) => api.get<{ count: number; paths: string[] }>(`/assets/${id}/nerf-frames`),
  getNerfFrameUrl: (id: string, framePath: string): string =>
    `/api/assets/${id}/nerf-frame?path=${encodeURIComponent(framePath)}`,
  upload: (file: File, onProgress?: (pct: number) => void) => {
    const form = new FormData();
    form.append('file', file);
    return api.post<{ objectName: string; originalName: string; size: number; mimetype: string; url: string }>(
      '/uploads',
      form,
      {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (e: { total?: number; loaded: number }) => {
          if (onProgress && e.total) onProgress(Math.round((e.loaded * 100) / e.total));
        },
      },
    );
  },
};

export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  point_cloud: '포인트 클라우드',
  nerf: 'NeRF',
  gaussian: '3D 가우시안 스플래팅',
  mesh: '메시',
};

export const ASSET_STATUS_LABELS: Record<AssetStatus, string> = {
  pending: '대기',
  processing: '처리 중',
  awaiting_crop: '영역 선택 대기',
  done: '완료',
  failed: '실패',
  gpu_required: 'GPU 필요',
};

export const ASSET_STATUS_COLORS: Record<AssetStatus, string> = {
  pending: 'bg-gray-100 text-gray-600',
  processing: 'bg-blue-100 text-blue-600',
  awaiting_crop: 'bg-orange-100 text-orange-700',
  done: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-600',
  gpu_required: 'bg-purple-100 text-purple-700',
};
