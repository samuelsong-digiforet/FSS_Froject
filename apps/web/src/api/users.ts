import api from './auth';

export interface UserItem {
  id: string;
  username: string;
  fullName: string;
  email: string;
  department?: string;
  position?: string;
  phone?: string;
  isApproved: boolean;
  isActive: boolean;
  lastLoginAt?: string;
  createdAt: string;
  createdBy?: { fullName: string };
  updatedBy?: { fullName: string };
  updatedAt?: string;
}

export interface CreateUserPayload {
  username: string;
  password: string;
  fullName: string;
  email: string;
  department?: string;
  position?: string;
  phone?: string;
  isApproved: boolean;
}

export interface UpdateUserPayload {
  fullName?: string;
  email?: string;
  department?: string;
  position?: string;
  phone?: string;
  isApproved?: boolean;
}

export const usersApi = {
  getAll: (params?: {
    search?: string;
    dateType?: string;
    startDate?: string;
    endDate?: string;
    approval?: string;
  }) => api.get<{ total: number; items: UserItem[] }>('/users', { params }),
  getOne: (id: string) => api.get<UserItem>(`/users/${id}`),
  create: (data: CreateUserPayload) => api.post<UserItem>('/users', data),
  update: (id: string, data: UpdateUserPayload) => api.patch<UserItem>(`/users/${id}`, data),
  remove: (id: string) => api.delete(`/users/${id}`),
  changePassword: (id: string, currentPassword: string, newPassword: string) =>
    api.patch(`/users/${id}/password`, { currentPassword, newPassword }),
};