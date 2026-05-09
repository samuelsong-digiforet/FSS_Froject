import { create } from 'zustand';

export interface MenuPermission {
  menuKey: string;
  use: boolean;
  view: boolean;
  detail: boolean;
  create: boolean;
  update: boolean;
  delete: boolean;
  approve: boolean;
  editor: boolean;
  excel: boolean;
}

interface PermissionState {
  permissions: Record<string, MenuPermission>;
  isLoaded: boolean;
  setPermissions: (perms: MenuPermission[]) => void;
  setLoaded: (v: boolean) => void;
  getMenu: (menuKey: string) => MenuPermission;
}

const defaultPerm = (menuKey: string): MenuPermission => ({
  menuKey, use: false, view: false, detail: false,
  create: false, update: false, delete: false,
  approve: false, editor: false, excel: false,
});

export const usePermissionStore = create<PermissionState>((set, get) => ({
  permissions: {},
  isLoaded: false,
  setPermissions: (perms) => {
    const map: Record<string, MenuPermission> = {};
    perms.forEach(p => { map[p.menuKey] = p; });
    set({ permissions: map, isLoaded: true });
  },
  setLoaded: (v) => set({ isLoaded: v }),
  getMenu: (menuKey) => get().permissions[menuKey] ?? defaultPerm(menuKey),
}));