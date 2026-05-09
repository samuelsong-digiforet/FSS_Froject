import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_SCENE_DATA, Scene, SceneData, scenesApi } from '@/api/scenes';
import Viewport from '@/pages/studio/Viewport';
import { formatDisplayLength, normalizeSceneLengthData } from '@/pages/studio/sceneUnits';

const DASHBOARD_SCENE_STORAGE_KEY = 'dashboard:selected-scene-id';

function getStoredSceneId() {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(DASHBOARD_SCENE_STORAGE_KEY);
}

function storeSceneId(sceneId: string) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(DASHBOARD_SCENE_STORAGE_KEY, sceneId);
}

function clearStoredSceneId() {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(DASHBOARD_SCENE_STORAGE_KEY);
}

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

function SceneLookupModal({
  scenes,
  loading,
  selectedSceneId,
  onSelect,
  onClose,
}: {
  scenes: Scene[];
  loading: boolean;
  selectedSceneId: string | null;
  onSelect: (sceneId: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
      <div className="w-full max-w-2xl overflow-hidden rounded-2xl border border-[#24324f] bg-[#0d1729] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#1b2740] px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-white">트윈 스튜디오 씬 조회</h2>
            <p className="mt-1 text-sm text-slate-400">대시보드에서 확인할 씬을 선택하세요.</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg border border-[#2a3652] px-3 py-1.5 text-sm text-slate-300 transition-colors hover:bg-[#17233b] hover:text-white"
          >
            닫기
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="flex h-48 items-center justify-center text-sm text-slate-400">씬 목록을 불러오는 중입니다.</div>
          ) : scenes.length === 0 ? (
            <div className="flex h-48 items-center justify-center text-sm text-slate-400">조회 가능한 씬이 없습니다.</div>
          ) : (
            <div className="space-y-3">
              {scenes.map((scene) => {
                const unit = scene.data?.unit ?? 'm';
                const area = scene.data?.area;
                const isSelected = selectedSceneId === scene.id;

                return (
                  <div
                    key={scene.id}
                    className={`rounded-xl border px-4 py-3 transition-colors ${
                      isSelected
                        ? 'border-sky-500/70 bg-sky-500/10'
                        : 'border-[#22304a] bg-[#101b2d] hover:border-[#3a4a67]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <p className="truncate text-base font-semibold text-white">{scene.name}</p>
                        <p className="mt-1 text-sm text-slate-400">
                          객체 {scene.data.objects.length}개
                          {area ? ` · ${formatDisplayLength(area.width, unit)} × ${formatDisplayLength(area.depth, unit)} ${unit}` : ''}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          최근 수정 {new Date(scene.updatedAt).toLocaleString('ko-KR')}
                        </p>
                      </div>
                      <button
                        onClick={() => onSelect(scene.id)}
                        className={`shrink-0 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                          isSelected
                            ? 'bg-sky-500 text-white'
                            : 'bg-[#1a2a45] text-slate-200 hover:bg-[#233655]'
                        }`}
                      >
                        {isSelected ? '조회 중' : '조회'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function HomePage() {
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [selectedScene, setSelectedScene] = useState<Scene | null>(null);
  const [showSceneModal, setShowSceneModal] = useState(false);
  const [loadingScenes, setLoadingScenes] = useState(false);
  const [loadingSceneDetail, setLoadingSceneDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadScenes = async () => {
    setLoadingScenes(true);
    setError(null);
    try {
      const { data } = await scenesApi.getAll();
      const normalized = data
        .map((scene) => ({
          ...scene,
          data: normalizeSceneData(scene.data as Partial<SceneData> | undefined),
        }))
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

      setScenes(normalized);

      const persistedSceneId = getStoredSceneId();
      if (persistedSceneId && !normalized.some((scene) => scene.id === persistedSceneId)) {
        clearStoredSceneId();
        setSelectedScene(null);
      }
    } catch {
      setError('씬 목록을 불러오지 못했습니다.');
    } finally {
      setLoadingScenes(false);
    }
  };

  useEffect(() => {
    const initializeDashboard = async () => {
      const persistedSceneId = getStoredSceneId();
      await loadScenes();

      if (!persistedSceneId) return;

      setLoadingSceneDetail(true);
      try {
        const { data } = await scenesApi.getOne(persistedSceneId);
        setSelectedScene({
          ...data,
          data: normalizeSceneData(data.data as Partial<SceneData> | undefined),
        });
      } catch {
        clearStoredSceneId();
        setSelectedScene(null);
        setError('저장된 대시보드 씬을 불러오지 못했습니다.');
      } finally {
        setLoadingSceneDetail(false);
      }
    };

    void initializeDashboard();
  }, []);

  const handleOpenSceneLookup = async () => {
    setShowSceneModal(true);
    await loadScenes();
  };

  const handleSelectScene = async (sceneId: string) => {
    setLoadingSceneDetail(true);
    setError(null);
    try {
      const { data } = await scenesApi.getOne(sceneId);
      storeSceneId(sceneId);
      setSelectedScene({
        ...data,
        data: normalizeSceneData(data.data as Partial<SceneData> | undefined),
      });
      setShowSceneModal(false);
    } catch {
      setError('선택한 씬을 불러오지 못했습니다.');
    } finally {
      setLoadingSceneDetail(false);
    }
  };

  const handleResetScene = () => {
    clearStoredSceneId();
    setSelectedScene(null);
    setError(null);
    setShowSceneModal(false);
  };

  const selectedSceneSummary = useMemo(() => {
    if (!selectedScene) return null;

    const unit = selectedScene.data.unit ?? 'm';
    const area = selectedScene.data.area;

    return {
      objectCount: selectedScene.data.objects.length,
      areaLabel: `${formatDisplayLength(area.width, unit)} × ${formatDisplayLength(area.depth, unit)} ${unit}`,
      updatedAtLabel: new Date(selectedScene.updatedAt).toLocaleString('ko-KR'),
    };
  }, [selectedScene]);

  return (
    <div className="flex h-full min-h-full flex-col bg-[#08111f] text-white">
      <div className="border-b border-[#1b2740] bg-[radial-gradient(circle_at_top_left,_rgba(56,189,248,0.12),_transparent_32%),linear-gradient(180deg,_#0f1a2e_0%,_#091321_100%)] px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.32em] text-sky-300/70">Digital Twin Dashboard</p>
            <h1 className="mt-2 text-2xl font-semibold text-white">트윈 스튜디오 씬 조회</h1>
            <p className="mt-2 text-sm text-slate-400">
              스튜디오에서 저장한 씬을 선택해 대시보드에서 읽기 전용으로 확인할 수 있습니다.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => void loadScenes()}
              className="rounded-lg border border-[#2c3d5e] px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-[#142137]"
            >
              목록 새로고침
            </button>
            <button
              onClick={handleResetScene}
              disabled={!selectedScene}
              className="rounded-lg border border-[#374863] px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-[#142137] disabled:cursor-not-allowed disabled:opacity-40"
            >
              초기화
            </button>
            <button
              onClick={() => void handleOpenSceneLookup()}
              className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-400"
            >
              조회
            </button>
          </div>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]">
          <div className="rounded-xl border border-[#24324f] bg-[#0f1b2d]/80 px-4 py-3">
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">현재 씬</p>
            <p className="mt-2 truncate text-lg font-semibold text-white">
              {selectedScene ? selectedScene.name : '선택된 씬 없음'}
            </p>
            <p className="mt-1 text-sm text-slate-400">
              {selectedScene ? '조회 버튼으로 다른 씬을 선택할 수 있습니다.' : '상단 조회 버튼으로 확인할 씬을 선택하세요.'}
            </p>
          </div>

          <div className="rounded-xl border border-[#24324f] bg-[#0f1b2d]/80 px-4 py-3">
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">배치 영역</p>
            <p className="mt-2 text-lg font-semibold text-white">{selectedSceneSummary?.areaLabel ?? '-'}</p>
          </div>

          <div className="rounded-xl border border-[#24324f] bg-[#0f1b2d]/80 px-4 py-3">
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">객체 수</p>
            <p className="mt-2 text-lg font-semibold text-white">
              {selectedSceneSummary ? `${selectedSceneSummary.objectCount}개` : '-'}
            </p>
          </div>

          <div className="rounded-xl border border-[#24324f] bg-[#0f1b2d]/80 px-4 py-3">
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">최근 수정</p>
            <p className="mt-2 text-sm font-medium text-white">{selectedSceneSummary?.updatedAtLabel ?? '-'}</p>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 p-6">
        {error && (
          <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        )}

        <div className="relative h-full min-h-[520px] overflow-hidden rounded-2xl border border-[#1d2a42] bg-[#0a1321] shadow-[0_24px_60px_rgba(0,0,0,0.35)]">
          {selectedScene ? (
            <>
              <Viewport
                sceneData={selectedScene.data}
                selectedId={null}
                transformMode="translate"
                measureMode={false}
                gdtMode={false}
                scaleLocked
                readOnly
                onSelectObject={() => {}}
                onTransformEnd={() => {}}
                onViewportRef={() => {}}
              />

              <div className="pointer-events-none absolute left-4 top-4 rounded-full border border-white/10 bg-black/35 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-sm">
                읽기 전용 씬 뷰
              </div>

              {loadingSceneDetail && (
                <div className="absolute inset-0 flex items-center justify-center bg-[#08111f]/65 backdrop-blur-[2px]">
                  <div className="rounded-xl border border-[#2a3652] bg-[#0f1a2e] px-5 py-3 text-sm text-slate-200">
                    씬을 불러오는 중입니다.
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
              <div className="rounded-full border border-sky-500/20 bg-sky-500/10 px-4 py-1 text-xs uppercase tracking-[0.24em] text-sky-300">
                Scene Viewer
              </div>
              <div>
                <h2 className="text-2xl font-semibold text-white">조회할 씬을 선택하세요</h2>
                <p className="mt-2 text-sm text-slate-400">
                  트윈 스튜디오에서 저장한 씬을 선택하면 대시보드에서 배치 수정 없이 그대로 확인할 수 있습니다.
                </p>
              </div>
              <button
                onClick={() => void handleOpenSceneLookup()}
                className="rounded-lg bg-sky-500 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-sky-400"
              >
                씬 조회
              </button>
            </div>
          )}
        </div>
      </div>

      {showSceneModal && (
        <SceneLookupModal
          scenes={scenes}
          loading={loadingScenes}
          selectedSceneId={selectedScene?.id ?? null}
          onSelect={(sceneId) => void handleSelectScene(sceneId)}
          onClose={() => setShowSceneModal(false)}
        />
      )}
    </div>
  );
}
