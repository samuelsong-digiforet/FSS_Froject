import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { rolesApi, Role, Permission, RoleUser } from '@/api/roles';
import { usePermission } from '@/hooks/usePermission';

interface MenuAction {
  key: keyof Omit<Permission, 'menuKey'>;
  label: string;
}

interface MenuItem {
  menuKey: string;
  label: string;
  actions: MenuAction[];
}

interface MenuGroup {
  group: string;
  items: MenuItem[];
}

const MENU_STRUCTURE: MenuGroup[] = [
  {
    group: '대시보드',
    items: [
      {
        menuKey: 'dashboard',
        label: '대시보드',
        actions: [
          { key: 'use',  label: '사용 여부' },
          { key: 'view', label: '조회' },
        ],
      },
    ],
  },
  {
    group: '에셋 라이브러리',
    items: [
      {
        menuKey: 'asset_category',
        label: '카테고리 관리',
        actions: [
          { key: 'use',    label: '사용 여부' },
          { key: 'view',   label: '조회 (검색)' },
          { key: 'detail', label: '상세 정보' },
          { key: 'create', label: '생성' },
          { key: 'update', label: '수정' },
          { key: 'delete', label: '삭제' },
        ],
      },
      {
        menuKey: 'asset_manage',
        label: '에셋 관리',
        actions: [
          { key: 'use',     label: '사용 여부' },
          { key: 'view',    label: '조회 (검색)' },
          { key: 'detail',  label: '상세 정보' },
          { key: 'create',  label: '생성' },
          { key: 'update',  label: '수정' },
          { key: 'delete',  label: '삭제' },
          { key: 'approve', label: '승인/미승인' },
        ],
      },
    ],
  },
  {
    group: '시스템 관리',
    items: [
      {
        menuKey: 'sys_users',
        label: '회원 관리',
        actions: [
          { key: 'use',     label: '사용 여부' },
          { key: 'view',    label: '조회 (검색)' },
          { key: 'detail',  label: '상세 정보' },
          { key: 'create',  label: '생성' },
          { key: 'update',  label: '수정' },
          { key: 'delete',  label: '삭제' },
          { key: 'approve', label: '승인/미승인' },
          { key: 'excel',   label: 'Excel 다운로드' },
        ],
      },
      {
        menuKey: 'sys_permissions',
        label: '권한 관리',
        actions: [
          { key: 'use',    label: '사용 여부' },
          { key: 'view',   label: '조회 (검색)' },
          { key: 'detail', label: '상세 정보' },
          { key: 'create', label: '생성' },
          { key: 'update', label: '수정' },
          { key: 'delete', label: '삭제' },
          { key: 'excel',  label: 'Excel 다운로드' },
        ],
      },
      {
        menuKey: 'sys_logs',
        label: '시스템 접속 로그',
        actions: [
          { key: 'use',   label: '사용 여부' },
          { key: 'view',  label: '조회 (검색)' },
          { key: 'excel', label: 'Excel 다운로드' },
        ],
      },
    ],
  },
];

const defaultPerm = (menuKey: string): Permission => ({
  menuKey, use: false, view: false, detail: false,
  create: false, update: false, delete: false,
  approve: false, editor: false, excel: false,
});

type Tab = 'permission' | 'user';

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

function UserTableHeader() {
  return (
    <tr className="bg-[#2d4a7a] text-white">
      <th className="px-4 py-2.5 text-center font-medium text-sm">아이디</th>
      <th className="px-4 py-2.5 text-center font-medium text-sm">이름</th>
      <th className="px-4 py-2.5 text-center font-medium text-sm">부서</th>
      <th className="px-4 py-2.5 text-center font-medium text-sm">직급</th>
    </tr>
  );
}

function UserRow({
  user, selected, onToggle, highlightColor,
}: {
  user: RoleUser;
  selected: boolean;
  onToggle: () => void;
  highlightColor: 'blue' | 'red';
}) {
  return (
    <tr
      onClick={onToggle}
      className={`border-t border-gray-100 cursor-pointer transition-colors
        ${selected
          ? highlightColor === 'blue' ? 'bg-blue-50 text-blue-700' : 'bg-red-50 text-red-700'
          : 'hover:bg-gray-50'}`}
    >
      <td className="px-4 py-2.5 text-center text-sm">{user.username}</td>
      <td className="px-4 py-2.5 text-center text-sm">{user.fullName}</td>
      <td className="px-4 py-2.5 text-center text-sm">{user.department ?? '-'}</td>
      <td className="px-4 py-2.5 text-center text-sm">{user.position ?? '-'}</td>
    </tr>
  );
}

export default function PermissionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const roleId = Number(id);
  const perm = usePermission('sys_permissions');

  const [role, setRole] = useState<Role | null>(null);
  const [permissions, setPermissions] = useState<Record<string, Permission>>({});
  const [editMode, setEditMode] = useState(false);
  const [editPerms, setEditPerms] = useState<Record<string, Permission>>({});
  const [tab, setTab] = useState<Tab>('permission');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [alert, setAlert] = useState<string | null>(null);

  // 사용자 설정 state
  const [roleUsers, setRoleUsers] = useState<RoleUser[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showRemoveModal, setShowRemoveModal] = useState(false);
  const [availableUsers, setAvailableUsers] = useState<RoleUser[]>([]);
  const [addSearch, setAddSearch] = useState('');
  const [selectedAddIds, setSelectedAddIds] = useState<string[]>([]);
  const [removeSearch, setRemoveSearch] = useState('');
  const [selectedRemoveIds, setSelectedRemoveIds] = useState<string[]>([]);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const [roleRes, permRes] = await Promise.all([
          rolesApi.getOne(roleId),
          rolesApi.getPermissions(roleId),
        ]);
        setRole(roleRes.data);
        const map: Record<string, Permission> = {};
        MENU_STRUCTURE.flatMap(g => g.items).forEach(item => {
          const found = permRes.data.find(p => p.menuKey === item.menuKey);
          map[item.menuKey] = found ?? defaultPerm(item.menuKey);
        });
        setPermissions(map);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [roleId]);

  const fetchRoleUsers = useCallback(async () => {
    try {
      const { data } = await rolesApi.getRoleUsers(roleId);
      setRoleUsers(data);
    } catch { /* ignore */ }
  }, [roleId]);

  useEffect(() => {
    if (tab === 'user') fetchRoleUsers();
  }, [tab, fetchRoleUsers]);

  const startEdit = () => {
    setEditPerms(JSON.parse(JSON.stringify(permissions)));
    setEditMode(true);
  };

  const cancelEdit = () => {
    setEditMode(false);
    setEditPerms({});
  };

  const save = async () => {
    setSaving(true);
    try {
      const list = Object.values(editPerms).map(({
        menuKey, use, view, detail, create, update,
        delete: del, approve, editor, excel,
      }) => ({
        menuKey, use, view, detail, create, update,
        delete: del, approve, editor, excel,
      }));
      await rolesApi.savePermissions(roleId, list);
      setPermissions(JSON.parse(JSON.stringify(editPerms)));
      setEditMode(false);
      setAlert('저장완료');
    } catch {
      setAlert('저장에 실패하였습니다.\n관리자에게 문의주세요.');
    } finally {
      setSaving(false);
    }
  };

  const toggle = (menuKey: string, action: keyof Omit<Permission, 'menuKey'>) => {
    setEditPerms(prev => ({
      ...prev,
      [menuKey]: { ...prev[menuKey], [action]: !prev[menuKey][action] },
    }));
  };

  const openAddModal = async () => {
    setAddSearch('');
    setSelectedAddIds([]);
    const { data } = await rolesApi.getAvailableUsers(roleId);
    setAvailableUsers(data);
    setShowAddModal(true);
  };

  const searchAvailable = async () => {
    const { data } = await rolesApi.getAvailableUsers(roleId, addSearch || undefined);
    setAvailableUsers(data);
  };

  const handleAddUsers = async () => {
    if (selectedAddIds.length === 0) return;
    try {
      await rolesApi.addUsers(roleId, selectedAddIds);
      setShowAddModal(false);
      fetchRoleUsers();
      setAlert('사용자가 추가되었습니다.');
    } catch {
      setAlert('추가에 실패하였습니다.\n관리자에게 문의주세요.');
    }
  };

  const openRemoveModal = () => {
    setRemoveSearch('');
    setSelectedRemoveIds([]);
    setShowRemoveModal(true);
  };

  const handleRemoveUsers = async () => {
    if (selectedRemoveIds.length === 0) return;
    try {
      await rolesApi.removeUsers(roleId, selectedRemoveIds);
      setShowRemoveModal(false);
      fetchRoleUsers();
      setAlert('사용자가 삭제되었습니다.');
    } catch {
      setAlert('삭제에 실패하였습니다.\n관리자에게 문의주세요.');
    }
  };

  const toggleSelect = (
    id: string,
    selected: string[],
    setSelected: (v: string[]) => void,
  ) => {
    setSelected(
      selected.includes(id)
        ? selected.filter(s => s !== id)
        : [...selected, id],
    );
  };

  const filteredRoleUsers = roleUsers.filter(u =>
    !removeSearch ||
    (u.username ?? '').includes(removeSearch) ||
    u.fullName.includes(removeSearch) ||
    (u.department ?? '').includes(removeSearch) ||
    (u.position ?? '').includes(removeSearch),
  );

  const currentPerms = editMode ? editPerms : permissions;

  // 권한 로딩 중
  if (!perm.isLoaded) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-400 text-sm">로딩 중...</p>
      </div>
    );
  }

  // 접근 권한 없음
  if (!perm.view) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-400 text-sm">접근 권한이 없습니다.</p>
      </div>
    );
  }

  // 데이터 로딩 중
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-400 text-sm">로딩 중...</p>
      </div>
    );
  }

  return (
    <div className="p-10 bg-gray-50 min-h-full">

      {/* 타이틀 */}
      <div className="flex items-center gap-2 mb-8">
        <button
          onClick={() => navigate('/system/permissions')}
          className="text-gray-400 hover:text-gray-600 text-sm"
        >
          권한 관리
        </button>
        <span className="text-gray-300">›</span>
        <h1 className="text-xl font-bold text-gray-800">
          권한 관리 - {role?.name}
        </h1>
      </div>

      {/* 탭 */}
      <div className="flex border-b border-gray-200 mb-8">
        {(['permission', 'user'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-8 py-4 text-sm font-medium border-b-2 transition-colors
              ${tab === t
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            {t === 'permission' ? '권한 설정' : '사용자 설정'}
          </button>
        ))}
      </div>

      {/* ── 권한 설정 탭 ── */}
      {tab === 'permission' && (
        <>
          {!editMode && perm.update && (
            <div className="flex justify-end mb-6">
              <button
                onClick={startEdit}
                className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-800
                           border border-gray-300 px-4 py-2 rounded-lg hover:bg-gray-100 transition-colors"
              >
                편집 ✏️
              </button>
            </div>
          )}

          <div className="space-y-6">
            {MENU_STRUCTURE.map((group) => (
              <div key={group.group} className="bg-white border border-gray-200 rounded-lg overflow-hidden shadow-sm">
                <div className="px-6 py-4 border-b border-gray-200 bg-gray-50">
                  <h3 className="font-semibold text-gray-800 text-base">{group.group}</h3>
                </div>
                {group.items.map((item, idx) => (
                  <div
                    key={item.menuKey}
                    className={`flex items-center px-6 py-4 gap-12
                      ${idx !== group.items.length - 1 ? 'border-b border-gray-100' : ''}`}
                  >
                    <span className="text-sm text-gray-700 w-48 shrink-0 font-medium">
                      {item.label}
                    </span>
                    <div className="flex items-center gap-5 flex-wrap">
                      {item.actions.map((action) => {
                        const checked = currentPerms[item.menuKey]?.[action.key] ?? false;
                        return (
                          <label
                            key={action.key}
                            className={`flex items-center gap-1.5 text-sm cursor-pointer
                              ${editMode
                                ? 'text-gray-700'
                                : checked ? 'text-blue-600 font-medium' : 'text-gray-400'}`}
                          >
                            {editMode && (
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggle(item.menuKey, action.key)}
                                className="w-4 h-4 rounded accent-blue-600"
                              />
                            )}
                            {action.label}
                            {!editMode && checked && (
                              <span className="text-blue-500 text-xs">✓</span>
                            )}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>

          {editMode && (
            <div className="flex justify-center gap-3 mt-10">
              <button
                onClick={cancelEdit}
                className="px-10 py-2.5 border border-gray-300 rounded-lg text-sm hover:bg-gray-50"
              >
                취소
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="px-10 py-2.5 bg-[#2d4a7a] text-white rounded-lg text-sm hover:bg-[#1e3a6a] disabled:opacity-50"
              >
                {saving ? '저장 중...' : '저장'}
              </button>
            </div>
          )}
        </>
      )}

      {/* ── 사용자 설정 탭 ── */}
      {tab === 'user' && (
        <div>
          <div className="flex justify-end gap-3 mb-4">
            <button
              onClick={openAddModal}
              className="text-sm text-gray-600 hover:text-gray-800 flex items-center gap-1
                         border border-gray-300 px-4 py-2 rounded-lg hover:bg-gray-100"
            >
              추가 +
            </button>
            <button
              onClick={openRemoveModal}
              className="text-sm text-red-400 hover:text-red-600 flex items-center gap-1
                         border border-red-300 px-4 py-2 rounded-lg hover:bg-red-50"
            >
              삭제 🗑
            </button>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden shadow-sm">
            <table className="w-full text-sm">
              <thead><UserTableHeader /></thead>
              <tbody>
                {roleUsers.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="text-center py-10 text-gray-400">
                      추가된 사용자가 없습니다.
                    </td>
                  </tr>
                ) : (
                  roleUsers.map(user => (
                    <tr key={user.id} className="border-t border-gray-100">
                      <td className="px-6 py-3 text-center text-gray-800">{user.username}</td>
                      <td className="px-6 py-3 text-center text-gray-800">{user.fullName}</td>
                      <td className="px-6 py-3 text-center text-gray-600">{user.department ?? '-'}</td>
                      <td className="px-6 py-3 text-center text-gray-600">{user.position ?? '-'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── 사용자 추가 팝업 ── */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg w-full max-w-xl mx-4 shadow-xl">
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <h3 className="font-semibold text-gray-800">권한 사용자 추가</h3>
              <button onClick={() => setShowAddModal(false)} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
            </div>
            <div className="px-6 py-4">
              <div className="relative mb-4">
                <input
                  type="text"
                  value={addSearch}
                  onChange={e => setAddSearch(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && searchAvailable()}
                  placeholder="아이디, 이름, 부서, 직급으로 검색"
                  className="w-full border border-gray-300 rounded-lg px-4 py-2.5 pr-10 text-sm
                             focus:outline-none focus:border-blue-500"
                />
                <button onClick={searchAvailable}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">🔍</button>
              </div>
              <div className="border border-gray-200 rounded-lg overflow-hidden max-h-64 overflow-y-auto">
                <table className="w-full">
                  <thead className="sticky top-0"><UserTableHeader /></thead>
                  <tbody>
                    {availableUsers.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="text-center py-8 text-gray-400 text-sm">
                          추가할 수 있는 사용자가 없습니다.
                        </td>
                      </tr>
                    ) : (
                      availableUsers.map(user => (
                        <UserRow
                          key={user.id}
                          user={user}
                          selected={selectedAddIds.includes(user.id)}
                          onToggle={() => toggleSelect(user.id, selectedAddIds, setSelectedAddIds)}
                          highlightColor="blue"
                        />
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              {selectedAddIds.length > 0 && (
                <p className="text-blue-600 text-xs mt-2">{selectedAddIds.length}명 선택됨</p>
              )}
            </div>
            <div className="flex justify-end gap-2 px-6 py-4 border-t bg-gray-50 rounded-b-lg">
              <button
                onClick={() => { setSelectedAddIds([]); setShowAddModal(false); }}
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-100"
              >취소</button>
              <button
                onClick={handleAddUsers}
                disabled={selectedAddIds.length === 0}
                className="px-4 py-2 text-sm bg-[#2d4a7a] text-white rounded-lg hover:bg-[#1e3a6a] disabled:opacity-50"
              >추가</button>
            </div>
          </div>
        </div>
      )}

      {/* ── 사용자 삭제 팝업 ── */}
      {showRemoveModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg w-full max-w-xl mx-4 shadow-xl">
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <h3 className="font-semibold text-gray-800">권한 사용자 삭제</h3>
              <button onClick={() => setShowRemoveModal(false)} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
            </div>
            <div className="px-6 py-4">
              <div className="relative mb-4">
                <input
                  type="text"
                  value={removeSearch}
                  onChange={e => setRemoveSearch(e.target.value)}
                  placeholder="아이디, 이름, 부서, 직급으로 검색"
                  className="w-full border border-gray-300 rounded-lg px-4 py-2.5 pr-10 text-sm
                             focus:outline-none focus:border-blue-500"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
              </div>
              <div className="border border-gray-200 rounded-lg overflow-hidden max-h-64 overflow-y-auto">
                <table className="w-full">
                  <thead className="sticky top-0"><UserTableHeader /></thead>
                  <tbody>
                    {filteredRoleUsers.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="text-center py-8 text-gray-400 text-sm">
                          삭제할 사용자가 없습니다.
                        </td>
                      </tr>
                    ) : (
                      filteredRoleUsers.map(user => (
                        <UserRow
                          key={user.id}
                          user={user}
                          selected={selectedRemoveIds.includes(user.id)}
                          onToggle={() => toggleSelect(user.id, selectedRemoveIds, setSelectedRemoveIds)}
                          highlightColor="red"
                        />
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              {selectedRemoveIds.length > 0 && (
                <p className="text-red-500 text-xs mt-2">{selectedRemoveIds.length}명 선택됨</p>
              )}
            </div>
            <div className="flex justify-end gap-2 px-6 py-4 border-t bg-gray-50 rounded-b-lg">
              <button
                onClick={() => { setSelectedRemoveIds([]); setShowRemoveModal(false); }}
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-100"
              >취소</button>
              <button
                onClick={handleRemoveUsers}
                disabled={selectedRemoveIds.length === 0}
                className="px-4 py-2 text-sm bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:opacity-50"
              >삭제</button>
            </div>
          </div>
        </div>
      )}

      {/* ── 공통 Alert ── */}
      {alert && (
        <Alert message={alert} onClose={() => setAlert(null)} />
      )}
    </div>
  );
}