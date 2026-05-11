import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from '@/components/Layout';
import PrivateRoute from '@/components/PrivateRoute';
import AssetCategoriesPage from '@/pages/assets/AssetCategoriesPage';
import AssetsPage from '@/pages/assets/AssetsPage';
import HomePage from '@/pages/HomePage';
import LoginPage from '@/pages/LoginPage';
import StudioPage from '@/pages/studio/StudioPage';
import LogsPage from '@/pages/system/LogsPage';
import PermissionDetailPage from '@/pages/system/PermissionDetailPage';
import PermissionsPage from '@/pages/system/PermissionsPage';
import UsersPage from '@/pages/system/UsersPage';

const wrap = (child: React.ReactNode) => (
  <PrivateRoute>
    <Layout>{child}</Layout>
  </PrivateRoute>
);

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/dashboard" element={wrap(<HomePage />)} />
      <Route
        path="/studio"
        element={(
          <PrivateRoute>
            <div className="h-screen">
              <StudioPage />
            </div>
          </PrivateRoute>
        )}
      />
      <Route path="/assets" element={wrap(<AssetsPage />)} />
      <Route path="/assets/categories" element={wrap(<AssetCategoriesPage />)} />
      <Route path="/assets/:assetId" element={wrap(<AssetsPage />)} />
      <Route path="/system/users" element={wrap(<UsersPage />)} />
      <Route path="/system/permissions" element={wrap(<PermissionsPage />)} />
      <Route path="/system/permissions/:id" element={wrap(<PermissionDetailPage />)} />
      <Route path="/system/logs" element={wrap(<LogsPage />)} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
