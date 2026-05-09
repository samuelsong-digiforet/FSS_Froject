import api from './auth';

export interface AccessLog {
  id: number;
  username?: string;
  fullName?: string;
  ip?: string;
  device?: string;
  menuName?: string;
  action?: string;
  accessedAt: string;
}

export const logsApi = {
  getAll: (params?: {
    search?: string;
    startDate?: string;
    endDate?: string;
    page?: number;
    limit?: number;
  }) => api.get<{ total: number; items: AccessLog[] }>('/logs', { params }),
};