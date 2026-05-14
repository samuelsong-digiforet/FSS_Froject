import { useState, useEffect, useCallback } from 'react';
import { logsApi, AccessLog } from '@/api/logs';

const PAGE_SIZE_OPTIONS = [20, 40, 60, 80, 100];

export default function LogsPage() {
  const [logs, setLogs] = useState<AccessLog[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  // 검색
  const [search, setSearch] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // 페이지네이션
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);

  const totalPages = Math.ceil(total / limit);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await logsApi.getAll({
        search: search || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        page,
        limit,
      });
      setLogs(data.items);
      setTotal(data.total);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [search, startDate, endDate, page, limit]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  // limit 변경 시 1페이지로 리셋
  const handleLimitChange = (newLimit: number) => {
    setLimit(newLimit);
    setPage(1);
  };

  // 검색 실행 시 1페이지로 리셋
  const handleSearch = () => {
    setPage(1);
    fetchLogs();
  };

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleString('ko-KR', { hour12: false })
      .replace(/\. /g, '-').replace('.', '');

  // 페이지네이션 버튼 생성 — 1페이지 항상 표시, 현재 페이지 ±2 표시
  const getPageNumbers = (): (number | string)[] => {
    if (totalPages <= 1) return [1];

    const delta = 2;
    const result: (number | string)[] = [1];

    const rangeStart = Math.max(2, page - delta);
    const rangeEnd = Math.min(totalPages, page + delta);

    if (rangeStart > 2) result.push('...');

    for (let i = rangeStart; i <= rangeEnd; i++) {
      result.push(i);
    }

    if (rangeEnd < totalPages) result.push('...');

    return result;
  };

  return (
    <div className="p-8 bg-gray-50 min-h-full">
      <h1 className="text-xl font-bold text-gray-800 mb-6">시스템 접속 로그</h1>

      {/* 검색 */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4 space-y-3">
        {/* 날짜 */}
        <div className="flex gap-2 items-center">
          <input
            type="date"
            value={startDate}
            onChange={e => setStartDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none flex-1"
          />
          <span className="text-gray-400">~</span>
          <input
            type="date"
            value={endDate}
            onChange={e => setEndDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none flex-1"
          />
        </div>

        {/* 검색어 */}
        <div className="relative">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            placeholder="검색어를 입력하세요"
            className="w-full border border-gray-300 rounded-lg px-4 py-2.5 pr-10 text-sm
                       focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={handleSearch}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
          >🔍</button>
        </div>
      </div>

      {/* 테이블 헤더 */}
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm text-gray-600">
          총 <span className="font-medium text-gray-800">{total.toLocaleString()}</span>건
        </p>
        <select
          value={limit}
          onChange={e => handleLimitChange(Number(e.target.value))}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none"
        >
          {PAGE_SIZE_OPTIONS.map(size => (
            <option key={size} value={size}>{size}줄씩 보기</option>
          ))}
        </select>
      </div>

      {/* 테이블 */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[#2d4a7a] text-white">
              <th className="px-4 py-3 text-center font-medium w-20">NO</th>
              <th className="px-4 py-3 text-center font-medium">아이디</th>
              <th className="px-4 py-3 text-center font-medium">사용자명</th>
              <th className="px-4 py-3 text-center font-medium">접속일시</th>
              <th className="px-4 py-3 text-center font-medium">IP</th>
              <th className="px-4 py-3 text-center font-medium">접속장치</th>
              <th className="px-4 py-3 text-center font-medium">메뉴명</th>
              <th className="px-4 py-3 text-center font-medium">기능</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} className="text-center py-10 text-gray-400">로딩 중...</td>
              </tr>
            ) : logs.length === 0 ? (
              <tr>
                <td colSpan={8} className="text-center py-10 text-gray-400">데이터가 없습니다.</td>
              </tr>
            ) : (
              logs.map((log, idx) => (
                <tr key={log.id} className="border-t border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-3 text-center text-gray-600">
                    {total - (page - 1) * limit - idx}
                  </td>
                  <td className="px-4 py-3 text-center text-gray-800">{log.username ?? '-'}</td>
                  <td className="px-4 py-3 text-center text-gray-800">{log.fullName ?? '-'}</td>
                  <td className="px-4 py-3 text-center text-gray-600">{formatDate(log.accessedAt)}</td>
                  <td className="px-4 py-3 text-center text-gray-600">{log.ip ?? '-'}</td>
                  <td className="px-4 py-3 text-center text-gray-600">{log.device ?? '-'}</td>
                  <td className="px-4 py-3 text-center text-gray-600">{log.menuName ?? '-'}</td>
                  <td className="px-4 py-3 text-center text-gray-600">{log.action ?? '-'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* 페이지네이션 */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-1 mt-6">
          {/* 처음으로 (10칸 이전) */}
          <button
            onClick={() => setPage(p => Math.max(1, p - 10))}
            disabled={page === 1}
            className="px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50
                       disabled:opacity-40 disabled:cursor-not-allowed"
          >
            «
          </button>

          {/* 이전 1칸 */}
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50
                       disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ‹
          </button>

          {/* 페이지 번호 */}
          {getPageNumbers().map((p, idx) =>
            p === '...' ? (
              <span key={`dot-${idx}`} className="px-3 py-2 text-sm text-gray-400">...</span>
            ) : (
              <button
                key={p}
                onClick={() => setPage(Number(p))}
                className={`px-3 py-2 text-sm border rounded-lg transition-colors
                  ${page === p
                    ? 'bg-[#2d4a7a] text-white border-[#2d4a7a]'
                    : 'border-gray-300 hover:bg-gray-50 text-gray-600'}`}
              >
                {p}
              </button>
            )
          )}

          {/* 다음 1칸 */}
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50
                       disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ›
          </button>

          {/* 10칸 앞으로 */}
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 10))}
            disabled={page === totalPages}
            className="px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50
                       disabled:opacity-40 disabled:cursor-not-allowed"
          >
            »
          </button>
        </div>
      )}
    </div>
  );
}