import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { rolesApi, Role } from '@/api/roles';

function Alert({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[70]">
      <div className="bg-white rounded-lg w-full max-w-sm mx-4 shadow-xl p-6">
        <p className="text-gray-700 text-sm text-center whitespace-pre-line mb-6">{message}</p>
        <div className="flex justify-center">
          <button
            onClick={onClose}
            className="px-8 py-2 text-sm bg-[#2d4a7a] text-white rounded-lg hover:bg-[#1e3a6a]"
          >
            확인
          </button>
        </div>
      </div>
    </div>
  );
}

function Modal({ title, onClose, children }: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg w-full max-w-md mx-4 shadow-xl">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h3 className="font-semibold text-gray-800">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function DeleteAlert({ onCancel, onConfirm }: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg w-full max-w-sm mx-4 shadow-xl p-6">
        <div className="flex items-center gap-3 mb-3">
          <span className="text-yellow-500 text-2xl">⚠️</span>
          <h3 className="font-semibold text-gray-800">권한 삭제</h3>
        </div>
        <p className="text-gray-600 text-sm mb-6">
          삭제하면 복구할 수 없습니다. 정말 삭제하시겠습니까?
        </p>
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            취소
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 text-sm bg-red-500 text-white rounded-lg hover:bg-red-600"
          >
            삭제
          </button>
        </div>
      </div>
    </div>
  );
}

export default function PermissionsPage() {
  const navigate = useNavigate();
  const [alert, setAlert] = useState<string | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState('');
  const [createLoading, setCreateLoading] = useState(false);

  const [selectedRole, setSelectedRole] = useState<Role | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editName, setEditName] = useState('');
  const [editError, setEditError] = useState('');

  const [showDeleteAlert, setShowDeleteAlert] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Role | null>(null);

  const fetchRoles = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await rolesApi.getAll(search || undefined);
      setRoles(data.items);
      setTotal(data.total);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => { fetchRoles(); }, [fetchRoles]);

  const handleCreate = async () => {
    if (!newName.trim()) { setCreateError('권한명을 입력하세요.'); return; }
    setCreateLoading(true);
    setCreateError('');
    try {
      await rolesApi.create(newName.trim());
      setNewName('');
      setShowCreate(false);
      fetchRoles();
      setAlert('생성완료');
    } catch (err: any) {
      setCreateError(err.response?.data?.message ?? '생성 실패');
      setAlert('생성에 실패하였습니다.\n관리자에게 문의주세요.');
    } finally {
      setCreateLoading(false);
    }
  };

  const handleUpdate = async () => {
    if (!selectedRole || !editName.trim()) return;
    setEditError('');
    try {
      await rolesApi.update(selectedRole.id, editName.trim());
      setShowDetail(false);
      setEditMode(false);
      fetchRoles();
      setAlert('수정완료');
    } catch (err: any) {
      setEditError(err.response?.data?.message ?? '수정 실패');
      setAlert('수정에 실패하였습니다.\n관리자에게 문의주세요.');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await rolesApi.remove(deleteTarget.id);
      setShowDeleteAlert(false);
      setShowDetail(false);
      setDeleteTarget(null);
      fetchRoles();
      setAlert('삭제완료');
    } catch {
      setAlert('삭제에 실패하였습니다.\n관리자에게 문의주세요.');
    }
  };

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleString('ko-KR', { hour12: false }).replace(/\. /g, '-').replace('.', '');

  return (
    <div className="p-8 bg-gray-50 min-h-full">
      <h1 className="text-xl font-bold text-gray-800 mb-6">권한 관리</h1>

      <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4 space-y-3">
        <div className="relative">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && fetchRoles()}
            placeholder="검색어를 입력하세요"
            className="w-full border border-gray-300 rounded-lg px-4 py-2.5 pr-10
                       text-sm focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={fetchRoles}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
          >
            🔍
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between mb-3">
        <p className="text-sm text-gray-600">총 {total}건</p>
        <button
          onClick={() => { setNewName(''); setCreateError(''); setShowCreate(true); }}
          className="px-4 py-2 bg-gray-800 text-white text-sm rounded-lg hover:bg-gray-700 flex items-center gap-1"
        >
          생성 +
        </button>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[#2d4a7a] text-white">
              <th className="px-6 py-3 text-center font-medium w-20">NO</th>
              <th className="px-6 py-3 text-center font-medium">권한명</th>
              <th className="px-6 py-3 text-center font-medium">최초 등록일시</th>
              <th className="px-6 py-3 text-center font-medium">최초 등록자명</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={4} className="text-center py-10 text-gray-400">로딩 중...</td>
              </tr>
            ) : roles.length === 0 ? (
              <tr>
                <td colSpan={4} className="text-center py-10 text-gray-400">데이터가 없습니다.</td>
              </tr>
            ) : (
              roles.map((role, idx) => (
                <tr
                  key={role.id}
                  onClick={() => {
                    setSelectedRole(role);
                    setEditName(role.name);
                    setEditMode(false);
                    setEditError('');
                    setShowDetail(true);
                  }}
                  className="border-t border-gray-100 hover:bg-blue-50 cursor-pointer transition-colors"
                >
                  <td className="px-6 py-3 text-center text-gray-600">{total - idx}</td>
                  <td className="px-6 py-3 text-center text-gray-800">{role.name}</td>
                  <td className="px-6 py-3 text-center text-gray-600">{formatDate(role.createdAt)}</td>
                  <td className="px-6 py-3 text-center text-gray-600">
                    {role.createdBy?.fullName ?? '시스템'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {showCreate && (
        <Modal title="권한 생성" onClose={() => setShowCreate(false)}>
          <div className="px-6 py-5 space-y-4">
            <div>
              <label className="text-sm font-medium text-gray-700 mb-1 block">
                권한명 <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                placeholder="권한명을 입력하세요"
                autoFocus
                className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm
                           focus:outline-none focus:border-blue-500"
              />
              {createError && (
                <p className="text-red-500 text-xs mt-1">{createError}</p>
              )}
            </div>
          </div>
          <div className="flex justify-end gap-2 px-6 py-4 border-t bg-gray-50 rounded-b-lg">
            <button
              onClick={() => { setNewName(''); setCreateError(''); setShowCreate(false); }}
              className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-100"
            >
              취소
            </button>
            <button
              onClick={handleCreate}
              disabled={createLoading}
              className="px-4 py-2 text-sm bg-[#2d4a7a] text-white rounded-lg hover:bg-[#1e3a6a] disabled:opacity-50"
            >
              {createLoading ? '처리 중...' : '생성'}
            </button>
          </div>
        </Modal>
      )}

      {showDetail && selectedRole && (
        <Modal
          title={editMode ? '권한 수정' : '권한 상세'}
          onClose={() => { setShowDetail(false); setEditMode(false); }}
        >
          <div className="px-6 py-5 space-y-4">
            <div>
              <label className="text-sm font-medium text-gray-700 mb-1 block">
                권한명 <span className="text-red-500">*</span>
              </label>
              {editMode ? (
                <>
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    autoFocus
                    className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm
                               focus:outline-none focus:border-blue-500"
                  />
                  {editError && <p className="text-red-500 text-xs mt-1">{editError}</p>}
                </>
              ) : (
                <p
                  onClick={() => {
                    const targetId = selectedRole.id;
                    setShowDetail(false);
                    setTimeout(() => navigate(`/system/permissions/${targetId}`), 50);
                  }}
                  className="text-blue-600 hover:underline cursor-pointer text-sm py-2"
                >
                  {selectedRole.name}
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm text-gray-600">
              <div>
                <p className="font-medium text-gray-700 mb-1">최초 등록일시</p>
                <p>{formatDate(selectedRole.createdAt)}</p>
              </div>
              <div>
                <p className="font-medium text-gray-700 mb-1">최초 등록자</p>
                <p>{selectedRole.createdBy?.fullName ?? '시스템'}</p>
              </div>
            </div>
          </div>
          <div className="flex justify-between px-6 py-4 border-t bg-gray-50 rounded-b-lg">
            <button
              onClick={() => {
                setDeleteTarget(selectedRole);
                setShowDeleteAlert(true);
              }}
              className="px-4 py-2 text-sm border border-red-300 text-red-500 rounded-lg hover:bg-red-50"
            >
              삭제
            </button>
            <div className="flex gap-2">
              <button
                onClick={() => { setShowDetail(false); setEditMode(false); }}
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-100"
              >
                닫기
              </button>
              {editMode ? (
                <button
                  onClick={handleUpdate}
                  className="px-4 py-2 text-sm bg-[#2d4a7a] text-white rounded-lg hover:bg-[#1e3a6a]"
                >
                  저장
                </button>
              ) : (
                <button
                  onClick={() => setEditMode(true)}
                  className="px-4 py-2 text-sm bg-[#2d4a7a] text-white rounded-lg hover:bg-[#1e3a6a]"
                >
                  수정
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}

      {showDeleteAlert && (
        <DeleteAlert
          onCancel={() => { setShowDeleteAlert(false); setDeleteTarget(null); }}
          onConfirm={handleDelete}
        />
      )}

      {/* ── 공통 Alert ── */}
      {alert && (
        <Alert message={alert} onClose={() => setAlert(null)} />
      )}
    </div>
  );
}