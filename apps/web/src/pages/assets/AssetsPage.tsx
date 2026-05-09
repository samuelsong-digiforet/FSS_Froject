import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  assetsApi,
  type Asset,
  type AssetObb,
  type AssetObbVersion,
  type MeshInteropDownloadFormat,
  type AssetStatus,
  type AssetType,
  type AssetUploadMode,
  ASSET_STATUS_COLORS,
  ASSET_STATUS_LABELS,
  ASSET_TYPE_FORMATS,
  ASSET_TYPE_LABELS,
} from '@/api/assets';
import {
  type AssetOutputProfile,
  detectInputFormatFromName,
  getAssetInputFormat,
  getAssetOutputProfile,
  getDefaultOutputProfile,
  getOutputProfilesForType,
  INPUT_KIND_LABELS,
  OUTPUT_PROFILE_ARTIFACTS,
  OUTPUT_PROFILE_DESCRIPTIONS,
  OUTPUT_PROFILE_LABELS,
} from '@/api/assetProfiles';
import { assetCategoriesApi, type AssetCategory } from '@/api/assetCategories';
import { usePermission } from '@/hooks/usePermission';
import type { ObbBox } from '@/components/ModelViewer';
import { downloadMeshAssetFormat, getAssetDownloadName, supportsMeshFormatDownload } from '@/utils/meshDownloads';

const ModelViewer = lazy(() => import('@/components/ModelViewer'));
const MeshCropEditor = lazy(() => import('@/components/MeshCropEditor'));
const NerfFrameCarousel = lazy(() => import('@/components/NerfFrameCarousel'));

type ModalType = 'none' | 'create' | 'detail' | 'delete' | 'edit' | 'texture';
type FileKind = 'image' | 'video' | 'model' | 'pointcloud' | 'zip' | 'other';
type StoredObb = { center: [string, string, string]; rotation: [string, string, string]; scale: [string, string, string] };
type ResumeOverride = { center: number[]; rotation: number[]; scale: number[]; previewCenter?: number[]; previewBounds?: number[] } | null | undefined;

const ASSET_TYPES: AssetType[] = ['point_cloud', 'nerf', 'gaussian', 'mesh'];
const POLLABLE: AssetStatus[] = ['pending', 'processing', 'preview_ready'];
const DEFAULT_STORED_OBB: StoredObb = {
  center: ['0', '0', '0'],
  rotation: ['0', '0', '0'],
  scale: ['1', '1', '1'],
};
const inputCls = `w-full border border-gray-300 rounded-xl px-4 py-2.5 text-sm bg-white focus:outline-none focus:border-blue-500`;
const UPLOAD_MODE_LABELS: Record<AssetUploadMode, string> = {
  direct: '일반 업로드',
  convert: '변환 필요 업로드',
};
const UPLOAD_MODE_DESCRIPTIONS: Record<AssetUploadMode, string> = {
  direct: '변환이 끝난 파일을 바로 등록해서 업로드 직후 미리보기와 편집을 사용할 수 있습니다.',
  convert: '원본 파일을 업로드하고 서버에서 변환 파이프라인을 실행합니다.',
};
const DIRECT_UPLOAD_FORMAT = {
  exts: ['glb', 'ply', 'zip'],
  desc: 'GLB, PLY, ZIP 결과 파일을 올리면 파일 구조를 보고 타입을 자동 판별합니다.',
};
const LOCAL_VERSION_KEY_PREFIX = 'obb_versions_';
const MESH_DOWNLOAD_FORMATS: Exclude<MeshInteropDownloadFormat, 'all'>[] = ['glb', 'obj', 'stl', 'ply'];

function getFileExtension(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

function getUploadFormatConfig(type: AssetType, uploadMode: AssetUploadMode) {
  return uploadMode === 'direct' ? DIRECT_UPLOAD_FORMAT : ASSET_TYPE_FORMATS[type];
}

function isAllowedUploadFile(type: AssetType, uploadMode: AssetUploadMode, fileName: string): boolean {
  return getUploadFormatConfig(type, uploadMode).exts.includes(getFileExtension(fileName));
}

function formatExtensions(exts: string[]): string {
  return exts.map((ext) => `.${ext}`).join(', ');
}

async function inferDirectAssetType(file: File): Promise<AssetType | null> {
  const ext = getFileExtension(file.name);

  if (ext === 'glb') return 'mesh';
  if (ext === 'zip') return 'nerf';
  if (ext !== 'ply') return null;

  try {
    const buffer = await file.slice(0, 128 * 1024).arrayBuffer();
    const text = new TextDecoder().decode(buffer);
    const headerEnd = text.indexOf('end_header');
    const header = (headerEnd >= 0 ? text.slice(0, headerEnd) : text).toLowerCase();
    const gaussianMarkers = ['f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0'];

    if (gaussianMarkers.some((marker) => header.includes(marker))) {
      return 'gaussian';
    }

    return 'point_cloud';
  } catch {
    return null;
  }
}

function getFileType(name: string): FileKind {
  const ext = getFileExtension(name);
  if (['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'avi', 'mkv'].includes(ext)) return 'video';
  if (['glb', 'gltf', 'obj', 'stl', 'fbx', 'dae'].includes(ext)) return 'model';
  if (['ply', 'pcd', 'las', 'laz', 'xyz', 'pts', 'ptx', 'e57'].includes(ext)) return 'pointcloud';
  if (ext === 'zip') return 'zip';
  return 'other';
}

function getBestPreviewObject(asset: Asset): string | undefined {
  const repScene = asset.metadata?.representativeSceneObject;
  if (repScene) {
    const ft = getFileType(repScene);
    if (ft !== 'other' && ft !== 'zip') return repScene;
  }
  if (asset.status === 'done' && asset.outputObject) {
    const ft = getFileType(asset.outputObject);
    if (ft !== 'other' && ft !== 'zip') return asset.outputObject;
  }
  if (asset.previewObject) return asset.previewObject;
  const ext = asset.sourceObject.split('.').pop()?.toLowerCase() ?? '';
  return ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff', 'mp4', 'mov', 'avi', 'mkv'].includes(ext) ? asset.sourceObject : undefined;
}

function getBestEditorObject(asset: Asset): string | undefined {
  return [asset.status === 'done' ? asset.outputObject : undefined, asset.previewObject]
    .filter((value): value is string => !!value)
    .find((value) => ['ply', 'glb', 'gltf'].includes(value.split('.').pop()?.toLowerCase() ?? ''));
}

function getObjectDisplayName(objectKey?: string | null): string {
  if (!objectKey) return '-';
  const filename = objectKey.split('/').filter(Boolean).pop() ?? objectKey;
  try {
    return decodeURIComponent(filename);
  } catch {
    return filename;
  }
}

function getCategoryDisplayName(asset: Asset | null | undefined, categories: AssetCategory[]): string {
  if (!asset) return '-';
  if (asset.category?.name) return asset.category.name;
  if (asset.categoryId) {
    return categories.find((category) => category.id === asset.categoryId)?.name ?? '-';
  }
  return '-';
}

function getPreviewCenterFromMetadata(asset: Asset | null): [number, number, number] | undefined {
  const raw = asset?.metadata?.previewCenter;
  if (!Array.isArray(raw) || raw.length < 3) return undefined;

  const values = raw.slice(0, 3).map((value) => Number(value));
  if (values.some((value) => !Number.isFinite(value))) return undefined;

  return [values[0], values[1], values[2]];
}

function getPreviewBoundsFromMetadata(asset: Asset | null): [number, number, number] | undefined {
  const raw = asset?.metadata?.previewBounds;
  if (!Array.isArray(raw) || raw.length < 3) return undefined;

  const values = raw.slice(0, 3).map((value) => Number(value));
  if (values.some((value) => !Number.isFinite(value))) return undefined;

  return [values[0], values[1], values[2]];
}

function getCalibrationScaleFromMetadata(asset: Asset | null): number {
  const raw = Number(asset?.metadata?.calibrationScale);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

function getCalibrationReferenceLengthFromMetadata(asset: Asset | null): number | undefined {
  const raw = Number(asset?.metadata?.calibrationReferenceLength);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('ko-KR', { hour12: false }).replace(/\. /g, '-').replace('.', '');
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function loadObb(id: string): StoredObb | null {
  try {
    const raw = localStorage.getItem(`obb_params_${id}`);
    return raw ? (JSON.parse(raw) as StoredObb) : null;
  } catch {
    return null;
  }
}

function saveObb(id: string, obb: StoredObb): void {
  localStorage.setItem(`obb_params_${id}`, JSON.stringify(obb));
}

function loadLocalVersions(id: string): AssetObbVersion[] {
  try {
    const raw = localStorage.getItem(`${LOCAL_VERSION_KEY_PREFIX}${id}`);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return null;

        const record = item as Record<string, unknown>;
        const obb = parseAssetObb(record.obb);
        if (!obb) return null;

        return {
          id: typeof record.id === 'string' ? record.id : crypto.randomUUID(),
          description: typeof record.description === 'string' ? record.description : '',
          createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
          obb,
        } satisfies AssetObbVersion;
      })
      .filter((item): item is AssetObbVersion => !!item)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  } catch {
    return [];
  }
}

function saveLocalVersions(id: string, versions: AssetObbVersion[]): void {
  localStorage.setItem(`${LOCAL_VERSION_KEY_PREFIX}${id}`, JSON.stringify(versions));
}

function parseObbTriplet(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) return null;

  const parsed = value.slice(0, 3).map((item) => Number(item));
  if (parsed.some((item) => !Number.isFinite(item))) return null;

  return [parsed[0], parsed[1], parsed[2]];
}

function parseAssetObb(value: unknown): AssetObb | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const center = parseObbTriplet(record.center);
  const rotation = parseObbTriplet(record.rotation);
  const scale = parseObbTriplet(record.scale);
  if (!center || !rotation || !scale) return null;

  return { center, rotation, scale };
}

function toStoredObb(obb: AssetObb): StoredObb {
  return {
    center: obb.center.map((value) => String(value)) as StoredObb['center'],
    rotation: obb.rotation.map((value) => String(value)) as StoredObb['rotation'],
    scale: obb.scale.map((value) => String(value)) as StoredObb['scale'],
  };
}

function toAssetObb(stored: StoredObb): AssetObb {
  return {
    center: stored.center.map(Number) as [number, number, number],
    rotation: stored.rotation.map(Number) as [number, number, number],
    scale: stored.scale.map(Number) as [number, number, number],
  };
}

function getAssetObbVersions(asset: Asset | null | undefined): AssetObbVersion[] {
  const raw = asset?.metadata?.obbVersions;
  if (!Array.isArray(raw)) return [];

  return raw
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;

      const record = item as unknown as Record<string, unknown>;
      const obb = parseAssetObb(record.obb);
      if (!obb) return null;

      return {
        id: typeof record.id === 'string' ? record.id : crypto.randomUUID(),
        description: typeof record.description === 'string' ? record.description : '',
        createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date(0).toISOString(),
        obb,
        ...(typeof record.sceneObject === 'string' && record.sceneObject ? { sceneObject: record.sceneObject } : {}),
      } satisfies AssetObbVersion;
    })
    .filter((item): item is AssetObbVersion => !!item)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function getStoredObbFromAsset(asset: Asset | null | undefined): StoredObb | null {
  const latestVersion = getAssetObbVersions(asset)[0];
  if (latestVersion) return toStoredObb(latestVersion.obb);

  const obb = parseAssetObb(asset?.metadata?.obbParams);
  return obb ? toStoredObb(obb) : null;
}

function mergeVersions(primary: AssetObbVersion[], secondary: AssetObbVersion[] = []): AssetObbVersion[] {
  const map = new Map<string, AssetObbVersion>();

  [...primary, ...secondary].forEach((version) => {
    if (!map.has(version.id)) {
      map.set(version.id, version);
    }
  });

  return [...map.values()].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function createInitialVersion(asset: Asset, obb: AssetObb): AssetObbVersion {
  return {
    id: `initial-${asset.id}`,
    description: '초기 상태',
    createdAt: asset.updatedAt || asset.createdAt,
    obb,
  };
}

function getInitialVersionsForAsset(asset: Asset, fallbackObb: AssetObb): AssetObbVersion[] {
  const merged = mergeVersions(getAssetObbVersions(asset), loadLocalVersions(asset.id));
  if (merged.length > 0) return merged;
  return [createInitialVersion(asset, fallbackObb)];
}

function isNotFoundError(error: unknown): boolean {
  return (error as { response?: { status?: number } })?.response?.status === 404;
}

function Modal({
  title,
  onClose,
  children,
  wide = false,
  zClass = 'z-50',
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  zClass?: string;
}) {
  return (
    <div className={`fixed inset-0 ${zClass} bg-black/60 p-4 flex items-center justify-center`}>
      <div className={`w-full ${wide ? 'max-w-6xl' : 'max-w-2xl'} max-h-[90vh] bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col`}>
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <button type="button" onClick={onClose} className="w-9 h-9 rounded-full border border-gray-200 text-gray-500 hover:text-gray-700">×</button>
        </div>
        <div className="overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: AssetStatus }) {
  return <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-medium ${ASSET_STATUS_COLORS[status]}`}>{ASSET_STATUS_LABELS[status]}</span>;
}

export default function AssetsPage() {
  const perm = usePermission('asset_manage');
  const [assets, setAssets] = useState<Asset[]>([]);
  const [categories, setCategories] = useState<AssetCategory[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | undefined>();
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [alert, setAlert] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalType>('none');
  const [selected, setSelected] = useState<Asset | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Asset | null>(null);
  const [form, setForm] = useState<{ name: string; description: string; type: AssetType; categoryId: string; outputProfile: AssetOutputProfile; uploadMode: AssetUploadMode }>({
    name: '',
    description: '',
    type: 'point_cloud',
    categoryId: '',
    outputProfile: getDefaultOutputProfile('point_cloud'),
    uploadMode: 'convert',
  });
  const [formError, setFormError] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [directDetectedType, setDirectDetectedType] = useState<AssetType | null>(null);
  const [directDetecting, setDirectDetecting] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [obbCenter, setObbCenter] = useState<[string, string, string]>(['0', '0', '0']);
  const [obbRotation, setObbRotation] = useState<[string, string, string]>(['0', '0', '0']);
  const [obbScale, setObbScale] = useState<[string, string, string]>(['1', '1', '1']);
  const [previewCenter, setPreviewCenter] = useState<[number, number, number]>([0, 0, 0]);
  const [previewBounds, setPreviewBounds] = useState<[number, number, number]>([0, 0, 0]);
  const [cropLoading, setCropLoading] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorVersions, setEditorVersions] = useState<AssetObbVersion[]>([]);
  const [editForm, setEditForm] = useState<{ name: string; description: string; categoryId: string; approved: boolean }>({ name: '', description: '', categoryId: '', approved: false });
  const [editSaving, setEditSaving] = useState(false);
  const [meshConvertLoading, setMeshConvertLoading] = useState(false);
  const [meshDownloadLoading, setMeshDownloadLoading] = useState<MeshInteropDownloadFormat | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const applyStoredObb = useCallback((stored: StoredObb) => {
    setObbCenter(stored.center);
    setObbRotation(stored.rotation);
    setObbScale(stored.scale);
  }, []);

  const syncDraftObb = useCallback((assetId: string, obb: AssetObb) => {
    const stored = toStoredObb(obb);
    applyStoredObb(stored);
    saveObb(assetId, stored);
  }, [applyStoredObb]);
  const selectedId = selected?.id ?? null;
  const handleDraftObbChange = useCallback((obb: AssetObb) => {
    if (!selectedId) return;
    syncDraftObb(selectedId, obb);
  }, [selectedId, syncDraftObb]);

  const fetchAssets = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await assetsApi.getAll(selectedCategoryId ? { categoryId: selectedCategoryId } : undefined);
      setAssets(data);
    } catch {
      setAlert('에셋 목록을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [selectedCategoryId]);

  const refreshSelected = useCallback(async (id: string) => {
    try {
      const { data } = await assetsApi.getOne(id);
      setSelected(data);
    } catch {
      setAlert('에셋 상세 정보를 불러오지 못했습니다.');
    }
  }, []);

  useEffect(() => { if (perm.isLoaded && perm.view) void fetchAssets(); }, [perm.isLoaded, perm.view, fetchAssets]);
  useEffect(() => { assetCategoriesApi.getAll({ limit: 100 }).then(({ data }) => setCategories(data.items)).catch(() => {}); }, []);
  useEffect(() => {
    const shouldPoll = assets.some((asset) => POLLABLE.includes(asset.status)) || (!!selected && POLLABLE.includes(selected.status));
    if (!shouldPoll) return;
    const timer = window.setInterval(() => { void fetchAssets(); if (selected) void refreshSelected(selected.id); }, 3000);
    return () => window.clearInterval(timer);
  }, [assets, selected, fetchAssets, refreshSelected]);
  useEffect(() => {
    if (!editorOpen || !selected) return;

    let cancelled = false;
    const fallbackStored = loadObb(selected.id) ?? getStoredObbFromAsset(selected) ?? DEFAULT_STORED_OBB;
    const fallbackObb = toAssetObb(fallbackStored);
    setEditorVersions(getInitialVersionsForAsset(selected, fallbackObb));

    void assetsApi.getVersions(selected.id)
      .then(({ data }) => {
        if (!cancelled) {
          const merged = mergeVersions(data, loadLocalVersions(selected.id));
          setEditorVersions(merged.length > 0 ? merged : [createInitialVersion(selected, fallbackObb)]);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (isNotFoundError(error)) {
          setEditorVersions(getInitialVersionsForAsset(selected, fallbackObb));
          return;
        }
        setAlert('버전 목록을 불러오지 못했습니다.');
      });

    return () => {
      cancelled = true;
    };
  }, [editorOpen, selected]);
  useEffect(() => {
    const metadataCenter = getPreviewCenterFromMetadata(selected);
    if (metadataCenter) setPreviewCenter(metadataCenter);

    const metadataBounds = getPreviewBoundsFromMetadata(selected);
    if (metadataBounds) setPreviewBounds(metadataBounds);
  }, [selected]);
  useEffect(() => {
    let cancelled = false;

    if (form.uploadMode !== 'direct') {
      setDirectDetectedType(null);
      setDirectDetecting(false);
      return () => {
        cancelled = true;
      };
    }

    if (!file) {
      setDirectDetectedType(null);
      setDirectDetecting(false);
      return () => {
        cancelled = true;
      };
    }

    setDirectDetecting(true);
    void inferDirectAssetType(file)
      .then((detectedType) => {
        if (cancelled) return;
        setDirectDetectedType(detectedType);
        if (detectedType) {
          setForm((prev) => ({
            ...prev,
            type: detectedType,
            outputProfile: getDefaultOutputProfile(detectedType, file.name),
          }));
        }
      })
      .finally(() => {
        if (!cancelled) setDirectDetecting(false);
      });

    return () => {
      cancelled = true;
    };
  }, [file, form.uploadMode]);

  const assetSequenceMap = new Map(
    [...assets]
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .map((asset, index) => [asset.id, index + 1]),
  );

  const filtered = assets
    .filter((asset) => {
      const matchesCategory = !selectedCategoryId || asset.categoryId === selectedCategoryId;
      const q = search.trim().toLowerCase();
      const matchesQuery = !q || asset.name.toLowerCase().includes(q) || ASSET_TYPE_LABELS[asset.type].toLowerCase().includes(q);
      return matchesCategory && matchesQuery;
    })
    .sort((a, b) => (assetSequenceMap.get(b.id) ?? 0) - (assetSequenceMap.get(a.id) ?? 0));
  const createProfiles = getOutputProfilesForType(form.type);
  const createFormatConfig = getUploadFormatConfig(form.type, form.uploadMode);
  const detectedInput = file ? detectInputFormatFromName(file.name) : undefined;
  const previewObject = selected ? getBestPreviewObject(selected) ?? selected.sourceObject : undefined;
  const previewType = previewObject ? getFileType(previewObject) : 'other';
  const previewUrl = previewObject ? assetsApi.getStreamUrl(previewObject) : undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const previewSceneCenter = useMemo(() => getPreviewCenterFromMetadata(selected), [JSON.stringify(selected?.metadata?.previewCenter)]);
  const editorObject = selected ? getBestEditorObject(selected) : undefined;
  const selectedInput = selected ? getAssetInputFormat(selected) : undefined;
  const selectedProfile = selected ? getAssetOutputProfile(selected) : undefined;
  const selectedCategoryName = getCategoryDisplayName(selected, categories);
  const selectedSourceObjectName = getObjectDisplayName(selected?.sourceObject);
  const selectedOutputObjectName = getObjectDisplayName(selected?.outputObject);
  const selectedCalibrationScale = getCalibrationScaleFromMetadata(selected);
  const selectedCalibrationReferenceLength = getCalibrationReferenceLengthFromMetadata(selected);
  const canSelectMeshDownloadFormat = supportsMeshFormatDownload(selected);
  const detailDownloadActions = selected ? (
    canSelectMeshDownloadFormat ? (
      <div className="pt-2 space-y-2">
        <p className="text-xs text-blue-700">메쉬 파일만 형식을 선택해 다운로드할 수 있습니다.</p>
        <div className="flex flex-wrap gap-2">
          {MESH_DOWNLOAD_FORMATS.map((format) => (
            <button
              key={format}
              type="button"
              onClick={() => void handleDownloadMeshArtifact(selected, format)}
              disabled={meshDownloadLoading !== null}
              className="px-4 py-2 rounded-lg bg-green-600 text-white text-sm hover:bg-green-700 disabled:opacity-40"
            >
              {meshDownloadLoading === format ? `${format.toUpperCase()} 다운로드 중...` : format.toUpperCase()}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void handleDownloadMeshArtifact(selected, 'all')}
            disabled={meshDownloadLoading !== null}
            className="px-4 py-2 rounded-lg border border-green-600 text-green-700 text-sm hover:bg-green-50 disabled:opacity-40"
          >
            {meshDownloadLoading === 'all' ? '전체 다운로드 중...' : '전체'}
          </button>
          <a href={assetsApi.getStreamUrl(selected.sourceObject)} download className="px-4 py-2 rounded-lg bg-gray-700 text-white text-sm hover:bg-gray-800">원본 다운로드</a>
        </div>
      </div>
    ) : (
      <div className="flex flex-wrap gap-2 pt-2">
        {selected.outputObject && <a href={assetsApi.getStreamUrl(selected.outputObject)} download={getAssetDownloadName(selected.name, selected.outputObject)} className="px-4 py-2 rounded-lg bg-green-600 text-white text-sm hover:bg-green-700">변환 결과 다운로드</a>}
        <a href={assetsApi.getStreamUrl(selected.sourceObject)} download className="px-4 py-2 rounded-lg bg-gray-700 text-white text-sm hover:bg-gray-800">원본 다운로드</a>
      </div>
    )
  ) : null;

  const openCreate = () => {
    setForm({
      name: '',
      description: '',
      type: 'point_cloud',
      categoryId: '',
      outputProfile: getDefaultOutputProfile('point_cloud'),
      uploadMode: 'convert',
    });
    setFormError('');
    setFile(null);
    setDirectDetectedType(null);
    setDirectDetecting(false);
    setUploadPct(0);
    if (fileRef.current) fileRef.current.value = '';
    setModal('create');
  };

  const openDetail = async (asset: Asset) => {
    setPreviewCenter([0, 0, 0]);
    setPreviewBounds([0, 0, 0]);
    try {
      const { data } = await assetsApi.getOne(asset.id);
      const saved = loadObb(data.id);
      const fallback = getStoredObbFromAsset(data) ?? DEFAULT_STORED_OBB;
      applyStoredObb(saved ?? fallback);
      setEditorVersions(getInitialVersionsForAsset(data, toAssetObb(saved ?? fallback)));
      setSelected(data);
      setModal('detail');
    } catch {
      setAlert('에셋 상세 정보를 불러오지 못했습니다.');
    }
  };

  const handleCreate = async () => {
    if (!form.name.trim()) return setFormError('에셋명을 입력하세요.');
    if (!file) return setFormError('업로드할 파일을 선택하세요.');
    if (form.uploadMode === 'direct' && directDetecting) return setFormError('파일 타입을 판별하는 중입니다. 잠시 후 다시 시도해주세요.');
    if (!isAllowedUploadFile(form.type, form.uploadMode, file.name)) {
      return setFormError(`${UPLOAD_MODE_LABELS[form.uploadMode]}에서는 ${formatExtensions(createFormatConfig.exts)} 파일만 업로드할 수 있습니다.`);
    }
    const effectiveType = form.uploadMode === 'direct' ? directDetectedType : form.type;
    if (!effectiveType) {
      return setFormError('일반 업로드 파일 타입을 자동 판별하지 못했습니다. GLB, PLY, ZIP 파일인지 확인해주세요.');
    }
    setUploading(true); setFormError('');
    try {
      const { data: uploaded } = await assetsApi.upload(file, setUploadPct);
      await assetsApi.create({
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        type: effectiveType,
        sourceObject: uploaded.objectName,
        categoryId: form.categoryId ? Number(form.categoryId) : undefined,
        ...(form.uploadMode === 'convert' ? { outputProfile: form.outputProfile } : {}),
        uploadMode: form.uploadMode,
      });
      setModal('none');
      await fetchAssets();
      setAlert(form.uploadMode === 'direct' ? '에셋 업로드를 완료했습니다.' : '에셋 업로드 후 변환을 시작했습니다.');
    } catch (error: unknown) {
      const message = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
      setFormError(message ?? '에셋 업로드에 실패했습니다.');
    } finally {
      setUploading(false); setUploadPct(0);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await assetsApi.remove(deleteTarget.id);
      setDeleteTarget(null); setSelected(null); setModal('none');
      await fetchAssets(); setAlert('에셋을 삭제했습니다.');
    } catch { setAlert('에셋 삭제에 실패했습니다.'); }
  };

  const handleResumeStage2 = async (withCrop: boolean, override?: ResumeOverride) => {
    if (!selected) return;
    setCropLoading(true);
    try {
      const params = override ? {
        obbCenter: override.center,
        obbRotation: override.rotation,
        obbScale: override.scale,
        previewCenter: override.previewCenter ?? previewCenter,
        previewBounds: override.previewBounds ?? previewBounds,
      }
        : withCrop ? {
          obbCenter: obbCenter.map(Number),
          obbRotation: obbRotation.map(Number),
          obbScale: obbScale.map(Number),
          previewCenter,
          previewBounds,
        }
        : {};
      await assetsApi.resumeStage2(selected.id, params);
      localStorage.removeItem(`obb_params_${selected.id}`);
      setEditorOpen(false); setModal('none');
      await fetchAssets(); setAlert(withCrop ? '선택 영역 변환을 재개했습니다.' : '전체 변환을 재개했습니다.');
    } catch (error: unknown) {
      const message = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
      setAlert(message ?? '2단계 변환 재개에 실패했습니다.');
    } finally { setCropLoading(false); }
  };

  const handleSaveCalibration = useCallback(async (
    calibrationScale: number,
    calibrationReferenceLength: number,
    calibrationMeasuredLength: number,
  ) => {
    if (!selected) return;

    const { data: updated } = await assetsApi.update(selected.id, {
      calibrationScale,
      calibrationReferenceLength,
      calibrationMeasuredLength,
    });

    setSelected(updated);
    await fetchAssets();
  }, [fetchAssets, selected]);

  const handleSaveCroppedScene = useCallback(async (blob: Blob, ext: string) => {
    if (!selected) return;
    const filename = `${selected.name.replace(/[\\/:*?"<>|]+/g, '-')}-edit.${ext}`;
    const file = new File([blob], filename, { type: blob.type });
    const { data: upload } = await assetsApi.upload(file);
    const updatePayload: Parameters<typeof assetsApi.update>[1] = {};
    if (selected.outputObject) {
      updatePayload.outputObject = upload.objectName;
    } else {
      updatePayload.previewObject = upload.objectName;
    }
    const { data: updated } = await assetsApi.update(selected.id, updatePayload);
    setSelected(updated);
    await fetchAssets();
  }, [fetchAssets, selected]);

  const handleCreateExtractedAsset = useCallback(async ({
    blob,
    ext,
    assetType,
  }: {
    blob: Blob;
    ext: string;
    assetType: AssetType;
  }) => {
    if (!selected) return;

    const safeName = selected.name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'extract';
    const file = new File([blob], `${safeName}-extract.${ext}`, { type: blob.type });
    const { data: upload } = await assetsApi.upload(file);
    await assetsApi.create({
      name: `${selected.name} - Extract`,
      type: assetType,
      sourceObject: upload.objectName,
      categoryId: selected.categoryId ?? undefined,
      uploadMode: 'direct',
    });
    await fetchAssets();
  }, [fetchAssets, selected]);

  const handleCreateVersion = useCallback(async ({ description, obb, sceneBlob, sceneExt }: { description?: string; obb: AssetObb; sceneBlob?: Blob; sceneExt?: string }): Promise<AssetObbVersion | void> => {
    if (!selected) return;

    // 첫 번째 버전 저장 시 현재 초기 OBB를 로컬에 보존
    const existingLocal = loadLocalVersions(selected.id);
    const apiVersionCount = getAssetObbVersions(selected).length;
    if (existingLocal.length === 0 && apiVersionCount === 0) {
      const initialStoredObb = getStoredObbFromAsset(selected) ?? DEFAULT_STORED_OBB;
      const initialObb = toAssetObb(initialStoredObb);
      const initialVersion: AssetObbVersion = {
        id: `initial-${selected.id}`,
        description: '초기 상태',
        createdAt: selected.createdAt,
        obb: initialObb,
      };
      saveLocalVersions(selected.id, [initialVersion]);
    }

    let sceneObjectName: string | undefined;
    if (sceneBlob && sceneExt) {
      const filename = `${selected.name.replace(/[\\/:*?"<>|]+/g, '-')}-version.${sceneExt}`;
      const file = new File([sceneBlob], filename, { type: sceneBlob.type });
      const { data: upload } = await assetsApi.upload(file);
      sceneObjectName = upload.objectName;
    }

    try {
      const { data: updated } = await assetsApi.createVersion(selected.id, {
        description: description?.trim() || undefined,
        ...obb,
        sceneObject: sceneObjectName ?? selected.outputObject ?? selected.previewObject ?? undefined,
      });

      // API 버전 + 로컬 초기 버전 병합
      const allVersions = mergeVersions(getAssetObbVersions(updated), loadLocalVersions(updated.id));
      setSelected(updated);
      setEditorVersions(allVersions);
      setAssets((prev) => prev.map((asset) => (asset.id === updated.id ? { ...asset, metadata: updated.metadata, updatedAt: updated.updatedAt } : asset)));
      syncDraftObb(updated.id, obb);
      return allVersions[0];
    } catch (error: unknown) {
      if (!isNotFoundError(error)) throw error;
    }

    // API 미지원 fallback: 로컬 저장
    const localVersion: AssetObbVersion = {
      id: crypto.randomUUID(),
      description: description?.trim() ?? '',
      createdAt: new Date().toISOString(),
      obb,
      ...(sceneObjectName ? { sceneObject: sceneObjectName } : {}),
    };
    const updatedLocal = mergeVersions([localVersion], loadLocalVersions(selected.id));
    saveLocalVersions(selected.id, updatedLocal);
    setEditorVersions(updatedLocal);
    syncDraftObb(selected.id, obb);
    return localVersion;
  }, [selected, syncDraftObb]);

  const handleUpdateVersion = useCallback(async ({
    versionId,
    description,
    obb,
  }: {
    versionId: string;
    description?: string;
    obb: AssetObb;
  }) => {
    if (!selected) return;

    try {
      const { data: updated } = await assetsApi.updateVersion(selected.id, versionId, {
        description: description?.trim() || undefined,
        ...obb,
      });

      setSelected(updated);
      setEditorVersions(mergeVersions(getAssetObbVersions(updated), loadLocalVersions(updated.id)));
      setAssets((prev) => prev.map((asset) => (asset.id === updated.id ? { ...asset, metadata: updated.metadata, updatedAt: updated.updatedAt } : asset)));
      syncDraftObb(updated.id, obb);
      return;
    } catch (error: unknown) {
      if (!isNotFoundError(error)) throw error;
    }

    const localVersions = loadLocalVersions(selected.id);
    const targetExists = localVersions.some((version) => version.id === versionId);
    if (!targetExists) throw new Error('버전을 수정할 수 없습니다.');

    const nextVersions = localVersions.map((version) => (
      version.id === versionId
        ? { ...version, description: description?.trim() ?? '', obb }
        : version
    ));
    saveLocalVersions(selected.id, nextVersions);
    setEditorVersions(mergeVersions(getAssetObbVersions(selected), nextVersions));
    syncDraftObb(selected.id, obb);
  }, [selected, syncDraftObb]);

  const handleDeleteVersion = useCallback(async (versionId: string) => {
    if (!selected) return;

    try {
      const { data: updated } = await assetsApi.removeVersion(selected.id, versionId);
      setSelected(updated);
      setEditorVersions(mergeVersions(getAssetObbVersions(updated), loadLocalVersions(updated.id)));
      setAssets((prev) => prev.map((asset) => (asset.id === updated.id ? { ...asset, metadata: updated.metadata, updatedAt: updated.updatedAt } : asset)));
      return;
    } catch (error: unknown) {
      if (!isNotFoundError(error)) throw error;
    }

    const localVersions = loadLocalVersions(selected.id);
    const nextVersions = localVersions.filter((version) => version.id !== versionId);
    if (nextVersions.length === localVersions.length) throw new Error('버전을 삭제할 수 없습니다.');

    saveLocalVersions(selected.id, nextVersions);
    setEditorVersions(mergeVersions(getAssetObbVersions(selected), nextVersions));
  }, [selected]);

  const handleSetRepresentative = useCallback(async (version: AssetObbVersion) => {
    if (!selected) return;
    setAlert('대표 버전이 설정되었습니다.');
    try {
      // sceneObject 없으면 null 전송 → 백엔드에서 대표 해제(초기 상태로 복원)
      const { data: updated } = await assetsApi.update(selected.id, { representativeSceneObject: version.sceneObject ?? null });
      setSelected(updated);
      setAssets((prev) => prev.map((a) => (a.id === updated.id ? { ...a, metadata: updated.metadata, updatedAt: updated.updatedAt } : a)));
    } catch {
      setAlert('대표 버전 설정에 실패했습니다.');
    }
  }, [selected]);

  const handleSaveEdit = async () => {
    if (!selected || !editForm.name.trim()) return;
    setEditSaving(true);
    try {
      const categoryId = editForm.categoryId ? Number(editForm.categoryId) : null;
      const { data: updated } = await assetsApi.update(selected.id, {
        name: editForm.name.trim(),
        description: editForm.description.trim() || undefined,
        categoryId,
        approved: editForm.approved,
      });
      setSelected(updated);
      await fetchAssets();
      setModal('detail');
    } catch { setAlert('수정에 실패했습니다.'); }
    finally { setEditSaving(false); }
  };

  const handleConvertToMesh = async () => {
    if (!selected) return;
    setMeshConvertLoading(true);
    try {
      await assetsApi.create({
        name: `${selected.name} - to MeSH`,
        type: 'mesh',
        sourceObject: selected.sourceObject,
        categoryId: selected.categoryId ?? undefined,
        outputProfile: getDefaultOutputProfile('mesh'),
      });
      await fetchAssets();
      setModal('none');
      setAlert(`"${selected.name} - to MeSH" 에셋 변환을 시작했습니다.`);
    } catch (error: unknown) {
      const message = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
      const lower = (message ?? '').toLowerCase();
      const isSimilarityError = lower.includes('match') || lower.includes('similar') || lower.includes('feature') || lower.includes('colmap') || lower.includes('correspond');
      setAlert(isSimilarityError ? '변환할 파일의 유사도가 충분하지 않습니다.' : (message ?? 'MeSH 변환 요청에 실패했습니다.'));
    } finally { setMeshConvertLoading(false); }
  };

  const handleDownloadMeshArtifact = useCallback(async (asset: Asset, format: MeshInteropDownloadFormat) => {
    setMeshDownloadLoading(format);
    try {
      await downloadMeshAssetFormat(asset, format);
    } catch {
      setAlert(format === 'all'
        ? '메쉬 전체 다운로드에 실패했습니다.'
        : `${format.toUpperCase()} 다운로드에 실패했습니다.`);
    } finally {
      setMeshDownloadLoading(null);
    }
  }, []);

  const updateObb = (field: 'center' | 'rotation' | 'scale', index: number, value: string) => {
    if (!selected) return;
    const next = { center: [...obbCenter] as StoredObb['center'], rotation: [...obbRotation] as StoredObb['rotation'], scale: [...obbScale] as StoredObb['scale'] };
    next[field][index] = value;
    applyStoredObb(next);
    saveObb(selected.id, next);
  };

  if (!perm.isLoaded) return <div className="h-full flex items-center justify-center text-sm text-gray-500">권한 정보를 불러오는 중입니다.</div>;
  if (!perm.view) return <div className="h-full flex items-center justify-center text-sm text-gray-500">에셋 관리 권한이 없습니다.</div>;

  return (
    <div className="p-6 md:p-8 bg-gray-50 min-h-full space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div><h1 className="text-2xl font-bold text-gray-900">에셋 관리</h1><p className="text-sm text-gray-500 mt-1">입력 포맷 자동 감지와 출력 프로파일 기반 변환을 관리합니다.</p></div>
        {perm.create && <button type="button" onClick={openCreate} className="px-4 py-2.5 rounded-xl bg-gray-900 text-white text-sm hover:bg-gray-800 self-start">새 에셋 업로드</button>}
      </div>
      <div className="grid gap-3 md:grid-cols-[1fr_240px]">
        <div className="relative"><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="에셋명 또는 유형으로 검색" className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 pr-11 text-sm focus:outline-none focus:border-blue-500" /><span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400">⌕</span></div>
        <select value={selectedCategoryId ?? ''} onChange={(e) => setSelectedCategoryId(e.target.value ? Number(e.target.value) : undefined)} className="rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm focus:outline-none focus:border-blue-500"><option value="">전체 카테고리</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      </div>
      <div className="text-sm text-gray-500">총 {filtered.length}건</div>
      {loading ? (
        <div className="py-20 text-center text-sm text-gray-400">목록을 불러오는 중입니다.</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white py-20 text-center text-sm text-gray-400">표시할 에셋이 없습니다.</div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white shadow-sm">
          <table className="w-full min-w-[1040px] table-fixed text-sm">
            <thead>
              <tr className="bg-[#2d4a7a] text-white">
                <th className="w-20 px-6 py-3 text-left font-medium">NO</th>
                <th className="px-6 py-3 text-left font-medium">제목</th>
                <th className="w-48 px-4 py-3 text-left font-medium">설명</th>
                <th className="w-36 px-4 py-3 text-left font-medium">파일 타입</th>
                <th className="w-32 px-4 py-3 text-left font-medium">카테고리</th>
                <th className="w-36 px-4 py-3 text-left font-medium">처리 상태</th>
                <th className="w-32 pl-4 pr-3 py-3 text-left font-medium">승인 상태</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((asset, index) => (
                <tr
                  key={asset.id}
                  onClick={() => { if (perm.detail) void openDetail(asset); }}
                  className={perm.detail ? 'cursor-pointer transition-colors hover:bg-blue-50' : undefined}
                >
                  <td className="px-6 py-4 text-gray-500">{assetSequenceMap.get(asset.id) ?? index + 1}</td>
                  <td className="px-6 py-4 font-semibold text-gray-900 truncate">{asset.name}</td>
                  <td className="px-4 py-4 text-gray-600 truncate">{asset.description?.trim() || '-'}</td>
                  <td className="px-4 py-4 text-gray-600 whitespace-nowrap">{ASSET_TYPE_LABELS[asset.type]}</td>
                  <td className="px-4 py-4 text-gray-600 whitespace-nowrap">{getCategoryDisplayName(asset, categories)}</td>
                  <td className="px-4 py-4">
                    <StatusBadge status={asset.status} />
                  </td>
                  <td className="pl-4 pr-3 py-4">
                    <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-medium ${asset.approved ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'}`}>
                      {asset.approved ? '승인됨' : '미승인'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal === 'create' && (
        <Modal title="에셋 업로드" onClose={() => (!uploading ? setModal('none') : undefined)}>
          <div className="px-6 py-6 space-y-5">
            {/* 에셋명 */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">에셋명 <span className="text-red-500">*</span></label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="에셋명을 입력하세요" autoFocus className={inputCls} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">업로드 방식 <span className="text-red-500">*</span></label>
              <div className="grid gap-2 sm:grid-cols-2">
                {(['direct', 'convert'] as const).map((mode) => (
                  <label key={mode} className={`flex items-start gap-3 rounded-xl border px-4 py-3 cursor-pointer transition-colors ${form.uploadMode === mode ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white hover:bg-gray-50'}`}>
                    <input
                      type="radio"
                      name="uploadMode"
                      value={mode}
                      checked={form.uploadMode === mode}
                      onChange={() => setForm((prev) => ({ ...prev, uploadMode: mode, outputProfile: getDefaultOutputProfile(prev.type, file?.name) }))}
                      className="mt-1 accent-blue-600"
                    />
                    <div>
                      <div className="text-sm font-medium text-gray-900">{UPLOAD_MODE_LABELS[mode]}</div>
                      <div className="mt-1 text-xs text-gray-500">{UPLOAD_MODE_DESCRIPTIONS[mode]}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
            {/* 카테고리 */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">카테고리</label>
              <select value={form.categoryId} onChange={e => setForm(f => ({ ...f, categoryId: e.target.value }))} className={inputCls}>
                <option value="">카테고리 없음</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            {/* 에셋 파일 타입 */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">에셋 파일 타입 <span className="text-red-500">*</span></label>
              <div className={`grid grid-cols-2 gap-2 ${form.uploadMode === 'direct' ? 'opacity-60' : ''}`}>
                {ASSET_TYPES.map(type => (
                  <label key={type} className={`flex items-center gap-2.5 rounded-xl border px-4 py-3 cursor-pointer transition-colors
                    ${form.type === type ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white hover:bg-gray-50'}
                    ${form.uploadMode === 'direct' ? 'cursor-not-allowed' : ''}`}>
                    <input type="radio" name="assetType" value={type} checked={form.type === type}
                      disabled={form.uploadMode === 'direct'}
                      onChange={() => { const t = type; setForm(f => ({ ...f, type: t, outputProfile: getDefaultOutputProfile(t, file?.name) })); }}
                      className="accent-blue-600" />
                    <span className="text-sm font-medium text-gray-800">{ASSET_TYPE_LABELS[type]}</span>
                  </label>
                ))}
              </div>
              <p className="mt-2 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-700">{createFormatConfig.desc}</p>
              {form.uploadMode === 'direct' && (
                <p className="mt-2 text-xs text-gray-500">
                  {directDetecting
                    ? '파일을 분석해서 타입을 자동 판별하는 중입니다.'
                    : directDetectedType
                      ? `자동 판별 결과: ${ASSET_TYPE_LABELS[directDetectedType]}`
                      : '일반 업로드에서는 파일을 선택하면 타입이 자동으로 정해집니다.'}
                </p>
              )}
            </div>
            {/* 출력 프로파일 */}
            <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4 space-y-4">
              <div>
                <p className="text-sm font-medium text-gray-800 mb-1">입력 포맷</p>
                <p className="text-xs text-gray-500">
                  {detectedInput
                    ? `${detectedInput.extension || '(확장자 없음)'} / ${INPUT_KIND_LABELS[detectedInput.kind]} / ${detectedInput.container}`
                    : `${UPLOAD_MODE_LABELS[form.uploadMode]}에 맞는 파일을 선택하면 자동 감지됩니다.`}
                </p>
              </div>
              {form.uploadMode === 'direct' ? (
                <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3">
                  <p className="text-sm font-medium text-green-900 mb-1">즉시 등록 프로파일</p>
                  <p className="text-sm text-green-800">
                    {directDetectedType ? OUTPUT_PROFILE_LABELS[getDefaultOutputProfile(directDetectedType, file?.name)] : '파일 선택 후 자동 결정'}
                  </p>
                  <p className="text-xs text-green-700 mt-1">일반 업로드는 변환 작업 없이 완료 상태로 등록됩니다.</p>
                </div>
              ) : (
                <div>
                  <p className="text-sm font-medium text-gray-800 mb-2">출력 프로파일</p>
                  <div className="space-y-2">
                    {createProfiles.map(profile => (
                      <label key={profile} className={`block rounded-xl border px-4 py-3 cursor-pointer ${form.outputProfile === profile ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white'}`}>
                        <div className="flex items-start gap-3">
                          <input type="radio" checked={form.outputProfile === profile} onChange={() => setForm(f => ({ ...f, outputProfile: profile }))} className="mt-1" />
                          <div>
                            <div className="text-sm font-medium text-gray-900">{OUTPUT_PROFILE_LABELS[profile]}</div>
                            <div className="text-xs text-gray-500 mt-1">{OUTPUT_PROFILE_DESCRIPTIONS[profile]}</div>
                            <div className="text-[11px] text-gray-400 mt-1 break-all">{OUTPUT_PROFILE_ARTIFACTS[profile].join(', ')}</div>
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
            {/* 설명 */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">설명</label>
              <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                rows={3} placeholder="설명을 입력하세요" className={`${inputCls} resize-none`} />
            </div>
            {/* 파일 업로드 */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">파일 <span className="text-red-500">*</span></label>
              <button type="button"
                onClick={() => { if (!uploading) fileRef.current?.click(); }}
                onDragOver={e => { e.preventDefault(); if (!uploading) setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={e => {
                  e.preventDefault(); setDragOver(false);
                  if (uploading) return;
                  const f = e.dataTransfer.files?.[0] ?? null;
                  setFile(f); if (f) setForm(prev => ({ ...prev, outputProfile: getDefaultOutputProfile(prev.type, f.name) }));
                }}
                className={`w-full rounded-2xl border-2 border-dashed px-4 py-8 text-center transition-colors ${dragOver ? 'border-blue-500 bg-blue-50' : 'border-gray-300 bg-white hover:border-blue-400'}`}>
                {file
                  ? <div className="space-y-1"><p className="text-sm font-medium text-gray-800">{file.name}</p><p className="text-xs text-gray-400">{formatSize(file.size)}</p></div>
                  : <div className="space-y-1"><p className="text-sm font-medium text-gray-700">{dragOver ? '여기에 놓으세요' : '클릭하거나 파일을 드래그하세요'}</p><p className="text-xs text-gray-400">{formatExtensions(createFormatConfig.exts)}</p></div>}
              </button>
              <input ref={fileRef} type="file" className="hidden"
                accept={createFormatConfig.exts.map(ext => `.${ext}`).join(',')}
                onChange={e => { const f = e.target.files?.[0] ?? null; setFile(f); if (f) setForm(prev => ({ ...prev, outputProfile: getDefaultOutputProfile(prev.type, f.name) })); }} />
              {uploading && (
                <div className="mt-3 space-y-1">
                  <div className="h-2 rounded-full bg-gray-200 overflow-hidden"><div className="h-full bg-blue-500 transition-all" style={{ width: `${uploadPct}%` }} /></div>
                  <div className="text-xs text-right text-gray-500">{uploadPct}%</div>
                </div>
              )}
            </div>
            {formError && <p className="text-sm text-red-600">{formError}</p>}
          </div>
          <div className="px-6 py-4 border-t border-gray-100 bg-gray-50 flex justify-end gap-2">
            <button type="button" onClick={() => setModal('none')} disabled={uploading}
              className="px-4 py-2 rounded-lg border border-gray-300 text-sm hover:bg-white disabled:opacity-40">취소</button>
            <button type="button" onClick={() => void handleCreate()} disabled={uploading || (form.uploadMode === 'direct' && directDetecting)}
              className="px-4 py-2 rounded-lg bg-gray-900 text-white text-sm hover:bg-gray-800 disabled:opacity-40">
              {uploading ? '업로드 중...' : '업로드'}
            </button>
          </div>
        </Modal>
      )}

      {modal === 'detail' && selected && <Modal title="에셋 상세" onClose={() => setModal('none')} wide><div className="px-6 py-6 space-y-6">
        {/* 이름 + 버튼 행 */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <h3 className="text-base font-semibold text-gray-900 truncate">{selected.name}</h3>
            <span className={`shrink-0 inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${selected.approved ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>{selected.approved ? '승인됨' : '미승인'}</span>
          </div>
          <div className="flex gap-2 shrink-0">
            <button type="button"
              onClick={() => {
                if (selected.type === 'nerf') { setAlert('NeRF 변환 파일은 편집기를 지원하지 않습니다.'); return; }
                if (editorObject) setEditorOpen(true);
              }}
              disabled={selected.type !== 'nerf' && !editorObject}
              className="px-3 py-2 rounded-lg border border-gray-300 text-sm hover:bg-gray-50 disabled:opacity-40">
              편집기 열기
            </button>
            {perm.update && <button type="button" onClick={() => { setEditForm({ name: selected.name, description: selected.description ?? '', categoryId: selected.categoryId ? String(selected.categoryId) : '', approved: selected.approved }); setModal('edit'); }} className="px-3 py-1.5 rounded-lg border border-blue-300 text-blue-600 text-sm hover:bg-blue-50">수정</button>}
            {selected.type === 'point_cloud' && perm.create && (
              <button type="button" onClick={() => void handleConvertToMesh()} disabled={meshConvertLoading}
                className="px-3 py-1.5 rounded-lg border border-purple-300 text-purple-700 text-sm hover:bg-purple-50 disabled:opacity-40">
                {meshConvertLoading ? '요청 중...' : 'MeSH 변환'}
              </button>
            )}
            {selected.type === 'mesh' && Array.isArray(selected.metadata?.textureObjects) && (selected.metadata.textureObjects as string[]).length > 0 && (
              <button type="button" onClick={() => setModal('texture')}
                className="px-3 py-1.5 rounded-lg border border-amber-300 text-amber-700 text-sm hover:bg-amber-50">
                메시 텍스쳐
              </button>
            )}
            {perm.delete && <button type="button" onClick={() => { setDeleteTarget(selected); setModal('delete'); }} className="px-3 py-2 rounded-lg border border-red-200 text-red-600 text-sm hover:bg-red-50">삭제</button>}
          </div>
        </div><div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]"><div className="space-y-4">{selectedProfile === 'mesh_interop_bundle' && <div className="rounded-2xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">GLB, OBJ, STL, PLY 결과가 ZIP 컨테이너로 제공됩니다.</div>}{selected.status === 'gpu_required' && <div className="rounded-2xl border border-purple-200 bg-purple-50 px-4 py-3 text-sm text-purple-800">GPU 서버 연동이 필요한 작업입니다.</div>}<div className="rounded-2xl border border-gray-200 bg-white overflow-hidden"><div className="px-4 py-3 border-b border-gray-100"><p className="text-sm font-medium text-gray-900">미리보기</p></div>{selected.type === 'nerf' && selected.status === 'done' && selected.outputObject ? <Suspense fallback={<div className="h-[320px] flex items-center justify-center bg-gray-50 text-sm text-gray-400">프레임 로딩 중...</div>}><NerfFrameCarousel assetId={selected.id} /></Suspense> : !previewUrl || previewType === 'other' || previewType === 'zip' ? <div className="h-[320px] flex items-center justify-center bg-gray-50 text-sm text-gray-400 px-6 text-center">브라우저 미리보기를 제공하지 않는 결과입니다. 다운로드로 확인하세요.</div> : previewType === 'image' ? <div className="h-[320px] bg-gray-50 flex items-center justify-center"><img src={previewUrl} alt={selected.name} className="max-h-full max-w-full object-contain" /></div> : previewType === 'video' ? <div className="h-[320px] bg-black"><video src={previewUrl} controls className="w-full h-full object-contain" /></div> : <div className="h-[320px] bg-gray-100"><Suspense fallback={<div className="w-full h-full flex items-center justify-center text-sm text-gray-400">미리보기를 불러오는 중입니다.</div>}><ModelViewer url={previewUrl} autoRotate={false} fileType={previewType} assetType={selected.type} sceneCenter={previewSceneCenter} onPointCloudCenter={selected.status === 'awaiting_crop' ? setPreviewCenter : undefined} obbBox={selected.status === 'awaiting_crop' ? { center: obbCenter.map(Number) as ObbBox['center'], rotation: obbRotation.map(Number) as ObbBox['rotation'], scale: obbScale.map(Number) as ObbBox['scale'] } : undefined} /></Suspense></div>}</div>{selected.status === 'awaiting_crop' && <div className="rounded-2xl border border-orange-200 bg-orange-50 p-4 space-y-4"><div><p className="text-sm font-medium text-orange-900">선택 범위 변환</p><p className="text-xs text-orange-700 mt-1">OBB를 조정한 뒤 전체 또는 선택 영역 변환을 재개할 수 있습니다.</p></div>{(['center', 'rotation', 'scale'] as const).map((field) => <div key={field}><p className="text-xs text-orange-800 mb-1.5">{field === 'center' ? '중심 (XYZ)' : field === 'rotation' ? '회전 ° (XYZ)' : '크기 (XYZ)'}</p><div className="grid grid-cols-3 gap-2">{(field === 'center' ? obbCenter : field === 'rotation' ? obbRotation : obbScale).map((value, index) => <input key={`${field}-${index}`} type="number" step="0.1" value={value} onChange={(e) => updateObb(field, index, e.target.value)} className="rounded-lg border border-orange-300 bg-white px-3 py-2 text-sm text-center focus:outline-none focus:border-orange-500" />)}</div></div>)}<div className="grid gap-2 sm:grid-cols-2"><button type="button" onClick={() => void handleResumeStage2(false)} disabled={cropLoading} className="px-4 py-2.5 rounded-xl border border-orange-300 text-orange-700 text-sm hover:bg-orange-100 disabled:opacity-40">전체 변환</button><button type="button" onClick={() => void handleResumeStage2(true)} disabled={cropLoading} className="px-4 py-2.5 rounded-xl bg-orange-600 text-white text-sm hover:bg-orange-700 disabled:opacity-40">{cropLoading ? '처리 중...' : '선택 범위 변환'}</button></div></div>}</div><div className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3"><div className="flex flex-wrap gap-2"><StatusBadge status={selected.status} /><span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-medium ${selected.approved ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>{selected.approved ? '승인됨' : '미승인'}</span><span className="inline-flex px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-700">{ASSET_TYPE_LABELS[selected.type]}</span></div><div className="space-y-3 text-sm"><div><span className="text-gray-500">카테고리:</span> <span className="text-gray-900">{selectedCategoryName}</span></div><div><span className="text-gray-500">설명:</span> <span className="text-gray-900">{selected.description ?? '-'}</span></div><div><span className="text-gray-500">입력:</span> <span className="text-gray-900">{selectedInput ? `${selectedInput.extension || '-'} / ${INPUT_KIND_LABELS[selectedInput.kind]} / ${selectedInput.container}` : '-'}</span></div><div><span className="text-gray-500">프로파일:</span> <span className="text-gray-900">{selectedProfile ? OUTPUT_PROFILE_LABELS[selectedProfile] : '-'}</span></div><div><span className="text-gray-500">산출물:</span> <span className="text-gray-900 break-all">{selectedProfile ? OUTPUT_PROFILE_ARTIFACTS[selectedProfile].join(', ') : '-'}</span></div><div><span className="text-gray-500">등록일시:</span> <span className="text-gray-900">{formatDate(selected.createdAt)}</span></div><div><span className="text-gray-500">수정일시:</span> <span className="text-gray-900">{formatDate(selected.updatedAt)}</span></div><div><span className="text-gray-500">원본 객체:</span> <span className="text-gray-900 break-all">{selectedSourceObjectName}</span></div><div><span className="text-gray-500">출력 객체:</span> <span className="text-gray-900 break-all">{selectedOutputObjectName}</span></div>{selected.errorMessage && <div className="text-red-600">{selected.errorMessage}</div>}</div>{detailDownloadActions}</div></div></div></Modal>}

      {modal === 'texture' && selected && (() => {
        const textures = (selected.metadata?.textureObjects as string[] | undefined) ?? [];
        return (
          <Modal title="메시 텍스쳐" onClose={() => setModal('detail')} wide>
            <div className="px-3 py-3">
              {textures.length === 0 ? (
                <p className="text-sm text-gray-500 text-center py-10">텍스쳐 이미지가 없습니다.</p>
              ) : (
                <div className="flex flex-wrap gap-3 justify-center">
                  {textures.map((obj, i) => {
                    const cardW = textures.length === 1 ? 'w-full max-w-2xl' : 'w-72 shrink-0';
                    return (
                      <div key={obj} className={`rounded-xl border border-gray-200 overflow-hidden bg-gray-50 ${cardW}`}>
                        <div className="overflow-hidden bg-gray-100">
                          <img
                            src={assetsApi.getStreamUrl(obj)}
                            alt={`텍스쳐 ${i + 1}`}
                            className="w-full object-contain max-h-[55vh]"
                          />
                        </div>
                        <div className="px-3 py-2 flex items-center justify-between">
                          <span className="text-xs text-gray-500">텍스쳐 {i + 1}</span>
                          <a href={assetsApi.getStreamUrl(obj)} download
                            className="text-xs text-blue-600 hover:underline">다운로드</a>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="px-4 py-3 border-t border-gray-100 bg-gray-50 flex justify-end">
              <button type="button" onClick={() => setModal('detail')}
                className="px-4 py-2 rounded-lg bg-gray-900 text-white text-sm hover:bg-gray-800">닫기</button>
            </div>
          </Modal>
        );
      })()}

      {modal === 'edit' && selected && (
        <Modal title="에셋 수정" onClose={() => setModal('detail')}>
          <div className="px-6 py-6 space-y-5">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">에셋명 <span className="text-red-500">*</span></label>
              <input autoFocus value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                placeholder="에셋명을 입력하세요" className={inputCls} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">설명</label>
              <textarea
                value={editForm.description}
                onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))}
                rows={4}
                placeholder="에셋 설명을 입력하세요"
                className={`${inputCls} min-h-[110px] resize-y`}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">카테고리</label>
              <select value={editForm.categoryId} onChange={e => setEditForm(f => ({ ...f, categoryId: e.target.value }))} className={inputCls}>
                <option value="">카테고리 없음</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">승인 상태</label>
              <div className="flex gap-2">
                <button type="button" onClick={() => setEditForm(f => ({ ...f, approved: false }))}
                  className={`flex-1 py-2.5 rounded-xl border text-sm font-medium transition-colors ${!editForm.approved ? 'border-gray-500 bg-gray-100 text-gray-800' : 'border-gray-200 text-gray-400 hover:bg-gray-50'}`}>
                  미승인
                </button>
                <button type="button" onClick={() => setEditForm(f => ({ ...f, approved: true }))}
                  className={`flex-1 py-2.5 rounded-xl border text-sm font-medium transition-colors ${editForm.approved ? 'border-green-500 bg-green-50 text-green-700' : 'border-gray-200 text-gray-400 hover:bg-gray-50'}`}>
                  ✓ 승인
                </button>
              </div>
            </div>
          </div>
          <div className="px-6 py-4 border-t border-gray-100 bg-gray-50 flex justify-end gap-2">
            <button type="button" onClick={() => setModal('detail')} className="px-4 py-2 rounded-lg border border-gray-300 text-sm hover:bg-white">취소</button>
            <button type="button" onClick={() => void handleSaveEdit()} disabled={editSaving || !editForm.name.trim()}
              className="px-4 py-2 rounded-lg bg-gray-900 text-white text-sm hover:bg-gray-800 disabled:opacity-40">
              {editSaving ? '저장 중...' : '저장'}
            </button>
          </div>
        </Modal>
      )}

      {modal === 'delete' && deleteTarget && <Modal title="에셋 삭제" onClose={() => { setDeleteTarget(null); setModal('detail'); }}><div className="px-6 py-6 space-y-3"><p className="text-sm text-gray-700"><span className="font-medium text-gray-900">{deleteTarget.name}</span> 을(를) 삭제합니다.</p><p className="text-sm text-red-600">삭제 후에는 복구할 수 없습니다.</p></div><div className="px-6 py-4 border-t border-gray-100 bg-gray-50 flex justify-end gap-2"><button type="button" onClick={() => { setDeleteTarget(null); setModal('detail'); }} className="px-4 py-2 rounded-lg border border-gray-300 text-sm hover:bg-white">취소</button><button type="button" onClick={() => void handleDelete()} className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm hover:bg-red-700">삭제</button></div></Modal>}
      {editorOpen && selected && editorObject && (
        <Suspense fallback={null}>
          <MeshCropEditor
            flyUrl={assetsApi.getStreamUrl(editorObject)}
            initialObb={{
              center: obbCenter.map(Number) as [number, number, number],
              rotation: obbRotation.map(Number) as [number, number, number],
              scale: obbScale.map(Number) as [number, number, number],
            }}
            versions={editorVersions}
            initialCalibrationScale={selectedCalibrationScale}
            initialCalibrationReferenceLength={selectedCalibrationReferenceLength}
            assetType={selected.type}
            loading={cropLoading}
            showConvertActions={selected.status === 'awaiting_crop'}
            downloadBaseName={selected.name}
            onClose={() => setEditorOpen(false)}
            onDraftObbChange={handleDraftObbChange}
            onCreateVersion={handleCreateVersion}
            onUpdateVersion={handleUpdateVersion}
            onDeleteVersion={handleDeleteVersion}
            onSetRepresentative={handleSetRepresentative}
            representativeSceneObject={selected.metadata?.representativeSceneObject ?? null}
            onSaveCalibration={handleSaveCalibration}
            onSaveEdit={handleSaveCroppedScene}
            onSaveExtractedAsset={handleCreateExtractedAsset}
            getSceneUrl={assetsApi.getStreamUrl}
            onConfirm={selected.status === 'awaiting_crop'
              ? (obb) => {
                if (obb) void handleResumeStage2(true, obb);
                else void handleResumeStage2(false);
              }
              : undefined}
          />
        </Suspense>
      )}
      {alert && <Modal title="알림" onClose={() => setAlert(null)} zClass="z-[70]"><div className="px-6 py-6 text-sm text-gray-700 whitespace-pre-line">{alert}</div><div className="px-6 py-4 border-t border-gray-100 bg-gray-50 flex justify-end"><button type="button" onClick={() => setAlert(null)} className="px-4 py-2 rounded-lg bg-gray-900 text-white text-sm hover:bg-gray-800">확인</button></div></Modal>}
    </div>
  );
}
