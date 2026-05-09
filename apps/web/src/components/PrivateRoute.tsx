import { Navigate } from 'react-router-dom';
import { useAuthStore } from '@/store/authStore';

export default function PrivateRoute({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token);
  return token ? <>{children}</> : <Navigate to="/login" replace />;
}