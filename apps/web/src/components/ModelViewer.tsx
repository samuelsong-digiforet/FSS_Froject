import { Component, type ReactNode, Suspense, useEffect, useMemo, useRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, Stage, useGLTF } from '@react-three/drei';
import { DropInViewer } from '@mkkellogg/gaussian-splats-3d';
import * as THREE from 'three';

import type { AssetType } from '@/api/assets';

type PlyParseResult = {
  positions: Float32Array;
  colors?: Float32Array;
};

type PlyProperty = {
  name: string;
  isUchar: boolean;
};

const SH_C0 = 0.28209479177387814;
const MAX_PLY_POINTS = 2_000_000;

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

function MeshModel({ url }: { url: string }) {
  const { scene: sourceScene } = useGLTF(url);
  const scene = useMemo(() => sourceScene.clone(true), [sourceScene]);
  return <primitive object={scene} />;
}

function findPlyHeaderByteLength(buffer: ArrayBuffer): number {
  const raw = new Uint8Array(buffer);
  const marker = new TextEncoder().encode('end_header');

  outer: for (let i = 0; i <= raw.length - marker.length; i++) {
    for (let j = 0; j < marker.length; j++) {
      if (raw[i + j] !== marker[j]) continue outer;
    }

    let offset = i + marker.length;
    if (raw[offset] === 0x0d) offset++;
    if (raw[offset] === 0x0a) offset++;
    return offset;
  }

  return -1;
}

function parsePly(buffer: ArrayBuffer): PlyParseResult | null {
  try {
    const headerText = new TextDecoder().decode(buffer.slice(0, 8192));
    const headerEnd = headerText.indexOf('end_header');
    if (headerEnd === -1) return null;

    const header = headerText.slice(0, headerEnd);
    const lines = header.split('\n');

    let vertexCount = 0;
    let isBinary = false;
    const props: PlyProperty[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('element vertex')) vertexCount = parseInt(trimmed.split(' ')[2], 10);
      if (trimmed === 'format binary_little_endian 1.0') isBinary = true;
      if (trimmed.startsWith('property float') || trimmed.startsWith('property uchar')) {
        props.push({
          name: trimmed.split(' ').pop() ?? '',
          isUchar: trimmed.includes('uchar'),
        });
      }
    }

    if (vertexCount === 0) return null;

    const propIndex = (names: string[]) => props.findIndex((prop) => names.includes(prop.name));
    const xi = propIndex(['x']);
    const yi = propIndex(['y']);
    const zi = propIndex(['z']);
    if (xi < 0 || yi < 0 || zi < 0) return null;

    const ri = propIndex(['red', 'r', 'diffuse_red']);
    const gi = propIndex(['green', 'g', 'diffuse_green']);
    const bi = propIndex(['blue', 'b', 'diffuse_blue']);
    const hasRgb = ri >= 0 && gi >= 0 && bi >= 0;

    const dc0i = propIndex(['f_dc_0']);
    const dc1i = propIndex(['f_dc_1']);
    const dc2i = propIndex(['f_dc_2']);
    const hasGaussianColor = dc0i >= 0 && dc1i >= 0 && dc2i >= 0;

    const hasColor = hasRgb || hasGaussianColor;
    const sampleEvery = vertexCount > MAX_PLY_POINTS ? Math.ceil(vertexCount / MAX_PLY_POINTS) : 1;
    const displayCount = Math.ceil(vertexCount / sampleEvery);

    const positions = new Float32Array(displayCount * 3);
    const colors = hasColor ? new Float32Array(displayCount * 3) : undefined;

    if (isBinary) {
      const offsets: number[] = [];
      let rowSize = 0;

      for (const prop of props) {
        offsets.push(rowSize);
        rowSize += prop.isUchar ? 1 : 4;
      }

      const headerByteLength = findPlyHeaderByteLength(buffer);
      if (headerByteLength < 0) return null;

      const dataView = new DataView(buffer, headerByteLength);
      let out = 0;

      for (let i = 0; i < vertexCount; i++) {
        if (i % sampleEvery !== 0) continue;

        const base = i * rowSize;
        positions[out * 3] = dataView.getFloat32(base + offsets[xi], true);
        positions[out * 3 + 1] = dataView.getFloat32(base + offsets[yi], true);
        positions[out * 3 + 2] = dataView.getFloat32(base + offsets[zi], true);

        if (colors) {
          if (hasRgb) {
            colors[out * 3] = dataView.getUint8(base + offsets[ri]) / 255;
            colors[out * 3 + 1] = dataView.getUint8(base + offsets[gi]) / 255;
            colors[out * 3 + 2] = dataView.getUint8(base + offsets[bi]) / 255;
          } else if (hasGaussianColor) {
            colors[out * 3] = sigmoid(SH_C0 * dataView.getFloat32(base + offsets[dc0i], true) + 0.5);
            colors[out * 3 + 1] = sigmoid(SH_C0 * dataView.getFloat32(base + offsets[dc1i], true) + 0.5);
            colors[out * 3 + 2] = sigmoid(SH_C0 * dataView.getFloat32(base + offsets[dc2i], true) + 0.5);
          }
        }

        out++;
      }
    } else {
      const dataText = new TextDecoder().decode(buffer).slice(headerEnd + 'end_header'.length).trim();
      const dataLines = dataText.split(/\r?\n/);
      let out = 0;

      for (let i = 0; i < Math.min(vertexCount, dataLines.length); i++) {
        if (i % sampleEvery !== 0) continue;

        const values = dataLines[i].trim().split(/\s+/).map(Number);
        positions[out * 3] = values[xi];
        positions[out * 3 + 1] = values[yi];
        positions[out * 3 + 2] = values[zi];

        if (colors) {
          if (hasRgb) {
            colors[out * 3] = values[ri] / 255;
            colors[out * 3 + 1] = values[gi] / 255;
            colors[out * 3 + 2] = values[bi] / 255;
          } else if (hasGaussianColor) {
            colors[out * 3] = sigmoid(SH_C0 * values[dc0i] + 0.5);
            colors[out * 3 + 1] = sigmoid(SH_C0 * values[dc1i] + 0.5);
            colors[out * 3 + 2] = sigmoid(SH_C0 * values[dc2i] + 0.5);
          }
        }

        out++;
      }
    }

    return { positions, colors };
  } catch (error) {
    console.error('[PLY Parser]', error);
    return null;
  }
}

function computeSceneFrame(
  positions: Float32Array,
  centerOverride?: [number, number, number],
): { center: THREE.Vector3; radius: number } {
  const center = centerOverride
    ? new THREE.Vector3(...centerOverride)
    : (() => {
        const box = new THREE.Box3();
        const point = new THREE.Vector3();

        for (let i = 0; i < positions.length; i += 3) {
          point.set(positions[i], positions[i + 1], positions[i + 2]);
          box.expandByPoint(point);
        }

        if (box.isEmpty()) return new THREE.Vector3();
        return box.getCenter(new THREE.Vector3());
      })();

  let radiusSq = 1;
  for (let i = 0; i < positions.length; i += 3) {
    const dx = positions[i] - center.x;
    const dy = positions[i + 1] - center.y;
    const dz = positions[i + 2] - center.z;
    radiusSq = Math.max(radiusSq, dx * dx + dy * dy + dz * dz);
  }

  return { center, radius: Math.sqrt(radiusSq) };
}

function framePerspectiveCamera(camera: THREE.Camera, radius: number) {
  if (!(camera instanceof THREE.PerspectiveCamera)) return;

  const safeRadius = Math.max(radius, 1);
  const fovRad = (camera.fov * Math.PI) / 180;
  const dist = (safeRadius / Math.sin(fovRad / 2)) * 1.2;

  camera.position.set(0, 0, dist);
  camera.near = dist * 0.001;
  camera.far = dist * 10;
  camera.updateProjectionMatrix();
}

function PointCloudModel({
  url,
  centerOverride,
  onCenterReady,
}: {
  url: string;
  centerOverride?: [number, number, number];
  onCenterReady?: (center: [number, number, number]) => void;
}) {
  const pointsRef = useRef<THREE.Points>(null);
  const hasFramedRef = useRef(false);
  const { camera } = useThree();

  // URL이 바뀔 때만 카메라 프레이밍 초기화 (centerOverride 변경으로 리셋되지 않도록)
  useEffect(() => {
    hasFramedRef.current = false;
  }, [url]);

  useEffect(() => {
    let cancelled = false;

    fetch(url)
      .then((response) => response.arrayBuffer())
      .then((buffer) => {
        if (cancelled) return;

        const points = parsePly(buffer);
        if (!points || !pointsRef.current) return;

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(points.positions, 3));
        if (points.colors) {
          const colorAttr = new THREE.Float32BufferAttribute(points.colors, 3);
          (colorAttr as unknown as { colorSpace: string }).colorSpace = THREE.SRGBColorSpace;
          geometry.setAttribute('color', colorAttr);
        }

        const { center, radius } = computeSceneFrame(points.positions, centerOverride);
        geometry.translate(-center.x, -center.y, -center.z);
        onCenterReady?.([center.x, center.y, center.z]);

        // 카메라는 최초 1회(URL 기준)만 프레이밍 — 폴링으로 centerOverride가
        // 새 배열 참조로 바뀌어도 카메라 위치가 리셋되지 않음
        if (!hasFramedRef.current) {
          framePerspectiveCamera(camera, radius);
          hasFramedRef.current = true;
        }

        pointsRef.current.geometry.dispose();
        pointsRef.current.geometry = geometry;
      })
      .catch((error) => console.error('[PointCloudModel] PLY load error:', error));

    return () => {
      cancelled = true;
    };
  }, [camera, centerOverride, onCenterReady, url]);

  return (
    <points ref={pointsRef}>
      <bufferGeometry />
      <pointsMaterial size={0.005} vertexColors={true} sizeAttenuation={true} toneMapped={false} />
    </points>
  );
}

type GaussianDropInViewer = THREE.Group & {
  addSplatScene: (
    path: string,
    options?: {
      progressiveLoad?: boolean;
      showLoadingUI?: boolean;
      splatAlphaRemovalThreshold?: number;
    },
  ) => Promise<unknown>;
  dispose: () => Promise<void>;
};

function GaussianSplatModel({
  url,
  centerOverride,
  onCenterReady,
}: {
  url: string;
  centerOverride?: [number, number, number];
  onCenterReady?: (center: [number, number, number]) => void;
}) {
  const { camera } = useThree();
  const hasFramedRef = useRef(false);
  const viewer = useMemo(
    () =>
      new DropInViewer({
        gpuAcceleratedSort: false,
        sharedMemoryForWorkers: false,
      }) as GaussianDropInViewer,
    [url],
  );

  // URL이 바뀔 때만 카메라 프레이밍 초기화
  useEffect(() => {
    hasFramedRef.current = false;
  }, [url]);

  useEffect(() => {
    let cancelled = false;

    const loadBounds = async () => {
      try {
        const response = await fetch(url);
        const buffer = await response.arrayBuffer();
        if (cancelled) return;

        const parsed = parsePly(buffer);
        if (!parsed) return;

        const { center, radius } = computeSceneFrame(parsed.positions, centerOverride);
        viewer.position.set(-center.x, -center.y, -center.z);
        onCenterReady?.([center.x, center.y, center.z]);
        if (!hasFramedRef.current) {
          framePerspectiveCamera(camera, radius);
          hasFramedRef.current = true;
        }
      } catch (error) {
        console.error('[GaussianSplatModel] Failed to compute bounds:', error);
      }
    };

    void Promise.all([
      viewer.addSplatScene(url, {
        progressiveLoad: false,
        showLoadingUI: false,
        splatAlphaRemovalThreshold: 5,
      }),
      loadBounds(),
    ]).catch((error) => {
      if (!cancelled) {
        console.error('[GaussianSplatModel] Splat load error:', error);
      }
    });

    return () => {
      cancelled = true;
      void viewer.dispose().catch((error) => {
        console.error('[GaussianSplatModel] dispose error:', error);
      });
    };
  }, [camera, centerOverride, onCenterReady, url, viewer]);

  return <primitive object={viewer} />;
}

class ModelErrorBoundary extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false };

  static getDerivedStateFromError() {
    return { error: true };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="w-full h-full flex flex-col items-center justify-center text-gray-400 gap-2">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-10 h-10">
            <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <span className="text-xs">미리보기를 불러올 수 없습니다.</span>
        </div>
      );
    }

    return this.props.children;
  }
}

export interface ObbBox {
  center: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

function ObbBoxHelper({ obb }: { obb: ObbBox }) {
  const rx = (obb.rotation[0] * Math.PI) / 180;
  const ry = (obb.rotation[1] * Math.PI) / 180;
  const rz = (obb.rotation[2] * Math.PI) / 180;

  return (
    <mesh position={obb.center} rotation={[rx, ry, rz]}>
      <boxGeometry args={obb.scale} />
      <meshBasicMaterial color="#f97316" wireframe />
    </mesh>
  );
}

export default function ModelViewer({
  url,
  autoRotate = true,
  fileType = 'model',
  assetType,
  obbBox,
  onPointCloudCenter,
  backgroundColor,
  sceneCenter,
}: {
  url: string;
  autoRotate?: boolean;
  fileType?: 'model' | 'pointcloud' | string;
  assetType?: AssetType | string;
  obbBox?: ObbBox;
  onPointCloudCenter?: (center: [number, number, number]) => void;
  backgroundColor?: string;
  sceneCenter?: [number, number, number];
}) {
  const isGaussian = assetType === 'gaussian';
  const isPointCloud = !isGaussian && (
    fileType === 'pointcloud' ||
    url.match(/\.(ply|pcd|las|xyz)(\?|$)/i) !== null
  );

  return (
    <ModelErrorBoundary>
      <Canvas camera={{ position: [0, 0, 3], fov: 45 }} style={backgroundColor ? { background: backgroundColor } : undefined}>
        <ambientLight intensity={1} />
        <Suspense fallback={null}>
          {isGaussian ? (
            <>
              <GaussianSplatModel url={url} centerOverride={sceneCenter} onCenterReady={onPointCloudCenter} />
              <OrbitControls autoRotate={autoRotate} autoRotateSpeed={1} enableZoom />
            </>
          ) : isPointCloud ? (
            <>
              <PointCloudModel url={url} centerOverride={sceneCenter} onCenterReady={onPointCloudCenter} />
              <OrbitControls autoRotate={autoRotate} autoRotateSpeed={1} enableZoom />
            </>
          ) : (
            <>
              <Stage environment="city" intensity={0.5}>
                <MeshModel url={url} />
              </Stage>
              <OrbitControls autoRotate={autoRotate} autoRotateSpeed={2} enableZoom />
            </>
          )}
          {obbBox && <ObbBoxHelper obb={obbBox} />}
        </Suspense>
      </Canvas>
    </ModelErrorBoundary>
  );
}
