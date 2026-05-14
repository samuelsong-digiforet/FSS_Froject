import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from '@/components/Layout';
import PrivateRoute from '@/components/PrivateRoute';

const AssetCategoriesPage = lazy(() => import('@/pages/assets/AssetCategoriesPage'));
const AssetsPage = lazy(() => import('@/pages/assets/AssetsPage'));
const HomePage = lazy(() => import('@/pages/HomePage'));
const LoginPage = lazy(() => import('@/pages/LoginPage'));
const LogsPage = lazy(() => import('@/pages/system/LogsPage'));
const PermissionDetailPage = lazy(() => import('@/pages/system/PermissionDetailPage'));
const PermissionsPage = lazy(() => import('@/pages/system/PermissionsPage'));
const UsersPage = lazy(() => import('@/pages/system/UsersPage'));

const routeFallback = (
  <div className="min-h-screen bg-gray-50 flex items-center justify-center text-sm text-gray-500">
    로딩 중...
  </div>
);

const wrap = (child: ReactNode) => (
  <PrivateRoute>
    <Layout>{child}</Layout>
  </PrivateRoute>
);

export default function App() {
  return (
    <Suspense fallback={routeFallback}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/dashboard" element={wrap(<HomePage />)} />
        <Route path="/assets" element={wrap(<AssetsPage />)} />
        <Route path="/assets/categories" element={wrap(<AssetCategoriesPage />)} />
        <Route path="/assets/:assetId" element={wrap(<AssetsPage />)} />
        <Route path="/system/users" element={wrap(<UsersPage />)} />
        <Route path="/system/permissions" element={wrap(<PermissionsPage />)} />
        <Route path="/system/permissions/:id" element={wrap(<PermissionDetailPage />)} />
        <Route path="/system/logs" element={wrap(<LogsPage />)} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Suspense>
  );
}
