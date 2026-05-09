import { useState, useEffect, useCallback, useRef } from 'react';
import { assetsApi } from '@/api/assets';

interface Props {
  assetId: string;
}

// 전체 경로 배열에서 10% 균등 샘플링
function samplePaths(paths: string[], ratio = 0.1): string[] {
  if (paths.length === 0) return [];
  const count = Math.max(1, Math.round(paths.length * ratio));
  if (count >= paths.length) return paths;
  return Array.from({ length: count }, (_, i) =>
    paths[Math.round((i * (paths.length - 1)) / (count - 1 || 1))],
  );
}

// JWT 인증 헤더를 포함하여 이미지를 fetch하고 blob URL을 반환
async function fetchFrameBlob(url: string): Promise<string> {
  const token = localStorage.getItem('token');
  const headers: HeadersInit = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export default function NerfFrameCarousel({ assetId }: Props) {
  const [frames, setFrames] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [imgLoading, setImgLoading] = useState(false);
  const blobUrlsRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    setLoading(true);
    setError(null);
    assetsApi
      .getNerfFrames(assetId)
      .then(({ data }) => {
        setFrames(samplePaths(data.paths));
        setIndex(0);
      })
      .catch(() => setError('프레임 목록을 불러올 수 없습니다.'))
      .finally(() => setLoading(false));

    // 컴포넌트 언마운트 시 blob URL 해제
    const blobMap = blobUrlsRef.current;
    return () => {
      blobMap.forEach((url) => URL.revokeObjectURL(url));
      blobMap.clear();
    };
  }, [assetId]);

  // index 또는 frames 변경 시 해당 프레임의 blob URL 로드
  useEffect(() => {
    if (frames.length === 0) return;
    const framePath = frames[index];
    const cached = blobUrlsRef.current.get(framePath);
    if (cached) {
      setBlobUrl(cached);
      return;
    }
    setImgLoading(true);
    setBlobUrl(null);
    const frameUrl = assetsApi.getNerfFrameUrl(assetId, framePath);
    fetchFrameBlob(frameUrl)
      .then((url) => {
        blobUrlsRef.current.set(framePath, url);
        setBlobUrl(url);
      })
      .catch(() => setBlobUrl(null))
      .finally(() => setImgLoading(false));
  }, [assetId, frames, index]);

  const prev = useCallback(
    () => setIndex((i) => (i - 1 + frames.length) % frames.length),
    [frames.length],
  );
  const next = useCallback(
    () => setIndex((i) => (i + 1) % frames.length),
    [frames.length],
  );

  if (loading) {
    return (
      <div className="h-[320px] flex items-center justify-center bg-gray-50 text-sm text-gray-400">
        NeRF 프레임을 불러오는 중...
      </div>
    );
  }

  if (error || frames.length === 0) {
    return (
      <div className="h-[320px] flex items-center justify-center bg-gray-50 text-sm text-gray-400">
        {error ?? '렌더링된 프레임이 없습니다.'}
      </div>
    );
  }

  return (
    <div className="relative h-[320px] bg-black select-none">
      {imgLoading && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-400 bg-black">
          프레임 로딩 중...
        </div>
      )}
      {blobUrl && (
        <img
          key={blobUrl}
          src={blobUrl}
          alt={`NeRF 프레임 ${index + 1}/${frames.length}`}
          className="w-full h-full object-contain"
        />
      )}
      {!imgLoading && !blobUrl && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-400">
          프레임을 불러올 수 없습니다.
        </div>
      )}

      {/* 이전 버튼 */}
      <button
        onClick={prev}
        className="absolute left-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-black/50 hover:bg-black/75 text-white flex items-center justify-center transition-colors"
        aria-label="이전 프레임"
      >
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
        </svg>
      </button>

      {/* 다음 버튼 */}
      <button
        onClick={next}
        className="absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-black/50 hover:bg-black/75 text-white flex items-center justify-center transition-colors"
        aria-label="다음 프레임"
      >
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
          <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
        </svg>
      </button>

      {/* 인덱스 표시 */}
      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 px-2.5 py-1 rounded-full bg-black/50 text-white text-xs">
        {index + 1} / {frames.length}
      </div>
    </div>
  );
}
