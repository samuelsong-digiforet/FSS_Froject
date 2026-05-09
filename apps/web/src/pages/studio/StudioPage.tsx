import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
const uuidv4 = () => crypto.randomUUID();
import { scenesApi, Scene, SceneData, SceneObject, SavedView, DEFAULT_SCENE_DATA, SceneUnit } from '@/api/scenes';
import { assetsApi, Asset, ASSET_TYPE_LABELS } from '@/api/assets';
import { assetCategoriesApi, AssetCategory } from '@/api/assetCategories';
import Viewport, { ViewportRef } from './Viewport';
import {
  SCENE_LENGTH_VERSION,
  formatDisplayLength,
  fromMeters,
  getUnitMeters,
  normalizeSceneLengthData,
  scaleSceneLengths,
  toMeters,
} from './sceneUnits';

function normalizeSceneData(data?: Partial<SceneData> | null): SceneData {
  const merged: SceneData = {
    ...DEFAULT_SCENE_DATA,
    ...data,
    objects: data?.objects ?? DEFAULT_SCENE_DATA.objects,
    savedViews: data?.savedViews ?? DEFAULT_SCENE_DATA.savedViews,
    camera: {
      ...DEFAULT_SCENE_DATA.camera,
      ...(data?.camera ?? {}),
    },
    lighting: {
      ambient: {
        ...DEFAULT_SCENE_DATA.lighting.ambient,
        ...(data?.lighting?.ambient ?? {}),
      },
      directional: {
        ...DEFAULT_SCENE_DATA.lighting.directional,
        ...(data?.lighting?.directional ?? {}),
      },
    },
    grid: {
      ...DEFAULT_SCENE_DATA.grid,
      ...(data?.grid ?? {}),
    },
    area: {
      ...DEFAULT_SCENE_DATA.area,
      ...(data?.area ?? {}),
    },
    lengthUnitVersion: data?.lengthUnitVersion,
  };
  return normalizeSceneLengthData(merged);
}

// ── 아이콘 ───────────────────────────────────────────────────────
function getAssetCalibrationScale(asset: Asset): number {
  const raw = Number(asset.metadata?.calibrationScale);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

type ObjectSize = {
  x: number;
  y: number;
  z: number;
};

const BOX_CEIL_EPS = 1e-6;

function roundUpBoxLength(length: number, unit: SceneUnit) {
  const displayLength = fromMeters(length, unit);
  if (!Number.isFinite(displayLength)) return length;
  const roundedDisplayLength = Math.ceil((displayLength - BOX_CEIL_EPS) * 1_000) / 1_000;
  return toMeters(Math.max(0.001, roundedDisplayLength), unit);
}

function getRoundedBoxSize(size: ObjectSize, unit: SceneUnit): ObjectSize {
  return {
    x: roundUpBoxLength(size.x, unit),
    y: roundUpBoxLength(size.y, unit),
    z: roundUpBoxLength(size.z, unit),
  };
}

const Icon = {
  Translate: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4"><path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M12 3v18M3 12h18"/></svg>,
  Rotate: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4"><path d="M1 4v6h6M23 20v-6h-6"/><path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"/></svg>,
  Scale: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>,
  Grid: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>,
  Eye: ({ visible }: { visible: boolean }) => visible
    ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
    : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24M1 1l22 22"/></svg>,
  Trash: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>,
  Save: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>,
  Camera: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>,
  Chevron: ({ open }: { open: boolean }) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`}>
      <path d="M6 9l6 6 6-6"/>
    </svg>
  ),
  Pencil: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3 h-3 opacity-60">
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>
  ),
};

// ── 토글 가능한 섹션 헤더 ─────────────────────────────────────────
function SectionHeader({ title, open, onToggle, action }: {
  title: string; open: boolean; onToggle: () => void; action?: React.ReactNode;
}) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center justify-between px-3 py-2 hover:bg-[#1a1f2e] transition-colors"
    >
      <div className="flex items-center gap-1.5">
        <Icon.Chevron open={open} />
        <span className="text-[11px] text-gray-400 uppercase tracking-wider font-medium">{title}</span>
      </div>
      {action && <span onClick={e => e.stopPropagation()}>{action}</span>}
    </button>
  );
}

// ── Number Input (Enter 또는 적용 버튼으로 확정) ──────────────────
function NumInput({ value, onChange, step = 0.1, label }: {
  value: number; onChange: (v: number) => void; step?: number; label: string;
}) {
  const fmt = (v: number) => String(Math.round(v * 1000) / 1000);
  const [draft, setDraft] = useState(fmt(value));
  const [dirty, setDirty] = useState(false);

  // 외부 값이 바뀌면 (클램프 등) 입력창 동기화 (편집 중이 아닐 때만)
  useEffect(() => {
    if (!dirty) setDraft(fmt(value));
  }, [value]);

  const apply = () => {
    const n = parseFloat(draft);
    if (!isNaN(n)) onChange(n);
    setDirty(false);
  };

  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] text-gray-500 w-3">{label}</span>
      <input
        type="number"
        value={draft}
        step={step}
        onChange={e => { setDraft(e.target.value); setDirty(true); }}
        onFocus={e => { setDraft(e.target.value); setDirty(true); }}
        onKeyDown={e => {
          if (e.key === 'Enter') { apply(); (e.target as HTMLInputElement).blur(); }
          if (e.key === 'Escape') { setDraft(fmt(value)); setDirty(false); (e.target as HTMLInputElement).blur(); }
        }}
        onBlur={apply}
        className={`w-full bg-[#1a1f2e] rounded px-1.5 py-0.5 text-xs text-gray-200
                    focus:outline-none transition-colors
                    ${dirty
                      ? 'border border-yellow-500/70 focus:border-yellow-400'
                      : 'border border-[#2a2f42] focus:border-sky-500'}`}
      />
      {dirty && (
        <button
          onMouseDown={e => e.preventDefault()} // blur 이전에 클릭 처리
          onClick={apply}
          className="shrink-0 px-1.5 py-0.5 rounded bg-yellow-600/80 hover:bg-yellow-500
                     text-[10px] text-white transition-colors">
          적용
        </button>
      )}
    </div>
  );
}

// ── 씬 선택 모달 ─────────────────────────────────────────────────
function SceneModal({ scenes, onSelect, onCreate, onRename, onClose }: {
  scenes: Scene[]; onSelect: (s: Scene) => void;
  onCreate: (name: string, areaWidth: number, areaDepth: number, unit: SceneUnit) => void;
  onRename: (sceneId: string, name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [newName, setNewName] = useState('');
  const [areaWidth, setAreaWidth] = useState(20);
  const [areaDepth, setAreaDepth] = useState(20);
  const [unit, setUnit] = useState<SceneUnit>('m');
  const [editingSceneId, setEditingSceneId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [renamingSceneId, setRenamingSceneId] = useState<string | null>(null);

  const handleCreate = () => {
    if (!newName.trim()) return;
    onCreate(newName.trim(), areaWidth, areaDepth, unit);
  };

  const resetRenameState = () => {
    setEditingSceneId(null);
    setEditingName('');
  };

  const startRename = (scene: Scene) => {
    setEditingSceneId(scene.id);
    setEditingName(scene.name);
  };

  const handleRename = async (scene: Scene) => {
    const trimmedName = editingName.trim();
    if (!trimmedName) return;
    if (trimmedName === scene.name) {
      resetRenameState();
      return;
    }

    setRenamingSceneId(scene.id);
    try {
      await onRename(scene.id, trimmedName);
      resetRenameState();
    } finally {
      setRenamingSceneId(null);
    }
  };

  const getSceneMeta = (scene: Scene) => {
    const unitLabel = scene.data?.unit ?? 'm';
    const areaLabel = scene.data?.area
      ? `${formatDisplayLength(scene.data.area.width, unitLabel)}×${formatDisplayLength(scene.data.area.depth, unitLabel)} ${unitLabel}`
      : '';
    const updatedLabel = new Date(scene.updatedAt).toLocaleString('ko-KR');
    return areaLabel ? `${areaLabel} · ${updatedLabel}` : updatedLabel;
  };

  useEffect(() => {
    if (editingSceneId && !scenes.some(scene => scene.id === editingSceneId)) {
      resetRenameState();
    }
  }, [editingSceneId, scenes]);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-[#0f1117] border border-[#2a2f42] rounded-xl w-full max-w-md mx-4 shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#2a2f42]">
          <h3 className="text-white font-semibold">씬 관리</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl">×</button>
        </div>
        <div className="px-6 py-4 space-y-4">
          {/* 새 씬 생성 폼 */}
          <div className="space-y-3 p-3 bg-[#1a1f2e]/50 rounded-lg border border-[#2a2f42]">
            <p className="text-[11px] text-gray-500 uppercase tracking-wider">새 씬 만들기</p>
            <input value={newName} onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreate()}
              placeholder="씬 이름"
              className="w-full bg-[#0f1117] border border-[#2a2f42] rounded-lg px-3 py-2
                         text-sm text-white placeholder-gray-600 focus:outline-none focus:border-sky-500" />
            {/* 단위 선택 */}
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-gray-500 w-20 shrink-0">길이 단위</span>
              <div className="flex gap-1">
                {(['m', 'cm', 'mm', 'ft'] as const).map(u => (
                  <button key={u} onClick={() => setUnit(u)}
                    className={`px-2.5 py-1 rounded text-xs transition-colors
                      ${unit === u ? 'bg-sky-600 text-white' : 'bg-[#0f1117] border border-[#2a2f42] text-gray-400 hover:text-gray-200'}`}>
                    {u}
                  </button>
                ))}
              </div>
            </div>
            {/* 배치 영역 */}
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-gray-500 w-20 shrink-0">배치 영역</span>
              <div className="flex items-center gap-1.5">
                <input type="number" value={areaWidth} min={1} step={1}
                  onChange={e => setAreaWidth(Math.max(1, parseInt(e.target.value) || 20))}
                  className="w-16 bg-[#0f1117] border border-[#2a2f42] rounded px-2 py-1
                             text-xs text-gray-200 focus:outline-none focus:border-sky-500" />
                <span className="text-gray-600 text-xs">×</span>
                <input type="number" value={areaDepth} min={1} step={1}
                  onChange={e => setAreaDepth(Math.max(1, parseInt(e.target.value) || 20))}
                  className="w-16 bg-[#0f1117] border border-[#2a2f42] rounded px-2 py-1
                             text-xs text-gray-200 focus:outline-none focus:border-sky-500" />
                <span className="text-[11px] text-gray-500">{unit}</span>
              </div>
            </div>
            <button onClick={handleCreate}
              className="w-full py-2 bg-sky-600 hover:bg-sky-500 text-white text-sm rounded-lg transition-colors">
              씬 생성
            </button>
          </div>

          {/* 기존 씬 목록 */}
          <div className="space-y-1 max-h-52 overflow-y-auto">
            {scenes.length === 0 && <p className="text-gray-600 text-sm text-center py-4">저장된 씬이 없습니다.</p>}
            {scenes.map(scene => {
              const isEditing = editingSceneId === scene.id;
              const isRenaming = renamingSceneId === scene.id;

              return (
                <div key={scene.id} className="rounded-lg border border-[#2a2f42] bg-[#121722]/70">
                  {isEditing ? (
                    <div className="space-y-2 p-3">
                      <input
                        autoFocus
                        value={editingName}
                        onChange={e => setEditingName(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void handleRename(scene);
                          }
                          if (e.key === 'Escape') {
                            resetRenameState();
                          }
                        }}
                        placeholder="씬 이름"
                        className="w-full bg-[#0f1117] border border-[#2a2f42] rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-sky-500"
                      />
                      <div className="flex items-center justify-between gap-3">
                        <p className="min-w-0 flex-1 truncate text-xs text-gray-600">{getSceneMeta(scene)}</p>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            onClick={resetRenameState}
                            className="px-2.5 py-1.5 rounded-lg bg-[#1a1f2e] text-xs text-gray-400 hover:text-gray-200 transition-colors"
                          >
                            취소
                          </button>
                          <button
                            onClick={() => void handleRename(scene)}
                            disabled={isRenaming || !editingName.trim()}
                            className="px-2.5 py-1.5 rounded-lg bg-sky-600 text-xs text-white hover:bg-sky-500 disabled:opacity-50 transition-colors"
                          >
                            {isRenaming ? '저장 중...' : '이름 저장'}
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 p-1">
                      <button
                        onClick={() => onSelect(scene)}
                        className="flex-1 text-left px-2 py-2.5 rounded-lg hover:bg-[#1a1f2e] text-gray-300 text-sm transition-colors"
                      >
                        <p className="font-medium">{scene.name}</p>
                        <p className="text-xs text-gray-600">{getSceneMeta(scene)}</p>
                      </button>
                      <button
                        onClick={() => startRename(scene)}
                        className="shrink-0 flex items-center gap-1.5 px-2.5 py-2 rounded-lg bg-[#1a1f2e] text-xs text-gray-300 hover:bg-[#20263a] transition-colors"
                      >
                        <Icon.Pencil />
                        수정
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 씬 전체가 잘 보이는 카메라 위치 계산 ─────────────────────────
// 영역 대각선을 기준으로 30° 앙각, 45° 방위각에서 바라보는 위치 반환
function computeFitCamera(area: { width: number; depth: number }): {
  position: [number, number, number];
  target: [number, number, number];
} {
  const safeWidth = Math.max(area.width, 0.001);
  const safeDepth = Math.max(area.depth, 0.001);
  // OrbitControls 제한과 동일하게 맞춤
  const maxDim = Math.max(safeWidth, safeDepth);
  const diagonal = Math.hypot(safeWidth, safeDepth);
  const fov = (60 * Math.PI) / 180;
  const padding = 1.35;
  const d = Math.max((diagonal * 0.5) / Math.tan(fov / 2) * padding, maxDim * 1.4);
  const elevation = Math.PI / 6; // 30°
  const azimuth   = Math.PI / 4; // 45°
  return {
    position: [
      d * Math.cos(elevation) * Math.sin(azimuth),
      d * Math.sin(elevation),
      d * Math.cos(elevation) * Math.cos(azimuth),
    ] as [number, number, number],
    target: [0, 0, 0],
  };
}

// ── 메인 스튜디오 ────────────────────────────────────────────────
export default function StudioPage() {
  const navigate = useNavigate();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [categories, setCategories] = useState<AssetCategory[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(null);
  const [assetSearch, setAssetSearch] = useState('');

  const [sceneData, setSceneData] = useState<SceneData>(DEFAULT_SCENE_DATA);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [transformMode, setTransformMode] = useState<'translate' | 'rotate' | 'scale'>('translate');
  const [currentScene, setCurrentScene] = useState<Scene | null>(null);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [showSceneModal, setShowSceneModal] = useState(false);
  const [measureMode, setMeasureMode] = useState(false);
  const [gdtMode, setGdtMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState(false);
  const [draggedAsset, setDraggedAsset] = useState<Asset | null>(null);
  const [sizeWarning, setSizeWarning] = useState<string | null>(null);
  const [areaDraftW, setAreaDraftW] = useState<string>('');
  const [areaDraftD, setAreaDraftD] = useState<string>('');
  const [objectSizes, setObjectSizes] = useState<Map<string, ObjectSize>>(new Map());
  const [pendingUnit, setPendingUnit] = useState<SceneUnit>(DEFAULT_SCENE_DATA.unit);
  const [numericConversionSourceUnit, setNumericConversionSourceUnit] = useState<SceneUnit | null>(null);

  // 우측 패널 섹션 토글
  const [openSections, setOpenSections] = useState<Set<string>>(
    new Set(['hierarchy', 'transform', 'lighting', 'camera'])
  );
  const [scaleLocked, setScaleLocked] = useState(true);
  const toggleSection = (key: string) =>
    setOpenSections(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const viewportRef = useRef<ViewportRef | null>(null);

  // 단축키
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'm' || e.key === 'M') { setMeasureMode(prev => !prev); setGdtMode(false); }
      if (e.key === 'g' || e.key === 'G') { setGdtMode(prev => !prev); setMeasureMode(false); }
      if (e.key === 'Escape') { setMeasureMode(false); setGdtMode(false); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // 데이터 로드
  useEffect(() => {
    assetsApi.getAll().then(({ data }) => setAssets(data)).catch(() => {});
    scenesApi.getAll().then(({ data }) => (
      setScenes(data.map(scene => ({
        ...scene,
        data: normalizeSceneData(scene.data as Partial<SceneData> | undefined),
      })))
    )).catch(() => {});
    assetCategoriesApi.getAll({ limit: 100 }).then(({ data }) => setCategories(data.items)).catch(() => {});
  }, []);

  // 승인됨 + 카테고리 + 검색 필터
  const filteredAssets = assets.filter(a => {
    if (!a.approved) return false;
    const matchCat = selectedCategoryId === null || a.categoryId === selectedCategoryId;
    const matchSearch = a.name.toLowerCase().includes(assetSearch.toLowerCase());
    return matchCat && matchSearch;
  });

  const selectedObj = sceneData.objects.find(o => o.id === selectedId) ?? null;
  const currentUnit = sceneData.unit ?? 'm';
  const selectedActualSize = selectedObj
    ? objectSizes.get(selectedObj.id) ?? { x: selectedObj.scale[0], y: selectedObj.scale[1], z: selectedObj.scale[2] }
    : null;
  const selectedRoundedBoxSize = selectedActualSize
    ? getRoundedBoxSize(selectedActualSize, currentUnit)
    : null;
  const toDisplay = useCallback((value: number) => fromMeters(value, currentUnit), [currentUnit]);
  const toRaw = useCallback((value: number) => toMeters(value, currentUnit), [currentUnit]);
  const formatForDisplay = useCallback((value: number, digits = 3) => formatDisplayLength(value, currentUnit, digits), [currentUnit]);
  const syncObjectSizesFromViewport = useCallback(() => {
    const boxes = viewportRef.current?.getObjectBoundingBoxes();
    if (!boxes) return;

    const next = new Map<string, ObjectSize>();
    sceneData.objects.forEach(obj => {
      const box = boxes.get(obj.id);
      if (!box) return;
      next.set(obj.id, { x: box.sizeX, y: box.sizeY, z: box.sizeZ });
    });

    setObjectSizes(next);
  }, [sceneData.objects]);
  const settingSourceUnit = numericConversionSourceUnit ?? currentUnit;
  const canApplyNumericUnitConversion = pendingUnit !== currentUnit;
  const canApplySettingUnitConversion = pendingUnit !== settingSourceUnit;

  useEffect(() => {
    setPendingUnit(currentUnit);
  }, [currentUnit]);

  useEffect(() => {
    const raf = window.requestAnimationFrame(syncObjectSizesFromViewport);
    return () => window.cancelAnimationFrame(raf);
  }, [sceneData.objects, syncObjectSizesFromViewport]);

  // ── 오브젝트 추가 ──────────────────────────────────────────────
  const GLTF_EXTS = new Set(['glb', 'gltf']);
  const getExt = (obj: string) => obj.split('.').pop()?.toLowerCase() ?? '';

  const addAssetToScene = (asset: Asset, position?: [number, number, number]) => {
    // 뷰포트는 GLB/GLTF만 렌더링 가능
    // outputObject가 ZIP(NeRF 메시 결과)인 경우 워커가 생성한 GLB previewObject를 사용
    const candidates = [asset.outputObject, asset.previewObject, asset.sourceObject].filter(Boolean) as string[];
    const viewObject = candidates.find(o => GLTF_EXTS.has(getExt(o)));

    if (!viewObject) {
      const ext = getExt(asset.outputObject ?? asset.sourceObject);
      alert(
        `이 에셋(${ext.toUpperCase()})은 스튜디오에서 지원되지 않는 형식입니다.\n` +
        `스튜디오는 GLB/GLTF 형식만 지원합니다.\n` +
        `(mesh 또는 nerf 타입으로 변환 완료된 에셋을 사용하세요)`,
      );
      return;
    }

    const newObj: SceneObject = {
      id: uuidv4(),
      assetId: asset.id,
      name: asset.name,
      sourceObject: viewObject,
      position: position ?? [0, 0, 0],
      rotation: [0, 0, 0],
      scale: (() => {
        const calibrationScale = getAssetCalibrationScale(asset);
        return [calibrationScale, calibrationScale, calibrationScale] as [number, number, number];
      })(),
      visible: true,
    };
    setSceneData(prev => ({ ...prev, objects: [...prev.objects, newObj] }));
    setSelectedId(newObj.id);
  };

  // ── transform 업데이트 ─────────────────────────────────────────
  const handleTransformEnd = useCallback((
    id: string,
    pos: [number, number, number],
    rot: [number, number, number],
    scl: [number, number, number],
  ) => {
    setSceneData(prev => ({
      ...prev,
      objects: prev.objects.map(o => o.id === id
        ? { ...o, position: pos, rotation: normalizeRotation(rot), scale: scl }
        : o),
    }));
    // 실제 크기 갱신 (바운딩박스 기반)
    const boxes = viewportRef.current?.getObjectBoundingBoxes();
    const box = boxes?.get(id);
    if (box) {
      setObjectSizes(prev => new Map(prev).set(id, { x: box.sizeX, y: box.sizeY, z: box.sizeZ }));
    }
  }, []);

  const updateObjectActualSize = (axis: 0 | 1 | 2, value: number) => {
    if (!selectedId || !selectedObj) return;

    const currentActual = objectSizes.get(selectedId) ?? {
      x: selectedObj.scale[0],
      y: selectedObj.scale[1],
      z: selectedObj.scale[2],
    };
    const actualValues = [currentActual.x, currentActual.y, currentActual.z] as [number, number, number];
    const safeActualValues = actualValues.map(v => Math.max(0.001, v)) as [number, number, number];
    const nextValue = Math.max(0.001, value);

    const requestedScale = (() => {
      if (scaleLocked) {
        const ratio = nextValue / safeActualValues[axis];
        return selectedObj.scale.map(v => Math.max(0.001, v * ratio)) as [number, number, number];
      }

      return selectedObj.scale.map((scale, index) => {
        const currentSize = safeActualValues[index];
        const targetSize = index === axis ? nextValue : safeActualValues[index];
        const ratio = currentSize > 0 ? targetSize / currentSize : 1;
        return Math.max(0.001, scale * ratio);
      }) as [number, number, number];
    })();

    const optimisticActual = (() => {
      if (scaleLocked) {
        const ratio = nextValue / safeActualValues[axis];
        return safeActualValues.map(v => Math.max(0.001, v * ratio)) as [number, number, number];
      }

      return safeActualValues.map((size, index) => index === axis ? nextValue : size) as [number, number, number];
    })();

    const fittedScale = viewportRef.current?.fitObjectScaleToArea(selectedId, requestedScale) ?? requestedScale;
    const wasClamped = fittedScale.some((entry, index) => Math.abs(entry - requestedScale[index]) > 0.0005);

    setSceneData(prev => ({
      ...prev,
      objects: prev.objects.map(o => (
        o.id === selectedId ? { ...o, scale: fittedScale } : o
      )),
    }));

    setObjectSizes(prev => new Map(prev).set(selectedId, {
      x: optimisticActual[0],
      y: optimisticActual[1],
      z: optimisticActual[2],
    }));

    window.requestAnimationFrame(syncObjectSizesFromViewport);

    if (wasClamped) {
      setSizeWarning('寃쎄퀎源뚯?留??ш린瑜?議곗젙?덉뒿?덈떎.');
      setTimeout(() => setSizeWarning(null), 2500);
    }
  };

  const updateObjectProp = (field: 'position' | 'rotation' | 'scale', axis: 0 | 1 | 2, value: number) => {
    if (!selectedId) return;
    if (field === 'scale' && selectedObj) {
      const requestedScale = (() => {
        if (scaleLocked) {
          const prevVal = selectedObj.scale[axis];
          const ratio = prevVal !== 0 ? value / prevVal : 1;
          return selectedObj.scale.map(v => Math.max(0.001, v * ratio)) as [number, number, number];
        }
        const next = [...selectedObj.scale] as [number, number, number];
        next[axis] = Math.max(0.001, value);
        return next;
      })();

      const fittedScale = viewportRef.current?.fitObjectScaleToArea(selectedId, requestedScale) ?? requestedScale;
      const wasClamped = fittedScale.some((entry, index) => Math.abs(entry - requestedScale[index]) > 0.0005);

      setSceneData(prev => ({
        ...prev,
        objects: prev.objects.map(o => (
          o.id === selectedId ? { ...o, scale: fittedScale } : o
        )),
      }));

      if (wasClamped) {
        setSizeWarning('경계까지만 크기를 조정했습니다.');
        setTimeout(() => setSizeWarning(null), 2500);
      }
      return;
    }

    setSceneData(prev => ({
      ...prev,
      objects: prev.objects.map(o => {
        if (o.id !== selectedId) return o;
        const arr = [...o[field]] as [number, number, number];
        if (field === 'rotation') {
          arr[axis] = ((value % 360) + 360) % 360;
        } else if (field === 'position') {
          // XZ 경계 클램프 (수치 입력 시)
          // Y 클램프는 Viewport useFrame에서 바운딩 박스 기준으로 처리
          const hw = (prev.area?.width ?? 20) / 2;
          const hd = (prev.area?.depth ?? 20) / 2;
          if (axis === 0) arr[0] = Math.max(-hw, Math.min(hw, value));      // X
          else if (axis === 2) arr[2] = Math.max(-hd, Math.min(hd, value)); // Z
          else arr[axis] = value;                                             // Y (바운딩박스 기준 클램프는 Viewport)
        } else {
          arr[axis] = value;
        }
        return { ...o, [field]: arr };
      }),
    }));
  };

  // TransformControls 회전 후에도 0~360° 범위로 정규화
  const normalizeRotation = (rot: [number, number, number]): [number, number, number] =>
    rot.map(v => ((v % 360) + 360) % 360) as [number, number, number];

  // ── 크기 정규화 ────────────────────────────────────────────────
  const handleNormalize = () => {
    if (!selectedId || !viewportRef.current) return;
    const scale = viewportRef.current.normalizeObject(selectedId);
    if (!scale) return;
    setSceneData(prev => ({
      ...prev,
      objects: prev.objects.map(o =>
        o.id === selectedId ? { ...o, scale } : o
      ),
    }));
  };

  // ── 기타 ───────────────────────────────────────────────────────
  const toggleVisible = (id: string) =>
    setSceneData(prev => ({
      ...prev,
      objects: prev.objects.map(o => o.id === id ? { ...o, visible: !o.visible } : o),
    }));

  const removeObject = (id: string) => {
    setSceneData(prev => ({ ...prev, objects: prev.objects.filter(o => o.id !== id) }));
    if (selectedId === id) setSelectedId(null);
    setObjectSizes(prev => { const next = new Map(prev); next.delete(id); return next; });
  };

  const updateLighting = (key: 'ambient' | 'directional', field: string, value: unknown) =>
    setSceneData(prev => ({
      ...prev,
      lighting: { ...prev.lighting, [key]: { ...prev.lighting[key], [field]: value } },
    }));

  const saveCurrentView = () => {
    if (!viewportRef.current) return;
    const state = viewportRef.current.getCameraState();
    const view: SavedView = { id: uuidv4(), name: `뷰 ${sceneData.savedViews.length + 1}`, ...state };
    setSceneData(prev => ({ ...prev, savedViews: [...prev.savedViews, view] }));
  };

  const applyView = (view: SavedView) => viewportRef.current?.setCameraState(view.position, view.target);
  const removeView = (id: string) =>
    setSceneData(prev => ({ ...prev, savedViews: prev.savedViews.filter(v => v.id !== id) }));

  const saveScene = async () => {
    if (!currentScene) return;
    setSaving(true);
    try {
      const camera = viewportRef.current?.getCameraState() ?? sceneData.camera;
      const payload = { ...sceneData, camera, lengthUnitVersion: SCENE_LENGTH_VERSION };
      const { data } = await scenesApi.update(currentScene.id, { data: payload });
      const normalized = { ...data, data: normalizeSceneData(data.data as Partial<SceneData> | undefined) };
      setCurrentScene(normalized);
      setScenes(prev => prev.map(scene => scene.id === normalized.id ? normalized : scene));
      setSavedMsg(true);
      setTimeout(() => setSavedMsg(false), 2000);
    } finally { setSaving(false); }
  };

  const openScene = (scene: Scene) => {
    const normalized = {
      ...scene,
      data: normalizeSceneData(scene.data as Partial<SceneData> | undefined),
    };
    // 씬 크기에 맞는 카메라 위치로 자동 피트 (저장된 카메라가 잘못된 위치일 수 있음)
    const fitCamera = computeFitCamera(normalized.data.area ?? { width: 20, depth: 20 });
    const dataWithFit = { ...normalized.data, camera: fitCamera };
    setNumericConversionSourceUnit(null);
    setCurrentScene({ ...normalized, data: dataWithFit });
    setSceneData(dataWithFit);
    setSelectedId(null);
    setShowSceneModal(false);
  };

  const applyNumericUnitConversion = () => {
    if (!canApplyNumericUnitConversion) return;
    const fitCamera = computeFitCamera(sceneData.area ?? { width: 20, depth: 20 });
    setAreaDraftW('');
    setAreaDraftD('');
    setNumericConversionSourceUnit(prev => prev ?? currentUnit);
    setSceneData(prev => ({
      ...prev,
      camera: fitCamera,
      unit: pendingUnit,
      lengthUnitVersion: SCENE_LENGTH_VERSION,
    }));
    viewportRef.current?.setCameraState(fitCamera.position, fitCamera.target);
  };

  const applySettingUnitConversion = () => {
    if (!canApplySettingUnitConversion) return;
    const factor = getUnitMeters(pendingUnit) / getUnitMeters(settingSourceUnit);

    // 변환 후 새 영역 크기 계산 → 씬 중심이 잘 보이는 카메라 위치 산출
    const currentArea = sceneData.area ?? { width: 20, depth: 20 };
    const newArea = {
      width: currentArea.width * factor,
      depth: currentArea.depth * factor,
    };
    const fitCamera = computeFitCamera(newArea);

    setAreaDraftW('');
    setAreaDraftD('');
    setNumericConversionSourceUnit(null);
    setSceneData(prev => ({
      ...scaleSceneLengths(prev, factor, {
        includeObjects: true,
        includeCamera: false,
        includeSavedViews: true,
        includeLighting: true,
      }),
      camera: fitCamera,
      unit: pendingUnit,
      lengthUnitVersion: SCENE_LENGTH_VERSION,
    }));

    // 뷰포트 카메라에 즉시 반영
    viewportRef.current?.setCameraState(fitCamera.position, fitCamera.target);
  };

  // 씬 영역 축소 시 에셋 초과 여부 검증 후 적용
  const tryApplyAreaLegacy = (dim: 'width' | 'depth', rawValue: string) => {
    const newVal = Math.max(0.001, toRaw(parseFloat(rawValue) || 0));
    const current = sceneData.area ?? { width: 20, depth: 20 };
    const newArea = { ...current, [dim]: newVal };

    // 축소인 경우에만 검증
    if (newVal < current[dim]) {
      const boxes = viewportRef.current?.getObjectBoundingBoxes();
      if (boxes && boxes.size > 0) {
        const unit = sceneData.unit ?? 'm';
        const hw = newArea.width / 2;
        const hd = newArea.depth / 2;
        const offenders = sceneData.objects
          .filter(obj => {
            const b = boxes.get(obj.id);
            return b && (
              b.minX < -hw ||
              b.maxX > hw ||
              b.minZ < -hd ||
              b.maxZ > hd
            );
          })
          .map(obj => obj.name);

        if (offenders.length > 0) {
          setSizeWarning(
            `범위를 줄일 수 없습니다 — 범위를 초과하는 에셋이 있습니다: "${offenders.join('", "')}" ` +
            `(대상 범위 ${newArea.width}×${newArea.depth}${unit})`
          );
          setTimeout(() => setSizeWarning(null), 5000);
          return; // 적용 취소
        }
      }
    }

    setSceneData(prev => ({
      ...prev,
      area: { ...(prev.area ?? { width: 20, depth: 20 }), [dim]: newVal },
    }));
  };
  void tryApplyAreaLegacy;

  const tryApplyArea = (dim: 'width' | 'depth', rawValue: string) => {
    const newVal = Math.max(0.001, toRaw(parseFloat(rawValue) || 0));
    const current = sceneData.area ?? { width: 20, depth: 20 };
    const newArea = { ...current, [dim]: newVal };
    const hw = newArea.width / 2;
    const hd = newArea.depth / 2;

    // 경계 밖 에셋은 경계 안으로 클램프 (차단 대신 이동)
    let updatedObjects = sceneData.objects;
    if (newVal < current[dim]) {
      const boxes = viewportRef.current?.getObjectBoundingBoxes();
      if (boxes) {
        updatedObjects = sceneData.objects.map(obj => {
          const box = boxes.get(obj.id);
          if (!box) return obj;
          const outside =
            box.minX < -hw || box.maxX > hw ||
            box.minZ < -hd || box.maxZ > hd;
          if (!outside) return obj;

          // 오브젝트 바운딩박스가 새 경계 내에 최대한 들어오도록 위치 조정
          const pos = [...obj.position] as [number, number, number];

          // X 축 클램프
          if (box.maxX > hw)  pos[0] += hw  - box.maxX;
          if (box.minX < -hw) pos[0] += -hw - box.minX;

          // Z 축 클램프
          if (box.maxZ > hd)  pos[2] += hd  - box.maxZ;
          if (box.minZ < -hd) pos[2] += -hd - box.minZ;

          return { ...obj, position: pos };
        });
      }
    }

    const fitCamera = computeFitCamera(newArea);
    setSceneData(prev => ({
      ...prev,
      objects: updatedObjects,
      area: { ...(prev.area ?? { width: 20, depth: 20 }), [dim]: newVal },
      camera: fitCamera,
    }));
    viewportRef.current?.setCameraState(fitCamera.position, fitCamera.target);
  };

  const createScene = async (name: string, areaWidth: number, areaDepth: number, unit: SceneUnit) => {
    try {
      const widthMeters = toMeters(areaWidth, unit);
      const depthMeters = toMeters(areaDepth, unit);
      const fitCamera = computeFitCamera({ width: widthMeters, depth: depthMeters });
      const sceneData: SceneData = {
        ...DEFAULT_SCENE_DATA,
        unit,
        area: { width: widthMeters, depth: depthMeters },
        camera: fitCamera,
        lengthUnitVersion: SCENE_LENGTH_VERSION,
      };
      const { data } = await scenesApi.create({ name, data: sceneData });
      const normalized = { ...data, data: normalizeSceneData(data.data as Partial<SceneData> | undefined) };
      setScenes(prev => [normalized, ...prev]);
      openScene(normalized);
    } catch { /* ignore */ }
  };

  const renameScene = async (sceneId: string, name: string) => {
    const trimmedName = name.trim();
    if (!trimmedName) return;

    try {
      const { data } = await scenesApi.update(sceneId, { name: trimmedName });
      setScenes(prev => prev.map(scene => (
        scene.id === sceneId
          ? { ...scene, name: data.name, description: data.description, updatedAt: data.updatedAt }
          : scene
      )));
      setCurrentScene(prev => (
        prev?.id === sceneId
          ? { ...prev, name: data.name, description: data.description, updatedAt: data.updatedAt }
          : prev
      ));
    } catch { /* ignore */ }
  };

  return (
    <div className="flex flex-col h-full bg-[#0a0c14] text-white overflow-hidden">

      {/* ── 툴바 ────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-4 py-2 bg-[#0f1117] border-b border-[#1e2130] shrink-0 flex-wrap">
        {/* 뒤로가기 */}
        <button onClick={() => navigate(-1)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#1a1f2e] hover:bg-[#2a2f42] text-sm text-gray-400 hover:text-gray-200 transition-colors"
          title="뒤로 가기">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
            <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          뒤로
        </button>

        <div className="w-px h-5 bg-[#2a2f42]" />

        <button onClick={() => setShowSceneModal(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#1a1f2e] hover:bg-[#2a2f42] text-sm text-gray-300">
          {currentScene ? currentScene.name : '씬 선택 / 새 씬'}
          <Icon.Pencil />
        </button>

        <div className="w-px h-5 bg-[#2a2f42]" />

        {(['translate', 'rotate', 'scale'] as const).map(mode => (
          <button key={mode} onClick={() => setTransformMode(mode)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors
              ${transformMode === mode ? 'bg-sky-600 text-white' : 'bg-[#1a1f2e] text-gray-400 hover:text-gray-200'}`}>
            {mode === 'translate' ? <Icon.Translate /> : mode === 'rotate' ? <Icon.Rotate /> : <Icon.Scale />}
            {mode === 'translate' ? '이동' : mode === 'rotate' ? '회전' : '크기'}
          </button>
        ))}

        <div className="w-px h-5 bg-[#2a2f42]" />

        <button onClick={() => setSceneData(prev => ({ ...prev, grid: { ...prev.grid, enabled: !prev.grid.enabled } }))}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs
            ${sceneData.grid.enabled ? 'bg-sky-600/20 text-sky-400' : 'bg-[#1a1f2e] text-gray-500'}`}>
          <Icon.Grid /> 그리드
        </button>

        {sceneData.grid.enabled && (
          <label className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-[#1a1f2e] text-xs text-gray-400">
            {/*
            <span>격자색</span>
            */}
            <span>Grid</span>
            <input
              type="color"
              value={sceneData.grid.color ?? DEFAULT_SCENE_DATA.grid.color}
              onChange={e => setSceneData(prev => ({ ...prev, grid: { ...prev.grid, color: e.target.value } }))}
              className="h-5 w-6 cursor-pointer rounded border-0 bg-transparent p-0"
            />
          </label>
        )}

        <button onClick={() => setSceneData(prev => ({ ...prev, grid: { ...prev.grid, snap: !prev.grid.snap } }))}
          className={`px-3 py-1.5 rounded-lg text-xs font-mono
            ${sceneData.grid.snap ? 'bg-yellow-600/20 text-yellow-400' : 'bg-[#1a1f2e] text-gray-500'}`}>
          SNAP
        </button>

        {sceneData.grid.snap && (
          <input type="number" value={toDisplay(sceneData.grid.snapSize)} step={0.1} min={0.1}
            onChange={e => setSceneData(prev => ({ ...prev, grid: { ...prev.grid, snapSize: Math.max(0.001, toRaw(parseFloat(e.target.value) || 0.5)) } }))}
            className="w-14 bg-[#1a1f2e] border border-[#2a2f42] rounded px-2 py-1 text-xs text-yellow-300 focus:outline-none" />
        )}

        <div className="w-px h-5 bg-[#2a2f42]" />

        <button onClick={() => { setMeasureMode(prev => !prev); setGdtMode(false); }}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors
            ${measureMode ? 'bg-yellow-500/20 text-yellow-300 ring-1 ring-yellow-500/50' : 'bg-[#1a1f2e] text-gray-400 hover:text-gray-200'}`}
          title="거리 측정 (M)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
            <path d="M2 12h20M2 12l4-4M2 12l4 4M22 12l-4-4M22 12l-4 4"/>
          </svg>
          {measureMode ? '측정 중 (ESC)' : '거리 측정 (M)'}
        </button>

        <button onClick={() => { setGdtMode(prev => !prev); setMeasureMode(false); }}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors
            ${gdtMode ? 'bg-purple-500/20 text-purple-300 ring-1 ring-purple-500/50' : 'bg-[#1a1f2e] text-gray-400 hover:text-gray-200'}`}
          title="GD&T 기하 공차 (G)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
            <rect x="3" y="8" width="18" height="8" rx="1"/>
            <path d="M9 8V6M15 8V6M3 12h4M17 12h4"/>
            <circle cx="12" cy="12" r="1.5" fill="currentColor"/>
          </svg>
          {gdtMode ? 'GD&T 중 (ESC)' : 'GD&T 공차 (G)'}
        </button>

        <div className="flex-1" />

        {/* 크기 초과 경고 토스트 */}
        {sizeWarning && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-red-900/40 border border-red-500/50 text-red-300 text-xs">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4 shrink-0">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            {sizeWarning}
          </div>
        )}

        {currentScene && (
          <button onClick={saveScene} disabled={saving}
            className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium
              ${savedMsg ? 'bg-green-600' : 'bg-sky-600 hover:bg-sky-500'} disabled:opacity-50`}>
            <Icon.Save />
            {savedMsg ? '저장됨' : saving ? '저장 중...' : '저장'}
          </button>
        )}
      </div>

      {/* ── 메인 ────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── 좌측: 에셋 라이브러리 ─────────────────────────────── */}
        <div className="w-56 bg-[#0f1117] border-r border-[#1e2130] flex flex-col shrink-0">
          {/* 검색 */}
          <div className="px-3 pt-3 pb-2">
            <input type="text" value={assetSearch} onChange={e => setAssetSearch(e.target.value)}
              placeholder="검색..."
              className="w-full bg-[#1a1f2e] border border-[#2a2f42] rounded px-2 py-1.5
                         text-xs text-gray-300 placeholder-gray-600 focus:outline-none focus:border-sky-500" />
          </div>

          {/* 카테고리 필터 */}
          <div className="px-3 pb-2">
            <div className="flex flex-wrap gap-1">
              <button
                onClick={() => setSelectedCategoryId(null)}
                className={`px-2 py-0.5 rounded text-[11px] transition-colors
                  ${selectedCategoryId === null ? 'bg-sky-600 text-white' : 'bg-[#1a1f2e] text-gray-500 hover:text-gray-300'}`}>
                전체
              </button>
              {categories.map(c => (
                <button key={c.id}
                  onClick={() => setSelectedCategoryId(c.id === selectedCategoryId ? null : c.id)}
                  className={`px-2 py-0.5 rounded text-[11px] transition-colors
                    ${selectedCategoryId === c.id ? 'bg-sky-600 text-white' : 'bg-[#1a1f2e] text-gray-500 hover:text-gray-300'}`}>
                  {c.name}
                </button>
              ))}
            </div>
          </div>

          <div className="border-t border-[#1e2130]" />

          {/* 에셋 목록 */}
          <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {filteredAssets.length === 0 && (
              <p className="text-gray-700 text-xs text-center py-6">에셋 없음</p>
            )}
            {filteredAssets.map(asset => (
              <div
                key={asset.id}
                draggable
                onDragStart={e => {
                  setDraggedAsset(asset);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onDragEnd={() => setDraggedAsset(null)}
                onDoubleClick={() => addAssetToScene(asset)}
                className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-[#1a1f2e] transition-colors group
                           cursor-grab active:cursor-grabbing select-none"
                title="더블클릭: 중앙 배치 | 드래그: 원하는 위치에 배치">
                <p className="text-xs font-medium text-gray-400 group-hover:text-gray-200 truncate">{asset.name}</p>
                <div className="flex items-center gap-1 mt-0.5">
                  <span className="text-[10px] text-gray-600">{ASSET_TYPE_LABELS[asset.type]}</span>
                  {asset.category && (
                    <span className="text-[10px] text-sky-700 bg-sky-900/20 px-1 rounded">{asset.category.name}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="px-3 py-2 border-t border-[#1e2130]">
            <p className="text-[10px] text-gray-700">더블클릭: 중앙 배치 | 드래그: 위치 지정</p>
          </div>
        </div>

        {/* ── 중앙: 뷰포트 ────────────────────────────────────── */}
        <div className="flex-1 relative">
          {!currentScene ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
              <p className="text-gray-600 text-sm">씬을 선택하거나 새로 만드세요</p>
              <button onClick={() => setShowSceneModal(true)}
                className="px-6 py-3 bg-sky-600 hover:bg-sky-500 text-white rounded-xl text-sm font-medium">
                씬 열기 / 새 씬 만들기
              </button>
            </div>
          ) : (
            <Viewport
              sceneData={sceneData}
              selectedId={selectedId}
              transformMode={transformMode}
              measureMode={measureMode}
              gdtMode={gdtMode}
              scaleLocked={scaleLocked}
              onSelectObject={setSelectedId}
              onTransformEnd={handleTransformEnd}
              onViewportRef={ref => {
                viewportRef.current = ref;
                window.requestAnimationFrame(syncObjectSizesFromViewport);
              }}
              onDropAsset={pos => {
                if (!draggedAsset) return;
                // 드롭 위치도 씬 경계 내로 클램프
                const hw = (sceneData.area?.width ?? 20) / 2;
                const hd = (sceneData.area?.depth ?? 20) / 2;
                const clamped: [number, number, number] = [
                  Math.max(-hw, Math.min(hw, pos[0])),
                  pos[1],
                  Math.max(-hd, Math.min(hd, pos[2])),
                ];
                addAssetToScene(draggedAsset, clamped);
              }}
              onScaleExceedsArea={() => {
                setSizeWarning('씬 경계를 초과하여 크기를 더 키울 수 없습니다.');
                setTimeout(() => setSizeWarning(null), 3000);
              }}
              onObjectExceedsArea={(name, sizeX, sizeZ) => {
                const area = sceneData.area ?? { width: 20, depth: 20 };
                const unit = sceneData.unit ?? 'm';
                setSizeWarning(
                  `"${name}" (${formatDisplayLength(sizeX, unit, 1)}×${formatDisplayLength(sizeZ, unit, 1)}${unit})이 씬 영역(${formatDisplayLength(area.width, unit, 1)}×${formatDisplayLength(area.depth, unit, 1)}${unit})을 초과하여 배치가 취소되었습니다.`
                );
                setTimeout(() => setSizeWarning(null), 4000);
              }}
              onObjectRemove={id => removeObject(id)}
            />
          )}
        </div>

        {/* ── 우측 패널 ───────────────────────────────────────── */}
        <div className="w-60 bg-[#0f1117] border-l border-[#1e2130] flex flex-col shrink-0 overflow-y-auto">

          {/* 계층 구조 */}
          <div className="border-b border-[#1e2130]">
            <SectionHeader
              title={`계층 구조 (${sceneData.objects.length})`}
              open={openSections.has('hierarchy')}
              onToggle={() => toggleSection('hierarchy')}
            />
            {openSections.has('hierarchy') && (
              <div className="max-h-48 overflow-y-auto pb-1">
                {sceneData.objects.length === 0 && (
                  <p className="text-gray-700 text-xs text-center py-3">오브젝트 없음</p>
                )}
                {sceneData.objects.map(obj => (
                  <div key={obj.id} onClick={() => setSelectedId(obj.id)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 cursor-pointer group transition-colors
                      ${selectedId === obj.id ? 'bg-sky-600/20 text-sky-300' : 'hover:bg-[#1a1f2e] text-gray-400'}`}>
                    <button onClick={e => { e.stopPropagation(); toggleVisible(obj.id); }}
                      className="text-gray-500 hover:text-gray-300 shrink-0">
                      <Icon.Eye visible={obj.visible} />
                    </button>
                    <span className="text-xs truncate flex-1">{obj.name}</span>
                    <button onClick={e => { e.stopPropagation(); removeObject(obj.id); }}
                      className="text-gray-700 hover:text-red-400 opacity-0 group-hover:opacity-100 shrink-0">
                      <Icon.Trash />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 트랜스폼 */}
          <div className="border-b border-[#1e2130]">
            <SectionHeader
              title="트랜스폼"
              open={openSections.has('transform')}
              onToggle={() => toggleSection('transform')}
            />
            {openSections.has('transform') && (
              <div className="px-3 pb-3 space-y-2.5">
                {!selectedObj ? (
                  <p className="text-gray-700 text-xs text-center py-2">오브젝트를 선택하세요</p>
                ) : (
                  <>
                    <div>
                      <p className="text-[10px] text-gray-600 mb-1">위치</p>
                      <div className="space-y-1">
                        {(['X','Y','Z'] as const).map((axis, i) => (
                          <NumInput key={axis} label={axis} value={toDisplay(selectedObj.position[i])}
                            onChange={v => updateObjectProp('position', i as 0|1|2, toRaw(v))} />
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-[10px] text-gray-600 mb-1">회전 (°)</p>
                      <div className="space-y-1">
                        {(['X','Y','Z'] as const).map((axis, i) => (
                          <NumInput key={axis} label={axis} value={selectedObj.rotation[i]} step={1}
                            onChange={v => updateObjectProp('rotation', i as 0|1|2, v)} />
                        ))}
                      </div>
                    </div>
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-1.5">
                          <p className="text-[10px] text-gray-600">크기</p>
                          {/* 비율 잠금 버튼 */}
                          <button
                            onClick={() => setScaleLocked(v => !v)}
                            title={scaleLocked ? '비율 잠금 해제' : '비율 잠금'}
                            className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] transition-colors
                              ${scaleLocked ? 'bg-sky-600/20 text-sky-400' : 'bg-[#1a1f2e] text-gray-500 hover:text-gray-300'}`}>
                            {scaleLocked ? (
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3 h-3">
                                <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>
                              </svg>
                            ) : (
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3 h-3">
                                <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 019.9-1"/>
                              </svg>
                            )}
                            비율
                          </button>
                        </div>
                        <button onClick={handleNormalize}
                          className="text-[10px] text-sky-400 hover:text-sky-300 px-1.5 py-0.5 rounded
                                     bg-sky-900/20 hover:bg-sky-900/40 transition-colors"
                          title="최대 크기를 1m로 정규화">
                          정규화
                        </button>
                      </div>
                      <div className="space-y-1">
                        {(['X','Y','Z'] as const).map((axis, i) => (
                          <NumInput key={axis} label={axis} value={toDisplay([selectedActualSize!.x, selectedActualSize!.y, selectedActualSize!.z][i])}
                            onChange={v => updateObjectActualSize(i as 0|1|2, toRaw(v))} />
                        ))}
                      </div>
                      {/* 실제 크기 표시 — 바운딩박스 기반 */}
                      {/*
                        ?ㅼ젣 ?ш린: {formatDisplayLength(selectedActualSize!.x, currentUnit)} 횞 {formatDisplayLength(selectedActualSize!.y, currentUnit)} 횞 {formatDisplayLength(selectedActualSize!.z, currentUnit)} {currentUnit}
                      */}
                      {/*
                        諛뺤뒪 湲곗? : {formatDisplayLength(selectedRoundedBoxSize!.x, currentUnit, 0)} 횞 {formatDisplayLength(selectedRoundedBoxSize!.y, currentUnit, 0)} 횞 {formatDisplayLength(selectedRoundedBoxSize!.z, currentUnit, 0)} {currentUnit}
                      */}
                      <p className="text-[10px] text-gray-500 mt-1">
                        Actual size: {formatDisplayLength(selectedActualSize!.x, currentUnit)} x {formatDisplayLength(selectedActualSize!.y, currentUnit)} x {formatDisplayLength(selectedActualSize!.z, currentUnit)} {currentUnit}
                      </p>
                      <p className="text-[10px] text-gray-600">
                        Box size: {formatDisplayLength(selectedRoundedBoxSize!.x, currentUnit, 0)} x {formatDisplayLength(selectedRoundedBoxSize!.y, currentUnit, 0)} x {formatDisplayLength(selectedRoundedBoxSize!.z, currentUnit, 0)} {currentUnit}
                      </p>
                      {/*
                        const unit = sceneData.unit ?? 'm';
                        const actual = objectSizes.get(selectedObj.id);
                        if (actual) {
                          return (
                            <p className="text-[10px] text-gray-500 mt-1">
                              실제 크기: {formatDisplayLength(actual.x, unit)} × {formatDisplayLength(actual.y, unit)} × {formatDisplayLength(actual.z, unit)} {unit}
                            </p>
                          );
                        }
                        const s = selectedObj.scale;
                        return (
                          <p className="text-[10px] text-gray-600 mt-1">
                            스케일: {formatDisplayLength(s[0], unit)} × {formatDisplayLength(s[1], unit)} × {formatDisplayLength(s[2], unit)} {unit}
                          </p>
                        );
                      */}
                    </div>
                    <button onClick={() => removeObject(selectedObj.id)}
                      className="w-full py-1.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-900/20
                                 rounded-lg border border-red-900/30 transition-colors">
                      오브젝트 삭제
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          {/* 조명 */}
          <div className="border-b border-[#1e2130]">
            <SectionHeader title="조명" open={openSections.has('lighting')} onToggle={() => toggleSection('lighting')} />
            {openSections.has('lighting') && (
              <div className="px-3 pb-3 space-y-3">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-[10px] text-gray-500">배경색</p>
                  </div>
                  <input type="color"
                    value={sceneData.backgroundColor ?? '#1a1a2e'}
                    onChange={e => setSceneData(prev => ({ ...prev, backgroundColor: e.target.value }))}
                    className="w-8 h-5 rounded cursor-pointer border-0 bg-transparent" />
                </div>
                {[
                  { key: 'ambient' as const, label: '주변광', max: 2 },
                  { key: 'directional' as const, label: '직사광', max: 3 },
                ].map(({ key, label, max }) => (
                  <div key={key}>
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-[10px] text-gray-500">{label}</p>
                      <span className="text-[10px] text-gray-600">{sceneData.lighting[key].intensity.toFixed(1)}</span>
                    </div>
                    <input type="range" min={0} max={max} step={0.1}
                      value={sceneData.lighting[key].intensity}
                      onChange={e => updateLighting(key, 'intensity', parseFloat(e.target.value))}
                      className="w-full h-1 rounded accent-sky-500" />
                    <input type="color" value={sceneData.lighting[key].color}
                      onChange={e => updateLighting(key, 'color', e.target.value)}
                      className="mt-1 w-6 h-4 rounded cursor-pointer border-0 bg-transparent" />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 씬 설정 */}
          {currentScene && (
            <div className="border-b border-[#1e2130]">
              <SectionHeader
                title="씬 설정"
                open={openSections.has('scene-settings')}
                onToggle={() => toggleSection('scene-settings')}
              />
              {openSections.has('scene-settings') && (
                <div className="px-3 pb-3 space-y-2.5">
                  {/* 단위 */}
                  <div>
                    <p className="text-[10px] text-gray-600 mb-1">길이 단위</p>
                    <div className="flex gap-1">
                      {(['m', 'cm', 'mm', 'ft'] as const).map(u => (
                        <button key={u}
                          onClick={() => setPendingUnit(u)}
                          className={`px-2 py-0.5 rounded text-[11px] transition-colors
                            ${pendingUnit === u
                              ? 'bg-sky-600 text-white'
                              : 'bg-[#1a1f2e] text-gray-500 hover:text-gray-300'}`}>
                          {u}
                        </button>
                      ))}
                    </div>
                    <div className="mt-2 flex gap-1">
                      <button
                        onClick={applyNumericUnitConversion}
                        disabled={!canApplyNumericUnitConversion}
                        className="flex-1 px-2 py-1 rounded bg-sky-600/20 text-sky-300 text-[11px] disabled:opacity-40 disabled:cursor-not-allowed hover:bg-sky-600/30 transition-colors"
                      >
                        수치 변환
                      </button>
                      <button
                        onClick={applySettingUnitConversion}
                        disabled={!canApplySettingUnitConversion}
                        className="flex-1 px-2 py-1 rounded bg-amber-500/15 text-amber-300 text-[11px] disabled:opacity-40 disabled:cursor-not-allowed hover:bg-amber-500/25 transition-colors"
                      >
                        설정 변환
                      </button>
                    </div>
                  </div>
                  {/* 배치 영역 */}
                  <div>
                    <p className="text-[10px] text-gray-600 mb-1">
                      배치 영역 ({currentUnit})
                    </p>
                    <div className="flex flex-col gap-1">
                      {([
                        { label: 'W', dim: 'width' as const, draft: areaDraftW, setDraft: setAreaDraftW },
                        { label: 'D', dim: 'depth' as const, draft: areaDraftD, setDraft: setAreaDraftD },
                      ]).map(({ label, dim, draft, setDraft }) => {
                        const committed = formatForDisplay(sceneData.area?.[dim] ?? 20);
                        const isDirty = draft !== '' && draft !== committed;
                        const applyDim = () => {
                          const raw = draft !== '' ? draft : committed;
                          tryApplyArea(dim, raw);
                          setDraft('');
                        };
                        return (
                          <div key={dim} className="flex items-center gap-1">
                            <span className="text-[10px] text-gray-500 w-4">{label}</span>
                            <input
                              type="number" min={0.001} step={0.1}
                              value={draft !== '' ? draft : committed}
                              onChange={e => setDraft(e.target.value)}
                              onFocus={e => setDraft(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') { applyDim(); (e.target as HTMLInputElement).blur(); }
                                if (e.key === 'Escape') { setDraft(''); (e.target as HTMLInputElement).blur(); }
                              }}
                              onBlur={applyDim}
                              className={`w-full bg-[#1a1f2e] rounded px-1.5 py-0.5 text-xs text-gray-200
                                          focus:outline-none transition-colors
                                          ${isDirty
                                            ? 'border border-yellow-500/70 focus:border-yellow-400'
                                            : 'border border-[#2a2f42] focus:border-sky-500'}`}
                            />
                            {isDirty && (
                              <button
                                onMouseDown={e => e.preventDefault()}
                                onClick={applyDim}
                                className="shrink-0 px-1.5 py-0.5 rounded bg-yellow-600/80 hover:bg-yellow-500
                                           text-[10px] text-white transition-colors">
                                적용
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <p className="text-[10px] text-gray-700 mt-1">
                      현재: {formatForDisplay(sceneData.area?.width ?? 20)} × {formatForDisplay(sceneData.area?.depth ?? 20)} {currentUnit}
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 카메라 뷰 */}
          <div>
            <SectionHeader
              title="카메라 뷰"
              open={openSections.has('camera')}
              onToggle={() => toggleSection('camera')}
              action={
                <button onClick={saveCurrentView}
                  className="flex items-center gap-0.5 text-[10px] text-sky-400 hover:text-sky-300">
                  <Icon.Camera /> 저장
                </button>
              }
            />
            {openSections.has('camera') && (
              <div className="px-3 pb-3 space-y-1">
                {sceneData.savedViews.length === 0 && (
                  <p className="text-gray-700 text-xs text-center py-2">저장된 뷰 없음</p>
                )}
                {sceneData.savedViews.map(view => (
                  <div key={view.id} className="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-[#1a1f2e] group">
                    <button onClick={() => applyView(view)}
                      className="flex-1 text-left text-xs text-gray-400 hover:text-gray-200">
                      {view.name}
                    </button>
                    <button onClick={() => removeView(view.id)}
                      className="text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100">
                      <Icon.Trash />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {showSceneModal && (
        <SceneModal
          scenes={scenes}
          onSelect={openScene}
          onCreate={createScene}
          onRename={renameScene}
          onClose={() => setShowSceneModal(false)}
        />
      )}
    </div>
  );
}
