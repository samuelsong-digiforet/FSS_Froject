import { useEffect, useMemo, useState } from 'react';
import { assetCategoriesApi, type AssetCategory } from '@/api/assetCategories';
import { assetsApi, type Asset, type AssetType } from '@/api/assets';
import { usePermission } from '@/hooks/usePermission';

const fmt = new Intl.NumberFormat('ko-KR');

/* ── 아이콘 ── */
const IcoCheck = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-7 h-7">
    <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const IcoX = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-7 h-7">
    <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
  </svg>
);
const IcoShield = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-7 h-7">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M9 12l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const IcoClock = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-7 h-7">
    <circle cx="12" cy="12" r="10" />
    <path d="M12 6v6l4 2" strokeLinecap="round" />
  </svg>
);
const IcoCloud = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} className="w-7 h-7">
    <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const IcoSpark = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} className="w-7 h-7">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const IcoCube = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} className="w-7 h-7">
    <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
  </svg>
);
const IcoEye = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} className="w-7 h-7">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" strokeLinecap="round" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
const IcoTag = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} className="w-7 h-7">
    <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" strokeLinecap="round" strokeLinejoin="round" />
    <line x1="7" y1="7" x2="7.01" y2="7" strokeLinecap="round" strokeWidth={3} />
  </svg>
);

/* ── 에셋 상태 카드 ── */
type AssetCardProps = {
  icon: React.ReactNode;
  iconBg: string;
  iconColor: string;
  label: string;
  value: number;
  desc: string;
  numColor: string;
};

function AssetCard({ icon, iconBg, iconColor, label, value, desc, numColor }: AssetCardProps) {
  return (
    <div className="rounded-2xl border-2 border-gray-300 bg-white p-6 flex flex-col gap-5">
      {/* 아이콘 + 라벨 박스 */}
      <div className="flex items-center gap-3 rounded-xl border-2 border-gray-300 px-4 py-2.5">
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${iconBg} ${iconColor}`}>
          {icon}
        </div>
        <span className="text-sm font-bold text-gray-600">{label}</span>
      </div>
      {/* 숫자 */}
      <div>
        <p className={`text-5xl font-black tabular-nums leading-none ${numColor}`}>
          {fmt.format(value)}<span className="text-2xl font-bold ml-1">개</span>
        </p>
        <p className="mt-2 text-xs font-bold text-gray-500">{desc}</p>
      </div>
    </div>
  );
}

/* ── 변환 파일 카드 ── */
type ConvertCardProps = {
  icon: React.ReactNode;
  iconBg: string;
  iconColor: string;
  label: string;
  total: number;
  success: number;
  failure: number;
  processing: number;
  barColor: string;
};

function ConvertCard({ icon, iconBg, iconColor, label, total, success, failure, processing, barColor }: ConvertCardProps) {
  const pending = total - success - failure - processing;
  const pct = total > 0 ? Math.round((success / total) * 100) : 0;
  return (
    <div className="rounded-2xl border-2 border-gray-300 bg-white p-6 flex flex-col gap-4">
      {/* 아이콘 + 라벨 + 성공률 박스 */}
      <div className="flex items-center gap-2 rounded-xl border-2 border-gray-300 px-3 py-2">
        <div className={`w-8 h-8 shrink-0 rounded-lg flex items-center justify-center ${iconBg} ${iconColor}`}>
          {icon}
        </div>
        <span className="text-sm font-bold text-gray-600 whitespace-nowrap">{label}</span>
        <span className={`ml-auto shrink-0 text-xs font-bold px-2 py-1 rounded-lg whitespace-nowrap ${iconBg} ${iconColor}`}>
          성공률 {pct}%
        </span>
      </div>
      {/* 총계 */}
      <div>
        <p className="text-5xl font-black tabular-nums leading-none text-gray-900">
          {fmt.format(total)}<span className="text-2xl font-bold ml-1">개</span>
        </p>
        <p className="mt-1 text-xs font-bold text-gray-500">전체 에셋</p>
      </div>
      {/* 프로그레스 바 */}
      <div className="h-2 w-full rounded-full bg-gray-100 overflow-hidden">
        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
      {/* 4분할 수치 */}
      <div className="grid grid-cols-4 gap-2">
        <div className="rounded-xl bg-emerald-50 px-2 py-2 text-center">
          <p className="text-[10px] font-bold text-emerald-500 mb-1">성공</p>
          <p className="text-lg font-black text-emerald-600 tabular-nums">{fmt.format(success)}</p>
        </div>
        <div className="rounded-xl bg-rose-50 px-2 py-2 text-center">
          <p className="text-[10px] font-bold text-rose-500 mb-1">실패</p>
          <p className="text-lg font-black text-rose-600 tabular-nums">{fmt.format(failure)}</p>
        </div>
        <div className="rounded-xl bg-blue-50 px-2 py-2 text-center">
          <p className="text-[10px] font-bold text-blue-500 mb-1">처리 중</p>
          <p className="text-lg font-black text-blue-600 tabular-nums">{fmt.format(processing)}</p>
        </div>
        <div className="rounded-xl bg-gray-50 px-2 py-2 text-center">
          <p className="text-[10px] font-bold text-gray-400 mb-1">대기</p>
          <p className="text-lg font-black text-gray-600 tabular-nums">{fmt.format(pending)}</p>
        </div>
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

function CatCard({ rank, name, count, total }: CatCardProps) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  const colors = [
    { badge: 'bg-amber-400 text-white',  bar: 'bg-amber-400',  bg: 'bg-amber-50',  num: 'text-amber-600' },
    { badge: 'bg-slate-400 text-white',  bar: 'bg-slate-400',  bg: 'bg-slate-50',  num: 'text-slate-600' },
    { badge: 'bg-orange-400 text-white', bar: 'bg-orange-400', bg: 'bg-orange-50', num: 'text-orange-600' },
    { badge: 'bg-blue-400 text-white',   bar: 'bg-blue-400',   bg: 'bg-blue-50',   num: 'text-blue-600' },
  ];
  const c = colors[Math.min(rank - 1, colors.length - 1)];
  return (
    <div className="rounded-2xl border-2 border-gray-300 bg-white p-6 flex flex-col gap-4">
      {/* 랭크 + 이름 박스 */}
      <div className="flex items-center gap-3 rounded-xl border-2 border-gray-300 px-4 py-2.5">
        <div className={`w-7 h-7 rounded-lg text-sm font-black flex items-center justify-center shrink-0 ${c.badge}`}>
          {rank}
        </div>
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${c.bg} ${c.num}`}>
          <IcoTag />
        </div>
        <p className="text-sm font-bold text-gray-700 truncate">{name}</p>
      </div>
      {/* 숫자 */}
      <div>
        <p className={`text-5xl font-black tabular-nums leading-none ${c.num}`}>
          {fmt.format(count)}<span className="text-2xl font-bold ml-1">개</span>
        </p>
        <p className="mt-1 text-xs font-bold text-gray-500">전체의 {pct}%</p>
      </div>
      {/* 바 */}
      <div className="h-2 w-full rounded-full bg-gray-100 overflow-hidden">
        <div className={`h-full rounded-full ${c.bar}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/* ── 스켈레톤 ── */
function Skeleton() {
  return (
    <div className="animate-pulse rounded-2xl border-2 border-gray-300 bg-white p-6 flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-gray-100" />
        <div className="h-4 w-20 rounded bg-gray-100" />
      </div>
      <div className="space-y-2">
        <div className="h-12 w-24 rounded-lg bg-gray-100" />
        <div className="h-3 w-32 rounded bg-gray-100" />
      </div>
    </div>
  );
}

function ConvertSkeleton() {
  return (
    <div className="animate-pulse rounded-2xl border-2 border-gray-300 bg-white p-6 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-gray-100" />
          <div className="h-4 w-16 rounded bg-gray-100" />
        </div>
        <div className="h-6 w-20 rounded-lg bg-gray-100" />
      </div>
      <div className="h-12 w-24 rounded-lg bg-gray-100" />
      <div className="h-2 rounded-full bg-gray-100" />
      <div className="grid grid-cols-3 gap-2">
        {[0,1,2].map(i => <div key={i} className="h-14 rounded-xl bg-gray-100" />)}
      </div>
    </div>
  );
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
    const approved = assets.filter((a) => a.approved).length;
    const unapproved = total - approved;

    const types: AssetType[] = ['point_cloud', 'gaussian', 'nerf', 'mesh'];
    const byType = types.map((type) => {
      const t = assets.filter((a) => a.type === type);
      const success = t.filter((a) => a.status === 'done').length;
      const failure = t.filter((a) => a.status === 'failed').length;
      const processing = t.filter((a) => a.status === 'processing' || a.status === 'pending' || a.status === 'awaiting_crop').length;
      return {
        type,
        total: t.length,
        success,
        failure,
        processing,
      };
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
      .filter((c) => c.count > 0)
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ko'));
    if (uncategorized > 0) catCards.push({ id: -1, name: '미분류', count: uncategorized });

    return { total, success, failure, approved, unapproved, byType, catCards };
  }, [assets, categories]);

  if (perm.isLoaded && !perm.view) {
    return <div className="h-full flex items-center justify-center text-sm text-gray-400">대시보드 권한이 없습니다.</div>;
  }

  const typeConfig: Record<AssetType, { label: string; icon: React.ReactNode; iconBg: string; iconColor: string; barColor: string }> = {
    point_cloud: { label: 'Point Cloud', icon: <IcoCloud />, iconBg: 'bg-cyan-100',    iconColor: 'text-cyan-700',    barColor: 'bg-cyan-500' },
    gaussian:    { label: '3DGS',        icon: <IcoSpark />, iconBg: 'bg-violet-100',  iconColor: 'text-violet-700',  barColor: 'bg-violet-500' },
    nerf:        { label: 'NeRF',        icon: <IcoEye />,   iconBg: 'bg-orange-100',  iconColor: 'text-orange-700',  barColor: 'bg-orange-500' },
    mesh:        { label: 'Mesh',        icon: <IcoCube />,  iconBg: 'bg-emerald-100', iconColor: 'text-emerald-700', barColor: 'bg-emerald-500' },
  };

  return (
    <div className="p-8 space-y-6">

      {/* ── 섹션 1: 에셋 ── */}
      <div className="rounded-2xl border-2 border-gray-300 overflow-hidden">
        <h2 className="text-2xl font-black text-white bg-[#2d4a7a] px-6 py-5">에셋</h2>
        <div className="grid grid-cols-4 gap-4 p-6">
          {loading ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} />) : (
            <>
              <AssetCard
                icon={<IcoCheck />}
                iconBg="bg-emerald-100" iconColor="text-emerald-600"
                label="변환 성공" value={d.success}
                desc={`전체 ${fmt.format(d.total)}개 중 완료`}
                numColor="text-emerald-600"
              />
              <AssetCard
                icon={<IcoX />}
                iconBg="bg-rose-100" iconColor="text-rose-600"
                label="변환 실패" value={d.failure}
                desc="실패 상태로 종료된 에셋"
                numColor="text-rose-600"
              />
              <AssetCard
                icon={<IcoShield />}
                iconBg="bg-blue-100" iconColor="text-blue-600"
                label="승인 완료" value={d.approved}
                desc="외부 활용 가능한 에셋"
                numColor="text-blue-600"
              />
              <AssetCard
                icon={<IcoClock />}
                iconBg="bg-amber-100" iconColor="text-amber-600"
                label="미승인" value={d.unapproved}
                desc="검수 또는 승인 대기 중"
                numColor="text-amber-600"
              />
            </>
          )}
        </div>
      </div>

      {/* ── 섹션 2: 변환 파일 ── */}
      <div className="rounded-2xl border-2 border-gray-300 overflow-hidden">
        <h2 className="text-2xl font-black text-white bg-[#2d4a7a] px-6 py-5">변환 파일</h2>
        <div className="grid grid-cols-4 gap-4 p-6">
          {loading ? Array.from({ length: 4 }, (_, i) => <ConvertSkeleton key={i} />) : (
            d.byType.map((item) => {
              const c = typeConfig[item.type];
              return (
                <ConvertCard
                  key={item.type}
                  icon={c.icon}
                  iconBg={c.iconBg} iconColor={c.iconColor}
                  label={c.label}
                  total={item.total} success={item.success} failure={item.failure} processing={item.processing}
                  barColor={c.barColor}
                />
              );
            })
          )}
        </div>
      </div>

      {/* ── 섹션 3: 카테고리 ── */}
      <div className="rounded-2xl border-2 border-gray-300 overflow-hidden">
        <h2 className="text-2xl font-black text-white bg-[#2d4a7a] px-6 py-5">카테고리</h2>
        <div className="grid grid-cols-4 gap-4 p-6">
          {loading
            ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} />)
            : d.catCards.slice(0, 4).map((cat, i) => (
                <CatCard key={cat.id} rank={i + 1} name={cat.name} count={cat.count} total={d.total} />
              ))
          }
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
      )}
    </div>
  );
}
