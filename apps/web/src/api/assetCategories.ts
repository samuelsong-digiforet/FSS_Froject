import api from './auth';

export interface AssetCategory {
  id: number;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: { fullName: string };
  updatedBy?: { fullName: string };
}

export const assetCategoriesApi = {
  getAll: (params?: {
    search?: string;
    startDate?: string;
    endDate?: string;
    page?: number;
    limit?: number;
  }) => api.get<{ total: number; items: AssetCategory[] }>('/asset-categories', { params }),
  getOne: (id: number) => api.get<AssetCategory>(`/asset-categories/${id}`),
  create: (data: { name: string; description?: string }) =>
    api.post<AssetCategory>('/asset-categories', data),
  update: (id: number, data: { name?: string; description?: string }) =>
    api.patch<AssetCategory>(`/asset-categories/${id}`, data),
  remove: (id: number) => api.delete(`/asset-categories/${id}`),
};