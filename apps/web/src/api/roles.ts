import api from './auth';

export interface Role {
  id: number;
  name: string;
  createdAt: string;
  createdBy?: { fullName: string };
}

export interface Permission {
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

export interface RoleUser {
  id: string;
  username: string;
  email: string;
  fullName: string;
  department?: string;
  position?: string;
}

export const rolesApi = {
  getAll: (search?: string) =>
    api.get<{ total: number; items: Role[] }>('/roles', {
      params: search ? { search } : {},
    }),
  getOne: (id: number) => api.get<Role>(`/roles/${id}`),
  create: (name: string) => api.post<Role>('/roles', { name }),
  update: (id: number, name: string) => api.patch<Role>(`/roles/${id}`, { name }),
  remove: (id: number) => api.delete(`/roles/${id}`),
  getPermissions: (id: number) => api.get<Permission[]>(`/roles/${id}/permissions`),
  savePermissions: (id: number, permissions: Permission[]) =>
    api.post<Permission[]>(`/roles/${id}/permissions`, { permissions }),
  getRoleUsers: (id: number, search?: string) =>
    api.get<RoleUser[]>(`/roles/${id}/users`, { params: search ? { search } : {} }),
  getAvailableUsers: (id: number, search?: string) =>
    api.get<RoleUser[]>(`/roles/${id}/available-users`, { params: search ? { search } : {} }),
  addUsers: (id: number, userIds: string[]) =>
    api.post(`/roles/${id}/users`, { userIds }),
  removeUsers: (id: number, userIds: string[]) =>
    api.delete(`/roles/${id}/users`, { data: { userIds } }),
};