import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
});

// 토큰 자동 주입
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// 401 시 자동 로그아웃
api.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  },
);

export interface AuthResponse {
  accessToken: string;
}

export interface MeResponse {
  id: string;
  email: string;
  fullName: string;
  role: string;
  roleId?: number;
}

export const authApi = {
  register: (email: string, password: string, fullName: string) =>
    api.post<AuthResponse>('/auth/register', { email, password, fullName }),
  login: (username: string, password: string) =>
    api.post<AuthResponse>('/auth/login', { username, password }),
  me: () => api.get<MeResponse>('/auth/me'),
};

export default api;
