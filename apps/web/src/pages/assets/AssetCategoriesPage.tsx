import { useState, useEffect, useCallback } from 'react';
import { assetCategoriesApi, AssetCategory } from '@/api/assetCategories';
import { usePermission } from '@/hooks/usePermission';

const PAGE_SIZE_OPTIONS = [20, 40, 60, 80, 100];

function Alert({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[70]">
      <div className="bg-white rounded-lg w-full max-w-sm mx-4 shadow-xl p-6">
        <p className="text-gray-700 text-sm text-center whitespace-pre-line mb-6">{message}</p>
        <div className="flex justify-center">
          <button onClick={onClose}
            className="px-8 py-2 text-sm bg-[#2d4a7a] text-white rounded-lg hover:bg-[#1e3a6a]">
            확인
          </button>
        </div>
      </div>
    </div>
  );
}

function Modal({ title, onClose, children }: {
  title: string; onClose: () => void; children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg w-full max-w-md mx-4 shadow-xl">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h3 className="font-semibold text-gray-800">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function DeleteAlert({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg w-full max-w-sm mx-4 shadow-xl p-6">
        <div className="flex items-center gap-3 mb-3">
          <span className="text-yellow-500 text-2xl">⚠️</span>
          <h3 className="font-semibold text-gray-800">카테고리 삭제</h3>
        </div>
        <p className="text-gray-600 text-sm mb-6 whitespace-pre-line">
          {'삭제한 데이터는 복구할 수 없습니다.\n정말로 삭제하시겠습니까?'}
        </p>
        <div className="flex gap-2 justify-end">
          <button onClick={onCancel}
            className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">취소</button>
          <button onClick={onConfirm}
            className="px-4 py-2 text-sm bg-red-500 text-white rounded-lg hover:bg-red-600">확인</button>
        </div>
      </div>
    </div>
  );
}

const inputCls = `w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm
  focus:outline-none focus:border-blue-500`;

type ModalType = 'none' | 'create' | 'detail' | 'edit' | 'delete';

export default function AssetCategoriesPage() {
  const perm = usePermission('asset_category');

  const [categories, setCategories] = useState<AssetCategory[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [alert, setAlert] = useState<string | null>(null);

  // 검색
  const [search, setSearch] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const totalPages = Math.ceil(total / limit);

  // 모달
  const [modal, setModal] = useState<ModalType>('none');
  const [selected, setSelected] = useState<AssetCategory | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AssetCategory | null>(null);

  // 폼
  const [form, setForm] = useState({ name: '', description: '' });
  const [formError, setFormError] = useState('');

  const fetchCategories = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await assetCategoriesApi.getAll({
        search: search || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        page,
        limit,
      });
      setCategories(data.items);
      setTotal(data.total);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [search, startDate, endDate, page, limit]);

  useEffect(() => { fetchCategories(); }, [fetchCategories]);

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleString('ko-KR', { hour12: false })
      .replace(/\. /g, '-').replace('.', '');

  const handleSearch = () => { setPage(1); fetchCategories(); };

  // 생성
  const openCreate = () => {
    setForm({ name: '', description: '' });
    setFormError('');
    setModal('create');
  };

  const handleCreate = async () => {
    if (!form.name.trim()) { setFormError('카테고리명을 입력하세요.'); return; }
    try {
      await assetCategoriesApi.create({ name: form.name.trim(), description: form.description || undefined });
      setModal('none');
      fetchCategories();
      setAlert('생성완료');
    } catch (err: any) {
      const msg = err.response?.data?.message ?? '';
      if (msg.includes('이미')) {
        setFormError(msg);
      } else {
        setModal('none');
        setAlert('생성에 실패하였습니다.\n관리자에게 문의주세요.');
      }
    }
  };

  // 상세
  const openDetail = (cat: AssetCategory) => {
    setSelected(cat);
    setModal('detail');
  };

  // 수정
  const openEdit = () => {
    if (!selected) return;
    setForm({ name: selected.name, description: selected.description ?? '' });
    setFormError('');
    setModal('edit');
  };

  const handleUpdate = async () => {
    if (!selected || !form.name.trim()) return;
    try {
      const { data } = await assetCategoriesApi.update(selected.id, {
        name: form.name.trim(),
        description: form.description || undefined,
      });
      setSelected(data);
      setModal('detail');
      fetchCategories();
      setAlert('수정완료');
    } catch (err: any) {
      const msg = err.response?.data?.message ?? '';
      if (msg.includes('이미')) {
        setFormError(msg);
      } else {
        setModal('none');
        setAlert('수정에 실패하였습니다.\n관리자에게 문의주세요.');
      }
    }
  };

  // 삭제
  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await assetCategoriesApi.remove(deleteTarget.id);
      setModal('none');
      setDeleteTarget(null);
      setSelected(null);
      fetchCategories();
      setAlert('삭제완료');
    } catch {
      setModal('none');
      setAlert('삭제에 실패하였습니다.\n관리자에게 문의주세요.');
    }
  };

  // 페이지네이션
  const getPageNumbers = () => {
    const delta = 2;
    const range: number[] = [];
    const result: (number | string)[] = [];
    for (let i = Math.max(2, page - delta); i <= Math.min(totalPages - 1, page + delta); i++) {
      range.push(i);
    }
    if (page - delta > 2) result.push(1, '...');
    else result.push(1);
    result.push(...range);
    if (page + delta < totalPages - 1) result.push('...', totalPages);
    else if (totalPages > 1) result.push(totalPages);
    return result;
  };

  if (!perm.isLoaded) {
    return <div className="flex items-center justify-center h-full"><p className="text-gray-400 text-sm">로딩 중...</p></div>;
  }

  if (!perm.view) {
    return <div className="flex items-center justify-center h-full"><p className="text-gray-400 text-sm">접근 권한이 없습니다.</p></div>;
  }

  return (
    <div className="p-8 bg-gray-50 min-h-full">
      <h1 className="text-xl font-bold text-gray-800 mb-6">에셋 카테고리 관리</h1>

      {/* 검색 */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4 space-y-3">
        <div className="flex gap-2 items-center">
          <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none flex-1" />
          <span className="text-gray-400">~</span>
          <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none flex-1" />
        </div>
        <div className="relative">
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            placeholder="검색어를 입력하세요"
            className="w-full border border-gray-300 rounded-lg px-4 py-2.5 pr-10 text-sm
                       focus:outline-none focus:border-blue-500" />
          <button onClick={handleSearch}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">🔍</button>
        </div>
      </div>

      {/* 테이블 헤더 */}
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm text-gray-600">총 {total}건</p>
        <div className="flex items-center gap-2">
          <select value={limit} onChange={e => { setLimit(Number(e.target.value)); setPage(1); }}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none">
            {PAGE_SIZE_OPTIONS.map(s => (
              <option key={s} value={s}>{s}줄씩 보기</option>
            ))}
          </select>
          {perm.create && (
            <button onClick={openCreate}
              className="px-4 py-2 bg-gray-800 text-white text-sm rounded-lg hover:bg-gray-700">
              생성 +
            </button>
          )}
        </div>
      </div>

      {/* 테이블 */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[#2d4a7a] text-white">
              <th className="px-6 py-3 text-center font-medium w-20">NO</th>
              <th className="px-6 py-3 text-center font-medium">카테고리명</th>
              <th className="px-6 py-3 text-center font-medium">최초 등록일시</th>
              <th className="px-6 py-3 text-center font-medium">최초 등록자명</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={4} className="text-center py-10 text-gray-400">로딩 중...</td></tr>
            ) : categories.length === 0 ? (
              <tr><td colSpan={4} className="text-center py-10 text-gray-400">데이터가 없습니다.</td></tr>
            ) : (
              categories.map((cat, idx) => (
                <tr
                  key={cat.id}
                  onClick={() => perm.detail && openDetail(cat)}
                  className={`border-t border-gray-100 transition-colors
                    ${perm.detail ? 'hover:bg-blue-50 cursor-pointer' : ''}`}
                >
                  <td className="px-6 py-3 text-center text-gray-600">{total - (page - 1) * limit - idx}</td>
                  <td className="px-6 py-3 text-center text-gray-800">{cat.name}</td>
                  <td className="px-6 py-3 text-center text-gray-600">{formatDate(cat.createdAt)}</td>
                  <td className="px-6 py-3 text-center text-gray-600">{cat.createdBy?.fullName ?? '-'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* 페이지네이션 */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-1 mt-6">
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
            className="px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40">‹</button>
          {getPageNumbers().map((p, idx) =>
            p === '...' ? (
              <span key={`dot-${idx}`} className="px-3 py-2 text-sm text-gray-400">...</span>
            ) : (
              <button key={p} onClick={() => setPage(Number(p))}
                className={`px-3 py-2 text-sm border rounded-lg transition-colors
                  ${page === p ? 'bg-[#2d4a7a] text-white border-[#2d4a7a]' : 'border-gray-300 hover:bg-gray-50 text-gray-600'}`}>
                {p}
              </button>
            )
          )}
          <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
            className="px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40">›</button>
        </div>
      )}

      {/* ── 생성 팝업 ── */}
      {modal === 'create' && (
        <Modal title="카테고리 생성" onClose={() => setModal('none')}>
          <div className="px-6 py-5 space-y-4">
            <div>
              <label className="text-sm font-medium text-gray-700 mb-1 block">
                카테고리명 <span className="text-red-500">*</span>
              </label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
                placeholder="카테고리명을 입력하세요" autoFocus className={inputCls} />
              {formError && <p className="text-red-500 text-xs mt-1">{formError}</p>}
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700 mb-1 block">설명</label>
              <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="설명을 입력하세요" rows={3}
                className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm
                           focus:outline-none focus:border-blue-500 resize-none" />
            </div>
          </div>
          <div className="flex justify-end gap-2 px-6 py-4 border-t bg-gray-50 rounded-b-lg">
            <button onClick={() => setModal('none')}
              className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-100">취소</button>
            <button onClick={handleCreate}
              className="px-4 py-2 text-sm bg-[#2d4a7a] text-white rounded-lg hover:bg-[#1e3a6a]">생성</button>
          </div>
        </Modal>
      )}

      {/* ── 상세 팝업 ── */}
      {modal === 'detail' && selected && (
        <Modal title="카테고리 상세정보" onClose={() => setModal('none')}>
          <div className="px-6 py-4">
            <div className="flex justify-end gap-3 mb-4">
              {perm.update && (
                <button onClick={openEdit}
                  className="text-sm text-gray-600 hover:text-gray-800 flex items-center gap-1">
                  수정 ✏️
                </button>
              )}
              {perm.delete && (
                <button onClick={() => { setDeleteTarget(selected); setModal('delete'); }}
                  className="text-sm text-red-400 hover:text-red-600 flex items-center gap-1">
                  삭제 🗑
                </button>
              )}
            </div>
            <div className="space-y-0">
              {[
                { label: '카테고리명', value: selected.name },
                { label: '설명', value: selected.description ?? '-' },
                { label: '최초 등록일시', value: formatDate(selected.createdAt) },
                { label: '최초 등록자', value: selected.createdBy?.fullName ?? '-' },
                { label: '최종 수정일시', value: selected.updatedAt ? formatDate(selected.updatedAt) : '-' },
                { label: '최종 수정자', value: selected.updatedBy?.fullName ?? '-' },
              ].map(({ label, value }) => (
                <div key={label} className="flex items-start py-3 border-b border-gray-100 last:border-0">
                  <span className="text-sm text-gray-500 w-32 shrink-0">{label}</span>
                  <span className="text-sm text-gray-800">{value}</span>
                </div>
              ))}
            </div>
          </div>
        </Modal>
      )}

      {/* ── 수정 팝업 ── */}
      {modal === 'edit' && selected && (
        <Modal title="카테고리 수정" onClose={() => setModal('detail')}>
          <div className="px-6 py-5 space-y-4">
            <div>
              <label className="text-sm font-medium text-gray-700 mb-1 block">
                카테고리명 <span className="text-red-500">*</span>
              </label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="카테고리명을 입력하세요" autoFocus className={inputCls} />
              {formError && <p className="text-red-500 text-xs mt-1">{formError}</p>}
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700 mb-1 block">설명</label>
              <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="설명을 입력하세요" rows={3}
                className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm
                           focus:outline-none focus:border-blue-500 resize-none" />
            </div>
          </div>
          <div className="flex justify-end gap-2 px-6 py-4 border-t bg-gray-50 rounded-b-lg">
            <button onClick={() => setModal('detail')}
              className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-100">취소</button>
            <button onClick={handleUpdate}
              className="px-4 py-2 text-sm bg-[#2d4a7a] text-white rounded-lg hover:bg-[#1e3a6a]">저장</button>
          </div>
        </Modal>
      )}

      {/* ── 삭제 Alert ── */}
      {modal === 'delete' && deleteTarget && (
        <DeleteAlert
          onCancel={() => { setDeleteTarget(null); setModal('detail'); }}
          onConfirm={handleDelete}
        />
      )}

      {/* ── 공통 Alert ── */}
      {alert && <Alert message={alert} onClose={() => setAlert(null)} />}
    </div>
  );
}