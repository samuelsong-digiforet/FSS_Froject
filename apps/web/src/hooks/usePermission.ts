import { usePermissionStore, MenuPermission } from '@/store/permissionStore';
import { useAuthStore } from '@/store/authStore';

export function usePermission(menuKey: string): MenuPermission & { isAdmin: boolean; isLoaded: boolean } {
  const { getMenu, isLoaded } = usePermissionStore();
  const user = useAuthStore(s => s.user);
  const isAdmin = user?.role === 'admin';
  const perm = getMenu(menuKey);

  // admin은 모든 권한 허용
  if (isAdmin) {
    return {
      ...perm,
      use: true, view: true, detail: true, create: true,
      update: true, delete: true, approve: true, editor: true, excel: true,
      isAdmin: true,
      isLoaded: true,
    };
  }

  return { ...perm, isAdmin: false, isLoaded };
}