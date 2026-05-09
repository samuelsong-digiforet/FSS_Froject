import api from './auth';

export type SceneUnit = 'm' | 'cm' | 'mm' | 'ft';

export interface SceneObject {
  id: string;
  assetId: string;
  name: string;
  sourceObject: string;
  position: [number, number, number];
  rotation: [number, number, number]; // degrees
  scale: [number, number, number];
  visible: boolean;
}

export interface SavedView {
  id: string;
  name: string;
  position: [number, number, number];
  target: [number, number, number];
}

export interface SceneData {
  objects: SceneObject[];
  camera: { position: [number, number, number]; target: [number, number, number] };
  lighting: {
    ambient: { intensity: number; color: string };
    directional: { intensity: number; color: string; position: [number, number, number] };
  };
  grid: { enabled: boolean; snap: boolean; snapSize: number; color: string };
  savedViews: SavedView[];
  backgroundColor: string;
  unit: SceneUnit;
  area: { width: number; depth: number };
  lengthUnitVersion?: number;
}

export interface Scene {
  id: string;
  name: string;
  description?: string;
  data: SceneData;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_SCENE_DATA: SceneData = {
  objects: [],
  camera: { position: [15, 12, 15], target: [0, 0, 0] },
  lighting: {
    ambient: { intensity: 0.6, color: '#ffffff' },
    directional: { intensity: 1.2, color: '#ffffff', position: [5, 10, 5] },
  },
  grid: { enabled: true, snap: false, snapSize: 0.5, color: '#31385a' },
  savedViews: [],
  backgroundColor: '#1a1a2e',
  unit: 'm',
  area: { width: 20, depth: 20 },
  lengthUnitVersion: 2,
};

export const scenesApi = {
  getAll: () => api.get<Scene[]>('/scenes'),
  getOne: (id: string) => api.get<Scene>(`/scenes/${id}`),
  create: (data: { name: string; description?: string; data?: SceneData }) =>
    api.post<Scene>('/scenes', data),
  update: (id: string, data: { name?: string; description?: string; data?: SceneData }) =>
    api.patch<Scene>(`/scenes/${id}`, data),
  remove: (id: string) => api.delete(`/scenes/${id}`),
};
