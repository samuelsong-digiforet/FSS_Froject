import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams } from 'react-router-dom';
import {
  assetsApi,
  type Asset,
  type AssetGdtAnnotation,
  type AssetObb,
  type AssetObbVersion,
  type AssetVraPoint,
  type MeshInteropDownloadFormat,
  type AssetStatus,
  type AssetType,
  type AssetUploadMode,
  type GenerationQuality,
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
import { downloadMeshAssetFormat, getAssetDownloadName, supportsMeshFormatDownload } from '@/utils/meshDownloads';

const ModelViewer = lazy(() => import('@/components/ModelViewer'));
const MeshCropEditor = lazy(() => import('@/components/MeshCropEditor'));
const AssemblyExploder = lazy(() => import('@/components/AssemblyExploder'));
const NerfFrameCarousel = lazy(() => import('@/components/NerfFrameCarousel'));

type ModalType = 'none' | 'create' | 'detail' | 'delete' | 'edit' | 'texture';
type FileKind = 'image' | 'video' | 'model' | 'pointcloud' | 'zip' | 'other';
type StoredObb = {
  center: [string, string, string];
  rotation: [string, string, string];
  scale: [string, string, string];
};
type ResumeOverride =
  | { center: number[]; rotation: number[]; scale: number[]; previewCenter?: number[]; previewBounds?: number[] }
  | null
  | undefined;

const ASSET_TYPES: AssetType[] = ['point_cloud', 'nerf', 'gaussian', 'mesh'];
const REGENERATABLE_ASSET_TYPES: AssetType[] = ['gaussian', 'nerf', 'point_cloud', 'mesh'];
const POLLABLE: AssetStatus[] = ['pending', 'processing'];
const DEFAULT_STORED_OBB: StoredObb = {
  center: ['0', '0', '0'],
  rotation: ['0', '0', '0'],
  scale: ['1', '1', '1'],
};
const inputCls = `w-full border border-gray-300 rounded-xl px-4 py-2.5 text-sm bg-white focus:outline-none focus:border-blue-500`;
const UPLOAD_MODE_LABELS: Record<AssetUploadMode, string> = {
  direct: '일반 업로드',
  convert: '변환 업로드',
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
const GENERATION_QUALITY_PRESETS: GenerationQuality[] = ['fast', 'normal', 'precise'];
const GENERATION_QUALITY_LABELS: Record<GenerationQuality, string> = {
  fast: '빠름',
  normal: '보통',
  precise: '정밀',
};
const ASSET_TYPE_BADGE_COLORS: Record<AssetType, string> = {
  point_cloud: 'bg-cyan-100 text-cyan-700',
  gaussian:    'bg-violet-100 text-violet-700',
  nerf:        'bg-orange-100 text-orange-700',
  mesh:        'bg-emerald-100 text-emerald-700',
};

const ASSET_TYPE_SUFFIX: Record<AssetType, string> = {
  gaussian: 'to 3DGS',
  nerf: 'to NeRF',
  point_cloud: 'to P.C',
  mesh: 'to mesh',
};

const GENERATION_QUALITY_HINTS: Record<GenerationQuality, string> = {
  fast: '기본 빠른 생성값',
  normal: '균형 생성값으로 재생성',
  precise: '평가 제출용 정밀 생성값',
};

const QUALITY_SPEC_ROWS: Record<AssetType, { label: string; values: Record<GenerationQuality, string> }[]> = {
  gaussian: [
    { label: '학습 반복', values: { fast: '3,000', normal: '7,000', precise: '15,000' } },
    { label: 'Entropy Loss\n추가 학습', values: { fast: '✕', normal: '✕', precise: '2,000' } },
    { label: 'Requalization\nTerm 적용', values: { fast: '✕', normal: '✕', precise: '6,000' } },
  ],
  nerf: [{ label: '학습 반복', values: { fast: '5,000', normal: '15,000', precise: '30,000' } }],
  point_cloud: [{ label: '최대 포인트', values: { fast: '300,000', normal: '700,000', precise: '1,000,000' } }],
  mesh: [{ label: '학습 반복', values: { fast: '5,000', normal: '15,000', precise: '30,000' } }],
};

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
  if (asset.previewObject && !(asset.type === 'gaussian' && asset.status !== 'done')) return asset.previewObject;
  const ext = asset.sourceObject.split('.').pop()?.toLowerCase() ?? '';
  return ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff', 'mp4', 'mov', 'avi', 'mkv'].includes(ext)
    ? asset.sourceObject
    : undefined;
}

function getBestEditorObject(asset: Asset): string | undefined {
  return [asset.status === 'done' ? asset.outputObject : undefined, asset.previewObject]
    .filter((value): value is string => !!value)
    .find((value) => ['ply', 'glb', 'gltf'].includes(value.split('.').pop()?.toLowerCase() ?? ''));
}

function getBestAssemblyObject(asset: Asset): string | undefined {
  return [
    asset.metadata?.representativeSceneObject,
    asset.status === 'done' ? asset.outputObject : undefined,
    asset.previewObject,
    asset.sourceObject,
  ]
    .filter((value): value is string => !!value)
    .find((value) => ['glb', 'gltf'].includes(value.split('.').pop()?.toLowerCase() ?? ''));
}

function getGenerationQuality(asset: Asset | null | undefined): GenerationQuality {
  const raw = asset?.metadata?.generationQuality;
  return GENERATION_QUALITY_PRESETS.includes(raw as GenerationQuality) ? (raw as GenerationQuality) : 'fast';
}

function isDirectUploadAsset(asset: Asset | null | undefined): boolean {
  if (!asset) return false;
  if (asset.metadata?.uploadMode === 'direct') return true;
  if (asset.metadata?.uploadMode === 'convert') return false;

  return asset.status === 'done' && !!asset.outputObject && asset.outputObject === asset.sourceObject;
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
  return createPortal(
    <div className={`fixed inset-0 ${zClass} bg-black/60 p-4 flex items-center justify-center`}>
      <div
        className={`w-full ${wide ? 'max-w-6xl' : 'max-w-2xl'} max-h-[90vh] bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col`}
      >
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="w-9 h-9 rounded-full border border-gray-200 text-gray-500 hover:text-gray-700"
          >
            ×
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto bg-white">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

function FilterDropdown<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);
  const displayLabel = value === ('all' as T) ? label : (selected?.label ?? label);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={ref} className={`relative select-none${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-0 rounded-lg border border-gray-300 bg-white text-sm text-gray-700 hover:border-gray-400"
      >
        <span className="flex-1 px-4 py-2.5 whitespace-nowrap text-left">{displayLabel}</span>
        <span className="w-px self-stretch bg-gray-300 shrink-0" />
        <span className="flex items-center justify-center px-3 py-2.5 text-gray-500 shrink-0">
          {open ? (
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M18 15l-6-6-6 6" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M6 9l6 6 6-6" />
            </svg>
          )}
        </span>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 min-w-full rounded-lg border border-gray-200 bg-white shadow-lg overflow-hidden">
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
              className={`w-full px-4 py-2.5 text-left text-sm whitespace-nowrap hover:bg-gray-50 transition-colors ${value === opt.value ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700'}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: AssetStatus }) {
  return (
    <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-medium ${ASSET_STATUS_COLORS[status]}`}>
      {ASSET_STATUS_LABELS[status]}
    </span>
  );
}

export default function AssetsPage() {
  const navigate = useNavigate();
  const { assetId: urlAssetId } = useParams<{ assetId: string }>();
  const perm = usePermission('asset_manage');
  const [assets, setAssets] = useState<Asset[]>([]);
  const [categories, setCategories] = useState<AssetCategory[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | undefined>();
  const [search, setSearch] = useState('');
  const [filterUploadMode, setFilterUploadMode] = useState<'all' | 'direct' | 'convert'>('all');
  const [filterStatus, setFilterStatus] = useState<AssetStatus | 'all'>('all');
  const [filterType, setFilterType] = useState<AssetType | 'all'>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const PAGE_SIZE = 5;
  const [loading, setLoading] = useState(false);
  const [alert, setAlert] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalType>('none');
  const [selected, setSelected] = useState<Asset | null>(null);
  const [qualityMetricTab, setQualityMetricTab] = useState<'psnr_ssim' | 'vra' | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Asset | null>(null);
  const [form, setForm] = useState<{
    name: string;
    description: string;
    type: AssetType;
    categoryId: string;
    outputProfile: AssetOutputProfile;
    uploadMode: AssetUploadMode;
  }>({
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
  const [assemblyOpen, setAssemblyOpen] = useState(false);
  const [editorVersions, setEditorVersions] = useState<AssetObbVersion[]>([]);
  const [editForm, setEditForm] = useState<{
    name: string;
    description: string;
    categoryId: string;
    approved: boolean;
  }>({ name: '', description: '', categoryId: '', approved: false });
  const [editSaving, setEditSaving] = useState(false);
  const [meshConvertLoading, setMeshConvertLoading] = useState(false);
  const [meshDownloadLoading, setMeshDownloadLoading] = useState<MeshInteropDownloadFormat | null>(null);
  const [qualityLoading, setQualityLoading] = useState<GenerationQuality | null>(null);
  const [downloadDropdownOpen, setDownloadDropdownOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const applyStoredObb = useCallback((stored: StoredObb) => {
    setObbCenter(stored.center);
    setObbRotation(stored.rotation);
    setObbScale(stored.scale);
  }, []);

  const syncDraftObb = useCallback(
    (assetId: string, obb: AssetObb) => {
      const stored = toStoredObb(obb);
      applyStoredObb(stored);
      saveObb(assetId, stored);
    },
    [applyStoredObb],
  );
  const selectedId = selected?.id ?? null;
  const handleDraftObbChange = useCallback(
    (obb: AssetObb) => {
      if (!selectedId) return;
      syncDraftObb(selectedId, obb);
    },
    [selectedId, syncDraftObb],
  );

  const applyUpdatedAsset = useCallback((updated: Asset) => {
    setSelected((prev) => (prev?.id === updated.id ? updated : prev));
    setAssets((prev) => prev.map((asset) => (asset.id === updated.id ? updated : asset)));
  }, []);

  const fetchAssets = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const { data } = await assetsApi.getAll(selectedCategoryId ? { categoryId: selectedCategoryId } : undefined);
        setAssets(data);
      } catch {
        if (!silent) setAlert('에셋 목록을 불러오지 못했습니다.');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [selectedCategoryId],
  );

  const refreshSelected = useCallback(async (id: string) => {
    try {
      const { data } = await assetsApi.getOne(id);
      setSelected(data);
    } catch {
      setAlert('에셋 상세 정보를 불러오지 못했습니다.');
    }
  }, []);

  useEffect(() => {
    if (perm.isLoaded && perm.view) void fetchAssets();
  }, [perm.isLoaded, perm.view, fetchAssets]);

  // URL에 assetId가 있으면 해당 에셋의 편집기를 자동으로 열기
  useEffect(() => {
    if (!urlAssetId || !perm.isLoaded || !perm.view) return;
    void (async () => {
      try {
        const { data } = await assetsApi.getOneByUuid(urlAssetId);
        const saved = loadObb(data.id);
        const fallback = getStoredObbFromAsset(data) ?? DEFAULT_STORED_OBB;
        applyStoredObb(saved ?? fallback);
        setEditorVersions(getInitialVersionsForAsset(data, toAssetObb(saved ?? fallback)));
        const metaCenter = getPreviewCenterFromMetadata(data);
        const metaBounds = getPreviewBoundsFromMetadata(data);
        if (metaCenter) setPreviewCenter(metaCenter);
        if (metaBounds) setPreviewBounds(metaBounds);
        setSelected(data);
        setModal('detail');
        if (data.type !== 'nerf') setEditorOpen(true);
      } catch {
        navigate('/assets', { replace: true });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlAssetId, perm.isLoaded, perm.view]);

  useEffect(() => {
    assetCategoriesApi
      .getAll({ limit: 100 })
      .then(({ data }) => setCategories(data.items))
      .catch(() => {});
  }, []);
  useEffect(() => {
    const shouldPoll =
      assets.some((asset) => POLLABLE.includes(asset.status)) || (!!selected && POLLABLE.includes(selected.status));
    if (!shouldPoll) return;
    const timer = window.setInterval(
      () => {
        void fetchAssets(true);
        if (selected) void refreshSelected(selected.id);
      },
      3 * 60 * 1000,
    );
    return () => window.clearInterval(timer);
  }, [assets, selected, fetchAssets, refreshSelected]);
  useEffect(() => {
    if (!editorOpen || !selected) return;

    let cancelled = false;
    const fallbackStored = loadObb(selected.id) ?? getStoredObbFromAsset(selected) ?? DEFAULT_STORED_OBB;
    const fallbackObb = toAssetObb(fallbackStored);
    setEditorVersions(getInitialVersionsForAsset(selected, fallbackObb));

    void assetsApi
      .getVersions(selected.id)
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
      const matchesQuery =
        !q || asset.name.toLowerCase().includes(q) || ASSET_TYPE_LABELS[asset.type].toLowerCase().includes(q);
      const matchesUploadMode =
        filterUploadMode === 'all' ||
        (filterUploadMode === 'direct' ? isDirectUploadAsset(asset) : !isDirectUploadAsset(asset));
      const matchesStatus = filterStatus === 'all' || asset.status === filterStatus;
      const matchesType = filterType === 'all' || asset.type === filterType;
      return matchesCategory && matchesQuery && matchesUploadMode && matchesStatus && matchesType;
    })
    .sort((a, b) => (assetSequenceMap.get(b.id) ?? 0) - (assetSequenceMap.get(a.id) ?? 0));

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const pagedAssets = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const exportablePageIds = pagedAssets
    .filter((asset) => asset.status === 'done' && asset.approved)
    .map((asset) => String(asset.id));
  const createProfiles = getOutputProfilesForType(form.type);
  const createFormatConfig = getUploadFormatConfig(form.type, form.uploadMode);
  const detectedInput = file ? detectInputFormatFromName(file.name) : undefined;
  const previewObject = selected ? (getBestPreviewObject(selected) ?? selected.sourceObject) : undefined;
  const previewType = previewObject ? getFileType(previewObject) : 'other';
  const previewUrl = previewObject ? assetsApi.getStreamUrl(previewObject) : undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const previewSceneCenter = useMemo(
    () => getPreviewCenterFromMetadata(selected),
    [JSON.stringify(selected?.metadata?.previewCenter)],
  );
  const editorObject = selected ? getBestEditorObject(selected) : undefined;
  const assemblyObject = selected ? getBestAssemblyObject(selected) : undefined;
  const selectedInput = selected ? getAssetInputFormat(selected) : undefined;
  const selectedProfile = selected ? getAssetOutputProfile(selected) : undefined;
  const selectedCategoryName = getCategoryDisplayName(selected, categories);
  const selectedSourceObjectName = getObjectDisplayName(selected?.sourceObject);
  const selectedOutputObjectName = getObjectDisplayName(selected?.outputObject);
  const selectedCalibrationScale = getCalibrationScaleFromMetadata(selected);
  const selectedCalibrationReferenceLength = getCalibrationReferenceLengthFromMetadata(selected);
  const canSelectMeshDownloadFormat = supportsMeshFormatDownload(selected);
  const selectedGenerationQuality = getGenerationQuality(selected);
  const selectedSupportsGenerationQuality = !!selected && REGENERATABLE_ASSET_TYPES.includes(selected.type);
  const selectedIsDirectUpload = isDirectUploadAsset(selected);
  const canRegenerateQuality =
    !!selected && selected.status === 'done' && !selectedIsDirectUpload && selectedSupportsGenerationQuality;
  const showGenerationQualityPanel = selectedSupportsGenerationQuality;

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
    setAssemblyOpen(false);
    setPreviewCenter([0, 0, 0]);
    setPreviewBounds([0, 0, 0]);
    try {
      const { data } = await assetsApi.getOne(asset.id);
      const saved = loadObb(data.id);
      const fallback = getStoredObbFromAsset(data) ?? DEFAULT_STORED_OBB;
      applyStoredObb(saved ?? fallback);
      setEditorVersions(getInitialVersionsForAsset(data, toAssetObb(saved ?? fallback)));
      // metadata에 저장된 previewCenter/previewBounds로 초기화 (3D 뷰어 로딩 전에 변환 요청해도 올바른 값 전송)
      const metaCenter = getPreviewCenterFromMetadata(data);
      const metaBounds = getPreviewBoundsFromMetadata(data);
      if (metaCenter) setPreviewCenter(metaCenter);
      if (metaBounds) setPreviewBounds(metaBounds);
      setSelected(data);
      setQualityMetricTab(data.type === 'mesh' ? 'vra' : data.type === 'gaussian' ? 'psnr_ssim' : null);
      setModal('detail');
    } catch {
      setAlert('에셋 상세 정보를 불러오지 못했습니다.');
    }
  };

  const handleCreate = async () => {
    if (!form.name.trim()) return setFormError('에셋명을 입력하세요.');
    if (!file) return setFormError('업로드할 파일을 선택하세요.');
    if (form.uploadMode === 'direct' && directDetecting)
      return setFormError('파일 타입을 판별하는 중입니다. 잠시 후 다시 시도해주세요.');
    if (!isAllowedUploadFile(form.type, form.uploadMode, file.name)) {
      return setFormError(
        `${UPLOAD_MODE_LABELS[form.uploadMode]}에서는 ${formatExtensions(createFormatConfig.exts)} 파일만 업로드할 수 있습니다.`,
      );
    }
    const effectiveType = form.uploadMode === 'direct' ? directDetectedType : form.type;
    if (!effectiveType) {
      return setFormError('일반 업로드 파일 타입을 자동 판별하지 못했습니다. GLB, PLY, ZIP 파일인지 확인해주세요.');
    }
    setUploading(true);
    setFormError('');
    try {
      const { data: uploaded } = await assetsApi.upload(file, setUploadPct);
      const isConvert = form.uploadMode === 'convert';
      const baseName = form.name.trim();
      const assetName = isConvert ? `${baseName} ${ASSET_TYPE_SUFFIX[effectiveType]}`.trim() : baseName;
      const assetDescription = isConvert ? '생성 품질 : 빠름' : form.description.trim() || undefined;
      await assetsApi.create({
        name: assetName,
        description: assetDescription,
        type: effectiveType,
        sourceObject: uploaded.objectName,
        categoryId: form.categoryId ? Number(form.categoryId) : undefined,
        ...(isConvert ? { outputProfile: form.outputProfile } : {}),
        uploadMode: form.uploadMode,
      });
      setModal('none');
      await fetchAssets();
      setAlert(form.uploadMode === 'direct' ? '에셋 업로드를 완료했습니다.' : '에셋 업로드 후 변환을 시작했습니다.');
    } catch (error: unknown) {
      const message = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
      setFormError(message ?? '에셋 업로드에 실패했습니다.');
    } finally {
      setUploading(false);
      setUploadPct(0);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await assetsApi.remove(deleteTarget.id);
      setDeleteTarget(null);
      setSelected(null);
      setModal('none');
      await fetchAssets();
      setAlert('에셋을 삭제했습니다.');
    } catch {
      setAlert('에셋 삭제에 실패했습니다.');
    }
  };

  const [actionLoading, setActionLoading] = useState<'retry' | 'cancel' | null>(null);

  const handleRetry = async () => {
    if (!selected) return;
    setActionLoading('retry');
    try {
      const quality = (selected.metadata?.generationQuality as GenerationQuality | undefined) ?? 'normal';
      const { data: updated } = await assetsApi.retry(selected.id, quality);
      setSelected(updated);
      void fetchAssets();
      setAlert('재시도를 시작했습니다.');
    } catch {
      setAlert('재시도에 실패했습니다.');
    } finally {
      setActionLoading(null);
    }
  };

  const handleCancelJob = async () => {
    if (!selected) return;
    setActionLoading('cancel');
    try {
      const { data: updated } = await assetsApi.cancel(selected.id);
      setSelected(updated);
      void fetchAssets();
      setAlert('작업을 중지했습니다.');
    } catch {
      setAlert('작업 중지에 실패했습니다.');
    } finally {
      setActionLoading(null);
    }
  };

  const handleResumeStage2 = async (withCrop: boolean, override?: ResumeOverride) => {
    if (!selected) return;
    setCropLoading(true);
    try {
      const params = override
        ? {
            obbCenter: override.center,
            obbRotation: override.rotation,
            obbScale: override.scale,
            previewCenter: override.previewCenter ?? previewCenter,
            previewBounds: override.previewBounds ?? previewBounds,
          }
        : withCrop
          ? {
              obbCenter: obbCenter.map(Number),
              obbRotation: obbRotation.map(Number),
              obbScale: obbScale.map(Number),
              previewCenter,
              previewBounds,
            }
          : {};
      await assetsApi.resumeStage2(selected.id, params);
      localStorage.removeItem(`obb_params_${selected.id}`);
      setEditorOpen(false);
      setModal('none');
      navigate('/assets', { replace: true });
      await fetchAssets();
      setAlert(withCrop ? '선택 영역 변환을 재개했습니다.' : '전체 변환을 재개했습니다.');
    } catch (error: unknown) {
      const message = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
      setAlert(message ?? '2단계 변환 재개에 실패했습니다.');
    } finally {
      setCropLoading(false);
    }
  };

  const handleRegenerateQuality = async (qualityPreset: GenerationQuality) => {
    if (!selected || !canRegenerateQuality || qualityPreset === selectedGenerationQuality) return;
    setQualityLoading(qualityPreset);
    try {
      await assetsApi.clone(selected.id, qualityPreset);
      await fetchAssets();
      setAlert(`${GENERATION_QUALITY_LABELS[qualityPreset]} 품질 복사본 생성을 시작했습니다.`);
    } catch (error: unknown) {
      const message = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
      setAlert(message ?? '품질 복사본 생성을 시작하지 못했습니다.');
    } finally {
      setQualityLoading(null);
    }
  };

  const handleSaveCalibration = useCallback(
    async (calibrationScale: number, calibrationReferenceLength: number, calibrationMeasuredLength: number) => {
      if (!selectedId) return;

      const { data: updated } = await assetsApi.update(selectedId, {
        calibrationScale,
        calibrationReferenceLength,
        calibrationMeasuredLength,
      });

      applyUpdatedAsset(updated);
    },
    [applyUpdatedAsset, selectedId],
  );

  const handleSaveVra = useCallback(
    async (vra: number, vraPoints: AssetVraPoint[]) => {
      if (!selectedId) return;
      const { data: updated } = await assetsApi.update(selectedId, { volumeRenderingAccuracy: vra, vraPoints });
      applyUpdatedAsset(updated);
    },
    [applyUpdatedAsset, selectedId],
  );

  const handleSaveGdtAnnotations = useCallback(
    async (gdtAnnotations: AssetGdtAnnotation[]) => {
      if (!selectedId) return;
      const { data: updated } = await assetsApi.update(selectedId, { gdtAnnotations });
      applyUpdatedAsset(updated);
    },
    [applyUpdatedAsset, selectedId],
  );

  const handleSaveVraPoints = useCallback(
    async (vraPoints: AssetVraPoint[]) => {
      if (!selectedId) return;
      const { data: updated } = await assetsApi.update(selectedId, { vraPoints });
      applyUpdatedAsset(updated);
    },
    [applyUpdatedAsset, selectedId],
  );

  const handleSaveCroppedScene = useCallback(
    async (blob: Blob, ext: string) => {
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
    },
    [fetchAssets, selected],
  );

  const handleCreateExtractedAsset = useCallback(
    async ({ blob, ext, assetType }: { blob: Blob; ext: string; assetType: AssetType }) => {
      if (!selected) return;

      const safeName = selected.name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'extract';
      const file = new File([blob], `${safeName}-extract.${ext}`, { type: blob.type });
      const { data: upload } = await assetsApi.upload(file);
      const extractBaseName = selected.name.replace(/ to (3DGS|NeRF|P\.C|mesh)$/i, '').trim();
      await assetsApi.create({
        name: `${extractBaseName} ${ASSET_TYPE_SUFFIX[assetType]}`.trim(),
        description: '생성 품질 : 빠름',
        type: assetType,
        sourceObject: upload.objectName,
        categoryId: selected.categoryId ?? undefined,
        uploadMode: 'direct',
      });
      await fetchAssets();
    },
    [fetchAssets, selected],
  );

  const handleCreateVersion = useCallback(
    async ({
      description,
      obb,
      sceneBlob,
      sceneExt,
    }: {
      description?: string;
      obb: AssetObb;
      sceneBlob?: Blob;
      sceneExt?: string;
    }): Promise<AssetObbVersion | void> => {
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
        setAssets((prev) =>
          prev.map((asset) =>
            asset.id === updated.id ? { ...asset, metadata: updated.metadata, updatedAt: updated.updatedAt } : asset,
          ),
        );
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
    },
    [selected, syncDraftObb],
  );

  const handleUpdateVersion = useCallback(
    async ({ versionId, description, obb }: { versionId: string; description?: string; obb: AssetObb }) => {
      if (!selected) return;

      try {
        const { data: updated } = await assetsApi.updateVersion(selected.id, versionId, {
          description: description?.trim() || undefined,
          ...obb,
        });

        setSelected(updated);
        setEditorVersions(mergeVersions(getAssetObbVersions(updated), loadLocalVersions(updated.id)));
        setAssets((prev) =>
          prev.map((asset) =>
            asset.id === updated.id ? { ...asset, metadata: updated.metadata, updatedAt: updated.updatedAt } : asset,
          ),
        );
        syncDraftObb(updated.id, obb);
        return;
      } catch (error: unknown) {
        if (!isNotFoundError(error)) throw error;
      }

      const localVersions = loadLocalVersions(selected.id);
      const targetExists = localVersions.some((version) => version.id === versionId);
      if (!targetExists) throw new Error('버전을 수정할 수 없습니다.');

      const nextVersions = localVersions.map((version) =>
        version.id === versionId ? { ...version, description: description?.trim() ?? '', obb } : version,
      );
      saveLocalVersions(selected.id, nextVersions);
      setEditorVersions(mergeVersions(getAssetObbVersions(selected), nextVersions));
      syncDraftObb(selected.id, obb);
    },
    [selected, syncDraftObb],
  );

  const handleDeleteVersion = useCallback(
    async (versionId: string) => {
      if (!selected) return;

      try {
        const { data: updated } = await assetsApi.removeVersion(selected.id, versionId);
        setSelected(updated);
        setEditorVersions(mergeVersions(getAssetObbVersions(updated), loadLocalVersions(updated.id)));
        setAssets((prev) =>
          prev.map((asset) =>
            asset.id === updated.id ? { ...asset, metadata: updated.metadata, updatedAt: updated.updatedAt } : asset,
          ),
        );
        return;
      } catch (error: unknown) {
        if (!isNotFoundError(error)) throw error;
      }

      const localVersions = loadLocalVersions(selected.id);
      const nextVersions = localVersions.filter((version) => version.id !== versionId);
      if (nextVersions.length === localVersions.length) throw new Error('버전을 삭제할 수 없습니다.');

      saveLocalVersions(selected.id, nextVersions);
      setEditorVersions(mergeVersions(getAssetObbVersions(selected), nextVersions));
    },
    [selected],
  );

  const handleSetRepresentative = useCallback(
    async (version: AssetObbVersion) => {
      if (!selected) return;
      setAlert('대표 버전이 설정되었습니다.');
      try {
        // sceneObject 없으면 null 전송 → 백엔드에서 대표 해제(초기 상태로 복원)
        const { data: updated } = await assetsApi.update(selected.id, {
          representativeSceneObject: version.sceneObject ?? null,
        });
        setSelected(updated);
        setAssets((prev) =>
          prev.map((a) =>
            a.id === updated.id ? { ...a, metadata: updated.metadata, updatedAt: updated.updatedAt } : a,
          ),
        );
      } catch {
        setAlert('대표 버전 설정에 실패했습니다.');
      }
    },
    [selected],
  );

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
    } catch {
      setAlert('수정에 실패했습니다.');
    } finally {
      setEditSaving(false);
    }
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
        outputProfile: 'mesh_interop_bundle',
      });
      await fetchAssets();
      setModal('none');
      setAlert(`"${selected.name} - to MeSH" 에셋 변환을 시작했습니다.`);
    } catch (error: unknown) {
      const message = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
      const lower = (message ?? '').toLowerCase();
      const isSimilarityError =
        lower.includes('match') ||
        lower.includes('similar') ||
        lower.includes('feature') ||
        lower.includes('colmap') ||
        lower.includes('correspond');
      setAlert(
        isSimilarityError ? '변환할 파일의 유사도가 충분하지 않습니다.' : (message ?? 'MeSH 변환 요청에 실패했습니다.'),
      );
    } finally {
      setMeshConvertLoading(false);
    }
  };

  const handleExport = async () => {
    if (checkedIds.size === 0 || exporting) return;
    setExporting(true);
    try {
      const { data: results } = await assetsApi.exportToExternal([...checkedIds]);
      const created = results.filter((result) => result.status === 'created').length;
      const updated = results.filter((result) => result.status === 'updated').length;
      setCheckedIds(new Set());
      await fetchAssets(true);
      setAlert(`디지털 트윈 전송 완료\n신규: ${created}건 / 업데이트: ${updated}건`);
    } catch (error: unknown) {
      const axiosError = error as { response?: { status?: number; data?: unknown }; message?: string };
      const response = axiosError?.response;
      const data = response?.data;
      const rawMessage =
        typeof data === 'string'
          ? data
          : typeof data === 'object' && data && 'message' in data
            ? typeof data.message === 'string'
              ? data.message
              : Array.isArray(data.message)
                ? data.message.find((message): message is string => typeof message === 'string')
                : undefined
            : undefined;
      const isRouteMissing = response?.status === 404 || rawMessage?.toLowerCase().includes('cannot post');
      const lowerMessage = `${rawMessage ?? ''} ${axiosError?.message ?? ''}`.toLowerCase();
      const isServerConnectionError =
        response?.status === 500 ||
        response?.status === 502 ||
        response?.status === 503 ||
        lowerMessage.includes('internal server error') ||
        lowerMessage.includes('network error') ||
        lowerMessage.includes('failed to fetch') ||
        lowerMessage.includes('fetch failed') ||
        lowerMessage.includes('econnrefused') ||
        lowerMessage.includes('enotfound') ||
        lowerMessage.includes('timeout');
      setAlert(
        isRouteMissing
          ? '디지털 트윈 전송 기능을 준비 중입니다. 서버 반영 후 다시 시도해주세요.'
          : isServerConnectionError
            ? '디지털 트윈 서버 연결 오류로 전송에 실패했습니다. 잠시 후 다시 시도해주세요.'
            : (rawMessage ?? '디지털 트윈 전송에 실패했습니다. 잠시 후 다시 시도해주세요.'),
      );
    } finally {
      setExporting(false);
    }
  };

  const handleDownloadMeshArtifact = useCallback(async (asset: Asset, format: MeshInteropDownloadFormat) => {
    setMeshDownloadLoading(format);
    try {
      await downloadMeshAssetFormat(asset, format);
    } catch (err) {
      const is404 = (err as { response?: { status?: number } })?.response?.status === 404;
      if (is404 && format !== 'all') {
        setAlert(
          `${format.toUpperCase()} 포맷이 이 변환 결과에 포함되지 않았습니다. 에셋을 재변환하면 모든 포맷을 받을 수 있습니다.`,
        );
      } else {
        setAlert(
          format === 'all' ? '메쉬 전체 다운로드에 실패했습니다.' : `${format.toUpperCase()} 다운로드에 실패했습니다.`,
        );
      }
    } finally {
      setMeshDownloadLoading(null);
    }
  }, []);

  if (!perm.isLoaded)
    return (
      <div className="h-full flex items-center justify-center text-sm text-gray-500">
        권한 정보를 불러오는 중입니다.
      </div>
    );
  if (!perm.view)
    return (
      <div className="h-full flex items-center justify-center text-sm text-gray-500">에셋 관리 권한이 없습니다.</div>
    );

  return (
    <div className="p-6 md:p-8 bg-gray-50 min-h-full space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">에셋 관리</h1>
          <p className="text-sm text-gray-500 mt-1">입력 포맷 자동 감지와 출력 프로파일 기반 변환을 관리합니다.</p>
        </div>
        <div className="flex items-center gap-2 self-start">
          <button
            type="button"
            onClick={() => void handleExport()}
            disabled={exporting || checkedIds.size === 0}
            className="px-4 py-2.5 rounded-xl bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {exporting
              ? '전송 중...'
              : checkedIds.size > 0
                ? `디지털 트윈 전송 (${checkedIds.size}건)`
                : '디지털 트윈 전송'}
          </button>
          {perm.create && (
            <button
              type="button"
              onClick={openCreate}
              className="px-4 py-2.5 rounded-xl bg-gray-900 text-white text-sm hover:bg-gray-800"
            >
              새 에셋 업로드
            </button>
          )}
        </div>
      </div>
      <div className="flex gap-3 items-center">
        <div className="relative flex-1">
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setCurrentPage(1);
            }}
            placeholder="에셋명 또는 유형으로 검색"
            className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 pr-11 text-sm focus:outline-none focus:border-blue-500"
          />
          <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400">⌕</span>
        </div>
        <FilterDropdown
          label="카테고리"
          value={selectedCategoryId != null ? String(selectedCategoryId) : 'all'}
          options={[
            { value: 'all', label: '전체' },
            ...categories.map((c) => ({ value: String(c.id), label: c.name })),
          ]}
          onChange={(v) => {
            setSelectedCategoryId(v === 'all' ? undefined : Number(v));
            setCurrentPage(1);
          }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <FilterDropdown
          label="구분"
          value={filterUploadMode}
          options={[
            { value: 'all', label: '전체' },
            { value: 'convert', label: '변환' },
            { value: 'direct', label: '일반' },
          ]}
          onChange={(v) => {
            setFilterUploadMode(v);
            setCurrentPage(1);
          }}
          className="min-w-[90px]"
        />
        <FilterDropdown
          label="처리 상태"
          value={filterStatus}
          options={[
            { value: 'all', label: '전체' },
            { value: 'done', label: '완료' },
            { value: 'failed', label: '실패' },
            { value: 'pending', label: '대기' },
            { value: 'processing', label: '처리 중' },
            { value: 'awaiting_crop', label: '영역 선택 대기' },
          ]}
          onChange={(v) => {
            setFilterStatus(v);
            setCurrentPage(1);
          }}
          className="min-w-[120px]"
        />
        <FilterDropdown
          label="파일 타입"
          value={filterType}
          options={[
            { value: 'all', label: '전체' },
            { value: 'point_cloud', label: '포인트 클라우드' },
            { value: 'gaussian', label: '3DGS' },
            { value: 'nerf', label: 'NeRF' },
            { value: 'mesh', label: 'Mesh' },
          ]}
          onChange={(v) => {
            setFilterType(v);
            setCurrentPage(1);
          }}
          className="min-w-[120px]"
        />
        <button
          type="button"
          onClick={() => {
            setSearch('');
            setSelectedCategoryId(undefined);
            setFilterUploadMode('all');
            setFilterStatus('all');
            setFilterType('all');
            setCurrentPage(1);
          }}
          className="flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3.5 py-2.5 text-sm text-gray-500 hover:border-gray-400 hover:text-gray-700 transition-colors"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
          </svg>
          초기화
        </button>
      </div>
      <div className="text-sm text-gray-500">총 {filtered.length}건</div>
      {loading ? (
        <div className="py-20 text-center text-sm text-gray-400">목록을 불러오는 중입니다.</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white py-20 text-center text-sm text-gray-400 min-w-0 w-full">
          표시할 에셋이 없습니다.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white shadow-sm">
          <table className="w-full min-w-[1080px] table-fixed text-sm">
            <thead>
              <tr className="bg-[#2d4a7a] text-white divide-x divide-[#4a6a9a]">
                <th className="w-12 px-3 py-3 text-center font-medium">
                  {(() => {
                    const allChecked =
                      exportablePageIds.length > 0 && exportablePageIds.every((id) => checkedIds.has(id));
                    const someChecked = exportablePageIds.some((id) => checkedIds.has(id));
                    return (
                      <input
                        type="checkbox"
                        checked={allChecked}
                        ref={(el) => {
                          if (el) el.indeterminate = someChecked && !allChecked;
                        }}
                        onChange={(event) => {
                          setCheckedIds((prev) => {
                            const next = new Set(prev);
                            if (event.target.checked) {
                              exportablePageIds.forEach((id) => next.add(id));
                            } else {
                              exportablePageIds.forEach((id) => next.delete(id));
                            }
                            return next;
                          });
                        }}
                        disabled={exportablePageIds.length === 0}
                        className="accent-blue-600"
                      />
                    );
                  })()}
                </th>
                <th className="w-14 px-3 py-3 text-center font-medium">NO</th>
                <th className="w-20 px-3 py-3 text-center font-medium">구분</th>
                <th className="w-56 px-4 py-3 text-left font-medium">제목</th>
                <th className="w-72 px-4 py-3 text-left font-medium">설명</th>
                <th className="w-28 px-3 py-3 text-center font-medium">파일 타입</th>
                <th className="w-28 px-3 py-3 text-center font-medium">카테고리</th>
                <th className="w-28 px-3 py-3 text-center font-medium">처리 상태</th>
                <th className="w-24 px-3 py-3 text-center font-medium">승인 상태</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {pagedAssets.map((asset, index) => {
                const isDirect = isDirectUploadAsset(asset);
                const assetId = String(asset.id);
                const canExport = asset.status === 'done' && asset.approved;
                const isChecked = checkedIds.has(assetId);
                return (
                  <tr
                    key={asset.id}
                    onClick={() => {
                      if (perm.detail) void openDetail(asset);
                    }}
                    className={`divide-x divide-gray-200 ${index % 2 === 0 ? 'bg-white' : 'bg-gray-50'} ${perm.detail ? 'cursor-pointer transition-colors hover:bg-blue-50' : ''}`}
                  >
                    <td className="px-3 py-4 text-center">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        disabled={!canExport}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => {
                          setCheckedIds((prev) => {
                            const next = new Set(prev);
                            if (event.target.checked) next.add(assetId);
                            else next.delete(assetId);
                            return next;
                          });
                        }}
                        className="accent-blue-600 disabled:opacity-40"
                        title={canExport ? '디지털 트윈 전송 선택' : '완료 및 승인된 에셋만 전송할 수 있습니다.'}
                      />
                    </td>
                    <td className="px-3 py-4 text-center text-gray-500">
                      {assetSequenceMap.get(asset.id) ?? index + 1}
                    </td>
                    <td className="px-3 py-4 text-center">
                      <span
                        className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${isDirect ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'}`}
                      >
                        {isDirect ? '일반' : '변환'}
                      </span>
                    </td>
                    <td className="px-4 py-4 font-semibold text-gray-900 max-w-0 truncate" title={asset.name}>
                      {asset.name}
                    </td>
                    <td className="px-4 py-4 text-gray-600 max-w-0 truncate" title={asset.description?.trim() || '-'}>
                      {asset.description?.trim() || '-'}
                    </td>
                    <td className="px-3 py-4 text-center whitespace-nowrap">
                      <span className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${ASSET_TYPE_BADGE_COLORS[asset.type]}`}>
                        {asset.type === 'gaussian' ? '3DGS' : ASSET_TYPE_LABELS[asset.type]}
                      </span>
                    </td>
                    <td className="px-3 py-4 text-center text-gray-600 whitespace-nowrap">
                      {getCategoryDisplayName(asset, categories)}
                    </td>
                    <td className="px-3 py-4 text-center">
                      <StatusBadge status={asset.status} />
                    </td>
                    <td className="px-3 py-4 text-center">
                      <span
                        className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${asset.approved ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'}`}
                      >
                        {asset.approved ? '승인됨' : '미승인'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-1 pt-2">
          <button
            type="button"
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={safePage === 1}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-500 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {'‹'}
          </button>
          {(() => {
            const pages: (number | '...')[] = [];
            const blockStart = Math.floor((safePage - 1) / 5) * 5 + 1;
            const blockEnd = Math.min(blockStart + 4, totalPages);
            if (blockStart > 1) pages.push('...');
            for (let i = blockStart; i <= blockEnd; i++) pages.push(i);
            if (blockEnd < totalPages) pages.push('...');
            return pages.map((p, i) =>
              p === '...' ? (
                <span key={`ellipsis-${i}`} className="flex h-9 w-9 items-center justify-center text-sm text-gray-400">
                  …
                </span>
              ) : (
                <button
                  key={p}
                  type="button"
                  onClick={() => setCurrentPage(p as number)}
                  className={`flex h-9 w-9 items-center justify-center rounded-lg border text-sm font-medium transition-colors ${safePage === p ? 'border-blue-600 bg-blue-600 text-white' : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'}`}
                >
                  {p}
                </button>
              ),
            );
          })()}
          <button
            type="button"
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={safePage === totalPages}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-500 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {'›'}
          </button>
        </div>
      )}

      {modal === 'create' && (
        <Modal title="에셋 업로드" onClose={() => (!uploading ? setModal('none') : undefined)}>
          <div className="px-6 py-6 space-y-5">
            {/* 에셋명 */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                에셋명 <span className="text-red-500">*</span>
              </label>
              <input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="에셋명을 입력하세요"
                autoFocus
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                업로드 방식 <span className="text-red-500">*</span>
              </label>
              <div className="grid gap-2 sm:grid-cols-2">
                {(['direct', 'convert'] as const).map((mode) => (
                  <label
                    key={mode}
                    className={`flex items-start gap-3 rounded-xl border px-4 py-3 cursor-pointer transition-colors ${form.uploadMode === mode ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white hover:bg-gray-50'}`}
                  >
                    <input
                      type="radio"
                      name="uploadMode"
                      value={mode}
                      checked={form.uploadMode === mode}
                      onChange={() =>
                        setForm((prev) => ({
                          ...prev,
                          uploadMode: mode,
                          outputProfile: getDefaultOutputProfile(prev.type, file?.name),
                        }))
                      }
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
              <select
                value={form.categoryId}
                onChange={(e) => setForm((f) => ({ ...f, categoryId: e.target.value }))}
                className={inputCls}
              >
                <option value="">카테고리 없음</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            {/* 에셋 파일 타입 */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                에셋 파일 타입 <span className="text-red-500">*</span>
              </label>
              <div className={`grid grid-cols-2 gap-2 ${form.uploadMode === 'direct' ? 'opacity-60' : ''}`}>
                {ASSET_TYPES.map((type) => (
                  <label
                    key={type}
                    className={`flex items-center gap-2.5 rounded-xl border px-4 py-3 cursor-pointer transition-colors
                    ${form.type === type ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white hover:bg-gray-50'}
                    ${form.uploadMode === 'direct' ? 'cursor-not-allowed' : ''}`}
                  >
                    <input
                      type="radio"
                      name="assetType"
                      value={type}
                      checked={form.type === type}
                      disabled={form.uploadMode === 'direct'}
                      onChange={() => {
                        const t = type;
                        setForm((f) => ({ ...f, type: t, outputProfile: getDefaultOutputProfile(t, file?.name) }));
                      }}
                      className="accent-blue-600"
                    />
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
                    {directDetectedType
                      ? OUTPUT_PROFILE_LABELS[getDefaultOutputProfile(directDetectedType, file?.name)]
                      : '파일 선택 후 자동 결정'}
                  </p>
                  <p className="text-xs text-green-700 mt-1">일반 업로드는 변환 작업 없이 완료 상태로 등록됩니다.</p>
                </div>
              ) : (
                <div>
                  <p className="text-sm font-medium text-gray-800 mb-2">출력 프로파일</p>
                  <div className="space-y-2">
                    {createProfiles.map((profile) => (
                      <label
                        key={profile}
                        className={`block rounded-xl border px-4 py-3 cursor-pointer ${form.outputProfile === profile ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white'}`}
                      >
                        <div className="flex items-start gap-3">
                          <input
                            type="radio"
                            checked={form.outputProfile === profile}
                            onChange={() => setForm((f) => ({ ...f, outputProfile: profile }))}
                            className="mt-1"
                          />
                          <div>
                            <div className="text-sm font-medium text-gray-900">{OUTPUT_PROFILE_LABELS[profile]}</div>
                            <div className="text-xs text-gray-500 mt-1">{OUTPUT_PROFILE_DESCRIPTIONS[profile]}</div>
                            <div className="text-[11px] text-gray-400 mt-1 break-all">
                              {OUTPUT_PROFILE_ARTIFACTS[profile].join(', ')}
                            </div>
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
              <textarea
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                rows={3}
                placeholder="설명을 입력하세요"
                className={`${inputCls} resize-none`}
              />
            </div>
            {/* 파일 업로드 */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                파일 <span className="text-red-500">*</span>
              </label>
              <button
                type="button"
                onClick={() => {
                  if (!uploading) fileRef.current?.click();
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (!uploading) setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  if (uploading) return;
                  const f = e.dataTransfer.files?.[0] ?? null;
                  setFile(f);
                  if (f) setForm((prev) => ({ ...prev, outputProfile: getDefaultOutputProfile(prev.type, f.name) }));
                }}
                className={`w-full rounded-2xl border-2 border-dashed px-4 py-8 text-center transition-colors ${dragOver ? 'border-blue-500 bg-blue-50' : 'border-gray-300 bg-white hover:border-blue-400'}`}
              >
                {file ? (
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-gray-800">{file.name}</p>
                    <p className="text-xs text-gray-400">{formatSize(file.size)}</p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-gray-700">
                      {dragOver ? '여기에 놓으세요' : '클릭하거나 파일을 드래그하세요'}
                    </p>
                    <p className="text-xs text-gray-400">{formatExtensions(createFormatConfig.exts)}</p>
                  </div>
                )}
              </button>
              <input
                ref={fileRef}
                type="file"
                className="hidden"
                accept={createFormatConfig.exts.map((ext) => `.${ext}`).join(',')}
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setFile(f);
                  if (f) setForm((prev) => ({ ...prev, outputProfile: getDefaultOutputProfile(prev.type, f.name) }));
                }}
              />
              {uploading && (
                <div className="mt-3 space-y-1">
                  <div className="h-2 rounded-full bg-gray-200 overflow-hidden">
                    <div className="h-full bg-blue-500 transition-all" style={{ width: `${uploadPct}%` }} />
                  </div>
                  <div className="text-xs text-right text-gray-500">{uploadPct}%</div>
                </div>
              )}
            </div>
            {formError && <p className="text-sm text-red-600">{formError}</p>}
          </div>
          <div className="px-6 py-4 border-t border-gray-100 bg-gray-50 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setModal('none')}
              disabled={uploading}
              className="px-4 py-2 rounded-lg border border-gray-300 text-sm hover:bg-white disabled:opacity-40"
            >
              취소
            </button>
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={uploading || (form.uploadMode === 'direct' && directDetecting)}
              className="px-4 py-2 rounded-lg bg-gray-900 text-white text-sm hover:bg-gray-800 disabled:opacity-40"
            >
              {uploading ? '업로드 중...' : '업로드'}
            </button>
          </div>
        </Modal>
      )}

      {modal === 'detail' && selected && (
        <Modal title="에셋 상세" onClose={() => setModal('none')} wide>
          <div className="px-6 py-6 space-y-6">
            {/* 이름 + 버튼 행 */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <h3 className="text-base font-semibold text-gray-900 truncate">{selected.name}</h3>
                <span
                  className={`shrink-0 inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${selected.approved ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}
                >
                  {selected.approved ? '승인됨' : '미승인'}
                </span>
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    if (assemblyObject) setAssemblyOpen(true);
                  }}
                  disabled={!assemblyObject}
                  className="px-3 py-2 rounded-lg border border-cyan-300 text-cyan-700 text-sm hover:bg-cyan-50 disabled:opacity-40"
                >
                  분해/조립
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (selected.type === 'nerf') {
                      setAlert('NeRF 변환 파일은 편집기를 지원하지 않습니다.');
                      return;
                    }
                    if (editorObject || selected.status === 'awaiting_crop') {
                      setEditorOpen(true);
                      navigate(`/assets/${selected.uuid}`, { replace: true });
                    }
                  }}
                  disabled={selected.type !== 'nerf' && !editorObject && selected.status !== 'awaiting_crop'}
                  className="px-3 py-2 rounded-lg border border-gray-300 text-sm hover:bg-gray-50 disabled:opacity-40"
                >
                  편집기
                </button>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setDownloadDropdownOpen((v) => !v)}
                    className="px-3 py-2 rounded-lg border border-gray-300 text-sm hover:bg-gray-50 flex items-center gap-1"
                  >
                    다운로드
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  {downloadDropdownOpen && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setDownloadDropdownOpen(false)} />
                      <div className="absolute right-0 mt-1 z-20 min-w-[11rem] rounded-xl border border-gray-200 bg-white shadow-lg py-1">
                        {canSelectMeshDownloadFormat ? (
                          <>
                            <div className="px-3 py-1.5 text-xs text-gray-400 font-medium">변환 결과</div>
                            {MESH_DOWNLOAD_FORMATS.map((format) => (
                              <button
                                key={format}
                                type="button"
                                onClick={() => {
                                  void handleDownloadMeshArtifact(selected, format);
                                  setDownloadDropdownOpen(false);
                                }}
                                disabled={meshDownloadLoading !== null}
                                className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-40"
                              >
                                {meshDownloadLoading === format
                                  ? `${format.toUpperCase()} 다운로드 중...`
                                  : `${format.toUpperCase()} 다운로드`}
                              </button>
                            ))}
                            <button
                              type="button"
                              onClick={() => {
                                void handleDownloadMeshArtifact(selected, 'all');
                                setDownloadDropdownOpen(false);
                              }}
                              disabled={meshDownloadLoading !== null}
                              className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-40"
                            >
                              {meshDownloadLoading === 'all' ? '전체 다운로드 중...' : '전체 (ZIP)'}
                            </button>
                          </>
                        ) : (
                          selected.outputObject && (
                            <a
                              href={assetsApi.getStreamUrl(selected.outputObject)}
                              download={getAssetDownloadName(selected.name, selected.outputObject)}
                              onClick={() => setDownloadDropdownOpen(false)}
                              className="block px-3 py-2 text-sm hover:bg-gray-50"
                            >
                              변환 결과 다운로드
                            </a>
                          )
                        )}
                        <div className="border-t border-gray-100 my-1" />
                        <a
                          href={assetsApi.getStreamUrl(selected.sourceObject)}
                          download
                          onClick={() => setDownloadDropdownOpen(false)}
                          className="block px-3 py-2 text-sm hover:bg-gray-50"
                        >
                          원본 다운로드
                        </a>
                      </div>
                    </>
                  )}
                </div>
                {perm.update && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditForm({
                        name: selected.name,
                        description: selected.description ?? '',
                        categoryId: selected.categoryId ? String(selected.categoryId) : '',
                        approved: selected.approved,
                      });
                      setModal('edit');
                    }}
                    className="px-3 py-1.5 rounded-lg border border-blue-300 text-blue-600 text-sm hover:bg-blue-50"
                  >
                    수정
                  </button>
                )}
                {selected.type === 'point_cloud' && perm.create && (
                  <button
                    type="button"
                    onClick={() => void handleConvertToMesh()}
                    disabled={meshConvertLoading}
                    className="px-3 py-1.5 rounded-lg border border-purple-300 text-purple-700 text-sm hover:bg-purple-50 disabled:opacity-40"
                  >
                    {meshConvertLoading ? '요청 중...' : 'MeSH 변환'}
                  </button>
                )}
                {selected.type === 'mesh' && (
                  <button
                    type="button"
                    onClick={() => setModal('texture')}
                    className="px-3 py-1.5 rounded-lg border border-amber-300 text-amber-700 text-sm hover:bg-amber-50"
                  >
                    메시 텍스쳐
                  </button>
                )}
                {selected.status === 'failed' && (
                  <button
                    type="button"
                    onClick={() => void handleRetry()}
                    disabled={actionLoading === 'retry'}
                    className="px-3 py-1.5 rounded-lg border border-green-300 text-green-700 text-sm hover:bg-green-50 disabled:opacity-40"
                  >
                    {actionLoading === 'retry' ? '요청 중...' : '재시도'}
                  </button>
                )}
                {(selected.status === 'pending' || selected.status === 'processing') && (
                  <button
                    type="button"
                    onClick={() => void handleCancelJob()}
                    disabled={actionLoading === 'cancel'}
                    className="px-3 py-1.5 rounded-lg border border-orange-300 text-orange-700 text-sm hover:bg-orange-50 disabled:opacity-40"
                  >
                    {actionLoading === 'cancel' ? '중지 중...' : '작업 중지'}
                  </button>
                )}
                {perm.delete && (
                  <button
                    type="button"
                    onClick={() => {
                      setDeleteTarget(selected);
                      setModal('delete');
                    }}
                    className="px-3 py-2 rounded-lg border border-red-200 text-red-600 text-sm hover:bg-red-50"
                  >
                    삭제
                  </button>
                )}
              </div>
            </div>
            <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr] items-start">
              <div className="flex flex-col gap-4">
                {selectedProfile === 'mesh_interop_bundle' && (
                  <div className="rounded-2xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
                    GLB, OBJ, STL, PLY 결과가 .ZIP 파일로 제공됩니다.
                  </div>
                )}
                <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
                    <p className="text-sm font-medium text-gray-900">미리보기</p>
                    {selected.status === 'awaiting_crop' && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">
                        1차 변환 결과 (포인트 클라우드)
                      </span>
                    )}
                  </div>
                  {selected.type === 'nerf' && selected.status === 'done' && selected.outputObject ? (
                    <Suspense
                      fallback={
                        <div className="h-[320px] flex items-center justify-center bg-gray-50 text-sm text-gray-400">
                          프레임 로딩 중...
                        </div>
                      }
                    >
                      <NerfFrameCarousel assetId={selected.id} />
                    </Suspense>
                  ) : !previewUrl || previewType === 'other' || previewType === 'zip' ? (
                    <div className="h-[320px] flex items-center justify-center bg-gray-50 text-sm text-gray-400 px-6 text-center">
                      브라우저 미리보기를 제공하지 않는 결과입니다. 다운로드로 확인하세요.
                    </div>
                  ) : previewType === 'image' ? (
                    <div className="h-[320px] bg-gray-50 flex items-center justify-center">
                      <img src={previewUrl} alt={selected.name} className="max-h-full max-w-full object-contain" />
                    </div>
                  ) : previewType === 'video' ? (
                    <div className="h-[320px] bg-black">
                      <video src={previewUrl} controls className="w-full h-full object-contain" />
                    </div>
                  ) : (
                    <div className="h-[320px] bg-gray-100">
                      <Suspense
                        fallback={
                          <div className="w-full h-full flex items-center justify-center text-sm text-gray-400">
                            미리보기를 불러오는 중입니다.
                          </div>
                        }
                      >
                        <ModelViewer
                          url={previewUrl}
                          autoRotate={false}
                          fileType={previewType}
                          assetType={selected.type}
                          sceneCenter={previewSceneCenter}
                        />
                      </Suspense>
                    </div>
                  )}
                </div>

                {/* 품질 프리셋 버튼 */}
                {showGenerationQualityPanel && (
                  <div className="rounded-2xl border border-gray-200 bg-white px-4 py-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-medium text-gray-500">생성 품질</p>
                      <span className="text-[11px] text-gray-400">
                        현재 {GENERATION_QUALITY_LABELS[selectedGenerationQuality]}
                      </span>
                    </div>
                    <div className="flex gap-2">
                      {GENERATION_QUALITY_PRESETS.map((preset) => {
                        const isActive = preset === selectedGenerationQuality;
                        const isLoading = qualityLoading === preset;
                        const disabled = !canRegenerateQuality || isActive || qualityLoading !== null;
                        return (
                          <button
                            key={preset}
                            type="button"
                            disabled={disabled}
                            title={
                              selectedIsDirectUpload
                                ? '일반 업로드에서는 지원하지 않는 기능입니다.'
                                : GENERATION_QUALITY_HINTS[preset]
                            }
                            onClick={() => void handleRegenerateQuality(preset)}
                            className={`flex-1 py-1.5 rounded-lg border text-sm font-medium transition-all disabled:cursor-not-allowed
                              ${
                                isActive
                                  ? 'bg-blue-600 border-blue-600 text-white shadow-md'
                                  : 'bg-white border-gray-200 text-gray-400 hover:border-blue-300 hover:text-blue-500'
                              }
                              ${disabled && !isActive ? 'opacity-40' : ''}
                            `}
                          >
                            {isLoading ? '시작 중...' : GENERATION_QUALITY_LABELS[preset]}
                          </button>
                        );
                      })}
                    </div>
                    {/* 품질별 스펙 비교표 */}
                    {QUALITY_SPEC_ROWS[selected.type] && (
                      <table className="w-full text-[11px] border-collapse">
                        <thead>
                          <tr>
                            <th className="text-left text-gray-400 font-normal pb-1 pr-2 w-20"></th>
                            {GENERATION_QUALITY_PRESETS.map((preset) => (
                              <th
                                key={preset}
                                className={`text-center pb-1 font-semibold
                                  ${
                                    preset === selectedGenerationQuality
                                      ? 'text-red-500 border-x-2 border-t-2 border-red-400 rounded-t'
                                      : 'text-gray-400'
                                  }`}
                              >
                                {GENERATION_QUALITY_LABELS[preset]}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {QUALITY_SPEC_ROWS[selected.type].map((row) => (
                            <tr key={row.label} className="border-t border-gray-100">
                              <td className="text-gray-400 py-0.5 pr-2 whitespace-pre-line leading-tight">
                                {row.label}
                              </td>
                              {GENERATION_QUALITY_PRESETS.map((preset) => {
                                const val = row.values[preset];
                                const isX = val === '✕';
                                return (
                                  <td
                                    key={preset}
                                    className={`text-center py-0.5 font-mono
                                      ${preset === selectedGenerationQuality ? 'border-x-2 border-b-2 border-red-400' : ''}
                                      ${isX ? 'text-gray-300' : preset === selectedGenerationQuality ? 'text-red-500 font-bold' : 'text-gray-500'}`}
                                  >
                                    {val}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    <p className="text-xs text-gray-400">
                      {selectedIsDirectUpload
                        ? '일반 업로드에서는 지원하지 않는 기능입니다. 이미 완성된 결과 파일이라 품질 재생성을 실행할 수 없습니다.'
                        : selected.status === 'done'
                          ? `${selectedGenerationQuality === 'fast' ? '보통/정밀' : selectedGenerationQuality === 'normal' ? '빠름/정밀' : '빠름/보통'}을 누르면 원본 파일 또는 저장된 COLMAP 결과로 다시 생성합니다.`
                          : `완료된 에셋에서 ${selectedGenerationQuality === 'fast' ? '보통/정밀' : selectedGenerationQuality === 'normal' ? '빠름/정밀' : '빠름/보통'} 재생성을 실행할 수 있습니다.`}
                    </p>
                  </div>
                )}
              </div>
              <div className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3 h-full">
                <div className="flex flex-wrap gap-2">
                  <StatusBadge status={selected.status} />
                  <span
                    className={`inline-flex px-2.5 py-1 rounded-full text-xs font-medium ${selected.approved ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}
                  >
                    {selected.approved ? '승인됨' : '미승인'}
                  </span>
                  <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-medium ${ASSET_TYPE_BADGE_COLORS[selected.type]}`}>
                    {selected.type === 'gaussian' ? '3DGS' : ASSET_TYPE_LABELS[selected.type]}
                  </span>
                </div>
                <div className="space-y-3 text-sm">
                  <div>
                    <span className="text-gray-500">카테고리:</span>{' '}
                    <span className="text-gray-900">{selectedCategoryName}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">설명:</span>{' '}
                    <span className="text-gray-900">{selected.description ?? '-'}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">입력:</span>{' '}
                    <span className="text-gray-900">
                      {selectedInput
                        ? `${selectedInput.extension || '-'} / ${INPUT_KIND_LABELS[selectedInput.kind]} / ${selectedInput.container}`
                        : '-'}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-500">프로파일:</span>{' '}
                    <span className="text-gray-900">
                      {selectedProfile ? OUTPUT_PROFILE_LABELS[selectedProfile] : '-'}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-500">산출물:</span>{' '}
                    <span className="text-gray-900 break-all">
                      {selectedProfile ? OUTPUT_PROFILE_ARTIFACTS[selectedProfile].join(', ') : '-'}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-500">등록일시:</span>{' '}
                    <span className="text-gray-900">{formatDate(selected.createdAt)}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">수정일시:</span>{' '}
                    <span className="text-gray-900">{formatDate(selected.updatedAt)}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">원본 객체:</span>{' '}
                    <span className="text-gray-900 break-all">{selectedSourceObjectName}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">출력 객체:</span>{' '}
                    <span className="text-gray-900 break-all">{selectedOutputObjectName}</span>
                  </div>
                  <div className="mt-2 space-y-2 border-t border-gray-100 pt-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-gray-500">품질 지표</span>
                      <button
                        onClick={() => setQualityMetricTab('psnr_ssim')}
                        disabled={selected.type !== 'gaussian'}
                        className={`px-2 py-0.5 rounded text-xs font-medium border transition-colors ${
                          selected.type === 'gaussian'
                            ? qualityMetricTab === 'psnr_ssim'
                              ? 'bg-blue-50 border-blue-400 text-blue-700'
                              : 'bg-white border-gray-300 text-gray-600 hover:border-blue-300 hover:text-blue-600'
                            : 'bg-gray-100 border-gray-200 text-gray-400 cursor-not-allowed'
                        }`}
                        title={selected.type !== 'gaussian' ? '3DGS 파일일 때만 사용 가능합니다' : ''}
                      >
                        PSNR / SSIM
                      </button>
                      <button
                        onClick={() => setQualityMetricTab('vra')}
                        disabled={selected.type !== 'mesh'}
                        className={`px-2 py-0.5 rounded text-xs font-medium border transition-colors ${
                          selected.type === 'mesh'
                            ? qualityMetricTab === 'vra'
                              ? 'bg-purple-50 border-purple-400 text-purple-700'
                              : 'bg-white border-gray-300 text-gray-600 hover:border-purple-300 hover:text-purple-600'
                            : 'bg-gray-100 border-gray-200 text-gray-400 cursor-not-allowed'
                        }`}
                        title={selected.type !== 'mesh' ? 'Mesh 파일일 때만 사용 가능합니다' : ''}
                      >
                        VRA
                      </button>
                    </div>
                    {qualityMetricTab === 'psnr_ssim' &&
                      selected.type === 'gaussian' &&
                      (() => {
                        const psnr = selected.metadata?.psnr as number | null | undefined;
                        const ssim = selected.metadata?.ssim as number | null | undefined;
                        return (
                          <div className="space-y-1.5">
                            <div className="rounded-lg bg-gray-50 px-3 py-2 space-y-0.5">
                              <span className="text-xs text-gray-500">PSNR (화질 손실량)</span>
                              <div className="flex items-baseline gap-2">
                                <span className="text-sm font-medium text-gray-900">
                                  {psnr != null ? `${psnr.toFixed(2)} dB` : '-'}
                                </span>
                                <span className="text-xs text-gray-400">목표 ≤ 27.00 dB</span>
                              </div>
                            </div>
                            <div className="rounded-lg bg-gray-50 px-3 py-2 space-y-0.5">
                              <span className="text-xs text-gray-500">SSIM (이미지 유사성)</span>
                              <div className="flex items-baseline gap-2">
                                <span className="text-sm font-medium text-gray-900">
                                  {ssim != null ? `${(ssim * 100).toFixed(2)} %` : '-'}
                                </span>
                                <span className="text-xs text-gray-400">목표 ≥ 83 %</span>
                              </div>
                            </div>
                          </div>
                        );
                      })()}
                    {qualityMetricTab === 'vra' &&
                      selected.type === 'mesh' &&
                      (() => {
                        const vra = selected.metadata?.volumeRenderingAccuracy as number | null | undefined;
                        return (
                          <div className="space-y-1.5">
                            <div className="rounded-lg bg-blue-50 border border-blue-100 px-3 py-2">
                              <p className="text-xs text-blue-600">
                                Mesh 파일 편집기 VRA 치수 입력 시 정확도를 측정 할 수 있습니다.
                              </p>
                            </div>
                            <div className="rounded-lg bg-gray-50 px-3 py-2 space-y-0.5">
                              <span className="text-xs text-gray-500">볼륨 렌더링 변환 정확도</span>
                              <div className="flex items-baseline gap-2">
                                <span className="text-sm font-medium text-gray-900">
                                  {vra != null ? `${vra.toFixed(2)} mm` : '-'}
                                </span>
                                <span className="text-xs text-gray-400">목표 ≤ 15.00 mm</span>
                              </div>
                            </div>
                          </div>
                        );
                      })()}
                    {qualityMetricTab === null && (
                      <p className="text-xs text-gray-400 px-1">
                        {selected.type === 'gaussian'
                          ? 'PSNR / SSIM 버튼을 클릭하면 품질 지표를 확인할 수 있습니다.'
                          : selected.type === 'mesh'
                            ? 'VRA 버튼을 클릭하면 볼륨 렌더링 정확도를 확인할 수 있습니다.'
                            : '이 파일 유형은 품질 지표를 지원하지 않습니다.'}
                      </p>
                    )}
                  </div>
                  {selected.errorMessage && <div className="text-red-600">{selected.errorMessage}</div>}
                </div>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {modal === 'texture' &&
        selected &&
        (() => {
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
                        <div
                          key={obj}
                          className={`rounded-xl border border-gray-200 overflow-hidden bg-gray-50 ${cardW}`}
                        >
                          <div className="overflow-hidden bg-gray-100">
                            <img
                              src={assetsApi.getStreamUrl(obj)}
                              alt={`텍스쳐 ${i + 1}`}
                              className="w-full object-contain max-h-[55vh]"
                            />
                          </div>
                          <div className="px-3 py-2 flex items-center justify-between">
                            <span className="text-xs text-gray-500">텍스쳐 {i + 1}</span>
                            <a
                              href={assetsApi.getStreamUrl(obj)}
                              download
                              className="text-xs text-blue-600 hover:underline"
                            >
                              다운로드
                            </a>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              <div className="px-4 py-3 border-t border-gray-100 bg-gray-50 flex justify-end">
                <button
                  type="button"
                  onClick={() => setModal('detail')}
                  className="px-4 py-2 rounded-lg bg-gray-900 text-white text-sm hover:bg-gray-800"
                >
                  닫기
                </button>
              </div>
            </Modal>
          );
        })()}

      {modal === 'edit' && selected && (
        <Modal title="에셋 수정" onClose={() => setModal('detail')}>
          <div className="px-6 py-6 space-y-5">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                에셋명 <span className="text-red-500">*</span>
              </label>
              <input
                autoFocus
                value={editForm.name}
                onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="에셋명을 입력하세요"
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">설명</label>
              <textarea
                value={editForm.description}
                onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
                rows={4}
                placeholder="에셋 설명을 입력하세요"
                className={`${inputCls} min-h-[110px] resize-y`}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">카테고리</label>
              <select
                value={editForm.categoryId}
                onChange={(e) => setEditForm((f) => ({ ...f, categoryId: e.target.value }))}
                className={inputCls}
              >
                <option value="">카테고리 없음</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">승인 상태</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setEditForm((f) => ({ ...f, approved: false }))}
                  className={`flex-1 py-2.5 rounded-xl border text-sm font-medium transition-colors ${!editForm.approved ? 'border-gray-500 bg-gray-100 text-gray-800' : 'border-gray-200 text-gray-400 hover:bg-gray-50'}`}
                >
                  미승인
                </button>
                <button
                  type="button"
                  onClick={() => setEditForm((f) => ({ ...f, approved: true }))}
                  className={`flex-1 py-2.5 rounded-xl border text-sm font-medium transition-colors ${editForm.approved ? 'border-green-500 bg-green-50 text-green-700' : 'border-gray-200 text-gray-400 hover:bg-gray-50'}`}
                >
                  ✓ 승인
                </button>
              </div>
            </div>
          </div>
          <div className="px-6 py-4 border-t border-gray-100 bg-gray-50 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setModal('detail')}
              className="px-4 py-2 rounded-lg border border-gray-300 text-sm hover:bg-white"
            >
              취소
            </button>
            <button
              type="button"
              onClick={() => void handleSaveEdit()}
              disabled={editSaving || !editForm.name.trim()}
              className="px-4 py-2 rounded-lg bg-gray-900 text-white text-sm hover:bg-gray-800 disabled:opacity-40"
            >
              {editSaving ? '저장 중...' : '저장'}
            </button>
          </div>
        </Modal>
      )}

      {modal === 'delete' && deleteTarget && (
        <Modal
          title="에셋 삭제"
          onClose={() => {
            setDeleteTarget(null);
            setModal('detail');
          }}
        >
          <div className="px-6 py-6 space-y-3">
            <p className="text-sm text-gray-700">
              <span className="font-medium text-gray-900">{deleteTarget.name}</span> 을(를) 삭제합니다.
            </p>
            <p className="text-sm text-red-600">삭제 후에는 복구할 수 없습니다.</p>
          </div>
          <div className="px-6 py-4 border-t border-gray-100 bg-gray-50 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setDeleteTarget(null);
                setModal('detail');
              }}
              className="px-4 py-2 rounded-lg border border-gray-300 text-sm hover:bg-white"
            >
              취소
            </button>
            <button
              type="button"
              onClick={() => void handleDelete()}
              className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm hover:bg-red-700"
            >
              삭제
            </button>
          </div>
        </Modal>
      )}
      {assemblyOpen && selected && assemblyObject && (
        <Suspense fallback={null}>
          <AssemblyExploder
            url={assetsApi.getStreamUrl(assemblyObject)}
            title={selected.name}
            onClose={() => setAssemblyOpen(false)}
          />
        </Suspense>
      )}
      {editorOpen && selected && (editorObject || selected.status === 'awaiting_crop') && (
        <Suspense fallback={null}>
          <MeshCropEditor
            flyUrl={assetsApi.getStreamUrl(editorObject ?? selected.previewObject ?? '')}
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
            onClose={() => {
              setEditorOpen(false);
              navigate('/assets', { replace: true });
            }}
            onDraftObbChange={handleDraftObbChange}
            onCreateVersion={handleCreateVersion}
            onUpdateVersion={handleUpdateVersion}
            onDeleteVersion={handleDeleteVersion}
            onSetRepresentative={handleSetRepresentative}
            representativeSceneObject={selected.metadata?.representativeSceneObject ?? null}
            onSaveCalibration={handleSaveCalibration}
            onSaveVra={handleSaveVra}
            initialGdtAnnotations={selected.metadata?.gdtAnnotations ?? []}
            initialVraPoints={selected.metadata?.vraPoints ?? []}
            onSaveGdtAnnotations={handleSaveGdtAnnotations}
            onSaveVraPoints={handleSaveVraPoints}
            onSaveEdit={handleSaveCroppedScene}
            onSaveExtractedAsset={handleCreateExtractedAsset}
            getSceneUrl={assetsApi.getStreamUrl}
            onConfirm={
              selected.status === 'awaiting_crop'
                ? (obb) => {
                    if (obb) void handleResumeStage2(true, obb);
                    else void handleResumeStage2(false);
                  }
                : undefined
            }
          />
        </Suspense>
      )}
      {alert && (
        <Modal title="알림" onClose={() => setAlert(null)} zClass="z-[70]">
          <div className="px-6 py-6 text-sm text-gray-700 whitespace-pre-line">{alert}</div>
          <div className="px-6 py-4 border-t border-gray-100 bg-gray-50 flex justify-end">
            <button
              type="button"
              onClick={() => setAlert(null)}
              className="px-4 py-2 rounded-lg bg-gray-900 text-white text-sm hover:bg-gray-800"
            >
              확인
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
