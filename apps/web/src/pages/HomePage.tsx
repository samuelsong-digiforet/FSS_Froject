import { useEffect, useMemo, useState } from 'react';
import { assetCategoriesApi, type AssetCategory } from '@/api/assetCategories';
import { assetsApi, type Asset, type AssetType } from '@/api/assets';
import { usePermission } from '@/hooks/usePermission';

const fmt = new Intl.NumberFormat('ko-KR');

/* ── 아이콘 ── */
const IcoCheck = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-5 h-5">
    <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const IcoX = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-5 h-5">
    <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
  </svg>
);
const IcoShield = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-5 h-5">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M9 12l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const IcoClock = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-5 h-5">
    <circle cx="12" cy="12" r="10" />
    <path d="M12 6v6l4 2" strokeLinecap="round" />
  </svg>
);
const IcoCloud = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} className="w-5 h-5">
    <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const IcoSpark = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} className="w-5 h-5">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const IcoCube = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} className="w-5 h-5">
    <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
  </svg>
);
const IcoEye = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} className="w-5 h-5">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" strokeLinecap="round" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
const IcoTag = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} className="w-4 h-4">
    <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" strokeLinecap="round" strokeLinejoin="round" />
    <line x1="7" y1="7" x2="7.01" y2="7" strokeLinecap="round" strokeWidth={3} />
  </svg>
);

/* ── 원형 프로그레스 ── */
function CircleProgress({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(value / max, 1) : 0;
  const r = 20;
  const circ = 2 * Math.PI * r;
  const dash = circ * pct;
  return (
    <svg width="52" height="52" viewBox="0 0 52 52">
      <circle cx="26" cy="26" r="25" fill="#1e293b" />
      <circle cx="26" cy="26" r={r} fill="none" stroke="#334155" strokeWidth="5" />
      <circle
        cx="26" cy="26" r={r} fill="none"
        stroke={color} strokeWidth="5"
        strokeDasharray={`${dash} ${circ - dash}`}
        strokeLinecap="round"
        transform="rotate(-90 26 26)"
        style={{ transition: 'stroke-dasharray 0.6s ease' }}
      />
      <text x="26" y="30" textAnchor="middle" fill="#ffffff" fontSize="10" fontWeight="800">
        {max > 0 ? Math.round(pct * 100) : 0}%
      </text>
    </svg>
  );
}

/* ── KPI 카드 ── */
type KpiCardProps = {
  icon: React.ReactNode;
  label: string;
  value: number;
  desc: string;
  accentBg: string;
  accentText: string;
  accentBar: string;
  showProgress?: boolean;
  progressMax?: number;
  progressColor?: string;
};

function KpiCard({ icon, label, value, desc, accentBg, accentText, accentBar, showProgress, progressMax, progressColor }: KpiCardProps) {
  return (
    <div className="relative rounded-2xl bg-white border border-gray-200 p-5 flex flex-col gap-3 overflow-hidden shadow-sm">
      {/* 좌측 액센트 바 */}
      <div className={`absolute left-0 top-0 bottom-0 w-1.5 rounded-l-2xl ${accentBar}`} />
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5 text-xs font-bold text-gray-900">
            <span className={`p-1 rounded-md ${accentBg} ${accentText}`}>{icon}</span>
            <span>{label}</span>
          </div>
          <p className="text-4xl font-black text-gray-900 tabular-nums leading-none mt-1">
            {fmt.format(value)}<span className="text-base font-bold text-gray-600 ml-1">개</span>
          </p>
          <p className="text-xs text-gray-700 font-semibold mt-0.5">{desc}</p>
        </div>
        {showProgress && progressMax !== undefined && progressColor && (
          <CircleProgress value={value} max={progressMax} color={progressColor} />
        )}
      </div>
    </div>
  );
}

/* ── 변환 파일 카드 ── */
type ConvertCardProps = {
  icon: React.ReactNode;
  label: string;
  total: number;
  success: number;
  failure: number;
  processing: number;
  accentBg: string;
  accentText: string;
  iconColor: string;
};

function ConvertCard({ icon, label, total, success, failure, processing, accentBg, accentText, iconColor }: ConvertCardProps) {
  const pending = total - success - failure - processing;
  const successPct = total > 0 ? Math.round((success / total) * 100) : 0;

  const stats = [
    { label: '성공', value: success, color: 'text-emerald-700', bg: 'bg-emerald-50' },
    { label: '실패', value: failure, color: 'text-rose-700',    bg: 'bg-rose-50' },
    { label: '처리 중', value: processing, color: 'text-sky-700', bg: 'bg-sky-50' },
    { label: '대기', value: pending, color: 'text-gray-700',    bg: 'bg-gray-100' },
  ];

  return (
    <div className="rounded-2xl bg-white border border-gray-300 p-5 flex flex-col gap-4 shadow-sm">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`w-8 h-8 rounded-lg ${accentBg} flex items-center justify-center`}>
            <span className={iconColor}>{icon}</span>
          </div>
          <span className="text-sm font-bold text-gray-900">{label}</span>
        </div>
        <div className="text-right">
          <p className="text-2xl font-black text-gray-900 tabular-nums leading-none">
            {fmt.format(total)}<span className="text-xs text-gray-600 ml-0.5">개</span>
          </p>
          <p className="text-xs text-gray-700 font-semibold">전체 에셋</p>
        </div>
      </div>

      {/* 성공률 바 */}
      <div>
        <div className="flex justify-between text-[10px] text-gray-600 font-semibold mb-1">
          <span>성공률</span>
          <span className="text-emerald-600 font-bold">{successPct}%</span>
        </div>
        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-emerald-500 rounded-full transition-all duration-700"
            style={{ width: `${successPct}%` }}
          />
        </div>
      </div>

      {/* 4분할 수치 */}
      <div className="grid grid-cols-4 gap-1.5">
        {stats.map((s) => (
          <div key={s.label} className={`rounded-xl ${s.bg} border border-gray-100 py-2 text-center`}>
            <p className="text-[10px] text-gray-700 font-bold mb-0.5">{s.label}</p>
            <p className={`text-sm font-black tabular-nums ${s.color}`}>{fmt.format(s.value)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── 카테고리 행 ── */
const CAT_BARS    = ['bg-blue-500', 'bg-orange-500', 'bg-teal-500', 'bg-violet-500', 'bg-rose-500', 'bg-amber-500'];
const CAT_TEXTS   = ['text-blue-600', 'text-orange-600', 'text-teal-600', 'text-violet-600', 'text-rose-600', 'text-amber-600'];
const CAT_BADGES  = ['bg-blue-100', 'bg-orange-100', 'bg-teal-100', 'bg-violet-100', 'bg-rose-100', 'bg-amber-100'];

function CatRow({ rank, name, count, total }: { rank: number; name: string; count: number; total: number }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  const bar   = CAT_BARS[Math.min(rank - 1, CAT_BARS.length - 1)];
  const text  = CAT_TEXTS[Math.min(rank - 1, CAT_TEXTS.length - 1)];
  const badge = CAT_BADGES[Math.min(rank - 1, CAT_BADGES.length - 1)];
  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-gray-200 last:border-0">
      <span className={`w-5 h-5 rounded-md ${badge} ${text} text-[10px] font-black flex items-center justify-center shrink-0`}>{rank}</span>
      <span className="text-sm text-gray-800 font-medium flex-1 truncate">{name}</span>
      <div className="flex items-center gap-3 shrink-0">
        <div className="w-28 h-2 bg-gray-100 rounded-full overflow-hidden">
          <div className={`h-full ${bar} rounded-full`} style={{ width: `${pct}%` }} />
        </div>
        <span className={`text-sm font-black tabular-nums w-10 text-right ${text}`}>{fmt.format(count)}<span className="text-xs text-gray-700 font-bold ml-0.5">개</span></span>
      </div>
    </div>
  );
}

/* ── 섹션 헤더 ── */
function SectionHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <span className="text-gray-500">{icon}</span>
      <span className="text-sm font-bold text-gray-700 tracking-normal border-b border-gray-200 pb-1.5 flex-1">{title}</span>
    </div>
  );
}

/* ── 스켈레톤 ── */
function Skeleton({ h }: { h: string }) {
  return <div className={`animate-pulse rounded-2xl bg-gray-100 ${h}`} />;
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

  const typeConfig: Record<AssetType, { label: string; icon: React.ReactNode; accentBg: string; accentText: string; iconColor: string }> = {
    point_cloud: { label: 'Point Cloud', icon: <IcoCloud />, accentBg: 'bg-cyan-100',   accentText: 'text-cyan-700',   iconColor: 'text-cyan-600' },
    gaussian:    { label: '3DGS',        icon: <IcoSpark />, accentBg: 'bg-violet-100', accentText: 'text-violet-700', iconColor: 'text-violet-600' },
    nerf:        { label: 'NeRF',        icon: <IcoEye />,   accentBg: 'bg-orange-100', accentText: 'text-orange-700', iconColor: 'text-orange-600' },
    mesh:        { label: 'Mesh',        icon: <IcoCube />,  accentBg: 'bg-teal-100',   accentText: 'text-teal-700',   iconColor: 'text-teal-600' },
  };

  const today = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\. /g, '-').replace('.', '');

  return (
    <div className="flex flex-col h-full bg-gray-100">

      {/* ── 페이지 헤더 ── */}
      <div className="bg-[#2d4a7a] px-8 py-4 flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-2xl font-black text-white tracking-tight">대시보드</h1>
          <p className="text-xs text-white/75 font-semibold mt-0.5">{today} 기준</p>
        </div>
        <div className="flex items-center gap-6">
          {[
            { label: '전체 에셋', value: d.total,      color: 'text-white' },
            { label: '변환 성공', value: d.success,    color: 'text-emerald-300' },
            { label: '변환 실패', value: d.failure,    color: 'text-rose-300' },
            { label: '처리 중',  value: d.processing,  color: 'text-sky-300' },
          ].map((k, i) => (
            <div key={k.label} className={`text-right ${i > 0 ? 'border-l border-white/20 pl-6' : ''}`}>
              <p className="text-[11px] text-white/80 font-bold">{k.label}</p>
              <p className={`text-xl font-black tabular-nums ${k.color}`}>{fmt.format(k.value)}<span className="text-xs text-white/70 font-bold ml-0.5">건</span></p>
            </div>
          ))}
          {/* 성공률 링 */}
          <div className="flex flex-col items-center ml-2">
            <CircleProgress value={d.success} max={d.total} color="#34d399" />
            <span className="text-[10px] text-white/80 font-bold mt-0.5">성공률</span>
          </div>
        </div>
      </div>

      {/* ── 본문 ── */}
      <div className="flex-1 overflow-y-auto p-6 space-y-8">

        {/* ── 에셋 현황 KPI ── */}
        <div>
          <SectionHeader icon={<IcoTag />} title="에셋 현황" />
          <div className="grid grid-cols-5 gap-4">
            {loading ? Array.from({ length: 5 }, (_, i) => <Skeleton key={i} h="h-32" />) : (
              <>
                <KpiCard icon={<IcoCheck />}  label="변환 성공" value={d.success}    desc={`전체 ${fmt.format(d.total)}개 중 완료`} accentBg="bg-emerald-100" accentText="text-emerald-700" accentBar="bg-emerald-500" showProgress progressMax={d.total} progressColor="#10b981" />
                <KpiCard icon={<IcoX />}      label="변환 실패" value={d.failure}    desc="실패 상태로 종료된 에셋"               accentBg="bg-rose-100"    accentText="text-rose-700"    accentBar="bg-rose-500"    showProgress progressMax={d.total} progressColor="#ef4444" />
                <KpiCard icon={<IcoCloud />}  label="변환 대기" value={d.pending}    desc="아직 시작되지 않은 에셋"               accentBg="bg-slate-100"   accentText="text-slate-600"   accentBar="bg-slate-400" />
                <KpiCard icon={<IcoShield />} label="승인 완료" value={d.approved}   desc="외부 활용 가능한 에셋"                accentBg="bg-blue-100"    accentText="text-blue-700"    accentBar="bg-blue-500"    showProgress progressMax={d.total} progressColor="#3b82f6" />
                <KpiCard icon={<IcoClock />}  label="미승인"    value={d.unapproved} desc="검수 또는 승인 대기 중"               accentBg="bg-amber-100"   accentText="text-amber-700"   accentBar="bg-amber-500" />
              </>
            )}
          </div>
        </div>

        {/* ── 변환 파일 + 카테고리 ── */}
        <div className="grid grid-cols-3 gap-6">

          {/* 변환 파일 (2/3) */}
          <div className="col-span-2">
            <SectionHeader icon={<IcoCloud />} title="변환 파일 타입" />
            <div className="grid grid-cols-2 gap-4">
              {loading ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} h="h-44" />) : (
                d.byType.map((item) => {
                  const c = typeConfig[item.type];
                  return (
                    <ConvertCard
                      key={item.type}
                      icon={c.icon}
                      label={c.label}
                      total={item.total} success={item.success} failure={item.failure} processing={item.processing}
                      accentBg={c.accentBg} accentText={c.accentText} iconColor={c.iconColor}
                    />
                  );
                })
              )}
            </div>
          </div>

          {/* 카테고리 (1/3) */}
          <div className="flex flex-col">
            <SectionHeader icon={<IcoTag />} title="카테고리" />
            <div className="rounded-2xl bg-white border border-gray-300 p-5 shadow-sm flex-1">
              {loading
                ? Array.from({ length: 5 }, (_, i) => <Skeleton key={i} h="h-8" />)
                : d.catCards.length === 0
                  ? <p className="text-xs text-gray-500 font-semibold text-center py-8">카테고리 없음</p>
                  : d.catCards.map((cat, i) => (
                      <CatRow key={cat.id} rank={i + 1} name={cat.name} count={cat.count} total={d.total} />
                    ))
              }
            </div>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-500">{error}</div>
        )}
      </div>
    </div>
  );
}
