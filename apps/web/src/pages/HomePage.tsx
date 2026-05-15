import { useEffect, useMemo, useState } from 'react';
import { assetCategoriesApi, type AssetCategory } from '@/api/assetCategories';
import { assetsApi, type Asset, type AssetType } from '@/api/assets';
import { usePermission } from '@/hooks/usePermission';

const fmt = new Intl.NumberFormat('ko-KR');
const CATEGORY_VISIBLE_COUNT = 4;

/* ── 아이콘 ── */
const IcoCheck = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-6 h-6">
    <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const IcoX = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-6 h-6">
    <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
  </svg>
);
const IcoShield = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-6 h-6">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M9 12l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const IcoClock = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-6 h-6">
    <circle cx="12" cy="12" r="10" />
    <path d="M12 6v6l4 2" strokeLinecap="round" />
  </svg>
);
const IcoCloud = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} className="w-6 h-6">
    <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const IcoSpark = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} className="w-6 h-6">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const IcoCube = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} className="w-6 h-6">
    <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
  </svg>
);
const IcoEye = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} className="w-6 h-6">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" strokeLinecap="round" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
const IcoTag = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} className="w-5 h-5">
    <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" strokeLinecap="round" strokeLinejoin="round" />
    <line x1="7" y1="7" x2="7.01" y2="7" strokeLinecap="round" strokeWidth={3} />
  </svg>
);
const IcoChevronLeft = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-4 h-4">
    <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const IcoChevronRight = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-4 h-4">
    <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const IcoGrid = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
    <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
  </svg>
);
const IcoConvert = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
    <path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const IcoCategory = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
    <path d="M4 6h16M4 10h16M4 14h16M4 18h16" strokeLinecap="round" />
  </svg>
);

/* ── 단색 에셋 카드 ── */
type SolidCardProps = {
  icon: React.ReactNode;
  label: string;
  value: number;
  desc: string;
  bg: string;
  labelColor: string;
};

function SolidCard({ icon: _icon, label, value, desc, bg, labelColor }: SolidCardProps) {
  return (
    <div className={`rounded-xl ${bg} p-4 flex flex-col gap-2`}>
      <div>
        <span className={`inline-block bg-white text-xs font-bold px-2.5 py-1 rounded-md ${labelColor}`}>{label}</span>
      </div>
      <p className="text-4xl font-black text-white tabular-nums leading-none">
        {fmt.format(value)}<span className="text-lg font-bold ml-1">개</span>
      </p>
      <p className="text-xs text-white font-bold">{desc}</p>
    </div>
  );
}

/* ── 단색 변환 파일 카드 ── */
type ConvertCardProps = {
  icon: React.ReactNode;
  label: string;
  total: number;
  success: number;
  failure: number;
  processing: number;
  bg: string;
  barBg: string;
  labelColor: string;
};

function ConvertCard({ icon: _icon, label, total, success, failure, processing, bg, barBg: _barBg, labelColor }: ConvertCardProps) {
  const pending = total - success - failure - processing;
  return (
    <div className={`rounded-xl ${bg} p-4 flex flex-col gap-3`}>
      {/* 헤더 */}
      <div>
        <span className={`inline-block bg-white text-xs font-bold px-2.5 py-1 rounded-md ${labelColor}`}>{label}</span>
      </div>
      {/* 총계 */}
      <div>
        <p className="text-4xl font-black text-white tabular-nums leading-none">
          {fmt.format(total)}<span className="text-lg font-bold ml-1">개</span>
        </p>
        <p className="text-xs text-white font-bold mt-0.5">전체 에셋</p>
      </div>
      {/* 4분할 수치 */}
      <div className="grid grid-cols-4 gap-1">
        {[
          { label: '성공',    value: success },
          { label: '실패',    value: failure },
          { label: '처리 중', value: processing },
          { label: '대기',    value: pending },
        ].map((item) => (
          <div key={item.label} className="rounded-lg bg-white/20 text-white px-1 py-1.5 text-center">
            <p className="text-[10px] font-extrabold text-white mb-0.5">{item.label}</p>
            <p className="text-sm font-black tabular-nums">{fmt.format(item.value)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── 카테고리 카드 ── */
type CatCardProps = {
  rank: number;
  name: string;
  count: number;
  total: number;
};

const CAT_COLORS = [
  { bg: 'bg-blue-600',   text: 'text-blue-600' },
  { bg: 'bg-orange-600', text: 'text-orange-600' },
  { bg: 'bg-teal-600',   text: 'text-teal-600' },
  { bg: 'bg-violet-600', text: 'text-violet-600' },
  { bg: 'bg-rose-600',   text: 'text-rose-600' },
  { bg: 'bg-amber-600',  text: 'text-amber-600' },
];

function CatCard({ rank, name, count, total: _total }: CatCardProps) {
  const c = CAT_COLORS[Math.min(rank - 1, CAT_COLORS.length - 1)];
  return (
    <div className={`rounded-xl ${c.bg} p-4 flex flex-col gap-3`}>
      <div>
        <span className={`inline-flex items-center gap-1.5 bg-white text-xs font-bold px-2 py-1 rounded-md ${c.text} max-w-full`}>
          <span className={`w-4 h-4 rounded text-[10px] font-black flex items-center justify-center shrink-0 ${c.bg} text-white`}>{rank}</span>
          <span className="truncate">{name}</span>
        </span>
      </div>
      <div>
        <p className="text-4xl font-black text-white tabular-nums leading-none">
          {fmt.format(count)}<span className="text-lg font-bold ml-1">개</span>
        </p>
      </div>
    </div>
  );
}

/* ── 섹션 라벨 ── */
function SectionLabel({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 text-[#2d4a7a] mb-3">
      {icon}
      <span className="text-sm font-bold">{title}</span>
    </div>
  );
}

/* ── 스켈레톤 ── */
function SolidSkeleton() {
  return <div className="animate-pulse rounded-xl bg-gray-200 h-32" />;
}
function ConvertSkeleton() {
  return <div className="animate-pulse rounded-xl bg-gray-200 h-44" />;
}

/* ── 메인 ── */
export default function HomePage() {
  const perm = usePermission('dashboard');
  const [assets, setAssets] = useState<Asset[]>([]);
  const [categories, setCategories] = useState<AssetCategory[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!perm.isLoaded || !perm.view) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      const [aRes, cRes] = await Promise.allSettled([
        assetsApi.getAll(),
        assetCategoriesApi.getAll({ limit: 100 }),
      ]);
      if (cancelled) return;
      setAssets(aRes.status === 'fulfilled' ? aRes.value.data : []);
      setCategories(cRes.status === 'fulfilled' ? cRes.value.data.items : []);
      if (aRes.status === 'rejected') setError('데이터를 불러오지 못했습니다.');
      setLoading(false);
    };
    void load();
    return () => { cancelled = true; };
  }, [perm.isLoaded, perm.view]);

  const d = useMemo(() => {
    const total = assets.length;
    const success = assets.filter((a) => a.status === 'done').length;
    const failure = assets.filter((a) => a.status === 'failed').length;
    const processing = assets.filter((a) => a.status === 'processing' || a.status === 'awaiting_crop').length;
    const pending = assets.filter((a) => a.status !== 'done' && a.status !== 'failed' && a.status !== 'processing' && a.status !== 'awaiting_crop').length;
    const approved = assets.filter((a) => a.approved).length;
    const unapproved = total - approved;

    const types: AssetType[] = ['point_cloud', 'gaussian', 'nerf', 'mesh'];
    const byType = types.map((type) => {
      const t = assets.filter((a) => a.type === type);
      const success = t.filter((a) => a.status === 'done').length;
      const failure = t.filter((a) => a.status === 'failed').length;
      const processing = t.filter((a) => a.status === 'processing' || a.status === 'awaiting_crop').length;
      return { type, total: t.length, success, failure, processing };
    });

    const catMap = new Map<number, string>();
    categories.forEach((c) => catMap.set(c.id, c.name));
    assets.forEach((a) => {
      if (a.categoryId && a.category?.name && !catMap.has(a.categoryId))
        catMap.set(a.categoryId, a.category.name);
    });
    const uncategorized = assets.filter((a) => !a.categoryId).length;
    const catCards = Array.from(catMap.entries())
      .map(([id, name]) => ({ id, name, count: assets.filter((a) => a.categoryId === id).length }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ko'));
    if (uncategorized > 0) catCards.push({ id: -1, name: '미분류', count: uncategorized });

    return { total, success, failure, processing, pending, approved, unapproved, byType, catCards };
  }, [assets, categories]);


  if (perm.isLoaded && !perm.view) {
    return <div className="h-full flex items-center justify-center text-sm text-gray-400">대시보드 권한이 없습니다.</div>;
  }

  const typeConfig: Record<AssetType, { label: string; icon: React.ReactNode; bg: string; barBg: string; labelColor: string }> = {
    point_cloud: { label: 'Point Cloud', icon: <IcoCloud />, bg: 'bg-cyan-600',    barBg: 'bg-cyan-800',    labelColor: 'text-cyan-600' },
    gaussian:    { label: '3DGS',        icon: <IcoSpark />, bg: 'bg-violet-600',  barBg: 'bg-violet-800',  labelColor: 'text-violet-600' },
    nerf:        { label: 'NeRF',        icon: <IcoEye />,   bg: 'bg-orange-600',  barBg: 'bg-orange-800',  labelColor: 'text-orange-600' },
    mesh:        { label: 'Mesh',        icon: <IcoCube />,  bg: 'bg-teal-600',    barBg: 'bg-teal-800',    labelColor: 'text-teal-600' },
  };

  const today = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\. /g, '-').replace('.', '');

  return (
    <div className="flex flex-col h-full">

      {/* ── 페이지 헤더 ── */}
      <div className="bg-[#2d4a7a] px-8 py-3 flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-2xl font-black text-white">대시보드</h1>
          <p className="text-xs text-white/55 mt-0.5">기준일: {today}</p>
        </div>
        <div className="flex items-center gap-8 text-right">
          <div>
            <p className="text-xs text-white/55 font-medium">전체 에셋</p>
            <p className="text-2xl font-black text-white tabular-nums">{fmt.format(d.total)}<span className="text-sm ml-0.5">건</span></p>
          </div>
          <div>
            <p className="text-xs text-white/55 font-medium">최근 성공</p>
            <p className="text-2xl font-black text-emerald-300 tabular-nums">{fmt.format(d.success)}<span className="text-sm ml-0.5">건</span></p>
          </div>
        </div>
      </div>

      {/* ── 본문 ── */}
      <div className="flex-1 overflow-y-auto bg-gray-100 p-6 space-y-6">

        {/* ── 섹션: 에셋 ── */}
        <div>
          <SectionLabel icon={<IcoGrid />} title="에셋" />
          <div className="grid grid-cols-5 gap-4">
            {loading ? Array.from({ length: 5 }, (_, i) => <SolidSkeleton key={i} />) : (
              <>
                <SolidCard icon={<IcoCheck />}  label="변환 성공" value={d.success}    desc={`전체 ${fmt.format(d.total)}개 중 완료`} bg="bg-emerald-600" labelColor="text-emerald-600" />
                <SolidCard icon={<IcoX />}      label="변환 실패" value={d.failure}    desc="실패 상태로 종료된 에셋"                  bg="bg-rose-600"    labelColor="text-rose-600" />
                <SolidCard icon={<IcoCloud />}  label="변환 대기" value={d.pending}    desc="아직 시작되지 않은 에셋"                  bg="bg-slate-500"   labelColor="text-slate-500" />
                <SolidCard icon={<IcoShield />} label="승인 완료" value={d.approved}   desc="외부 활용 가능한 에셋"                   bg="bg-blue-600"    labelColor="text-blue-600" />
                <SolidCard icon={<IcoClock />}  label="미승인"    value={d.unapproved} desc="검수 또는 승인 대기 중"                  bg="bg-amber-500"   labelColor="text-amber-500" />
              </>
            )}
          </div>
        </div>

        {/* ── 섹션: 변환 파일 ── */}
        <div>
          <SectionLabel icon={<IcoConvert />} title="변환 파일" />
          <div className="grid grid-cols-4 gap-4">
            {loading ? Array.from({ length: 4 }, (_, i) => <ConvertSkeleton key={i} />) : (
              d.byType.map((item) => {
                const c = typeConfig[item.type];
                return (
                  <ConvertCard
                    key={item.type}
                    icon={c.icon}
                    label={c.label}
                    total={item.total} success={item.success} failure={item.failure} processing={item.processing}
                    bg={c.bg} barBg={c.barBg} labelColor={c.labelColor}
                  />
                );
              })
            )}
          </div>
        </div>

        {/* ── 섹션: 카테고리 ── */}
        <div>
          <SectionLabel icon={<IcoCategory />} title="카테고리" />
          <div className="grid grid-cols-5 gap-4">
            {loading
              ? Array.from({ length: 5 }, (_, i) => <SolidSkeleton key={i} />)
              : d.catCards.map((cat, i) => (
                  <CatCard key={cat.id} rank={i + 1} name={cat.name} count={cat.count} total={d.total} />
                ))
            }
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
        )}
      </div>
    </div>
  );
}
