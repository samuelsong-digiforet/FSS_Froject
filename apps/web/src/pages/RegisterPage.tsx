import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { authApi } from '@/api/auth';
import { useAuthStore } from '@/store/authStore';

export default function RegisterPage() {
  const navigate = useNavigate();
  const { setToken, setUser } = useAuthStore();

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const { data } = await authApi.register(email, password, fullName);
      setToken(data.accessToken);

      const { data: me } = await authApi.me();
      setUser(me);

      navigate('/dashboard');
    } catch (err: any) {
      setError(err.response?.data?.message ?? '회원가입에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-md">

        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-sky-400">FSS</h1>
          <p className="text-gray-400 mt-1 text-sm">Factory Studio Suite</p>
        </div>

        <div className="bg-gray-900 rounded-2xl p-8 border border-gray-800">
          <h2 className="text-white text-xl font-semibold mb-6">회원가입</h2>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-gray-400 text-sm mb-1 block">이름</label>
              <input
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="홍길동"
                required
                className="w-full bg-gray-800 text-white rounded-lg px-4 py-3
                           border border-gray-700 focus:border-sky-500
                           focus:outline-none focus:ring-1 focus:ring-sky-500
                           placeholder-gray-600 text-sm"
              />
            </div>

            <div>
              <label className="text-gray-400 text-sm mb-1 block">이메일</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="email@example.com"
                required
                className="w-full bg-gray-800 text-white rounded-lg px-4 py-3
                           border border-gray-700 focus:border-sky-500
                           focus:outline-none focus:ring-1 focus:ring-sky-500
                           placeholder-gray-600 text-sm"
              />
            </div>

            <div>
              <label className="text-gray-400 text-sm mb-1 block">비밀번호</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="8자 이상"
                required
                minLength={8}
                className="w-full bg-gray-800 text-white rounded-lg px-4 py-3
                           border border-gray-700 focus:border-sky-500
                           focus:outline-none focus:ring-1 focus:ring-sky-500
                           placeholder-gray-600 text-sm"
              />
            </div>

            {error && (
              <p className="text-red-400 text-sm bg-red-400/10 px-3 py-2 rounded-lg">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-sky-500 hover:bg-sky-400 disabled:bg-sky-500/50
                         text-white font-semibold py-3 rounded-lg transition-colors
                         text-sm mt-2"
            >
              {loading ? '처리 중...' : '회원가입'}
            </button>
          </form>

          <p className="text-gray-500 text-sm text-center mt-6">
            이미 계정이 있으신가요?{' '}
            <Link to="/login" className="text-sky-400 hover:text-sky-300">
              로그인
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}