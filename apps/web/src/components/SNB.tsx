import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/store/authStore';
import { usePermissionStore } from '@/store/permissionStore';

const Icons = {
  Dashboard: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5">
      <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  ),
  Asset: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5">
      <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
    </svg>
  ),
  System: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.07 4.93a10 10 0 010 14.14M4.93 4.93a10 10 0 000 14.14" />
    </svg>
  ),
  Category: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-4 h-4">
      <path d="M4 6h16M4 12h10M4 18h6" />
    </svg>
  ),
  Manage: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-4 h-4">
      <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
    </svg>
  ),
  Users: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-4 h-4">
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
    </svg>
  ),
  Permission: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-4 h-4">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0110 0v4" />
    </svg>
  ),
  Log: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-4 h-4">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
    </svg>
  ),
  Chevron: ({ open }: { open: boolean }) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      className={`w-4 h-4 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  ),
  Collapse: ({ collapsed }: { collapsed: boolean }) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
      {collapsed ? <path d="M9 18l6-6-6-6" /> : <path d="M15 18l-6-6 6-6" />}
    </svg>
  ),
  Logout: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-4 h-4">
      <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />
    </svg>
  ),
  Help: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-4 h-4">
      <circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3M12 17h.01" />
    </svg>
  ),
};

// 메뉴별 권한 키 매핑
const MENU_KEY_MAP: Record<string, string> = {
  dashboard:   'dashboard',
  asset:       'asset_category',
  'asset-category': 'asset_category',
  'asset-manage':   'asset_manage',
  users:       'sys_users',
  permission:  'sys_permissions',
  log:         'sys_logs',
};

interface NavChild {
  id: string;
  label: string;
  icon: React.ReactNode;
  path: string;
}

interface NavItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  path?: string;
  children?: NavChild[];
}

const navItems: NavItem[] = [
  {
    id: 'dashboard',
    label: '디지털 트윈 대시보드',
    icon: <Icons.Dashboard />,
    path: '/dashboard',
  },
  {
    id: 'asset',
    label: '에셋 라이브러리',
    icon: <Icons.Asset />,
    children: [
      { id: 'asset-category', label: '에셋 카테고리 관리', icon: <Icons.Category />, path: '/assets/categories' },
      { id: 'asset-manage',   label: '에셋 관리',          icon: <Icons.Manage />,   path: '/assets' },
    ],
  },
  {
    id: 'system',
    label: '시스템 관리',
    icon: <Icons.System />,
    children: [
      { id: 'users',      label: '회원 관리',       icon: <Icons.Users />,      path: '/system/users' },
      { id: 'permission', label: '권한 관리',        icon: <Icons.Permission />, path: '/system/permissions' },
      { id: 'log',        label: '시스템 접속 로그', icon: <Icons.Log />,        path: '/system/logs' },
    ],
  },
];

export default function SNB() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuthStore();
  const { getMenu } = usePermissionStore();

  const [collapsed, setCollapsed] = useState(false);
  const [openMenus, setOpenMenus] = useState<string[]>(['asset', 'system']);

  const isAdmin = user?.role === 'admin';

  const toggleMenu = (id: string) => {
    setOpenMenus((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id],
    );
  };

  const isActive = (path?: string) => path && location.pathname === path;
  const isParentActive = (item: NavItem) =>
    item.children?.some((c) => location.pathname === c.path);

  // 메뉴 사용 여부 체크
  const canUseMenu = (id: string): boolean => {
    if (isAdmin) return true;
    const menuKey = MENU_KEY_MAP[id];
    if (!menuKey) return true; // 키 없으면 허용 (system 그룹 등)
    return getMenu(menuKey).use;
  };

  // 부모 메뉴 표시 여부 (자식 중 하나라도 use=true면 표시)
  const canUseParent = (item: NavItem): boolean => {
    if (isAdmin) return true;
    if (!item.children) return canUseMenu(item.id);
    return item.children.some(child => canUseMenu(child.id));
  };

  return (
    <aside
      className={`flex flex-col h-screen bg-[#0f1117] border-r border-[#1e2130]
                  transition-all duration-300 ${collapsed ? 'w-[60px]' : 'w-[220px]'}`}
    >
      {/* 프로필 */}
      <div className={`flex items-center gap-3 px-4 py-5 border-b border-[#1e2130]
                       ${collapsed ? 'justify-center' : ''}`}>
        <div className="w-8 h-8 rounded-full bg-sky-500/20 border border-sky-500/40
                        flex items-center justify-center text-sky-400 text-xs font-bold shrink-0">
          {user?.fullName?.[0] ?? 'U'}
        </div>
        {!collapsed && (
          <div className="overflow-hidden">
            <p className="text-[11px] text-gray-500 uppercase tracking-wider truncate">
              {user?.role === 'admin' ? 'Administrator' : 'User'}
            </p>
            <p className="text-white text-sm font-medium truncate">{user?.fullName ?? '사용자'}</p>
          </div>
        )}
        <button
          onClick={() => setCollapsed((v) => !v)}
          className={`text-gray-600 hover:text-gray-300 transition-colors shrink-0
                      ${collapsed ? 'mx-auto' : 'ml-auto'}`}
        >
          <Icons.Collapse collapsed={collapsed} />
        </button>
      </div>

      {/* 네비게이션 */}
      <nav className="flex-1 overflow-y-auto py-3 space-y-0.5 px-2">
        {!collapsed && (
          <p className="text-[10px] text-gray-600 uppercase tracking-widest px-2 pt-2 pb-1">
            Main
          </p>
        )}

        {navItems.map((item) => {
          // 부모 메뉴 사용 여부 체크
          if (!canUseParent(item)) return null;

          return (
            <div key={item.id}>
              <button
                onClick={() => {
                  if (item.children) {
                    if (!collapsed) toggleMenu(item.id);
                  } else if (item.path) {
                    navigate(item.path);
                  }
                }}
                className={`w-full flex items-center gap-3 px-2 py-2.5 rounded-lg
                            text-sm transition-all duration-150
                            ${collapsed ? 'justify-center' : ''}
                            ${isActive(item.path) || isParentActive(item)
                              ? 'bg-sky-500/10 text-sky-400'
                              : 'text-gray-400 hover:bg-[#1a1f2e] hover:text-gray-200'}`}
                title={collapsed ? item.label : undefined}
              >
                <span className="shrink-0">{item.icon}</span>
                {!collapsed && (
                  <>
                    <span className="flex-1 text-left truncate">{item.label}</span>
                    {item.children && (
                      <Icons.Chevron open={openMenus.includes(item.id)} />
                    )}
                  </>
                )}
              </button>

              {/* 서브메뉴 */}
              {item.children && !collapsed && openMenus.includes(item.id) && (
                <div className="mt-0.5 mb-1 ml-3 pl-3 border-l border-[#1e2130] space-y-0.5">
                  {item.children.map((child) => {
                    // 자식 메뉴 사용 여부 체크
                    if (!canUseMenu(child.id)) return null;

                    return (
                      <button
                        key={child.id}
                        onClick={() => navigate(child.path)}
                        className={`w-full flex items-center gap-2.5 px-2 py-2 rounded-lg
                                    text-[13px] transition-all duration-150
                                    ${isActive(child.path)
                                      ? 'bg-sky-500/10 text-sky-400'
                                      : 'text-gray-500 hover:bg-[#1a1f2e] hover:text-gray-300'}`}
                      >
                        <span className="shrink-0">{child.icon}</span>
                        <span className="truncate">{child.label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* 하단 */}
      <div className="border-t border-[#1e2130] p-2 space-y-0.5">
        <button
          className={`w-full flex items-center gap-3 px-2 py-2.5 rounded-lg
                      text-gray-500 hover:bg-[#1a1f2e] hover:text-gray-300
                      text-sm transition-all ${collapsed ? 'justify-center' : ''}`}
          title={collapsed ? '도움말' : undefined}
        >
          <Icons.Help />
          {!collapsed && <span>도움말</span>}
        </button>
        <button
          onClick={() => { logout(); navigate('/login'); }}
          className={`w-full flex items-center gap-3 px-2 py-2.5 rounded-lg
                      text-gray-500 hover:bg-red-500/10 hover:text-red-400
                      text-sm transition-all ${collapsed ? 'justify-center' : ''}`}
          title={collapsed ? '로그아웃' : undefined}
        >
          <Icons.Logout />
          {!collapsed && <span>로그아웃</span>}
        </button>
      </div>
    </aside>
  );
}