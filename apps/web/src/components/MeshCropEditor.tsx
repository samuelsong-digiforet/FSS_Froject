/**
 * MeshCropEditor — 풀스크린 3D 크롭 박스 에디터
 *
 * 크롭 흐름:
 *   [크롭] → 뷰포트 미리보기 (서버 저장 없음)
 *   [저장] → 서버 업로드 (크롭 후에만 활성)
 *   [크롭 취소] → 저장 전이면 원본 복원 가능
 */
import {
  useRef,
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  Suspense,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { TransformControls, OrbitControls, useGLTF, Html, Environment } from '@react-three/drei';
import { DropInViewer, RenderMode, SceneFormat } from '@mkkellogg/gaussian-splats-3d';
import * as THREE from 'three';

import type { AssetObbVersion, AssetType } from '@/api/assets';

export interface ObbParams {
  center: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

export interface CropConfirmParams extends ObbParams {
  previewCenter: [number, number, number];
  previewBounds: [number, number, number];
}

interface PlyData {
  positions: Float32Array;
  colors?: Float32Array;
  headerLines?: string[];
  rowSize?: number;
  binaryRows?: Uint8Array;
  vertexCount?: number;
}

interface StrokePoint {
  x: number;
  y: number;
}

interface ScreenBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface PointCutSelection {
  kind: 'points';
  keepMask: Uint8Array;
  selectedCount: number;
  highlightGeometry: THREE.BufferGeometry;
}

interface MeshCutPatch {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry | null;
  remainingFaceCount: number;
}

interface MeshCutSelection {
  kind: 'mesh';
  removedFaceCount: number;
  highlightGroup: THREE.Group;
  patches: MeshCutPatch[];
}

type CutSelection = PointCutSelection | MeshCutSelection;

// ── PLY 파서 (바이너리 헤더를 바이트 단위로 탐색) ──────────────
const SH_C0 = 0.28209479177387814;
const CUT_BRUSH_RADIUS_PX = 18;
const sig = (x: number) => 1 / (1 + Math.exp(-x));

function sameTriplet(a: [number, number, number], b: [number, number, number], epsilon = 1e-4): boolean {
  return a.every((value, index) => Math.abs(value - b[index]) <= epsilon);
}

function sameObb(a: ObbParams, b: ObbParams, epsilon = 1e-4): boolean {
  return (
    sameTriplet(a.center, b.center, epsilon) &&
    sameTriplet(a.rotation, b.rotation, epsilon) &&
    sameTriplet(a.scale, b.scale, epsilon)
  );
}

function formatVersionDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('ko-KR', { hour12: false });
}

function parsePlyBinary(buffer: ArrayBuffer): PlyData | null {
  try {
    const txt = new TextDecoder().decode(buffer.slice(0, 8192));
    const hEnd = txt.indexOf('end_header');
    if (hEnd === -1) return null;

    const lines = txt.slice(0, hEnd).split('\n');
    let vertexCount = 0;
    const props: { name: string; uchar: boolean }[] = [];
    for (const l of lines) {
      const t = l.trim();
      if (t.startsWith('element vertex')) vertexCount = parseInt(t.split(' ')[2]);
      if (t.startsWith('property float') || t.startsWith('property uchar'))
        props.push({ name: t.split(' ').pop()!, uchar: t.includes('uchar') });
    }
    if (vertexCount === 0) return null;

    const idx = (ns: string[]) => props.findIndex((p) => ns.includes(p.name));
    const xi = idx(['x']),
      yi = idx(['y']),
      zi = idx(['z']);
    if (xi < 0 || yi < 0 || zi < 0) return null;
    const ri = idx(['red', 'r']),
      gi = idx(['green', 'g']),
      bi = idx(['blue', 'b']);
    const d0i = idx(['f_dc_0']),
      d1i = idx(['f_dc_1']),
      d2i = idx(['f_dc_2']);
    const hasRgb = ri >= 0 && gi >= 0 && bi >= 0;
    const hasGS = d0i >= 0 && d1i >= 0 && d2i >= 0;

    const offsets: number[] = [];
    let rowSize = 0;
    for (const p of props) {
      offsets.push(rowSize);
      rowSize += p.uchar ? 1 : 4;
    }

    // 헤더 끝 바이트 위치를 바이너리로 직접 탐색 (\r\n 대응)
    const raw8 = new Uint8Array(buffer);
    const marker = new TextEncoder().encode('end_header');
    let hdrBytes = 0;
    outer: for (let i = 0; i < raw8.length - marker.length; i++) {
      for (let j = 0; j < marker.length; j++) if (raw8[i + j] !== marker[j]) continue outer;
      let k = i + marker.length;
      if (raw8[k] === 0x0d) k++;
      if (raw8[k] === 0x0a) k++;
      hdrBytes = k;
      break;
    }
    if (hdrBytes === 0) return null;

    const dv = new DataView(buffer, hdrBytes);
    const binaryRows = new Uint8Array(buffer, hdrBytes, vertexCount * rowSize);
    const pos = new Float32Array(vertexCount * 3);
    const col = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount; i++) {
      const b = i * rowSize;
      pos[i * 3] = dv.getFloat32(b + offsets[xi], true);
      pos[i * 3 + 1] = dv.getFloat32(b + offsets[yi], true);
      pos[i * 3 + 2] = dv.getFloat32(b + offsets[zi], true);
      if (hasRgb) {
        col[i * 3] = dv.getUint8(b + offsets[ri]) / 255;
        col[i * 3 + 1] = dv.getUint8(b + offsets[gi]) / 255;
        col[i * 3 + 2] = dv.getUint8(b + offsets[bi]) / 255;
      } else if (hasGS) {
        col[i * 3] = sig(SH_C0 * dv.getFloat32(b + offsets[d0i], true) + 0.5);
        col[i * 3 + 1] = sig(SH_C0 * dv.getFloat32(b + offsets[d1i], true) + 0.5);
        col[i * 3 + 2] = sig(SH_C0 * dv.getFloat32(b + offsets[d2i], true) + 0.5);
      }
    }
    return {
      positions: pos,
      colors: hasRgb || hasGS ? col : undefined,
      headerLines: lines,
      rowSize,
      binaryRows,
      vertexCount,
    };
  } catch {
    return null;
  }
}

// ── PLY 직렬화 ───────────────────────────────────────────────────
function writePlyBinary(positions: Float32Array, colors: Float32Array | undefined): Blob {
  const N = positions.length / 3;
  const hasC = !!colors;
  const header = [
    'ply',
    'format binary_little_endian 1.0',
    `element vertex ${N}`,
    'property float x',
    'property float y',
    'property float z',
    ...(hasC ? ['property uchar red', 'property uchar green', 'property uchar blue'] : []),
    'end_header',
    '',
  ].join('\n');
  const hdr = new TextEncoder().encode(header);
  const rowSize = hasC ? 15 : 12;
  const data = new Uint8Array(N * rowSize);
  const dv = new DataView(data.buffer);
  for (let i = 0; i < N; i++) {
    dv.setFloat32(i * rowSize, positions[i * 3], true);
    dv.setFloat32(i * rowSize + 4, positions[i * 3 + 1], true);
    dv.setFloat32(i * rowSize + 8, positions[i * 3 + 2], true);
    if (hasC && colors) {
      data[i * rowSize + 12] = Math.round(colors[i * 3] * 255);
      data[i * rowSize + 13] = Math.round(colors[i * 3 + 1] * 255);
      data[i * rowSize + 14] = Math.round(colors[i * 3 + 2] * 255);
    }
  }
  return new Blob([hdr, data], { type: 'application/octet-stream' });
}

function writeFilteredPlyBinary(data: PlyData, keepMask: Uint8Array): Blob | null {
  if (!data.headerLines || !data.rowSize || !data.binaryRows || !data.vertexCount) return null;

  let keepCount = 0;
  for (let i = 0; i < keepMask.length; i++) {
    if (keepMask[i]) keepCount++;
  }
  if (keepCount <= 0) return null;

  const headerLines = data.headerLines.map((line) =>
    line.trim().startsWith('element vertex') ? `element vertex ${keepCount}` : line.trim(),
  );
  const header = `${headerLines.join('\n')}\nend_header\n`;
  const rows = new Uint8Array(keepCount * data.rowSize);

  let out = 0;
  for (let i = 0; i < keepMask.length; i++) {
    if (!keepMask[i]) continue;
    const srcStart = i * data.rowSize;
    rows.set(data.binaryRows.subarray(srcStart, srcStart + data.rowSize), out * data.rowSize);
    out++;
  }

  return new Blob([new TextEncoder().encode(header), rows], { type: 'application/octet-stream' });
}

function distanceToSegmentSquared(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const abLenSq = abx * abx + aby * aby;
  const t = abLenSq <= 1e-6 ? 0 : THREE.MathUtils.clamp((apx * abx + apy * aby) / abLenSq, 0, 1);
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy;
}

function buildScreenBounds(points: StrokePoint[], pad = 0): ScreenBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }

  return {
    minX: minX - pad,
    minY: minY - pad,
    maxX: maxX + pad,
    maxY: maxY + pad,
  };
}

function boundsOverlap(a: ScreenBounds, b: ScreenBounds): boolean {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

function cross2D(a: StrokePoint, b: StrokePoint, c: StrokePoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointInTriangle2D(point: StrokePoint, a: StrokePoint, b: StrokePoint, c: StrokePoint): boolean {
  const d1 = cross2D(point, a, b);
  const d2 = cross2D(point, b, c);
  const d3 = cross2D(point, c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function segmentsIntersect2D(a: StrokePoint, b: StrokePoint, c: StrokePoint, d: StrokePoint): boolean {
  const ab1 = cross2D(a, b, c);
  const ab2 = cross2D(a, b, d);
  const cd1 = cross2D(c, d, a);
  const cd2 = cross2D(c, d, b);

  if (ab1 === 0 && ab2 === 0 && cd1 === 0 && cd2 === 0) {
    const overlapX =
      Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <= Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x));
    const overlapY =
      Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) <= Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y));
    return overlapX && overlapY;
  }

  return (
    (ab1 === 0 || ab2 === 0 || Math.sign(ab1) !== Math.sign(ab2)) &&
    (cd1 === 0 || cd2 === 0 || Math.sign(cd1) !== Math.sign(cd2))
  );
}

function segmentDistanceSquared2D(a: StrokePoint, b: StrokePoint, c: StrokePoint, d: StrokePoint): number {
  if (segmentsIntersect2D(a, b, c, d)) return 0;
  return Math.min(
    distanceToSegmentSquared(a.x, a.y, c.x, c.y, d.x, d.y),
    distanceToSegmentSquared(b.x, b.y, c.x, c.y, d.x, d.y),
    distanceToSegmentSquared(c.x, c.y, a.x, a.y, b.x, b.y),
    distanceToSegmentSquared(d.x, d.y, a.x, a.y, b.x, b.y),
  );
}

export function triangleIntersectsStroke(
  triangle: [StrokePoint, StrokePoint, StrokePoint],
  stroke: StrokePoint[],
  brushRadiusPx: number,
  strokeBounds: ScreenBounds,
): boolean {
  const triangleBounds = buildScreenBounds(triangle, brushRadiusPx);
  if (!boundsOverlap(triangleBounds, strokeBounds)) return false;

  for (const point of stroke) {
    if (pointInTriangle2D(point, triangle[0], triangle[1], triangle[2])) return true;
  }

  const radiusSq = brushRadiusPx * brushRadiusPx;
  const edges: Array<[StrokePoint, StrokePoint]> = [
    [triangle[0], triangle[1]],
    [triangle[1], triangle[2]],
    [triangle[2], triangle[0]],
  ];

  for (let i = 1; i < stroke.length; i += 1) {
    const segment: [StrokePoint, StrokePoint] = [stroke[i - 1], stroke[i]];
    const segmentBounds = buildScreenBounds(segment, brushRadiusPx);
    if (!boundsOverlap(segmentBounds, triangleBounds)) continue;

    for (const edge of edges) {
      if (segmentDistanceSquared2D(edge[0], edge[1], segment[0], segment[1]) <= radiusSq) {
        return true;
      }
    }
  }

  return false;
}

function buildPointHighlightGeometry(positions: number[], colors?: number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (colors && colors.length > 0) {
    const colorAttr = new THREE.Float32BufferAttribute(colors, 3);
    (colorAttr as unknown as { colorSpace: string }).colorSpace = THREE.SRGBColorSpace;
    geometry.setAttribute('color', colorAttr);
  }
  geometry.computeBoundingSphere();
  return geometry;
}

function buildPointCutSelection(
  data: PlyData,
  camera: THREE.Camera,
  stroke: StrokePoint[],
  width: number,
  height: number,
): PointCutSelection | null {
  if (stroke.length < 2) return null;

  // 드래그 시작점과 끝점으로 사각형 선택 범위 계산
  const start = stroke[0];
  const end = stroke[stroke.length - 1];
  const minX = Math.min(start.x, end.x);
  const maxX = Math.max(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const maxY = Math.max(start.y, end.y);
  if (maxX - minX < 2 && maxY - minY < 2) return null;

  const positions = data.positions;
  const colors = data.colors;
  const count = positions.length / 3;
  const keepMask = new Uint8Array(count);
  keepMask.fill(1);

  const highlightPositions: number[] = [];
  const highlightColors = colors ? ([] as number[]) : undefined;

  const world = new THREE.Vector3();
  camera.updateMatrixWorld();
  if (camera instanceof THREE.PerspectiveCamera) camera.updateProjectionMatrix();

  let selectedCount = 0;
  for (let i = 0; i < count; i += 1) {
    world.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]).project(camera);
    if (world.z < -1 || world.z > 1) continue;

    const sx = (world.x * 0.5 + 0.5) * width;
    const sy = (-world.y * 0.5 + 0.5) * height;
    if (sx < minX || sx > maxX || sy < minY || sy > maxY) continue;

    keepMask[i] = 0;
    selectedCount += 1;
    highlightPositions.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    if (highlightColors && colors) {
      highlightColors.push(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]);
    }
  }

  if (selectedCount <= 0) return null;

  return {
    kind: 'points',
    keepMask,
    selectedCount,
    highlightGeometry: buildPointHighlightGeometry(highlightPositions, highlightColors),
  };
}

// ── 서브샘플 geometry 생성 헬퍼 ──────────────────────────────────
function buildStrokeKeepMask(
  data: PlyData,
  camera: THREE.Camera,
  stroke: StrokePoint[],
  width: number,
  height: number,
): Uint8Array | null {
  return buildPointCutSelection(data, camera, stroke, width, height)?.keepMask ?? null;
}

function buildGeo(centered: PlyData, maxPts = 1_000_000): THREE.BufferGeometry {
  const N = centered.positions.length / 3;
  const skip = N > maxPts ? Math.ceil(N / maxPts) : 1;
  const M = Math.ceil(N / skip);
  const rPos = new Float32Array(M * 3);
  const rCol = centered.colors ? new Float32Array(M * 3) : undefined;
  let out = 0;
  for (let i = 0; i < N; i++) {
    if (i % skip !== 0) continue;
    rPos[out * 3] = centered.positions[i * 3];
    rPos[out * 3 + 1] = centered.positions[i * 3 + 1];
    rPos[out * 3 + 2] = centered.positions[i * 3 + 2];
    if (rCol && centered.colors) {
      rCol[out * 3] = centered.colors[i * 3];
      rCol[out * 3 + 1] = centered.colors[i * 3 + 1];
      rCol[out * 3 + 2] = centered.colors[i * 3 + 2];
    }
    out++;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(rPos.slice(0, out * 3), 3));
  if (rCol) {
    const colorAttr = new THREE.Float32BufferAttribute(rCol.slice(0, out * 3), 3);
    (colorAttr as unknown as { colorSpace: string }).colorSpace = THREE.SRGBColorSpace;
    geo.setAttribute('color', colorAttr);
  }
  geo.computeBoundingSphere();
  return geo;
}

// ── PLY 포인트 클라우드 렌더 ─────────────────────────────────────
function FlyPointCloud({
  url,
  fullDataRef,
  pointsRef,
  onBoundsReady,
  onPreviewCenterReady,
  fitCameraRef,
}: {
  url: string;
  fullDataRef: MutableRefObject<PlyData | null>;
  pointsRef: MutableRefObject<THREE.Points | null>;
  onBoundsReady: (extX: number, extY: number, extZ: number) => void;
  onPreviewCenterReady: (center: [number, number, number]) => void;
  fitCameraRef: MutableRefObject<((geo: THREE.BufferGeometry) => void) | null>;
}) {
  const { camera } = useThree();
  const initialCamDone = useRef(false);

  // 크롭 후 카메라를 geometry에 맞추는 함수를 부모에 등록
  useEffect(() => {
    fitCameraRef.current = (geo: THREE.BufferGeometry) => {
      geo.computeBoundingSphere();
      const sphere = geo.boundingSphere;
      if (!sphere) return;
      const cam = camera as THREE.PerspectiveCamera;
      const dist = (sphere.radius / Math.sin((cam.fov * Math.PI) / 180 / 2)) * 1.2;
      camera.position.set(sphere.center.x, sphere.center.y, sphere.center.z + dist);
      camera.near = Math.max(dist * 0.001, 0.001);
      camera.far = dist * 10;
      cam.updateProjectionMatrix?.();
    };
    return () => {
      fitCameraRef.current = null;
    };
  }, [camera, fitCameraRef]);

  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        if (cancelled) return;

        const raw = parsePlyBinary(buf);
        if (!raw) {
          console.error('[MeshCropEditor] PLY 파싱 실패');
          return;
        }

        const { positions: rp, colors: rc } = raw;
        const N = rp.length / 3;

        // bbox 중심 계산 → 센터링
        let minX = Infinity,
          maxX = -Infinity,
          minY = Infinity,
          maxY = -Infinity,
          minZ = Infinity,
          maxZ = -Infinity;
        for (let i = 0; i < N; i++) {
          const x = rp[i * 3],
            y = rp[i * 3 + 1],
            z = rp[i * 3 + 2];
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
        }
        const cx = (minX + maxX) / 2,
          cy = (minY + maxY) / 2,
          cz = (minZ + maxZ) / 2;
        onPreviewCenterReady([cx, cy, cz]);

        const centeredPos = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
          centeredPos[i * 3] = rp[i * 3] - cx;
          centeredPos[i * 3 + 1] = rp[i * 3 + 1] - cy;
          centeredPos[i * 3 + 2] = rp[i * 3 + 2] - cz;
        }

        // 전체 센터링 포인트 저장 (크롭 필터용)
        fullDataRef.current = { ...raw, positions: centeredPos, colors: rc };

        // bbox 크기를 부모에 알려 박스 초기 스케일 자동 설정
        if (!cancelled) onBoundsReady(maxX - minX, maxY - minY, maxZ - minZ);

        // 렌더링 geometry 생성 후 Points 오브젝트에 직접 할당
        const geo = buildGeo({ positions: centeredPos, colors: rc });

        const radius = geo.boundingSphere?.radius ?? 1;
        const cam = camera as THREE.PerspectiveCamera;
        if (!initialCamDone.current) {
          const dist = (radius / Math.sin((cam.fov * Math.PI) / 180 / 2)) * 1.2;
          camera.position.set(0, 0, dist);
          camera.near = dist * 0.001;
          camera.far = dist * 10;
          cam.updateProjectionMatrix?.();
          initialCamDone.current = true;
        } else {
          // 컷 후 재로드 시 near/far만 갱신 (카메라 위치 유지)
          const dist = radius * 6;
          camera.near = Math.min(camera.near, dist * 0.001);
          camera.far = Math.max(camera.far, dist * 10);
          cam.updateProjectionMatrix?.();
        }

        if (!cancelled && pointsRef.current) {
          pointsRef.current.geometry.dispose();
          pointsRef.current.geometry = geo;
        }
      })
      .catch((e) => console.error('[MeshCropEditor] fetch 실패', e));
    return () => {
      cancelled = true;
    };
  }, [url, camera, fullDataRef, pointsRef, onBoundsReady, onPreviewCenterReady]); // initialCamDone은 ref이므로 의존성 불필요

  return (
    <points ref={pointsRef}>
      <bufferGeometry />
      <pointsMaterial size={0.005} vertexColors sizeAttenuation toneMapped={false} />
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

function GaussianSplatCloud({
  url,
  fullDataRef,
  pointsRef,
  onBoundsReady,
  onPreviewCenterReady,
  fitCameraRef,
  showSplat,
  showPoints,
  forceShowSplat,
}: {
  url: string;
  fullDataRef: MutableRefObject<PlyData | null>;
  pointsRef: MutableRefObject<THREE.Points | null>;
  onBoundsReady: (extX: number, extY: number, extZ: number) => void;
  onPreviewCenterReady: (center: [number, number, number]) => void;
  fitCameraRef: MutableRefObject<((geo: THREE.BufferGeometry) => void) | null>;
  showSplat: boolean;
  showPoints: boolean;
  forceShowSplat?: boolean;
}) {
  const { camera } = useThree();
  const hasFramedRef = useRef(false);
  const canUseSharedMemory = typeof window !== 'undefined' && window.crossOriginIsolated;
  const viewer = useMemo(
    () =>
      new DropInViewer({
        gpuAcceleratedSort: canUseSharedMemory,
        sharedMemoryForWorkers: canUseSharedMemory,
        useBuiltInControls: false,
        ignoreDevicePixelRatio: true,
        halfPrecisionCovariancesOnGPU: true,
        renderMode: RenderMode.OnChange,
        inMemoryCompressionLevel: 1,
        freeIntermediateSplatData: true,
        antialiased: false,
      }) as GaussianDropInViewer,
    [canUseSharedMemory, url],
  );

  useEffect(() => {
    // Drag-cut after editing swaps the scene to a local blob URL. Keep the current view
    // in that case, but allow a fresh frame when we load a non-blob scene again.
    if (!url.startsWith('blob:')) {
      hasFramedRef.current = false;
    }
  }, [url]);

  useEffect(() => {
    fitCameraRef.current = (geo: THREE.BufferGeometry) => {
      geo.computeBoundingSphere();
      const sphere = geo.boundingSphere;
      if (!sphere) return;
      const cam = camera as THREE.PerspectiveCamera;
      const dist = (sphere.radius / Math.sin((cam.fov * Math.PI) / 180 / 2)) * 1.2;
      camera.position.set(sphere.center.x, sphere.center.y, sphere.center.z + dist);
      camera.near = Math.max(dist * 0.001, 0.001);
      camera.far = dist * 10;
      cam.updateProjectionMatrix?.();
    };
    return () => {
      fitCameraRef.current = null;
    };
  }, [camera, fitCameraRef]);

  useEffect(() => {
    let cancelled = false;

    const loadBounds = async () => {
      const response = await fetch(url);
      const buffer = await response.arrayBuffer();
      if (cancelled) return;

      const raw = parsePlyBinary(buffer);
      if (!raw) throw new Error('Gaussian PLY 파싱 실패');

      const { positions: rp, colors: rc } = raw;
      const N = rp.length / 3;

      let minX = Infinity,
        maxX = -Infinity;
      let minY = Infinity,
        maxY = -Infinity;
      let minZ = Infinity,
        maxZ = -Infinity;
      for (let i = 0; i < N; i++) {
        const x = rp[i * 3];
        const y = rp[i * 3 + 1];
        const z = rp[i * 3 + 2];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }

      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const cz = (minZ + maxZ) / 2;
      onPreviewCenterReady([cx, cy, cz]);

      const centeredPos = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) {
        centeredPos[i * 3] = rp[i * 3] - cx;
        centeredPos[i * 3 + 1] = rp[i * 3 + 1] - cy;
        centeredPos[i * 3 + 2] = rp[i * 3 + 2] - cz;
      }

      fullDataRef.current = { ...raw, positions: centeredPos, colors: rc };
      if (!cancelled) onBoundsReady(maxX - minX, maxY - minY, maxZ - minZ);

      const geo = buildGeo({ positions: centeredPos, colors: rc });
      const radius = geo.boundingSphere?.radius ?? 1;
      const cam = camera as THREE.PerspectiveCamera;
      if (!hasFramedRef.current) {
        const dist = (radius / Math.sin((cam.fov * Math.PI) / 180 / 2)) * 1.2;
        camera.position.set(0, 0, dist);
        camera.near = dist * 0.001;
        camera.far = dist * 10;
        hasFramedRef.current = true;
      } else {
        const dist = radius * 6;
        camera.near = Math.min(camera.near, dist * 0.001);
        camera.far = Math.max(camera.far, dist * 10);
      }
      cam.updateProjectionMatrix?.();

      viewer.position.set(-cx, -cy, -cz);

      if (!cancelled && pointsRef.current) {
        pointsRef.current.geometry.dispose();
        pointsRef.current.geometry = geo;
      }
    };

    const splatPromise = viewer.addSplatScene(url, {
      progressiveLoad: false,
      showLoadingUI: false,
      splatAlphaRemovalThreshold: 5,
      ...(url.startsWith('blob:') && { format: SceneFormat.Ply }),
    });

    void Promise.all([splatPromise, loadBounds()]).catch((error) => {
      if (!cancelled) {
        console.error('[MeshCropEditor] gaussian load failed', error);
      }
    });

    return () => {
      cancelled = true;
      void viewer.dispose().catch((error) => {
        console.error('[MeshCropEditor] gaussian dispose failed', error);
      });
    };
  }, [camera, fitCameraRef, fullDataRef, onBoundsReady, onPreviewCenterReady, pointsRef, url, viewer]);

  return (
    <>
      <primitive object={viewer} visible={forceShowSplat || showSplat} />
      <points ref={pointsRef} visible={!forceShowSplat && showPoints}>
        <bufferGeometry />
        <pointsMaterial size={0.005} vertexColors sizeAttenuation toneMapped={false} />
      </points>
    </>
  );
}

// ── 크롭 박스 ────────────────────────────────────────────────────
/**
 * ScaleHandles — 코너(균등) / 면(단일 축) 스케일 핸들
 *
 * R3F 레이캐스트 대신 캔버스 레벨의 2D 거리 검사를 사용하므로
 * point cloud, GLB, Gaussian 등 모든 에셋 타입에서 동작합니다.
 */
function ScaleHandles({
  boxRef,
  onObbChange,
  onLiveObbChange,
  onDraggingChange,
  visible,
}: {
  boxRef: React.RefObject<THREE.Group>;
  onObbChange: (o: ObbParams) => void;
  onLiveObbChange: (o: ObbParams) => void;
  onDraggingChange: (v: boolean) => void;
  visible: boolean;
}) {
  const { camera, gl, size } = useThree();

  const CORNER_SIGNS = useMemo<[number, number, number][]>(() => {
    const s: [number, number, number][] = [];
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) s.push([x, y, z]);
    return s;
  }, []);

  const FACE_DEFS = useMemo(
    () => [
      { axis: 0, sign: 1, color: '#ff4444' },
      { axis: 0, sign: -1, color: '#ff4444' },
      { axis: 1, sign: 1, color: '#44cc44' },
      { axis: 1, sign: -1, color: '#44cc44' },
      { axis: 2, sign: 1, color: '#4488ff' },
      { axis: 2, sign: -1, color: '#4488ff' },
    ],
    [],
  );

  // 시각적 핸들 메시 refs (위치 갱신용)
  const cornerRefs = useRef<(THREE.Mesh | null)[]>(Array(8).fill(null));
  const faceRefs = useRef<(THREE.Mesh | null)[]>(Array(6).fill(null));

  // 2D 히트 테스트용 스크린 좌표 저장
  type HandleInfo = { sx: number; sy: number } & ({ kind: 'corner' } | { kind: 'face'; axis: number; sign: number });
  const screenHandles = useRef<HandleInfo[]>([]);

  const readObb = useCallback((): ObbParams => {
    const m = boxRef.current!;
    return {
      center: [+m.position.x.toFixed(3), +m.position.y.toFixed(3), +m.position.z.toFixed(3)],
      rotation: [
        +((m.rotation.x * 180) / Math.PI).toFixed(1),
        +((m.rotation.y * 180) / Math.PI).toFixed(1),
        +((m.rotation.z * 180) / Math.PI).toFixed(1),
      ],
      scale: [+m.scale.x.toFixed(3), +m.scale.y.toFixed(3), +m.scale.z.toFixed(3)],
    };
  }, [boxRef]);

  const worldToScreen = useCallback(
    (world: THREE.Vector3): [number, number] => {
      const ndc = world.clone().project(camera);
      return [(ndc.x * 0.5 + 0.5) * size.width, (1 - (ndc.y * 0.5 + 0.5)) * size.height];
    },
    [camera, size],
  );

  // 매 프레임 핸들 위치(3D + 2D 스크린) 갱신
  useFrame(() => {
    if (!boxRef.current) return;
    const box = boxRef.current;
    const quat = new THREE.Quaternion().setFromEuler(box.rotation);
    const infos: HandleInfo[] = [];

    CORNER_SIGNS.forEach(([sx, sy, sz], i) => {
      const local = new THREE.Vector3(sx * box.scale.x * 0.5, sy * box.scale.y * 0.5, sz * box.scale.z * 0.5);
      local.applyQuaternion(quat).add(box.position);
      const mesh = cornerRefs.current[i];
      if (mesh) mesh.position.copy(local);
      const [px, py] = worldToScreen(local);
      infos.push({ kind: 'corner', sx: px, sy: py });
    });

    FACE_DEFS.forEach(({ axis, sign }, i) => {
      const local = new THREE.Vector3(0, 0, 0);
      local.setComponent(axis, sign * box.scale.getComponent(axis) * 0.5);
      local.applyQuaternion(quat).add(box.position);
      const mesh = faceRefs.current[i];
      if (mesh) mesh.position.copy(local);
      const [px, py] = worldToScreen(local);
      infos.push({ kind: 'face', axis, sign, sx: px, sy: py });
    });

    screenHandles.current = infos;
  });

  // 캔버스 레벨 pointerdown — R3F 레이캐스트 우회
  useEffect(() => {
    const canvas = gl.domElement;
    const HIT_PX = 16; // 히트 허용 반경 (픽셀)

    const onDown = (e: PointerEvent) => {
      if (!visible || !boxRef.current) return;

      const rect = canvas.getBoundingClientRect();
      // CSS 픽셀 기준 (worldToScreen도 size.width/height = CSS 픽셀 사용)
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      // 가장 가까운 핸들 탐색
      let best: HandleInfo | null = null;
      let bestDist = HIT_PX;
      for (const h of screenHandles.current) {
        const d = Math.hypot(mx - h.sx, my - h.sy);
        if (d < bestDist) {
          bestDist = d;
          best = h;
        }
      }
      if (!best) return;

      e.stopPropagation();
      const box = boxRef.current;

      if (best.kind === 'corner') {
        // ── 코너: 균등 비율 스케일 ──────────────────────────────
        const [cx, cy] = worldToScreen(box.position.clone());
        const initDist = Math.max(1, Math.hypot(mx - cx, my - cy));
        const initScale = box.scale.clone();
        onDraggingChange(true);

        const onMove = (ev: PointerEvent) => {
          if (!boxRef.current) return;
          const mr = canvas.getBoundingClientRect();
          const emx = ev.clientX - mr.left;
          const emy = ev.clientY - mr.top;
          const ratio = Math.max(0.001, Math.hypot(emx - cx, emy - cy) / initDist);
          boxRef.current.scale.set(
            Math.max(0.001, initScale.x * ratio),
            Math.max(0.001, initScale.y * ratio),
            Math.max(0.001, initScale.z * ratio),
          );
          onLiveObbChange(readObb());
        };
        const onUp = () => {
          onDraggingChange(false);
          if (boxRef.current) onObbChange(readObb());
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      } else {
        // ── 면: 해당 축만 스케일 ────────────────────────────────
        const { axis, sign } = best;
        const quat = new THREE.Quaternion().setFromEuler(box.rotation);
        const localN = new THREE.Vector3(0, 0, 0);
        localN.setComponent(axis, sign);
        const worldN = localN.applyQuaternion(quat);

        const [sx0, sy0] = worldToScreen(box.position.clone());
        const [sx1, sy1] = worldToScreen(box.position.clone().add(worldN));
        const screenLen = Math.max(0.5, Math.hypot(sx1 - sx0, sy1 - sy0));
        const screenNx = (sx1 - sx0) / screenLen;
        const screenNy = (sy1 - sy0) / screenLen;

        const initScaleAxis = box.scale.getComponent(axis);
        const initMx = mx,
          initMy = my;
        onDraggingChange(true);

        const onMove = (ev: PointerEvent) => {
          if (!boxRef.current) return;
          const mr = canvas.getBoundingClientRect();
          const emx = ev.clientX - mr.left;
          const emy = ev.clientY - mr.top;
          const projPx = (emx - initMx) * screenNx + (emy - initMy) * screenNy;
          const newScale = Math.max(0.001, initScaleAxis + (projPx / screenLen) * 2);
          boxRef.current.scale.setComponent(axis, newScale);
          onLiveObbChange(readObb());
        };
        const onUp = () => {
          onDraggingChange(false);
          if (boxRef.current) onObbChange(readObb());
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      }
    };

    canvas.addEventListener('pointerdown', onDown);
    return () => canvas.removeEventListener('pointerdown', onDown);
  }, [boxRef, gl, visible, onDraggingChange, onLiveObbChange, onObbChange, readObb, worldToScreen]);

  const HS = 0.06;

  if (!visible) return null;

  return (
    <>
      {/* 시각적 핸들만 렌더링 (상호작용은 캔버스 레벨에서 처리) */}
      {CORNER_SIGNS.map((_, i) => (
        <mesh
          key={`c${i}`}
          ref={(m) => {
            cornerRefs.current[i] = m;
          }}
          renderOrder={10}
        >
          <sphereGeometry args={[HS, 8, 8]} />
          <meshBasicMaterial color="#ffffff" depthTest={false} />
        </mesh>
      ))}
      {FACE_DEFS.map(({ color }, i) => (
        <mesh
          key={`f${i}`}
          ref={(m) => {
            faceRefs.current[i] = m;
          }}
          renderOrder={10}
        >
          <boxGeometry args={[HS, HS, HS]} />
          <meshBasicMaterial color={color} depthTest={false} />
        </mesh>
      ))}
    </>
  );
}

function CropBoxControls({
  obb,
  mode,
  onObbChange,
  onLiveObbChange,
  onDraggingChange,
  visible,
  assetGroupRef,
}: {
  obb: ObbParams;
  mode: 'translate' | 'rotate' | 'scale';
  onObbChange: (o: ObbParams) => void;
  onLiveObbChange: (o: ObbParams) => void;
  onDraggingChange: (v: boolean) => void;
  visible: boolean;
  assetGroupRef: MutableRefObject<THREE.Group | null>;
}) {
  const boxRef = useRef<THREE.Group>(null);
  const [transformTarget, setTransformTarget] = useState<THREE.Object3D | null>(null);
  const controlsRef = useRef<
    | (THREE.Object3D & {
        addEventListener: (type: string, listener: () => void) => void;
        removeEventListener: (type: string, listener: () => void) => void;
      })
    | null
  >(null);
  const dragging = useRef(false);
  const { controls: orbitControls } = useThree();
  const skipNextSync = useRef(false);
  const lastLiveObbRef = useRef<ObbParams>(obb);

  useEffect(() => {
    if (!boxRef.current) return;
    if (skipNextSync.current) {
      const currentObb = {
        center: [
          +boxRef.current.position.x.toFixed(3),
          +boxRef.current.position.y.toFixed(3),
          +boxRef.current.position.z.toFixed(3),
        ] as [number, number, number],
        rotation: [
          +((boxRef.current.rotation.x * 180) / Math.PI).toFixed(1),
          +((boxRef.current.rotation.y * 180) / Math.PI).toFixed(1),
          +((boxRef.current.rotation.z * 180) / Math.PI).toFixed(1),
        ] as [number, number, number],
        scale: [
          +boxRef.current.scale.x.toFixed(3),
          +boxRef.current.scale.y.toFixed(3),
          +boxRef.current.scale.z.toFixed(3),
        ] as [number, number, number],
      };
      skipNextSync.current = false;
      const sameAsIncoming =
        currentObb.center.every((value, index) => value === obb.center[index]) &&
        currentObb.rotation.every((value, index) => value === obb.rotation[index]) &&
        currentObb.scale.every((value, index) => value === obb.scale[index]);
      if (sameAsIncoming) return;
    }
    boxRef.current.position.set(...obb.center);
    boxRef.current.rotation.set(
      (obb.rotation[0] * Math.PI) / 180,
      (obb.rotation[1] * Math.PI) / 180,
      (obb.rotation[2] * Math.PI) / 180,
    );
    boxRef.current.scale.set(...obb.scale);
  }, [obb]);

  const readObb = useCallback((): ObbParams => {
    const m = boxRef.current!;
    return {
      center: [+m.position.x.toFixed(3), +m.position.y.toFixed(3), +m.position.z.toFixed(3)],
      rotation: [
        +((m.rotation.x * 180) / Math.PI).toFixed(1),
        +((m.rotation.y * 180) / Math.PI).toFixed(1),
        +((m.rotation.z * 180) / Math.PI).toFixed(1),
      ],
      scale: [+m.scale.x.toFixed(3), +m.scale.y.toFixed(3), +m.scale.z.toFixed(3)],
    };
  }, []);

  const isSameObb = useCallback(
    (a: ObbParams, b: ObbParams) =>
      a.center.every((value, index) => value === b.center[index]) &&
      a.rotation.every((value, index) => value === b.rotation[index]) &&
      a.scale.every((value, index) => value === b.scale[index]),
    [],
  );

  useEffect(() => {
    lastLiveObbRef.current = obb;
  }, [obb]);

  useLayoutEffect(() => {
    const nextTarget = mode === 'rotate' ? assetGroupRef.current : boxRef.current;
    setTransformTarget((prev) => (prev === nextTarget ? prev : nextTarget));
  }, [assetGroupRef, mode, visible]);

  useEffect(() => {
    let frameId = 0;
    let lastTick = 0;

    const loop = (ts: number) => {
      if (boxRef.current && ts - lastTick >= 100) {
        const nextObb = readObb();
        if (!isSameObb(nextObb, lastLiveObbRef.current)) {
          lastLiveObbRef.current = nextObb;
          onLiveObbChange(nextObb);
        }
        lastTick = ts;
      }
      frameId = requestAnimationFrame(loop);
    };

    frameId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frameId);
  }, [isSameObb, onLiveObbChange, readObb]);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;

    const handleMouseDown = () => {
      dragging.current = true;
      if (orbitControls) (orbitControls as unknown as { enabled: boolean }).enabled = false;
      onDraggingChange(true);
    };

    const handleObjectChange = () => {
      if (mode === 'rotate') return;
      if (!boxRef.current) return;
      onLiveObbChange(readObb());
    };

    const handleMouseUp = () => {
      dragging.current = false;
      if (orbitControls) (orbitControls as unknown as { enabled: boolean }).enabled = true;
      onDraggingChange(false);
      if (mode === 'rotate') return;
      if (!boxRef.current) return;
      const nextObb = readObb();
      skipNextSync.current = true;
      lastLiveObbRef.current = nextObb;
      onLiveObbChange(nextObb);
      onObbChange(nextObb);
    };

    controls.addEventListener('mouseDown', handleMouseDown);
    controls.addEventListener('objectChange', handleObjectChange);
    controls.addEventListener('mouseUp', handleMouseUp);

    return () => {
      controls.removeEventListener('mouseDown', handleMouseDown);
      controls.removeEventListener('objectChange', handleObjectChange);
      controls.removeEventListener('mouseUp', handleMouseUp);
    };
  }, [onDraggingChange, onLiveObbChange, onObbChange, readObb, mode, assetGroupRef, orbitControls]);

  return (
    <>
      {/* translate/rotate 모드: TransformControls — rotate 시 에셋 그룹, translate 시 박스 */}
      {/* @ts-ignore runtime usage is valid even when package typings are too narrow */}
      {visible && mode !== 'scale' && transformTarget && (
        <TransformControls
          ref={controlsRef as never}
          object={transformTarget as never}
          mode={mode}
        />
      )}
      <group ref={boxRef} visible={visible}>
        <mesh>
          <boxGeometry args={[1, 1, 1]} />
          <meshBasicMaterial color="#f97316" wireframe opacity={0.8} transparent />
        </mesh>
      </group>
      {/* scale 모드: 커스텀 핸들 (코너=균등, 면=단일축) */}
      {mode === 'scale' && (
        <ScaleHandles
          boxRef={boxRef}
          onObbChange={onObbChange}
          onLiveObbChange={onLiveObbChange}
          onDraggingChange={onDraggingChange}
          visible={visible}
        />
      )}
    </>
  );
}

// ── GLB 메시 렌더러 ──────────────────────────────────────────────
function GlbMesh({
  url,
  glbGroupRef,
  onBoundsReady,
  onPreviewCenterReady,
  fitCameraRef,
}: {
  url: string;
  glbGroupRef: MutableRefObject<THREE.Group | null>;
  onBoundsReady: (extX: number, extY: number, extZ: number) => void;
  onPreviewCenterReady: (center: [number, number, number]) => void;
  fitCameraRef: MutableRefObject<((geo: THREE.BufferGeometry) => void) | null>;
}) {
  const { scene: sourceScene } = useGLTF(url);
  const scene = useMemo(() => {
    const clone = sourceScene.clone(true);
    clone.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const cloned = mats.map((m) => {
          const c = (m as THREE.Material).clone() as THREE.MeshStandardMaterial;
          c.envMap = null;
          c.needsUpdate = true;
          return c;
        });
        mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0];
      }
    });
    return clone;
  }, [sourceScene]);
  const { camera } = useThree();

  useEffect(() => {
    fitCameraRef.current = (geo: THREE.BufferGeometry) => {
      geo.computeBoundingSphere();
      const sphere = geo.boundingSphere;
      if (!sphere) return;
      const cam = camera as THREE.PerspectiveCamera;
      const dist = (sphere.radius / Math.sin((cam.fov * Math.PI) / 180 / 2)) * 1.2;
      camera.position.set(sphere.center.x, sphere.center.y, sphere.center.z + dist);
      camera.near = Math.max(dist * 0.001, 0.001);
      camera.far = dist * 10;
      cam.updateProjectionMatrix?.();
    };
    return () => {
      fitCameraRef.current = null;
    };
  }, [camera, fitCameraRef]);

  useEffect(() => {
    if (!scene) return;

    // bbox 계산
    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    // 씬 중심 이동
    if (glbGroupRef.current) {
      glbGroupRef.current.position.set(-center.x, -center.y, -center.z);
    }

    onPreviewCenterReady([center.x, center.y, center.z]);
    onBoundsReady(size.x, size.y, size.z);

    // 카메라 맞춤
    const cam = camera as THREE.PerspectiveCamera;
    const radius = Math.max(size.x, size.y, size.z) / 2;
    const dist = (radius / Math.sin((cam.fov * Math.PI) / 180 / 2)) * 1.4;
    camera.position.set(0, 0, dist);
    camera.near = dist * 0.001;
    camera.far = dist * 10;
    cam.updateProjectionMatrix?.();
    return () => {
      if (glbGroupRef.current) {
        glbGroupRef.current.position.set(0, 0, 0);
      }
    };
  }, [scene, camera, glbGroupRef, onBoundsReady, onPreviewCenterReady]);

  return (
    <group ref={glbGroupRef}>
      <primitive object={scene} />
    </group>
  );
}

// ── 거리 측정 마커 + 라인 ────────────────────────────────────────
function MeasureMarkers({ pts }: { pts: THREE.Vector3[] }) {
  if (pts.length === 0) return null;
  return (
    <>
      {pts.map((p, i) => (
        <mesh key={i} position={p}>
          <sphereGeometry args={[0.012, 12, 12]} />
          <meshBasicMaterial color={i === 0 ? '#facc15' : '#f97316'} />
        </mesh>
      ))}
      {pts.length === 2 &&
        (() => {
          const points = [pts[0], pts[1]];
          const geo = new THREE.BufferGeometry().setFromPoints(points);
          return <primitive object={new THREE.Line(geo, new THREE.LineBasicMaterial({ color: '#facc15' }))} />;
        })()}
    </>
  );
}

// ── 씬 ───────────────────────────────────────────────────────────
const GDT_SYMBOLS: Record<string, string> = {
  평면도: '⏥',
  진직도: '⏤',
  진원도: '○',
  원통도: '⌭',
  직각도: '⊥',
  평행도: '∥',
  경사도: '∠',
  위치도: '⊕',
  동심도: '◎',
  흔들림: '↗',
};

function GdtMarkers({
  annotations,
  editingId,
  onEdit,
  onOpenEdit,
  onDelete,
}: {
  annotations: { id: string; position: THREE.Vector3; type: string; tolerance: string }[];
  editingId: string | null;
  onEdit: (id: string) => void; // 드롭다운 토글
  onOpenEdit: (id: string) => void; // 수정 모달 열기
  onDelete: (id: string) => void;
}) {
  if (annotations.length === 0) return null;
  return (
    <>
      {annotations.map((a) => (
        <group key={a.id} position={a.position}>
          <mesh>
            <sphereGeometry args={[0.012, 12, 12]} />
            <meshBasicMaterial color="#c084fc" />
          </mesh>
          <Html distanceFactor={6} center>
            <div style={{ position: 'relative' }}>
              <div
                onClick={() => onEdit(a.id)}
                style={{
                  background: editingId === a.id ? '#3b0764' : '#1e1b4b',
                  border: `1.5px solid ${editingId === a.id ? '#d946ef' : '#a855f7'}`,
                  borderRadius: 5,
                  padding: '2px 7px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  whiteSpace: 'nowrap',
                  boxShadow: '0 2px 8px rgba(168,85,247,0.4)',
                  fontSize: 11,
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                <span style={{ color: '#e9d5ff', fontWeight: 700 }}>{GDT_SYMBOLS[a.type] ?? '⊕'}</span>
                <span style={{ color: '#d8b4fe' }}>{a.type}</span>
                <span style={{ color: '#a855f7', borderLeft: '1px solid #6d28d9', paddingLeft: 4 }}>
                  {a.tolerance} mm
                </span>
                <span style={{ color: '#7c3aed', paddingLeft: 2, fontSize: 10 }}>✎</span>
              </div>
              {editingId === a.id && (
                <div
                  style={{
                    position: 'absolute',
                    top: '100%',
                    left: 0,
                    marginTop: 4,
                    zIndex: 100,
                    background: '#0f0a1e',
                    border: '1px solid #6d28d9',
                    borderRadius: 6,
                    boxShadow: '0 4px 16px rgba(0,0,0,0.7)',
                    padding: '4px 0',
                    minWidth: 90,
                  }}
                >
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onEdit(a.id);
                      onOpenEdit(a.id);
                    }}
                    style={{
                      display: 'block',
                      width: '100%',
                      padding: '5px 12px',
                      background: 'none',
                      border: 'none',
                      color: '#c4b5fd',
                      fontSize: 11,
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    ✎ 수정
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(a.id);
                    }}
                    style={{
                      display: 'block',
                      width: '100%',
                      padding: '5px 12px',
                      background: 'none',
                      border: 'none',
                      color: '#f87171',
                      fontSize: 11,
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    ✕ 삭제
                  </button>
                </div>
              )}
            </div>
          </Html>
        </group>
      ))}
    </>
  );
}

function EditorScene({
  flyUrl,
  obb,
  mode,
  onObbChange,
  onLiveObbChange,
  fullDataRef,
  pointsRef,
  glbGroupRef,
  onBoundsReady,
  onPreviewCenterReady,
  fitCameraRef,
  measureMode,
  measurePts,
  onMeasureClick,
  suppressClickRef,
  assetType,
  isExtracted,
  cameraRef,
  assetGroupRef,
  cutMode,
  cutSelection,
  glbResetKey,
  forceShowSplat,
  gdtMode,
  gdtVisible,
  gdtAnnotations,
  onGdtClick,
  gdtEditingId,
  onGdtEdit,
  onGdtOpenEdit,
  onGdtDelete,
}: {
  flyUrl: string;
  obb: ObbParams;
  mode: 'translate' | 'rotate' | 'scale';
  onObbChange: (o: ObbParams) => void;
  onLiveObbChange: (o: ObbParams) => void;
  fullDataRef: MutableRefObject<PlyData | null>;
  pointsRef: MutableRefObject<THREE.Points | null>;
  glbGroupRef: MutableRefObject<THREE.Group | null>;
  onBoundsReady: (extX: number, extY: number, extZ: number) => void;
  onPreviewCenterReady: (center: [number, number, number]) => void;
  fitCameraRef: MutableRefObject<((geo: THREE.BufferGeometry) => void) | null>;
  measureMode: boolean;
  measurePts: THREE.Vector3[];
  onMeasureClick: (pt: THREE.Vector3) => void;
  suppressClickRef: MutableRefObject<boolean>;
  assetType?: AssetType | string;
  isExtracted: boolean;
  cameraRef: MutableRefObject<THREE.Camera | null>;
  assetGroupRef: MutableRefObject<THREE.Group | null>;
  cutMode: boolean;
  cutSelection: CutSelection | null;
  glbResetKey: number;
  forceShowSplat?: boolean;
  gdtMode: boolean;
  gdtVisible: boolean;
  gdtAnnotations: { id: string; position: THREE.Vector3; type: string; tolerance: string }[];
  onGdtClick: (pt: THREE.Vector3) => void;
  gdtEditingId: string | null;
  onGdtEdit: (id: string) => void;
  onGdtOpenEdit: (id: string) => void;
  onGdtDelete: (id: string) => void;
}) {
  const { camera, raycaster, gl } = useThree();
  const [dragging, setDragging] = useState(false);
  const isGlb = /\.(glb|gltf)(\?|$)/i.test(flyUrl);
  const isGaussian = assetType === 'gaussian' && !isGlb;

  useEffect(() => {
    cameraRef.current = camera;
    return () => {
      cameraRef.current = null;
    };
  }, [camera, cameraRef]);

  // 측정 모드 전환 시 dragging 상태 초기화 (OrbitControls 비활성화 방지)
  useEffect(() => {
    if (measureMode) setDragging(false);
  }, [measureMode]);

  // 측정 모드 클릭: PLY(Points) 또는 GLB(Mesh) 모두 지원
  useEffect(() => {
    if (!measureMode) return;
    const canvas = gl.domElement;

    const handleClick = (e: MouseEvent) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(mouse, camera);

      // GLB 메시에 raycasting
      if (isGlb && glbGroupRef.current) {
        const hits = raycaster.intersectObject(glbGroupRef.current, true);
        if (hits.length > 0) {
          onMeasureClick(hits[0].point.clone());
          return;
        }
      }

      // PLY Points에 raycasting
      const pts = pointsRef.current;
      if (pts && pts.geometry.attributes.position) {
        const camDist = camera.position.length();
        raycaster.params.Points = { threshold: camDist * 0.015 };
        const hits = raycaster.intersectObject(pts, false);
        if (hits.length > 0) {
          onMeasureClick(hits[0].point.clone());
          return;
        }
      }

      // 히트 없을 때: 원점 기준 평면에 투영
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
        camera.getWorldDirection(new THREE.Vector3()),
        new THREE.Vector3(0, 0, 0),
      );
      const target = new THREE.Vector3();
      raycaster.ray.intersectPlane(plane, target);
      if (target) onMeasureClick(target.clone());
    };

    canvas.addEventListener('click', handleClick);
    return () => canvas.removeEventListener('click', handleClick);
  }, [measureMode, camera, raycaster, gl, isGlb, glbGroupRef, pointsRef, onMeasureClick]);

  // GD&T 모드 클릭
  useEffect(() => {
    if (!gdtMode) return;
    const canvas = gl.domElement;
    const handleClick = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(mouse, camera);
      if (isGlb && glbGroupRef.current) {
        const hits = raycaster.intersectObject(glbGroupRef.current, true);
        if (hits.length > 0) {
          onGdtClick(hits[0].point.clone());
          return;
        }
      }
      const pts = pointsRef.current;
      if (pts && pts.geometry.attributes.position) {
        const camDist = camera.position.length();
        raycaster.params.Points = { threshold: camDist * 0.015 };
        const hits = raycaster.intersectObject(pts, false);
        if (hits.length > 0) {
          onGdtClick(hits[0].point.clone());
          return;
        }
      }
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
        camera.getWorldDirection(new THREE.Vector3()),
        new THREE.Vector3(0, 0, 0),
      );
      const target = new THREE.Vector3();
      raycaster.ray.intersectPlane(plane, target);
      if (target) onGdtClick(target.clone());
    };
    canvas.addEventListener('click', handleClick);
    return () => canvas.removeEventListener('click', handleClick);
  }, [gdtMode, camera, raycaster, gl, isGlb, glbGroupRef, pointsRef, onGdtClick]);

  return (
    <>
      {/* GLB PBR 재질(MeshStandardMaterial)의 텍스처·색상이 IBL 없이 사라지는 문제 방지 */}
      <Environment preset="city" background={false} />
      <ambientLight intensity={1.2} />
      <directionalLight position={[5, 10, 5]} intensity={0.8} />
      <group ref={assetGroupRef}>
        <Suspense fallback={null}>
          {isGlb ? (
            <GlbMesh
              key={`${flyUrl}-${glbResetKey}`}
              url={flyUrl}
              glbGroupRef={glbGroupRef}
              onBoundsReady={onBoundsReady}
              onPreviewCenterReady={onPreviewCenterReady}
              fitCameraRef={fitCameraRef}
            />
          ) : isGaussian ? (
            <GaussianSplatCloud
              url={flyUrl}
              fullDataRef={fullDataRef}
              pointsRef={pointsRef}
              onBoundsReady={onBoundsReady}
              onPreviewCenterReady={onPreviewCenterReady}
              fitCameraRef={fitCameraRef}
              showSplat={!isExtracted && !flyUrl.startsWith('blob:')}
              showPoints={isExtracted || flyUrl.startsWith('blob:')}
              forceShowSplat={forceShowSplat}
            />
          ) : (
            <FlyPointCloud
              url={flyUrl}
              fullDataRef={fullDataRef}
              pointsRef={pointsRef}
              onBoundsReady={onBoundsReady}
              onPreviewCenterReady={onPreviewCenterReady}
              fitCameraRef={fitCameraRef}
            />
          )}
        </Suspense>
      </group>
      <CropBoxControls
        obb={obb}
        mode={mode}
        onObbChange={onObbChange}
        onLiveObbChange={onLiveObbChange}
        onDraggingChange={setDragging}
        visible={!measureMode && !cutMode}
        assetGroupRef={assetGroupRef}
      />
      {cutSelection?.kind === 'points' && (
        <points geometry={cutSelection.highlightGeometry} frustumCulled={false} renderOrder={10}>
          <pointsMaterial
            size={0.015}
            color="#fb7185"
            sizeAttenuation
            transparent
            opacity={0.95}
            depthWrite={false}
            depthTest={false}
          />
        </points>
      )}
      {cutSelection?.kind === 'mesh' && <primitive object={cutSelection.highlightGroup} />}
      <MeasureMarkers pts={measurePts} />
      {gdtVisible && (
        <GdtMarkers
          annotations={gdtAnnotations}
          editingId={gdtEditingId}
          onEdit={onGdtEdit}
          onOpenEdit={onGdtOpenEdit}
          onDelete={onGdtDelete}
        />
      )}
      <OrbitControls
        makeDefault
        enabled={!dragging && !cutMode}
        enableRotate={!measureMode && !cutMode && !gdtMode}
        mouseButtons={{
          LEFT: measureMode || cutMode || gdtMode ? undefined : THREE.MOUSE.ROTATE,
          MIDDLE: THREE.MOUSE.DOLLY,
          RIGHT: cutMode ? undefined : THREE.MOUSE.PAN,
        }}
      />
    </>
  );
}

// ── GD&T 팝업 오버레이 (신규 추가 / 수정 공용) ───────────────────
function GdtPickerOverlay({
  onPick,
  onCancel,
  initialType,
  initialTol,
  isEdit,
}: {
  onPick: (type: string, tolerance: string) => void;
  onCancel: () => void;
  initialType?: string;
  initialTol?: string;
  isEdit?: boolean;
}) {
  const firstKey = Object.keys(GDT_SYMBOLS)[0];
  const [selected, setSelected] = useState(initialType ?? firstKey);
  const [tol, setTol] = useState(initialTol ?? '0.05');
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 200,
      }}
      onClick={onCancel}
    >
      <div
        style={{
          background: '#0f1117',
          border: '1px solid #2a2f42',
          borderRadius: 12,
          padding: 20,
          minWidth: 260,
          boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <p style={{ color: '#e2e8f0', fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
          {isEdit ? 'GD&T 공차 수정' : 'GD&T 공차 기호 선택'}
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 14 }}>
          {Object.entries(GDT_SYMBOLS).map(([key, sym]) => (
            <button
              key={key}
              onClick={() => setSelected(key)}
              style={{
                background: selected === key ? '#581c87' : '#1a1f2e',
                border: `1px solid ${selected === key ? '#a855f7' : '#2a2f42'}`,
                borderRadius: 6,
                padding: '5px 8px',
                color: selected === key ? '#e9d5ff' : '#9ca3af',
                fontSize: 11,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              <span style={{ fontSize: 14 }}>{sym}</span>
              {key}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <span style={{ color: '#9ca3af', fontSize: 11 }}>공차 (mm)</span>
          <input
            value={tol}
            onChange={(e) => setTol(e.target.value)}
            style={{
              flex: 1,
              background: '#1a1f2e',
              border: '1px solid #2a2f42',
              borderRadius: 6,
              padding: '4px 8px',
              color: '#e2e8f0',
              fontSize: 12,
            }}
          />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={onCancel}
            style={{
              flex: 1,
              background: '#1a1f2e',
              border: '1px solid #2a2f42',
              borderRadius: 6,
              padding: '6px 0',
              color: '#9ca3af',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            취소
          </button>
          <button
            onClick={() => onPick(selected, tol)}
            style={{
              flex: 1,
              background: '#7c3aed',
              border: 'none',
              borderRadius: 6,
              padding: '6px 0',
              color: '#fff',
              fontSize: 12,
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            {isEdit ? '저장' : '추가'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Icon({ d, className = 'w-4 h-4' }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className={className}>
      <path d={d} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── 브라우저 다운로드 헬퍼 ───────────────────────────────────────
// ── 메시 Three.js Group → PLY 바이너리 (CloudCompare용) ──────────
function writeMeshPlyBinary(group: THREE.Group): Blob | null {
  const allVerts: number[] = [];
  const allFaces: number[] = [];
  let vertOffset = 0;

  group.traverse((child: THREE.Object3D) => {
    if (!(child instanceof THREE.Mesh)) return;
    const geo = child.geometry.clone();
    geo.applyMatrix4(child.matrixWorld);
    const pos = geo.getAttribute('position');
    if (!pos) return;
    for (let i = 0; i < pos.count; i++) {
      allVerts.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    }
    if (geo.index) {
      for (let i = 0; i < geo.index.count; i += 3) {
        allFaces.push(
          geo.index.getX(i) + vertOffset,
          geo.index.getX(i + 1) + vertOffset,
          geo.index.getX(i + 2) + vertOffset,
        );
      }
    } else {
      for (let i = 0; i < pos.count; i += 3) {
        allFaces.push(i + vertOffset, i + 1 + vertOffset, i + 2 + vertOffset);
      }
    }
    vertOffset += pos.count;
  });

  if (allVerts.length === 0) return null;

  const nV = allVerts.length / 3;
  const nF = allFaces.length / 3;
  const header = [
    'ply',
    'format binary_little_endian 1.0',
    `element vertex ${nV}`,
    'property float x',
    'property float y',
    'property float z',
    `element face ${nF}`,
    'property list uchar int vertex_indices',
    'end_header',
    '',
  ].join('\n');

  const hdrBytes = new TextEncoder().encode(header);
  const vertBytes = new ArrayBuffer(nV * 12);
  const vertDv = new DataView(vertBytes);
  for (let i = 0; i < allVerts.length; i++) {
    vertDv.setFloat32(i * 4, allVerts[i], true);
  }
  const faceBytes = new ArrayBuffer(nF * 13); // 1(count) + 3*4(indices)
  const faceDv = new DataView(faceBytes);
  for (let i = 0; i < nF; i++) {
    faceDv.setUint8(i * 13, 3);
    faceDv.setInt32(i * 13 + 1, allFaces[i * 3], true);
    faceDv.setInt32(i * 13 + 5, allFaces[i * 3 + 1], true);
    faceDv.setInt32(i * 13 + 9, allFaces[i * 3 + 2], true);
  }
  return new Blob([hdrBytes, vertBytes, faceBytes], { type: 'application/octet-stream' });
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── OBB 내부 포인트 필터 ─────────────────────────────────────────
function filterPointsInObb(
  positions: Float32Array,
  colors: Float32Array | undefined,
  center: number[],
  rotation: number[],
  scale: number[],
): { positions: Float32Array; colors?: Float32Array } | null {
  const N = positions.length / 3;
  const keepMask = new Uint8Array(N);
  const euler = new THREE.Euler(
    (rotation[0] * Math.PI) / 180,
    (rotation[1] * Math.PI) / 180,
    (rotation[2] * Math.PI) / 180,
    'XYZ',
  );
  const invRot = new THREE.Matrix4().makeRotationFromEuler(euler).invert();
  const hx = scale[0] / 2,
    hy = scale[1] / 2,
    hz = scale[2] / 2;
  const v = new THREE.Vector3();
  let keepCount = 0;
  for (let i = 0; i < N; i++) {
    v.set(
      positions[i * 3] - center[0],
      positions[i * 3 + 1] - center[1],
      positions[i * 3 + 2] - center[2],
    ).applyMatrix4(invRot);
    if (Math.abs(v.x) <= hx && Math.abs(v.y) <= hy && Math.abs(v.z) <= hz) {
      keepMask[i] = 1;
      keepCount += 1;
    }
  }
  if (keepCount === 0) return null;
  const outPos = new Float32Array(keepCount * 3);
  const outCol = colors ? new Float32Array(keepCount * 3) : undefined;
  let dst = 0;
  for (let src = 0; src < N; src += 1) {
    if (!keepMask[src]) continue;
    outPos[dst * 3] = positions[src * 3];
    outPos[dst * 3 + 1] = positions[src * 3 + 1];
    outPos[dst * 3 + 2] = positions[src * 3 + 2];
    if (outCol && colors) {
      outCol[dst * 3] = colors[src * 3];
      outCol[dst * 3 + 1] = colors[src * 3 + 1];
      outCol[dst * 3 + 2] = colors[src * 3 + 2];
    }
    dst += 1;
  }
  return { positions: outPos, colors: outCol };
}

function buildPointKeepMaskInObb(
  positions: Float32Array,
  center: number[],
  rotation: number[],
  scale: number[],
): Uint8Array | null {
  const N = positions.length / 3;
  const keepMask = new Uint8Array(N);
  const euler = new THREE.Euler(
    (rotation[0] * Math.PI) / 180,
    (rotation[1] * Math.PI) / 180,
    (rotation[2] * Math.PI) / 180,
    'XYZ',
  );
  const invRot = new THREE.Matrix4().makeRotationFromEuler(euler).invert();
  const hx = scale[0] / 2;
  const hy = scale[1] / 2;
  const hz = scale[2] / 2;
  const v = new THREE.Vector3();
  let keepCount = 0;

  for (let i = 0; i < N; i += 1) {
    v.set(
      positions[i * 3] - center[0],
      positions[i * 3 + 1] - center[1],
      positions[i * 3 + 2] - center[2],
    ).applyMatrix4(invRot);

    if (Math.abs(v.x) <= hx && Math.abs(v.y) <= hy && Math.abs(v.z) <= hz) {
      keepMask[i] = 1;
      keepCount += 1;
    }
  }

  return keepCount > 0 ? keepMask : null;
}

// ── OBB 내부 메시 면 필터 ────────────────────────────────────────
type ClippedVertex = {
  local: THREE.Vector3;
  world: THREE.Vector3;
  normal?: THREE.Vector3;
  uv?: THREE.Vector2;
  color?: THREE.Vector3;
};

function interpolateClippedVertex(a: ClippedVertex, b: ClippedVertex, t: number): ClippedVertex {
  return {
    local: a.local.clone().lerp(b.local, t),
    world: a.world.clone().lerp(b.world, t),
    normal: a.normal
      ? a.normal
          .clone()
          .lerp(b.normal ?? a.normal, t)
          .normalize()
      : undefined,
    uv: a.uv ? a.uv.clone().lerp(b.uv ?? a.uv, t) : undefined,
    color: a.color ? a.color.clone().lerp(b.color ?? a.color, t) : undefined,
  };
}

function clipPolygonAgainstPlane(
  polygon: ClippedVertex[],
  axis: 'x' | 'y' | 'z',
  boundary: number,
  keepLessThan: boolean,
): ClippedVertex[] {
  if (polygon.length === 0) return [];

  const output: ClippedVertex[] = [];
  const isInside = (vertex: ClippedVertex) =>
    keepLessThan ? vertex.local[axis] <= boundary : vertex.local[axis] >= boundary;

  let previous = polygon[polygon.length - 1];
  let previousInside = isInside(previous);

  for (const current of polygon) {
    const currentInside = isInside(current);

    if (currentInside !== previousInside) {
      const prevValue = previous.local[axis];
      const currValue = current.local[axis];
      const denom = currValue - prevValue;
      const t = Math.abs(denom) < 1e-8 ? 0 : (boundary - prevValue) / denom;
      output.push(interpolateClippedVertex(previous, current, THREE.MathUtils.clamp(t, 0, 1)));
    }

    if (currentInside) {
      output.push({
        local: current.local.clone(),
        world: current.world.clone(),
        normal: current.normal?.clone(),
        uv: current.uv?.clone(),
        color: current.color?.clone(),
      });
    }

    previous = current;
    previousInside = currentInside;
  }

  return output;
}

function clipTriangleToObb(triangle: ClippedVertex[], half: THREE.Vector3): ClippedVertex[] {
  let polygon = triangle;

  polygon = clipPolygonAgainstPlane(polygon, 'x', half.x, true);
  polygon = clipPolygonAgainstPlane(polygon, 'x', -half.x, false);
  polygon = clipPolygonAgainstPlane(polygon, 'y', half.y, true);
  polygon = clipPolygonAgainstPlane(polygon, 'y', -half.y, false);
  polygon = clipPolygonAgainstPlane(polygon, 'z', half.z, true);
  polygon = clipPolygonAgainstPlane(polygon, 'z', -half.z, false);

  return polygon;
}

function filterMeshInObb(
  mesh: THREE.Mesh,
  center: number[],
  rotation: number[],
  scale: number[],
): { geometry: THREE.BufferGeometry; faceCount: number } | null {
  const sourceGeo = mesh.geometry;
  const workingGeo = sourceGeo.index ? sourceGeo.toNonIndexed() : sourceGeo;
  const shouldDisposeWorkingGeo = !!sourceGeo.index;
  const posAttr = workingGeo.attributes.position;

  if (!posAttr) {
    if (shouldDisposeWorkingGeo) workingGeo.dispose();
    return null;
  }

  const normAttr = workingGeo.attributes.normal;
  const uvAttr = workingGeo.attributes.uv;
  const colorAttr = workingGeo.attributes.color;

  const euler = new THREE.Euler(
    (rotation[0] * Math.PI) / 180,
    (rotation[1] * Math.PI) / 180,
    (rotation[2] * Math.PI) / 180,
    'XYZ',
  );
  const invRot = new THREE.Matrix4().makeRotationFromEuler(euler).invert();
  const centerVec = new THREE.Vector3(center[0], center[1], center[2]);
  const half = new THREE.Vector3(Math.abs(scale[0]) / 2, Math.abs(scale[1]) / 2, Math.abs(scale[2]) / 2);
  const worldMatrix = mesh.matrixWorld.clone();
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(worldMatrix);

  const worldPosition = new THREE.Vector3();
  const localPosition = new THREE.Vector3();
  const worldNormal = new THREE.Vector3();
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  let keptFaces = 0;

  for (let i = 0; i < posAttr.count; i += 3) {
    const triangle: ClippedVertex[] = [];

    for (let v = 0; v < 3; v += 1) {
      worldPosition.fromBufferAttribute(posAttr, i + v).applyMatrix4(worldMatrix);
      localPosition.copy(worldPosition).sub(centerVec).applyMatrix4(invRot);

      const vertex: ClippedVertex = {
        local: localPosition.clone(),
        world: worldPosition.clone(),
      };

      if (normAttr) {
        worldNormal
          .fromBufferAttribute(normAttr, i + v)
          .applyMatrix3(normalMatrix)
          .normalize();
        vertex.normal = worldNormal.clone();
      }
      if (uvAttr) {
        vertex.uv = new THREE.Vector2(uvAttr.getX(i + v), uvAttr.getY(i + v));
      }
      if (colorAttr) {
        vertex.color = new THREE.Vector3(colorAttr.getX(i + v), colorAttr.getY(i + v), colorAttr.getZ(i + v));
      }

      triangle.push(vertex);
    }

    const clipped = clipTriangleToObb(triangle, half);
    if (clipped.length < 3) continue;

    for (let v = 1; v < clipped.length - 1; v += 1) {
      const a = clipped[0];
      const b = clipped[v];
      const c = clipped[v + 1];

      keptFaces += 1;
      positions.push(a.world.x, a.world.y, a.world.z, b.world.x, b.world.y, b.world.z, c.world.x, c.world.y, c.world.z);

      if (a.normal && b.normal && c.normal) {
        normals.push(
          a.normal.x,
          a.normal.y,
          a.normal.z,
          b.normal.x,
          b.normal.y,
          b.normal.z,
          c.normal.x,
          c.normal.y,
          c.normal.z,
        );
      }

      if (a.uv && b.uv && c.uv) {
        uvs.push(a.uv.x, a.uv.y, b.uv.x, b.uv.y, c.uv.x, c.uv.y);
      }

      if (a.color && b.color && c.color) {
        colors.push(a.color.x, a.color.y, a.color.z, b.color.x, b.color.y, b.color.z, c.color.x, c.color.y, c.color.z);
      }
    }
  }

  if (shouldDisposeWorkingGeo) workingGeo.dispose();
  if (keptFaces === 0) return null;

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (normals.length > 0) {
    out.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  } else {
    out.computeVertexNormals();
  }
  if (uvs.length > 0) out.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  if (colors.length > 0) {
    const colorAttr = new THREE.Float32BufferAttribute(colors, 3);
    (colorAttr as unknown as { colorSpace: string }).colorSpace = THREE.SRGBColorSpace;
    out.setAttribute('color', colorAttr);
  }
  out.computeBoundingSphere();

  return { geometry: out, faceCount: keptFaces };
}

interface MeshBufferAccumulator {
  positions: number[];
  normals: number[];
  uvs: number[];
  colors: number[];
}

function createMeshAccumulator(): MeshBufferAccumulator {
  return {
    positions: [],
    normals: [],
    uvs: [],
    colors: [],
  };
}

function appendTriangleToAccumulator(
  target: MeshBufferAccumulator,
  triPositions: number[],
  triNormals: number[],
  triUvs: number[],
  triColors: number[],
) {
  target.positions.push(...triPositions);
  if (triNormals.length > 0) target.normals.push(...triNormals);
  if (triUvs.length > 0) target.uvs.push(...triUvs);
  if (triColors.length > 0) target.colors.push(...triColors);
}

function buildMeshGeometryFromAccumulator(buffers: MeshBufferAccumulator): THREE.BufferGeometry | null {
  if (buffers.positions.length === 0) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(buffers.positions, 3));

  if (buffers.normals.length > 0) {
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(buffers.normals, 3));
  } else {
    geometry.computeVertexNormals();
  }

  if (buffers.uvs.length > 0) {
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(buffers.uvs, 2));
  }
  if (buffers.colors.length > 0) {
    const colorAttr = new THREE.Float32BufferAttribute(buffers.colors, 3);
    (colorAttr as unknown as { colorSpace: string }).colorSpace = THREE.SRGBColorSpace;
    geometry.setAttribute('color', colorAttr);
  }

  geometry.computeBoundingSphere();
  return geometry;
}

function buildMeshCutSelection(
  group: THREE.Group,
  camera: THREE.Camera,
  stroke: StrokePoint[],
  width: number,
  height: number,
): MeshCutSelection | null {
  if (stroke.length < 2) return null;

  const start = stroke[0];
  const end = stroke[stroke.length - 1];
  const strokeBounds: ScreenBounds = {
    minX: Math.min(start.x, end.x),
    maxX: Math.max(start.x, end.x),
    minY: Math.min(start.y, end.y),
    maxY: Math.max(start.y, end.y),
  };
  if (strokeBounds.maxX - strokeBounds.minX < 2 && strokeBounds.maxY - strokeBounds.minY < 2) return null;
  const highlightGroup = new THREE.Group();
  const patches: MeshCutPatch[] = [];
  const worldPosition = new THREE.Vector3();
  const clipPosition = new THREE.Vector3();

  camera.updateMatrixWorld();
  if (camera instanceof THREE.PerspectiveCamera) camera.updateProjectionMatrix();
  group.updateWorldMatrix(true, true);

  let removedFaceCount = 0;

  group.traverse((child: THREE.Object3D) => {
    if (!(child instanceof THREE.Mesh) || !child.visible) return;

    const sourceGeo = child.geometry;
    const workingGeo = sourceGeo.index ? sourceGeo.toNonIndexed() : sourceGeo;
    const shouldDisposeWorkingGeo = !!sourceGeo.index;
    const posAttr = workingGeo.attributes.position;
    if (!posAttr) {
      if (shouldDisposeWorkingGeo) workingGeo.dispose();
      return;
    }

    const normAttr = workingGeo.attributes.normal;
    const uvAttr = workingGeo.attributes.uv;
    const colorAttr = workingGeo.attributes.color;
    const kept = createMeshAccumulator();
    const removed = createMeshAccumulator();
    const worldMatrix = child.matrixWorld.clone();

    let keptFaces = 0;
    let meshRemovedFaces = 0;

    for (let i = 0; i < posAttr.count; i += 3) {
      const triPositions: number[] = [];
      const triNormals: number[] = [];
      const triUvs: number[] = [];
      const triColors: number[] = [];
      const screenTriangle: [StrokePoint, StrokePoint, StrokePoint] = [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ];

      for (let v = 0; v < 3; v += 1) {
        const index = i + v;
        const x = posAttr.getX(index);
        const y = posAttr.getY(index);
        const z = posAttr.getZ(index);

        triPositions.push(x, y, z);

        worldPosition.set(x, y, z).applyMatrix4(worldMatrix);
        clipPosition.copy(worldPosition).project(camera);
        screenTriangle[v] = {
          x: (clipPosition.x * 0.5 + 0.5) * width,
          y: (-clipPosition.y * 0.5 + 0.5) * height,
        };

        if (normAttr) {
          triNormals.push(normAttr.getX(index), normAttr.getY(index), normAttr.getZ(index));
        }
        if (uvAttr) {
          triUvs.push(uvAttr.getX(index), uvAttr.getY(index));
        }
        if (colorAttr) {
          triColors.push(colorAttr.getX(index), colorAttr.getY(index), colorAttr.getZ(index));
        }
      }

      // 삼각형의 세 꼭짓점 중 하나라도 사각형 범위 안에 있으면 선택
      const triInRect = screenTriangle.some(
        (v) =>
          v.x >= strokeBounds.minX && v.x <= strokeBounds.maxX && v.y >= strokeBounds.minY && v.y <= strokeBounds.maxY,
      );
      if (triInRect) {
        appendTriangleToAccumulator(removed, triPositions, triNormals, triUvs, triColors);
        meshRemovedFaces += 1;
      } else {
        appendTriangleToAccumulator(kept, triPositions, triNormals, triUvs, triColors);
        keptFaces += 1;
      }
    }

    if (shouldDisposeWorkingGeo) workingGeo.dispose();
    if (meshRemovedFaces === 0) return;

    const keptGeometry = buildMeshGeometryFromAccumulator(kept);
    const removedGeometry = buildMeshGeometryFromAccumulator(removed);
    removedFaceCount += meshRemovedFaces;

    patches.push({
      mesh: child,
      geometry: keptGeometry,
      remainingFaceCount: keptFaces,
    });

    if (!removedGeometry) return;

    const highlightMesh = new THREE.Mesh(
      removedGeometry,
      new THREE.MeshBasicMaterial({
        color: '#fb7185',
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    highlightMesh.matrix.copy(worldMatrix);
    highlightMesh.matrixAutoUpdate = false;
    highlightMesh.renderOrder = 20;
    highlightMesh.frustumCulled = false;
    highlightGroup.add(highlightMesh);
  });

  if (removedFaceCount <= 0 || patches.length === 0) {
    highlightGroup.traverse((child: THREE.Object3D) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        const material = child.material;
        if (Array.isArray(material)) material.forEach((item) => item.dispose());
        else material.dispose();
      }
    });
    return null;
  }

  return {
    kind: 'mesh',
    removedFaceCount,
    highlightGroup,
    patches,
  };
}

function countMeshFaces(group: THREE.Group): number {
  let total = 0;

  group.traverse((child: THREE.Object3D) => {
    if (!(child instanceof THREE.Mesh) || !child.visible) return;
    if (child.geometry.index) {
      total += Math.floor(child.geometry.index.count / 3);
      return;
    }
    const position = child.geometry.getAttribute('position');
    if (!position) return;
    total += Math.floor(position.count / 3);
  });

  return total;
}

// ── 메인 ─────────────────────────────────────────────────────────
export default function MeshCropEditor({
  flyUrl,
  initialObb,
  versions = [],
  onCreateVersion,
  onUpdateVersion,
  onDeleteVersion,
  onSetRepresentative,
  representativeSceneObject,
  onDraftObbChange,
  onSaveCalibration,
  onConfirm,
  onClose,
  loading,
  showConvertActions = false,
  downloadBaseName = 'extract',
  assetType,
  initialCalibrationScale = 1,
  initialCalibrationReferenceLength,
  onSaveEdit,
  onSaveExtractedAsset,
  getSceneUrl,
}: {
  flyUrl: string;
  initialObb: ObbParams;
  versions?: AssetObbVersion[];
  onCreateVersion?: (payload: { description?: string; obb: ObbParams; sceneBlob?: Blob; sceneExt?: string }) => Promise<AssetObbVersion | void> | AssetObbVersion | void;
  onUpdateVersion?: (payload: { versionId: string; description?: string; obb: ObbParams }) => Promise<void> | void;
  onDeleteVersion?: (versionId: string) => Promise<void> | void;
  onSetRepresentative?: (version: AssetObbVersion) => Promise<void>;
  representativeSceneObject?: string | null;
  onDraftObbChange?: (obb: ObbParams) => void;
  onSaveCalibration?: (
    calibrationScale: number,
    calibrationReferenceLength: number,
    calibrationMeasuredLength: number,
  ) => Promise<void> | void;
  onConfirm?: (obb: CropConfirmParams | null) => void;
  onClose: () => void;
  loading: boolean;
  showConvertActions?: boolean;
  downloadBaseName?: string;
  assetType?: AssetType | string;
  initialCalibrationScale?: number;
  initialCalibrationReferenceLength?: number;
  onSaveEdit?: (blob: Blob, ext: string) => Promise<void>;
  onSaveExtractedAsset?: (payload: { blob: Blob; ext: string; assetType: AssetType }) => Promise<void>;
  getSceneUrl?: (objectName: string) => string;
}) {
  const isGlb = /\.(glb|gltf)(\?|$)/i.test(flyUrl);
  const isGaussianAsset = assetType === 'gaussian' && !isGlb;

  const [mode, setMode] = useState<'translate' | 'rotate' | 'scale'>('translate');
  const [extractLoading, setExtractLoading] = useState(false);
  const [isExtracted, setIsExtracted] = useState(false); // 추출 미리보기 상태
  const [measureMode, setMeasureMode] = useState(false);
  const [measurePts, setMeasurePts] = useState<THREE.Vector3[]>([]);
  const [calibrationScale, setCalibrationScale] = useState(
    Number.isFinite(initialCalibrationScale) && initialCalibrationScale > 0 ? initialCalibrationScale : 1,
  );
  const [calibrationInput, setCalibrationInput] = useState(
    initialCalibrationReferenceLength && Number.isFinite(initialCalibrationReferenceLength)
      ? String(Math.round(initialCalibrationReferenceLength * 1000) / 1000)
      : '',
  );
  const [calibrationUnit, setCalibrationUnit] = useState<'m' | 'cm' | 'mm'>('m');
  const [calibrationSaving, setCalibrationSaving] = useState(false);
  const [gdtMode, setGdtMode] = useState(false);
  const [gdtVisible, setGdtVisible] = useState(true);
  const [gdtAnnotations, setGdtAnnotations] = useState<
    { id: string; position: THREE.Vector3; type: string; tolerance: string }[]
  >([]);
  const [gdtPending, setGdtPending] = useState<THREE.Vector3 | null>(null);
  const [gdtSelected, setGdtSelected] = useState<string | null>(null); // 드롭다운
  const [gdtEditing, setGdtEditing] = useState<string | null>(null); // 수정 모달
  const [bgColor, setBgColor] = useState('#111827');
  const [sceneUrl, setSceneUrl] = useState(flyUrl);
  const [viewAsGaussian, setViewAsGaussian] = useState(false);
  const [cutMode, setCutMode] = useState(false);
  const [cutStroke, setCutStroke] = useState<StrokePoint[]>([]);
  const [isCutDragging, setIsCutDragging] = useState(false);
  const isCutDraggingRef = useRef(false); // state 스테일 클로저 방지용 ref
  const [cutSelectionPreview, setCutSelectionPreview] = useState<CutSelection | null>(null);
  const [glbResetKey, setGlbResetKey] = useState(0);
  const [glbEditVersion, setGlbEditVersion] = useState(0);
  const [saveEditLoading, setSaveEditLoading] = useState(false);
  const [saveExtractedAssetLoading, setSaveExtractedAssetLoading] = useState(false);
  const [isVersionPanelOpen, setIsVersionPanelOpen] = useState(false);
  const [versionPanelTab, setVersionPanelTab] = useState<'save' | 'load'>('save');
  const [versionDescription, setVersionDescription] = useState('');
  const [versionSaving, setVersionSaving] = useState(false);
  const [editingVersionId, setEditingVersionId] = useState<string | null>(null);
  const [deletingVersionId, setDeletingVersionId] = useState<string | null>(null);
  const [appliedVersionId, setAppliedVersionId] = useState<string | null>(null);

  const suppressNextMeasureClick = useRef(false);
  const fullDataRef = useRef<PlyData | null>(null);
  const pointsRef = useRef<THREE.Points | null>(null);
  const glbGroupRef = useRef<THREE.Group | null>(null);
  const croppedData = useRef<PlyData | null>(null);
  const fitCameraRef = useRef<((geo: THREE.BufferGeometry) => void) | null>(null);
  const previewCenterRef = useRef<[number, number, number]>([0, 0, 0]);
  const previewBoundsRef = useRef<[number, number, number]>([0, 0, 0]);
  const liveObbRef = useRef<ObbParams>(initialObb);
  const cameraRef = useRef<THREE.Camera | null>(null);
  const assetGroupRef = useRef<THREE.Group | null>(null);
  const tempSceneUrlRef = useRef<string | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const cutSelectionRef = useRef<CutSelection | null>(null);
  const generatedMeshGeometriesRef = useRef<Set<THREE.BufferGeometry>>(new Set());
  const draftObbChangeRef = useRef<typeof onDraftObbChange>();

  // ── 히스토리 (OBB 조작) ──────────────────────────────────────
  const [history, setHistory] = useState<ObbParams[]>([initialObb]);
  const [histIdx, setHistIdx] = useState(0);
  const obb = history[histIdx];
  const [liveObb, setLiveObb] = useState<ObbParams>(initialObb);
  const canUndo = histIdx > 0;
  const isDirty = histIdx > 0;
  const busy = loading || extractLoading;
  const hasLocalSceneEdits = isGlb ? glbEditVersion > 0 : sceneUrl !== flyUrl;

  useEffect(() => {
    liveObbRef.current = obb;
    setLiveObb(obb);
  }, [obb]);

  useEffect(() => {
    draftObbChangeRef.current = onDraftObbChange;
  }, [onDraftObbChange]);

  useEffect(() => {
    draftObbChangeRef.current?.(obb);
  }, [obb]);

  // ── 토스트 ───────────────────────────────────────────────────
  const [toast, setToast] = useState<{ msg: string; type: 'ok' | 'err' } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  const showToast = useCallback((msg: string, type: 'ok' | 'err' = 'ok') => {
    setToast({ msg, type });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  }, []);

  useEffect(() => {
    const nextScale =
      Number.isFinite(initialCalibrationScale) && initialCalibrationScale > 0 ? initialCalibrationScale : 1;
    setCalibrationScale(nextScale);
  }, [initialCalibrationScale]);

  useEffect(() => {
    if (!initialCalibrationReferenceLength || !Number.isFinite(initialCalibrationReferenceLength)) return;
    setCalibrationInput(String(Math.round(initialCalibrationReferenceLength * 1000) / 1000));
  }, [initialCalibrationReferenceLength]);

  const disposeGeneratedMeshGeometries = useCallback(() => {
    generatedMeshGeometriesRef.current.forEach((geometry) => geometry.dispose());
    generatedMeshGeometriesRef.current.clear();
  }, []);

  const disposeCutSelection = useCallback(
    (selection: CutSelection | null, options?: { preserveMeshPatchGeometries?: boolean }) => {
      if (!selection) return;

      if (selection.kind === 'points') {
        selection.highlightGeometry.dispose();
        return;
      }

      selection.highlightGroup.traverse((child: THREE.Object3D) => {
        if (!(child instanceof THREE.Mesh)) return;
        child.geometry.dispose();
        const material = child.material;
        if (Array.isArray(material)) material.forEach((item) => item.dispose());
        else material.dispose();
      });

      if (options?.preserveMeshPatchGeometries) return;
      selection.patches.forEach((patch) => patch.geometry?.dispose());
    },
    [],
  );

  const clearCutSelectionPreview = useCallback(
    (options?: { preserveMeshPatchGeometries?: boolean }) => {
      const prev = cutSelectionRef.current;
      cutSelectionRef.current = null;
      setCutSelectionPreview(null);
      disposeCutSelection(prev, options);
    },
    [disposeCutSelection],
  );

  const replaceCutSelectionPreview = useCallback(
    (next: CutSelection | null) => {
      const prev = cutSelectionRef.current;
      cutSelectionRef.current = next;
      setCutSelectionPreview(next);
      disposeCutSelection(prev);
    },
    [disposeCutSelection],
  );

  const handlePreviewCenterReady = useCallback((center: [number, number, number]) => {
    previewCenterRef.current = center;
  }, []);
  useEffect(() => {
    clearCutSelectionPreview();
    disposeGeneratedMeshGeometries();
    if (tempSceneUrlRef.current) {
      URL.revokeObjectURL(tempSceneUrlRef.current);
      tempSceneUrlRef.current = null;
    }
    setSceneUrl(flyUrl);
    setCutMode(false);
    setCutStroke([]);
    setIsCutDragging(false);
    setIsExtracted(false);
    setGlbResetKey(0);
    setGlbEditVersion(0);
    setIsVersionPanelOpen(false);
    setVersionPanelTab('save');
    setVersionDescription('');
    setVersionSaving(false);
    setEditingVersionId(null);
    setDeletingVersionId(null);
    previewBoundsRef.current = [0, 0, 0];
  }, [clearCutSelectionPreview, disposeGeneratedMeshGeometries, flyUrl]);
  useEffect(
    () => () => {
      disposeCutSelection(cutSelectionRef.current);
      disposeGeneratedMeshGeometries();
      if (tempSceneUrlRef.current) {
        URL.revokeObjectURL(tempSceneUrlRef.current);
        tempSceneUrlRef.current = null;
      }
    },
    [disposeCutSelection, disposeGeneratedMeshGeometries],
  );

  const getViewportPoint = useCallback((clientX: number, clientY: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }, []);

  const pushCutPoint = useCallback((point: StrokePoint) => {
    setCutStroke((prev) => {
      if (prev.length === 0) return [point];
      const last = prev[prev.length - 1];
      const dx = point.x - last.x;
      const dy = point.y - last.y;
      return dx * dx + dy * dy < 4 ? prev : [...prev, point];
    });
  }, []);

  const clearCutStroke = useCallback(
    (showMessage = false) => {
      clearCutSelectionPreview();
      setCutStroke([]);
      setIsCutDragging(false);
      if (showMessage) showToast('자유 컷 경로를 지웠습니다.');
    },
    [clearCutSelectionPreview, showToast],
  );

  const restoreScene = useCallback(
    (showMessage = true) => {
      clearCutSelectionPreview();
      if (tempSceneUrlRef.current) {
        URL.revokeObjectURL(tempSceneUrlRef.current);
        tempSceneUrlRef.current = null;
      }
      disposeGeneratedMeshGeometries();
      setSceneUrl(flyUrl);
      setViewAsGaussian(false);
      setCutStroke([]);
      setIsCutDragging(false);
      setIsExtracted(false);
      setGlbResetKey((prev) => prev + 1);
      setGlbEditVersion(0);
      croppedData.current = null;
      if (showMessage) showToast('원본 3DGS로 복원했습니다.');
    },
    [clearCutSelectionPreview, disposeGeneratedMeshGeometries, flyUrl, showToast],
  );

  // PLY 로드 완료 시 박스 스케일을 클라우드 크기에 맞게 자동 설정
  const handleBoundsReady = useCallback((extX: number, extY: number, extZ: number) => {
    previewBoundsRef.current = [extX, extY, extZ];
    setHistory((prev) => {
      const cur = prev[0];
      // 기본 [1,1,1] 스케일일 때만 자동 조정 (저장된 OBB가 있으면 유지)
      if (cur.scale[0] === 1 && cur.scale[1] === 1 && cur.scale[2] === 1) {
        const s = Math.max(extX, extY, extZ) * 0.4;
        const nextObb = { ...cur, scale: [s, s, s] as [number, number, number] };
        liveObbRef.current = nextObb;
        return [nextObb];
      }
      return prev;
    });
    setHistIdx(0);
  }, []);

  const handleLiveObbChange = useCallback((newObb: ObbParams) => {
    liveObbRef.current = newObb;
    setLiveObb(newObb);
  }, []);

  const handleObbChange = useCallback(
    (newObb: ObbParams) => {
      liveObbRef.current = newObb;
      setLiveObb(newObb);
      setHistory((prev) => [...prev.slice(0, histIdx + 1), newObb]);
      setHistIdx((prev) => prev + 1);
      setAppliedVersionId(null);
    },
    [histIdx],
  );

  const getActiveObb = useCallback(() => liveObbRef.current, []);

  const handleUndo = useCallback(() => {
    if (canUndo) setHistIdx((p) => p - 1);
  }, [canUndo]);
  const handleRevert = useCallback(() => {
    setHistIdx(0);
  }, []);
  const cloneObb = useCallback(
    (source: ObbParams): ObbParams => ({
      center: [...source.center] as [number, number, number],
      rotation: [...source.rotation] as [number, number, number],
      scale: [...source.scale] as [number, number, number],
    }),
    [],
  );

  const getSceneBlob = useCallback(async (): Promise<{ blob: Blob; ext: string } | null> => {
    if (!hasLocalSceneEdits) return null;
    if (isGlb) {
      const group = glbGroupRef.current;
      group?.updateWorldMatrix(true, true);
      if (!group) return null;
      const exportScene = group.clone(true);
      const [px, py, pz] = previewCenterRef.current;
      exportScene.position.add(new THREE.Vector3(px, py, pz));
      if (countMeshFaces(exportScene) === 0) return null;
      const mod = await import('three/addons/exporters/GLTFExporter.js').catch(
        () => import('three/examples/jsm/exporters/GLTFExporter.js'),
      );
      const exporter = new mod.GLTFExporter();
      const result = await new Promise<ArrayBuffer>((resolve, reject) => {
        exporter.parse(
          exportScene,
          (value: ArrayBuffer | ArrayBufferView | unknown) => {
            if (value instanceof ArrayBuffer) { resolve(value); return; }
            if (ArrayBuffer.isView(value)) {
              const copy = new Uint8Array(value.byteLength);
              copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
              resolve(copy.buffer); return;
            }
            reject(new Error('GLB 내보내기 결과를 해석할 수 없습니다.'));
          },
          (error: unknown) => reject(error),
          { binary: true },
        );
      });
      return { blob: new Blob([result], { type: 'model/gltf-binary' }), ext: 'glb' };
    }
    const response = await fetch(sceneUrl);
    const blob = await response.blob();
    return { blob, ext: 'ply' };
  }, [hasLocalSceneEdits, isGlb, sceneUrl]);

  const getExtractedAssetBlob = useCallback(async (): Promise<{ blob: Blob; ext: string; assetType: AssetType } | null> => {
    if (isGlb) {
      const activeObb = getActiveObb();
      const group = glbGroupRef.current;
      group?.updateWorldMatrix(true, true);
      if (!group) return null;

      const extractedScene = new THREE.Group();
      const [px, py, pz] = previewCenterRef.current;
      extractedScene.position.set(px, py, pz);
      let totalFaces = 0;

      group.traverse((child: THREE.Object3D) => {
        if (!(child instanceof THREE.Mesh)) return;
        const filtered = filterMeshInObb(child, activeObb.center, activeObb.rotation, activeObb.scale);
        if (!filtered) return;

        totalFaces += filtered.faceCount;
        const sourceMat = Array.isArray(child.material) ? child.material[0] : child.material;
        const mat = sourceMat ? sourceMat.clone() : new THREE.MeshStandardMaterial({ color: '#d1d5db' });
        const extractedMesh = new THREE.Mesh(filtered.geometry, mat);
        extractedMesh.name = child.name || 'extracted-mesh';
        extractedScene.add(extractedMesh);
      });

      if (totalFaces === 0) return null;

      const mod = await import('three/addons/exporters/GLTFExporter.js').catch(
        () => import('three/examples/jsm/exporters/GLTFExporter.js'),
      );
      const exporter = new mod.GLTFExporter();
      const result = await new Promise<ArrayBuffer>((resolve, reject) => {
        exporter.parse(
          extractedScene,
          (value: ArrayBuffer | ArrayBufferView | unknown) => {
            if (value instanceof ArrayBuffer) {
              resolve(value);
              return;
            }
            if (ArrayBuffer.isView(value)) {
              const copy = new Uint8Array(value.byteLength);
              copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
              resolve(copy.buffer);
              return;
            }
            reject(new Error('GLB 추출 결과를 해석할 수 없습니다.'));
          },
          (error: unknown) => reject(error),
          { binary: true },
        );
      });

      return {
        blob: new Blob([result], { type: 'model/gltf-binary' }),
        ext: 'glb',
        assetType: 'mesh',
      };
    }

    const sourceObb = getActiveObb();
    let activeObb = sourceObb;
    const assetGroup = assetGroupRef.current;
    if (assetGroup) {
      const q = assetGroup.quaternion;
      if (!(q.x === 0 && q.y === 0 && q.z === 0 && q.w === 1)) {
        const invQ = q.clone().invert();
        const invMat = new THREE.Matrix4().makeRotationFromQuaternion(invQ);
        const localCenter = new THREE.Vector3(...sourceObb.center).applyMatrix4(invMat);
        const obbQuat = new THREE.Quaternion().setFromEuler(
          new THREE.Euler(
            (sourceObb.rotation[0] * Math.PI) / 180,
            (sourceObb.rotation[1] * Math.PI) / 180,
            (sourceObb.rotation[2] * Math.PI) / 180,
          ),
        );
        const localObbQuat = invQ.clone().multiply(obbQuat);
        const localEuler = new THREE.Euler().setFromQuaternion(localObbQuat);
        activeObb = {
          center: [localCenter.x, localCenter.y, localCenter.z],
          rotation: [
            (localEuler.x * 180) / Math.PI,
            (localEuler.y * 180) / Math.PI,
            (localEuler.z * 180) / Math.PI,
          ],
          scale: sourceObb.scale,
        };
      }
    }
    const extractedAssetType: AssetType = isGaussianAsset ? 'gaussian' : 'point_cloud';
    const full = fullDataRef.current;
    if (full) {
      const keepMask = buildPointKeepMaskInObb(full.positions, activeObb.center, activeObb.rotation, activeObb.scale);
      if (keepMask) {
        const filteredBlob = writeFilteredPlyBinary(full, keepMask);
        if (filteredBlob) {
          return {
            blob: filteredBlob,
            ext: 'ply',
            assetType: extractedAssetType,
          };
        }
      }
    }

    const data = croppedData.current;
    if (!data) return null;

    const [px, py, pz] = previewCenterRef.current;
    const worldPos = new Float32Array(data.positions.length);
    for (let i = 0; i < data.positions.length; i += 3) {
      worldPos[i] = data.positions[i] + px;
      worldPos[i + 1] = data.positions[i + 1] + py;
      worldPos[i + 2] = data.positions[i + 2] + pz;
    }

    return {
      blob: writePlyBinary(worldPos, data.colors),
      ext: 'ply',
      assetType: extractedAssetType,
    };
  }, [getActiveObb, isGaussianAsset, isGlb]);

  const handleCreateVersion = useCallback(async () => {
    if (editingVersionId ? !onUpdateVersion : !onCreateVersion) return;

    const activeObb = cloneObb(getActiveObb());
    setVersionSaving(true);
    try {
      if (editingVersionId) {
        await onUpdateVersion?.({
          versionId: editingVersionId,
          description: versionDescription.trim() || undefined,
          obb: activeObb,
        });
      } else {
        const sceneBlobData = await getSceneBlob().catch(() => null);
        const created = await onCreateVersion?.({
          description: versionDescription.trim() || undefined,
          obb: activeObb,
          sceneBlob: sceneBlobData?.blob,
          sceneExt: sceneBlobData?.ext,
        });
        if (created) setAppliedVersionId(created.id);
      }
      setHistory([activeObb]);
      setHistIdx(0);
      setVersionPanelTab('load');
      setVersionDescription('');
      setEditingVersionId(null);
      showToast(editingVersionId ? '버전을 수정했습니다.' : '버전을 저장했습니다.');
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : editingVersionId
          ? '버전 수정에 실패했습니다.'
          : '버전 저장에 실패했습니다.';
      showToast(message, 'err');
    } finally {
      setVersionSaving(false);
    }
  }, [cloneObb, editingVersionId, getActiveObb, getSceneBlob, onCreateVersion, onUpdateVersion, showToast, versionDescription]);

  const applyVersion = useCallback((version: AssetObbVersion) => {
    const cloned = cloneObb(version.obb);
    liveObbRef.current = cloned;
    setLiveObb(cloned);
    setHistory([cloned]);
    setHistIdx(0);
    setAppliedVersionId(version.id);
    draftObbChangeRef.current?.(cloned);

    if (version.sceneObject && getSceneUrl) {
      clearCutSelectionPreview();
      if (tempSceneUrlRef.current) {
        URL.revokeObjectURL(tempSceneUrlRef.current);
        tempSceneUrlRef.current = null;
      }
      disposeGeneratedMeshGeometries();
      setSceneUrl(getSceneUrl(version.sceneObject));
      setViewAsGaussian(false);
      setCutStroke([]);
      setIsCutDragging(false);
      setIsExtracted(false);
      setGlbResetKey((prev) => prev + 1);
      setGlbEditVersion(0);
      croppedData.current = null;
    } else {
      restoreScene(false);
    }

    showToast('선택한 버전으로 불러왔습니다.');
  }, [cloneObb, clearCutSelectionPreview, disposeGeneratedMeshGeometries, getSceneUrl, restoreScene, showToast]);

  // 에셋 그룹 회전이 적용된 경우 OBB를 로컬 공간으로 역변환
  const getLocalObb = useCallback(
    (obb: ObbParams): ObbParams => {
      const group = assetGroupRef.current;
      if (!group) return obb;
      const q = group.quaternion;
      if (q.x === 0 && q.y === 0 && q.z === 0 && q.w === 1) return obb;
      const invQ = q.clone().invert();
      const invMat = new THREE.Matrix4().makeRotationFromQuaternion(invQ);
      const localCenter = new THREE.Vector3(...obb.center).applyMatrix4(invMat);
      const obbQuat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          (obb.rotation[0] * Math.PI) / 180,
          (obb.rotation[1] * Math.PI) / 180,
          (obb.rotation[2] * Math.PI) / 180,
        ),
      );
      const localObbQuat = invQ.clone().multiply(obbQuat);
      const localEuler = new THREE.Euler().setFromQuaternion(localObbQuat);
      return {
        center: [localCenter.x, localCenter.y, localCenter.z],
        rotation: [(localEuler.x * 180) / Math.PI, (localEuler.y * 180) / Math.PI, (localEuler.z * 180) / Math.PI],
        scale: obb.scale,
      };
    },
    [assetGroupRef],
  );

  // ── 추출 미리보기 (뷰포트에 결과 표시) ──────────────────────
  const handleExtract = useCallback(() => {
    const full = fullDataRef.current;
    const points = pointsRef.current;
    if (!full || !points) {
      showToast('포인트 클라우드가 아직 로드되지 않았습니다.', 'err');
      return;
    }

    const activeObb = getLocalObb(getActiveObb());
    const result = filterPointsInObb(
      full.positions,
      full.colors,
      activeObb.center,
      activeObb.rotation,
      activeObb.scale,
    );
    if (!result) {
      showToast('선택 영역 안에 포인트가 없습니다.', 'err');
      return;
    }

    croppedData.current = result;

    const newGeo = buildGeo(result);
    const oldGeo = points.geometry;
    points.geometry = newGeo;
    oldGeo.dispose();
    fitCameraRef.current?.(newGeo);

    setIsExtracted(true);
    showToast(`추출 미리보기 — ${(result.positions.length / 3) | 0}개 포인트 (다운로드하려면 [다운로드] 클릭)`);
  }, [getActiveObb, getLocalObb, showToast]);

  // ── 추출 취소 (원본 복원) ────────────────────────────────────
  const handleExtractCancel = useCallback(() => {
    const full = fullDataRef.current;
    const points = pointsRef.current;
    if (!full || !points) return;
    const oldGeo = points.geometry;
    points.geometry = buildGeo(full);
    oldGeo.dispose();
    croppedData.current = null;
    setIsExtracted(false);
    showToast('추출이 취소되었습니다.');
  }, [showToast]);

  // ── 다운로드 (PLY / GLB) ─────────────────────────────────────
  const handleLegacyFreeCut = useCallback(async () => {
    if (!isGaussianAsset) return;

    const camera = cameraRef.current;
    const data = fullDataRef.current;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!camera || !data || !rect || rect.width <= 0 || rect.height <= 0) {
      showToast('가우시안 데이터가 아직 준비되지 않았습니다.', 'err');
      return;
    }
    if (cutStroke.length < 2) {
      showToast('먼저 드래그해서 지울 경로를 그려주세요.', 'err');
      return;
    }

    setExtractLoading(true);
    try {
      const keepMask = buildStrokeKeepMask(data, camera, cutStroke, rect.width, rect.height);
      if (!keepMask) {
        showToast('드래그한 경로와 겹치는 가우시안이 없습니다.', 'err');
        return;
      }

      const nextBlob = writeFilteredPlyBinary(data, keepMask);
      if (!nextBlob) {
        showToast('모든 가우시안이 삭제되어 컷을 적용할 수 없습니다.', 'err');
        return;
      }

      if (tempSceneUrlRef.current) {
        URL.revokeObjectURL(tempSceneUrlRef.current);
      }
      tempSceneUrlRef.current = URL.createObjectURL(nextBlob);
      setSceneUrl(tempSceneUrlRef.current);
      setViewAsGaussian(false);
      setCutStroke([]);
      setIsCutDragging(false);
      setIsExtracted(false);
      croppedData.current = null;
      showToast('드래그한 경로 주변 3DGS를 잘라냈습니다.');
    } catch (error) {
      showToast((error as Error).message ?? '자유 컷 적용에 실패했습니다.', 'err');
    } finally {
      setExtractLoading(false);
    }
  }, [cutStroke, isGaussianAsset, setViewAsGaussian, showToast]);

  const handleLegacyViewportPointerDownCapture = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || !isGaussianAsset || busy || measureMode || !(cutMode || e.shiftKey)) {
        return;
      }

      const point = getViewportPoint(e.clientX, e.clientY);
      if (!point) return;

      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      setIsCutDragging(true);
      setCutStroke([point]);
    },
    [busy, cutMode, getViewportPoint, isGaussianAsset, measureMode],
  );

  const handleLegacyViewportPointerMoveCapture = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!isCutDragging) return;
      const point = getViewportPoint(e.clientX, e.clientY);
      if (!point) return;

      e.preventDefault();
      e.stopPropagation();
      pushCutPoint(point);
    },
    [getViewportPoint, isCutDragging, pushCutPoint],
  );

  const handleLegacyViewportPointerUpCapture = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!isCutDragging) return;

      e.preventDefault();
      e.stopPropagation();
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      setIsCutDragging(false);
    },
    [isCutDragging],
  );

  void handleLegacyFreeCut;
  void handleLegacyViewportPointerDownCapture;
  void handleLegacyViewportPointerMoveCapture;
  void handleLegacyViewportPointerUpCapture;

  const buildCurrentCutSelection = useCallback((): CutSelection | null => {
    if (cutStroke.length < 2) return null;

    const camera = cameraRef.current;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!camera || !rect || rect.width <= 0 || rect.height <= 0) return null;

    if (isGlb) {
      const group = glbGroupRef.current;
      if (!group) return null;
      return buildMeshCutSelection(group, camera, cutStroke, rect.width, rect.height);
    }

    const data = fullDataRef.current;
    if (!data) return null;
    return buildPointCutSelection(data, camera, cutStroke, rect.width, rect.height);
  }, [cutStroke, isGlb]);

  useEffect(() => {
    if (cutStroke.length === 0) {
      clearCutSelectionPreview();
      return;
    }
    if (cutStroke.length < 2 || busy || measureMode || isExtracted) return;

    let cancelled = false;
    // 사각형 선택은 드래그 중에도 빠르게 업데이트
    const delay = isCutDragging ? 80 : 30;
    const timeoutId = window.setTimeout(() => {
      const selection = buildCurrentCutSelection();
      if (cancelled) {
        disposeCutSelection(selection);
        return;
      }
      replaceCutSelectionPreview(selection);
    }, delay);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [
    buildCurrentCutSelection,
    busy,
    clearCutSelectionPreview,
    cutStroke.length,
    disposeCutSelection,
    isCutDragging,
    isExtracted,
    measureMode,
    replaceCutSelectionPreview,
  ]);

  const handleFreeCut = useCallback(async () => {
    if (cutStroke.length < 2) {
      showToast('먼저 드래그해서 자를 경로를 그려주세요.', 'err');
      return;
    }

    let selection = cutSelectionRef.current;
    const selectionFromPreview = !!selection;
    if (!selection) selection = buildCurrentCutSelection();

    if (!selection) {
      showToast('드래그 경로와 겹치는 영역을 찾지 못했습니다.', 'err');
      return;
    }

    setExtractLoading(true);
    try {
      if (selection.kind === 'mesh') {
        selection.patches.forEach((patch) => {
          const oldGeometry = patch.mesh.geometry;
          if (generatedMeshGeometriesRef.current.has(oldGeometry)) {
            oldGeometry.dispose();
            generatedMeshGeometriesRef.current.delete(oldGeometry);
          }

          if (patch.geometry) {
            patch.mesh.geometry = patch.geometry;
            patch.mesh.visible = true;
            generatedMeshGeometriesRef.current.add(patch.geometry);
            return;
          }

          patch.mesh.visible = false;
        });

        if (selectionFromPreview) {
          clearCutSelectionPreview({ preserveMeshPatchGeometries: true });
        } else {
          disposeCutSelection(selection, { preserveMeshPatchGeometries: true });
        }

        setCutStroke([]);
        setIsCutDragging(false);
        setIsExtracted(false);
        croppedData.current = null;
        setGlbEditVersion((prev) => prev + 1);
        showToast(`선택된 ${selection.removedFaceCount.toLocaleString()}개 면을 잘라냈습니다.`);
        return;
      }

      const data = fullDataRef.current;
      if (!data) {
        showToast('포인트 데이터를 아직 불러오지 못했습니다.', 'err');
        return;
      }

      const nextBlob = writeFilteredPlyBinary(data, selection.keepMask);
      if (!nextBlob) {
        showToast('선택된 영역을 제외하면 장면이 비어 잘라낼 수 없습니다.', 'err');
        return;
      }

      if (selectionFromPreview) clearCutSelectionPreview();
      else disposeCutSelection(selection);

      if (tempSceneUrlRef.current) {
        URL.revokeObjectURL(tempSceneUrlRef.current);
      }
      tempSceneUrlRef.current = URL.createObjectURL(nextBlob);
      setSceneUrl(tempSceneUrlRef.current);
      setViewAsGaussian(false);
      setCutStroke([]);
      setIsCutDragging(false);
      setIsExtracted(false);
      croppedData.current = null;
      showToast(`선택된 ${selection.selectedCount.toLocaleString()}개 포인트를 잘라냈습니다.`);
    } catch (error) {
      showToast((error as Error).message ?? '드래그 컷 적용에 실패했습니다.', 'err');
    } finally {
      setExtractLoading(false);
    }
  }, [
    buildCurrentCutSelection,
    clearCutSelectionPreview,
    cutStroke.length,
    disposeCutSelection,
    setViewAsGaussian,
    showToast,
  ]);

  const handleViewportPointerDownCapture = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || busy || measureMode || isExtracted || !(cutMode || e.shiftKey)) {
        return;
      }

      const point = getViewportPoint(e.clientX, e.clientY);
      if (!point) return;

      clearCutSelectionPreview();
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      isCutDraggingRef.current = true;
      setIsCutDragging(true);
      setCutStroke([point]);
    },
    [busy, clearCutSelectionPreview, cutMode, getViewportPoint, isExtracted, measureMode, isCutDraggingRef],
  );

  const handleViewportPointerMoveCapture = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!isCutDraggingRef.current) return;

      const point = getViewportPoint(e.clientX, e.clientY);
      if (!point) return;

      e.preventDefault();
      e.stopPropagation();
      // 사각형 선택: 시작점과 현재점 2개만 유지
      setCutStroke((prev) => (prev.length > 0 ? [prev[0], point] : [point]));
    },
    [getViewportPoint, isCutDraggingRef],
  );

  const handleViewportPointerUpCapture = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!isCutDraggingRef.current) return;

      e.preventDefault();
      e.stopPropagation();
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      isCutDraggingRef.current = false;
      setIsCutDragging(false);
    },
    [isCutDraggingRef],
  );

  const handleLegacyDownload = useCallback(async () => {
    setExtractLoading(true);
    try {
      const activeObb = getActiveObb();
      if (isGlb) {
        // ── GLB 메시 추출 ────────────────────────────────────
        const group = glbGroupRef.current;
        group?.updateWorldMatrix(true, true);
        if (!group) {
          showToast('GLB 모델이 로드되지 않았습니다.', 'err');
          return;
        }

        // 면을 필터링한 새 씬 구성
        const extractedScene = new THREE.Group();
        const [px, py, pz] = previewCenterRef.current;
        extractedScene.position.set(px, py, pz);
        let totalFaces = 0;
        group.traverse((child: THREE.Object3D) => {
          if (!(child instanceof THREE.Mesh)) return;
          const filtered = filterMeshInObb(child, activeObb.center, activeObb.rotation, activeObb.scale);
          if (!filtered) return;
          totalFaces += filtered.faceCount;
          const sourceMat = Array.isArray(child.material) ? child.material[0] : child.material;
          const mat = sourceMat ? sourceMat.clone() : new THREE.MeshStandardMaterial({ color: '#d1d5db' });
          const extractedMesh = new THREE.Mesh(filtered.geometry, mat);
          extractedMesh.name = child.name || 'extracted-mesh';
          extractedScene.add(extractedMesh);
        });

        if (totalFaces === 0) {
          showToast('선택 영역 안에 면이 없습니다.', 'err');
          return;
        }

        const mod = await import('three/addons/exporters/GLTFExporter.js').catch(
          () => import('three/examples/jsm/exporters/GLTFExporter.js'),
        );
        const exporter = new mod.GLTFExporter();
        const result = await new Promise<ArrayBuffer>((resolve, reject) => {
          exporter.parse(
            extractedScene,
            (value: ArrayBuffer | ArrayBufferView | unknown) => {
              if (value instanceof ArrayBuffer) {
                resolve(value);
                return;
              }
              if (ArrayBuffer.isView(value)) {
                const copy = new Uint8Array(value.byteLength);
                copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
                resolve(copy.buffer);
                return;
              }
              reject(new Error('GLB 추출 결과 형식을 해석할 수 없습니다.'));
            },
            (err: unknown) => reject(err),
            { binary: true },
          );
        });
        const safeName = downloadBaseName.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'extract';

        // GLB 다운로드
        const glbBlob = new Blob([result], { type: 'model/gltf-binary' });
        downloadBlob(glbBlob, `${safeName}-extract.glb`);

        // PLY(메시) 다운로드 — CloudCompare 등 외부 툴용
        const plyBlob = writeMeshPlyBinary(extractedScene);
        if (plyBlob) downloadBlob(plyBlob, `${safeName}-extract.ply`);

        showToast(`추출 완료 — ${totalFaces.toLocaleString()}개 면 (GLB + PLY)`);
      } else {
        // ── PLY 포인트 클라우드 추출 ─────────────────────────
        const cd = croppedData.current;
        if (!cd) {
          showToast('먼저 추출 미리보기를 실행하세요.', 'err');
          return;
        }
        const [px, py, pz] = previewCenterRef.current;
        const worldPos = new Float32Array(cd.positions.length);
        for (let i = 0; i < cd.positions.length; i += 3) {
          worldPos[i] = cd.positions[i] + px;
          worldPos[i + 1] = cd.positions[i + 1] + py;
          worldPos[i + 2] = cd.positions[i + 2] + pz;
        }
        const blob = writePlyBinary(worldPos, cd.colors);
        downloadBlob(blob, `${downloadBaseName.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'extract'}-extract.ply`);
        showToast('PLY 다운로드 완료');
      }
    } catch (e: unknown) {
      showToast((e as Error).message ?? '다운로드 실패', 'err');
    } finally {
      setExtractLoading(false);
    }
  }, [downloadBaseName, getActiveObb, isGlb, showToast]);

  // ── 거리 측정 ────────────────────────────────────────────────
  const handleDownload = useCallback(async () => {
    if (!hasLocalSceneEdits || isExtracted) {
      await handleLegacyDownload();
      return;
    }

    setExtractLoading(true);
    try {
      const safeName = downloadBaseName.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'extract';

      if (isGlb) {
        const group = glbGroupRef.current;
        group?.updateWorldMatrix(true, true);
        if (!group) {
          showToast('GLB 모델을 아직 불러오지 못했습니다.', 'err');
          return;
        }

        const exportScene = group.clone(true);
        const [px, py, pz] = previewCenterRef.current;
        exportScene.position.add(new THREE.Vector3(px, py, pz));

        const totalFaces = countMeshFaces(exportScene);
        if (totalFaces === 0) {
          showToast('잘라낸 뒤 남은 메시 면이 없습니다.', 'err');
          return;
        }

        const mod = await import('three/addons/exporters/GLTFExporter.js').catch(
          () => import('three/examples/jsm/exporters/GLTFExporter.js'),
        );
        const exporter = new mod.GLTFExporter();
        const result = await new Promise<ArrayBuffer>((resolve, reject) => {
          exporter.parse(
            exportScene,
            (value: ArrayBuffer | ArrayBufferView | unknown) => {
              if (value instanceof ArrayBuffer) {
                resolve(value);
                return;
              }
              if (ArrayBuffer.isView(value)) {
                const copy = new Uint8Array(value.byteLength);
                copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
                resolve(copy.buffer);
                return;
              }
              reject(new Error('GLB 내보내기 결과를 해석할 수 없습니다.'));
            },
            (error: unknown) => reject(error),
            { binary: true },
          );
        });

        downloadBlob(new Blob([result], { type: 'model/gltf-binary' }), `${safeName}-cut.glb`);
        const plyBlob = writeMeshPlyBinary(exportScene);
        if (plyBlob) downloadBlob(plyBlob, `${safeName}-cut.ply`);
        showToast(`편집된 메시 ${totalFaces.toLocaleString()}개 면을 다운로드했습니다.`);
        return;
      }

      const response = await fetch(sceneUrl);
      const blob = await response.blob();
      downloadBlob(blob, `${safeName}-cut.ply`);
      showToast('편집된 포인트 장면을 다운로드했습니다.');
    } catch (error) {
      showToast((error as Error).message ?? '다운로드에 실패했습니다.', 'err');
    } finally {
      setExtractLoading(false);
    }
  }, [downloadBaseName, handleLegacyDownload, hasLocalSceneEdits, isExtracted, isGlb, sceneUrl, showToast]);

  const handleSaveToServer = useCallback(async () => {
    if (!onSaveEdit || !hasLocalSceneEdits) return;
    setSaveEditLoading(true);
    try {
      if (isGlb) {
        const group = glbGroupRef.current;
        group?.updateWorldMatrix(true, true);
        if (!group) {
          showToast('GLB 모델을 아직 불러오지 못했습니다.', 'err');
          return;
        }
        if (countMeshFaces(group) === 0) {
          showToast('잘라낸 뒤 남은 메시 면이 없습니다.', 'err');
          return;
        }
      }
      const sceneBlobData = await getSceneBlob();
      if (!sceneBlobData) {
        showToast('저장할 씬 데이터가 없습니다.', 'err');
        return;
      }
      await onSaveEdit(sceneBlobData.blob, sceneBlobData.ext);
      showToast(isGlb ? '편집된 GLB가 서버에 저장되었습니다.' : '편집된 포인트 장면이 서버에 저장되었습니다.');
    } catch (error) {
      showToast((error as Error).message ?? '서버 저장에 실패했습니다.', 'err');
    } finally {
      setSaveEditLoading(false);
    }
  }, [getSceneBlob, hasLocalSceneEdits, isGlb, onSaveEdit, showToast]);

  const handleSaveExtractedAsset = useCallback(async () => {
    if (!onSaveExtractedAsset) return;

    if (!isGlb && !isExtracted) {
      showToast('먼저 추출 미리보기를 실행하세요.', 'err');
      return;
    }

    setSaveExtractedAssetLoading(true);
    try {
      const extracted = await getExtractedAssetBlob();
      if (!extracted) {
        showToast(isGlb ? '선택 영역 안에 메쉬가 없습니다.' : '저장할 추출 결과가 없습니다.', 'err');
        return;
      }

      await onSaveExtractedAsset(extracted);
      showToast(
        extracted.assetType === 'mesh'
          ? '추출 메쉬를 새 에셋으로 저장했습니다.'
          : '추출 포인트 클라우드를 새 에셋으로 저장했습니다.',
      );
    } catch (error) {
      showToast((error as Error).message ?? '추출 에셋 저장에 실패했습니다.', 'err');
    } finally {
      setSaveExtractedAssetLoading(false);
    }
  }, [getExtractedAssetBlob, isExtracted, isGlb, onSaveExtractedAsset, showToast]);

  const handleMeasureClick = useCallback((pt: THREE.Vector3) => {
    setMeasurePts((prev: THREE.Vector3[]) => {
      if (prev.length >= 2) return [pt]; // 3번째 클릭 → 초기화 후 새 시작
      return [...prev, pt];
    });
  }, []);

  const measureDistanceRaw = measurePts.length === 2 ? measurePts[0].distanceTo(measurePts[1]) : null;
  const measureDistance = measureDistanceRaw !== null ? measureDistanceRaw * calibrationScale : null;
  const calibrationReferenceLengthMeters = useMemo(() => {
    const raw = parseFloat(calibrationInput);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    if (calibrationUnit === 'cm') return raw / 100;
    if (calibrationUnit === 'mm') return raw / 1000;
    return raw;
  }, [calibrationInput, calibrationUnit]);
  const canSaveCalibration =
    measureDistanceRaw !== null &&
    measureDistanceRaw > 0 &&
    calibrationReferenceLengthMeters !== null &&
    calibrationReferenceLengthMeters > 0 &&
    !calibrationSaving;
  const isLiveDirty =
    liveObb.center.some((value, index) => value !== obb.center[index]) ||
    liveObb.rotation.some((value, index) => value !== obb.rotation[index]) ||
    liveObb.scale.some((value, index) => value !== obb.scale[index]);
  const currentVersionId = useMemo(
    () => {
      if (appliedVersionId && versions.some((v) => v.id === appliedVersionId)) return appliedVersionId;
      return versions.find((version) => sameObb(version.obb, liveObb))?.id ?? null;
    },
    [appliedVersionId, liveObb, versions],
  );
  const editingVersion = useMemo(
    () => versions.find((version) => version.id === editingVersionId) ?? null,
    [editingVersionId, versions],
  );
  const handleToggleVersionPanel = useCallback(() => {
    if (!isVersionPanelOpen) {
      setVersionPanelTab(isDirty || isLiveDirty ? 'save' : 'load');
    }
    setIsVersionPanelOpen((prev) => !prev);
  }, [isDirty, isLiveDirty, isVersionPanelOpen]);
  const handleStartVersionEdit = useCallback((version: AssetObbVersion) => {
    applyVersion(version);
    setEditingVersionId(version.id);
    setVersionDescription(version.description);
    setVersionPanelTab('save');
  }, [applyVersion]);
  const handleCancelVersionEdit = useCallback(() => {
    setEditingVersionId(null);
    setVersionDescription('');
  }, []);
  const handleDeleteVersion = useCallback(async (version: AssetObbVersion) => {
    if (!onDeleteVersion) return;
    if (!window.confirm('이 버전을 삭제하시겠습니까?')) return;

    const remainingVersions = versions.filter((item) => item.id !== version.id);
    setDeletingVersionId(version.id);
    try {
      await onDeleteVersion(version.id);
      if (editingVersionId === version.id) {
        setEditingVersionId(null);
        setVersionDescription('');
        setVersionPanelTab('load');
      }
      if (currentVersionId === version.id && remainingVersions[0]) {
        applyVersion(remainingVersions[0]);
      }
      showToast('버전을 삭제했습니다.');
    } catch (error) {
      showToast((error as Error).message ?? '버전 삭제에 실패했습니다.', 'err');
    } finally {
      setDeletingVersionId(null);
    }
  }, [applyVersion, currentVersionId, editingVersionId, onDeleteVersion, showToast, versions]);

  const handleSaveCalibration = useCallback(async () => {
    if (!canSaveCalibration || measureDistanceRaw === null || calibrationReferenceLengthMeters === null) return;

    const nextScale = calibrationReferenceLengthMeters / measureDistanceRaw;
    setCalibrationSaving(true);
    try {
      await onSaveCalibration?.(nextScale, calibrationReferenceLengthMeters, measureDistanceRaw);
      setCalibrationScale(nextScale);
      showToast(`실측 보정 저장 완료 — 기준 길이 ${calibrationReferenceLengthMeters.toFixed(3)}m`);
    } catch (error) {
      showToast((error as Error).message ?? '실측 보정 저장에 실패했습니다.', 'err');
    } finally {
      setCalibrationSaving(false);
    }
  }, [calibrationReferenceLengthMeters, canSaveCalibration, measureDistanceRaw, onSaveCalibration, showToast]);

  // ── Ctrl+Z ───────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;

      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        if (cutStroke.length > 0) {
          clearCutStroke(true);
          return;
        }
        handleUndo();
        return;
      }

      if (!e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'c' && !measureMode && !busy) {
        e.preventDefault();
        if (cutStroke.length > 0) {
          void handleFreeCut();
        } else if (hasLocalSceneEdits) {
          void handleDownload();
        } else if (isGlb) {
          void handleDownload();
        } else if (!isExtracted) {
          handleExtract();
        }
        return;
      }

      if (e.key === 'g' || e.key === 'G') {
        setGdtMode((prev) => !prev);
        setMeasureMode(false);
        setMeasurePts([]);
        setGdtPending(null);
        return;
      }

      if (e.key === 'Escape') {
        if (gdtMode) {
          setGdtMode(false);
          setGdtPending(null);
          return;
        }
        if (measureMode) {
          setMeasureMode(false);
          setMeasurePts([]);
          return;
        }

        if (cutStroke.length > 0) {
          clearCutStroke(true);
          return;
        }

        if (isExtracted && !busy) {
          handleExtractCancel();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    busy,
    clearCutStroke,
    cutStroke.length,
    handleDownload,
    handleExtract,
    handleExtractCancel,
    handleFreeCut,
    handleUndo,
    hasLocalSceneEdits,
    isExtracted,
    isGlb,
    measureMode,
  ]);

  const fmt = (arr: number[]) => arr.map((v) => v.toFixed(3)).join(', ');

  useEffect(() => {
    const { body, documentElement } = document;
    const prevBodyOverflow = body.style.overflow;
    const prevHtmlOverflow = documentElement.style.overflow;

    body.style.overflow = 'hidden';
    documentElement.style.overflow = 'hidden';

    return () => {
      body.style.overflow = prevBodyOverflow;
      documentElement.style.overflow = prevHtmlOverflow;
    };
  }, []);

  const editorLayout = (
    <div
      className="fixed inset-0 z-[60] m-0 flex h-screen w-screen flex-col overflow-hidden bg-gray-950"
      style={{ inset: 0, minHeight: '100dvh' }}
    >
      {/* ── 툴바 ── */}
      <div className="flex items-center gap-2 px-4 py-2 bg-gray-900 border-b border-gray-700 shrink-0 flex-wrap">
        <span className="text-white text-sm font-semibold mr-1">영역 편집</span>

        {/* 모드 (추출 미리보기 중이 아닐 때만) */}
        {!isExtracted && (
          <div className="flex rounded overflow-hidden border border-gray-600">
            {(['translate', 'rotate', 'scale'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-3 py-1 text-xs transition-colors ${mode === m ? 'bg-orange-500 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
              >
                {{ translate: '이동', rotate: '회전', scale: '크기' }[m]}
              </button>
            ))}
          </div>
        )}

        <div className="w-px h-5 bg-gray-700 mx-1" />

        {/* 거리 측정 모드 */}
        <button
          onClick={() => {
            setMeasureMode((m: boolean) => {
              // 켤 때: 혹시 남은 suppress 플래그 초기화
              // 끌 때: 버튼 클릭 이벤트가 canvas에 전파되지 않으므로 suppress 불필요
              suppressNextMeasureClick.current = false;
              return !m;
            });
            setMeasurePts([]);
            setCutMode(false);
            setIsCutDragging(false);
          }}
          className={`flex items-center gap-1 px-2 py-1 text-xs rounded border transition-colors ${
            measureMode
              ? 'border-yellow-400 bg-yellow-900/40 text-yellow-300'
              : 'border-gray-600 text-gray-300 hover:bg-gray-700'
          }`}
          title="두 점을 클릭하여 거리 측정"
        >
          <Icon d="M3 7h18M3 12h18M3 17h18" className="w-3.5 h-3.5" />
          측정{measureMode && measurePts.length > 0 && ` (${measurePts.length}/2)`}
        </button>

        {/* GD&T 기하 공차 모드 */}
        <button
          onClick={() => {
            setGdtMode((m) => !m);
            setMeasureMode(false);
            setMeasurePts([]);
            setGdtPending(null);
            setCutMode(false);
          }}
          className={`flex items-center gap-1 px-2 py-1 text-xs rounded border transition-colors ${
            gdtMode
              ? 'border-purple-400 bg-purple-900/40 text-purple-300'
              : 'border-gray-600 text-gray-300 hover:bg-gray-700'
          }`}
          title="GD&T 기하 공차 표기 (G)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5">
            <rect x="3" y="8" width="18" height="8" rx="1" />
            <path d="M9 8V6M15 8V6M3 12h3M18 12h3" />
            <circle cx="12" cy="12" r="1.5" fill="currentColor" />
          </svg>
          GD&T{gdtMode && ' (G)'}
        </button>

        {gdtAnnotations.length > 0 && (
          <button
            onClick={() => setGdtVisible((v) => !v)}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded border transition-colors ${
              gdtVisible
                ? 'border-purple-600 text-purple-300 hover:bg-gray-700'
                : 'border-gray-600 text-gray-500 hover:bg-gray-700'
            }`}
            title="GD&T 어노테이션 표시/숨김"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5">
              {gdtVisible ? (
                <>
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </>
              ) : (
                <>
                  <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24M1 1l22 22" />
                </>
              )}
            </svg>
            {gdtVisible ? '숨기기' : '보이기'}
          </button>
        )}

        <div className="w-px h-5 bg-gray-700 mx-1" />

        {/* OBB 되돌리기 (추출 미리보기 전에만) */}
        {!isExtracted && (
          <>
            <button
              onClick={() => {
                setCutMode((prev) => {
                  const next = !prev;
                  if (next) {
                    setMeasureMode(false);
                    setMeasurePts([]);
                  }
                  return next;
                });
                setIsCutDragging(false);
              }}
              disabled={busy}
              title="자유 컷 모드"
              className={`flex items-center gap-1 px-2 py-1 text-xs rounded border transition-colors ${
                cutMode
                  ? 'border-rose-400 bg-rose-900/40 text-rose-200'
                  : 'border-gray-600 text-gray-300 hover:bg-gray-700'
              } disabled:opacity-40`}
            >
              <Icon d="M4 4l16 16M7.5 7.5l9 9M15 5l4 4-9.5 9.5a2.121 2.121 0 0 1-3 0l-1-1a2.121 2.121 0 0 1 0-3L15 5z" />
              자유 컷
            </button>
            <button
              onClick={() => clearCutStroke(true)}
              disabled={busy || cutStroke.length === 0}
              title="현재 그린 경로 지우기"
              className="flex items-center gap-1 px-2 py-1 text-xs rounded text-gray-300 hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Icon d="M6 18 18 6M6 6l12 12" />
              경로 지우기
            </button>
            {isGaussianAsset && hasLocalSceneEdits && !isExtracted && (
              <button
                onClick={() => setViewAsGaussian((v) => !v)}
                disabled={busy}
                title={viewAsGaussian ? '포인트 클라우드로 보기' : '3DGS로 보기'}
                className={`flex items-center gap-1 px-2 py-1 text-xs rounded border disabled:opacity-30 disabled:cursor-not-allowed ${viewAsGaussian ? 'border-violet-400 text-violet-300 hover:bg-violet-900/40' : 'border-violet-600 text-violet-400 hover:bg-violet-900/30'}`}
              >
                <Icon d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                {viewAsGaussian ? '포인트로 보기' : '3DGS로 보기'}
              </button>
            )}
            <button
              onClick={() => restoreScene()}
              disabled={busy || !hasLocalSceneEdits}
              title="원본 3DGS로 되돌리기"
              className="flex items-center gap-1 px-2 py-1 text-xs rounded text-gray-300 hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Icon d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
              원본 복원
            </button>
            {/*
            {/*
            {/*
            <span className={`${cutMode ? 'text-rose-300' : 'text-gray-300'} font-medium`}>
              {cutMode ? '드래그 컷 모드' : '편집 대기'}
            </span>
            <span><span className="text-gray-500 mr-1">경로 포인트</span>{cutStroke.length}</span>
            <span><span className="text-gray-500 mr-1">브러시</span>{CUT_BRUSH_RADIUS_PX}px</span>
            {cutSelectionPreview?.kind === 'points' && (
              <span className="text-rose-300">선택 포인트 {cutSelectionPreview.selectedCount.toLocaleString()}개</span>
            )}
            {cutSelectionPreview?.kind === 'mesh' && (
              <span className="text-rose-300">선택 면 {cutSelectionPreview.removedFaceCount.toLocaleString()}개</span>
            )}
            {!isGlb && <span><span className="text-gray-500 mr-1">중심</span>{fmt(liveObb.center)}</span>}
            {!isGlb && <span><span className="text-gray-500 mr-1">회전</span>{fmt(liveObb.rotation)}</span>}
            {!isGlb && <span><span className="text-gray-500 mr-1">크기</span>{fmt(liveObb.scale)}</span>}
            {isExtracted && <span className="ml-auto text-emerald-400">영역 미리보기 상태입니다. 다운로드하거나 취소할 수 있습니다.</span>}
            {!isExtracted && hasLocalSceneEdits && <span className="ml-auto text-rose-300">현재 장면에 드래그 컷 편집이 적용되어 있습니다.</span>}
            {!isExtracted && !hasLocalSceneEdits && !cutSelectionPreview && (isDirty || isLiveDirty) && <span className="ml-auto text-orange-400">저장되지 않은 OBB 변경이 있습니다.</span>}
            {!isExtracted && cutStroke.length === 0 && <span className="ml-auto text-gray-500">Shift+드래그 또는 컷 버튼 후 드래그, `C`로 자르기</span>}
            */}
          </>
        )}
        {!isExtracted && (
          <>
            <button
              onClick={handleUndo}
              disabled={!canUndo}
              title="되돌리기 (Ctrl+Z)"
              className="flex items-center gap-1 px-2 py-1 text-xs rounded text-gray-300 hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Icon d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" />
              되돌리기
            </button>
            <button
              onClick={handleRevert}
              disabled={!isDirty}
              title="마지막 저장 시점으로 복원"
              className="flex items-center gap-1 px-2 py-1 text-xs rounded text-gray-300 hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Icon d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
              원래대로
            </button>
            {onSaveExtractedAsset && (
              <button
                onClick={() => void handleSaveExtractedAsset()}
                disabled={busy || saveExtractedAssetLoading}
                className="flex items-center gap-1.5 px-3 py-1 text-xs rounded border border-cyan-500 text-cyan-300 hover:bg-cyan-900/40 disabled:opacity-40"
              >
                <Icon
                  d="M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-4-4zm-5 16a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm3-10H5V5h10v4z"
                  className="w-3.5 h-3.5"
                />
                {saveExtractedAssetLoading ? '저장 중...' : '추출 에셋 저장'}
              </button>
            )}
          </>
        )}

        <div className="flex-1" />

        {/* 박스 선택 범위 저장 (추출 전에만) */}
        {!isExtracted && (
          <button
            onClick={handleToggleVersionPanel}
            disabled={busy}
            className={`flex items-center gap-1.5 px-3 py-1 text-xs rounded border disabled:opacity-40 ${
              isVersionPanelOpen
                ? 'border-sky-400 bg-sky-900/40 text-sky-200'
                : 'border-sky-600 text-sky-300 hover:bg-sky-900/30'
            }`}
          >
            <Icon
              d="M4.5 5.25A2.25 2.25 0 0 1 6.75 3h4.864c.597 0 1.17.237 1.591.659l1.636 1.636c.422.422.659.994.659 1.591v10.364A2.25 2.25 0 0 1 13.25 19.5h-6.5A2.25 2.25 0 0 1 4.5 17.25v-12Z M9 7.5h3m-3 3h4.5M9 13.5h4.5"
              className="w-3.5 h-3.5"
            />
            버전
            {versions.length > 0 && (
              <span className="rounded-full bg-sky-500/20 px-1.5 py-0.5 text-[10px] text-sky-200">
                {versions.length}
              </span>
            )}
            {(isDirty || isLiveDirty) && <span className="w-1.5 h-1.5 rounded-full bg-orange-400 inline-block" />}
          </button>
        )}

        {/* 추출 / 추출취소 + 다운로드 */}
        {cutStroke.length >= 2 ? (
          <button
            onClick={() => void handleFreeCut()}
            disabled={busy || measureMode || cutStroke.length < 2}
            title="C: 드래그한 경로 컷 적용"
            className="flex items-center gap-1.5 px-3 py-1 text-xs rounded border border-rose-500 text-rose-200 hover:bg-rose-900/40 disabled:opacity-40"
          >
            <Icon
              d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"
              className="w-3.5 h-3.5"
            />
            {extractLoading ? '컷 적용 중..' : '드래그 컷 적용'}
          </button>
        ) : hasLocalSceneEdits ? (
          <>
            <button
              onClick={handleDownload}
              disabled={busy}
              title="C: 현재 장면 다운로드"
              className="flex items-center gap-1.5 px-3 py-1 text-xs rounded border border-emerald-500 text-emerald-300 hover:bg-emerald-900/40 disabled:opacity-40"
            >
              <Icon
                d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"
                className="w-3.5 h-3.5"
              />
              {extractLoading ? '처리 중...' : '현재 장면 다운로드'}
            </button>
            {onSaveEdit && (
              <button
                onClick={() => void handleSaveToServer()}
                disabled={busy || saveEditLoading}
                title="편집된 장면을 서버에 저장"
                className="flex items-center gap-1.5 px-3 py-1 text-xs rounded border border-blue-500 text-blue-300 hover:bg-blue-900/40 disabled:opacity-40"
              >
                <Icon
                  d="M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-4-4zm-5 16a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm3-10H5V5h10v4z"
                  className="w-3.5 h-3.5"
                />
                {saveEditLoading ? '저장 중...' : '저장'}
              </button>
            )}
          </>
        ) : !isExtracted ? (
          <>
            <button
              onClick={isGlb ? handleDownload : handleExtract}
              disabled={busy}
              title={isGlb ? 'C: 추출 다운로드' : 'C: 컷 미리보기'}
              className="flex items-center gap-1.5 px-3 py-1 text-xs rounded border border-emerald-500 text-emerald-300 hover:bg-emerald-900/40 disabled:opacity-40"
            >
              <Icon
                d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"
                className="w-3.5 h-3.5"
              />
              {extractLoading ? '추출 중...' : isGlb ? '추출 다운로드' : '추출 미리보기'}
            </button>
            {isGlb && onSaveExtractedAsset && (
              <button
                onClick={() => void handleSaveExtractedAsset()}
                disabled={busy || saveExtractedAssetLoading}
                className="flex items-center gap-1.5 px-3 py-1 text-xs rounded border border-cyan-500 text-cyan-300 hover:bg-cyan-900/40 disabled:opacity-40"
              >
                <Icon
                  d="M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-4-4zm-5 16a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm3-10H5V5h10v4z"
                  className="w-3.5 h-3.5"
                />
                {saveExtractedAssetLoading ? '저장 중...' : '추출 에셋 저장'}
              </button>
            )}
          </>
        ) : (
          <>
            <span className="text-xs text-emerald-400 font-medium">추출 미리보기</span>
            <button
              onClick={handleExtractCancel}
              disabled={busy}
              className="px-3 py-1 text-xs rounded border border-gray-500 text-gray-300 hover:bg-gray-700 disabled:opacity-40"
            >
              취소
            </button>
            <button
              onClick={handleDownload}
              disabled={busy}
              className="flex items-center gap-1.5 px-4 py-1 text-xs rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40"
            >
              {extractLoading ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  다운로드 중...
                </>
              ) : (
                <>
                  <Icon
                    d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"
                    className="w-3.5 h-3.5"
                  />
                  추출 범위 다운로드
                </>
              )}
            </button>
            {onSaveExtractedAsset && (
              <button
                onClick={() => void handleSaveExtractedAsset()}
                disabled={busy || saveExtractedAssetLoading}
                className="flex items-center gap-1.5 px-3 py-1 text-xs rounded border border-cyan-500 text-cyan-300 hover:bg-cyan-900/40 disabled:opacity-40"
              >
                <Icon
                  d="M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-4-4zm-5 16a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm3-10H5V5h10v4z"
                  className="w-3.5 h-3.5"
                />
                {saveExtractedAssetLoading ? '저장 중...' : '추출 에셋 저장'}
              </button>
            )}
          </>
        )}

        <div className="w-px h-5 bg-gray-700 mx-1" />

        <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
          배경색
          <input
            type="color"
            value={bgColor}
            onChange={(e) => setBgColor(e.target.value)}
            className="w-7 h-5 rounded cursor-pointer border-0 bg-transparent"
          />
        </label>

        <div className="w-px h-5 bg-gray-700 mx-1" />

        <button
          onClick={onClose}
          disabled={busy}
          className="px-3 py-1 text-xs bg-gray-700 text-gray-300 rounded hover:bg-gray-600 disabled:opacity-40"
        >
          닫기
        </button>
        {showConvertActions && onConfirm && (
          <>
            <button
              onClick={() => onConfirm(null)}
              disabled={busy}
              className="px-3 py-1 text-xs border border-orange-400 text-orange-300 rounded hover:bg-orange-900/40 disabled:opacity-40"
            >
              전체 변환
            </button>
            <button
              onClick={() =>
                onConfirm({
                  ...getActiveObb(),
                  previewCenter: [...previewCenterRef.current] as [number, number, number],
                  previewBounds: [...previewBoundsRef.current] as [number, number, number],
                })
              }
              disabled={busy}
              className="px-4 py-1 text-xs bg-orange-500 text-white rounded hover:bg-orange-600 disabled:opacity-40"
            >
              {loading ? '처리 중...' : '선택 범위 변환'}
            </button>
          </>
        )}
      </div>

      {/* ── 뷰포트 ── */}
      <div className="flex flex-1 min-h-0">
        <div
          ref={viewportRef}
          className="flex-1 min-w-0 relative"
          onContextMenu={(e) => e.preventDefault()}
          onPointerDownCapture={handleViewportPointerDownCapture}
          onPointerMoveCapture={handleViewportPointerMoveCapture}
          onPointerUpCapture={handleViewportPointerUpCapture}
          onPointerCancelCapture={handleViewportPointerUpCapture}
        >
        <Canvas camera={{ position: [0, 0, 3], fov: 45 }} style={{ background: bgColor }}>
          <EditorScene
            flyUrl={sceneUrl}
            obb={obb}
            mode={mode}
            onObbChange={handleObbChange}
            onLiveObbChange={handleLiveObbChange}
            fullDataRef={fullDataRef}
            pointsRef={pointsRef}
            glbGroupRef={glbGroupRef}
            onBoundsReady={handleBoundsReady}
            onPreviewCenterReady={handlePreviewCenterReady}
            fitCameraRef={fitCameraRef}
            measureMode={measureMode}
            measurePts={measurePts}
            onMeasureClick={handleMeasureClick}
            suppressClickRef={suppressNextMeasureClick}
            assetType={assetType}
            isExtracted={isExtracted}
            cameraRef={cameraRef}
            assetGroupRef={assetGroupRef}
            cutMode={cutMode}
            cutSelection={cutSelectionPreview}
            glbResetKey={glbResetKey}
            forceShowSplat={viewAsGaussian}
            gdtMode={gdtMode}
            gdtVisible={gdtVisible}
            gdtAnnotations={gdtAnnotations}
            onGdtClick={(pt) => {
              setGdtSelected(null);
              setGdtEditing(null);
              setGdtPending(pt);
            }}
            gdtEditingId={gdtSelected}
            onGdtEdit={(id) => setGdtSelected((prev) => (prev === id ? null : id))}
            onGdtOpenEdit={(id) => {
              setGdtSelected(null);
              setGdtEditing(id);
            }}
            onGdtDelete={(id) => {
              setGdtAnnotations((prev) => prev.filter((a) => a.id !== id));
              setGdtSelected(null);
            }}
          />
        </Canvas>

        {/* GD&T 신규 추가 팝업 */}
        {gdtPending && !gdtEditing && (
          <GdtPickerOverlay
            onPick={(type, tol) => {
              setGdtAnnotations((prev) => [
                ...prev,
                { id: crypto.randomUUID(), position: gdtPending, type, tolerance: tol },
              ]);
              setGdtPending(null);
            }}
            onCancel={() => setGdtPending(null)}
          />
        )}
        {/* GD&T 수정 팝업 */}
        {gdtEditing &&
          (() => {
            const target = gdtAnnotations.find((a) => a.id === gdtEditing);
            if (!target) return null;
            return (
              <GdtPickerOverlay
                isEdit
                initialType={target.type}
                initialTol={target.tolerance}
                onPick={(type, tol) => {
                  setGdtAnnotations((prev) =>
                    prev.map((a) => (a.id === gdtEditing ? { ...a, type, tolerance: tol } : a)),
                  );
                  setGdtEditing(null);
                }}
                onCancel={() => setGdtEditing(null)}
              />
            );
          })()}

        {cutStroke.length >= 2 &&
          (() => {
            const s = cutStroke[0];
            const e = cutStroke[cutStroke.length - 1];
            const rx = Math.min(s.x, e.x);
            const ry = Math.min(s.y, e.y);
            const rw = Math.abs(e.x - s.x);
            const rh = Math.abs(e.y - s.y);
            return (
              <svg className="absolute inset-0 w-full h-full pointer-events-none">
                <rect
                  x={rx}
                  y={ry}
                  width={rw}
                  height={rh}
                  fill="rgba(244, 63, 94, 0.10)"
                  stroke="rgba(253, 164, 175, 0.95)"
                  strokeWidth={2}
                  strokeDasharray="5 3"
                />
              </svg>
            );
          })()}

        {false && (
          <div className="absolute top-3 left-3 bg-black/70 border border-rose-400/30 text-gray-200 text-xs px-2.5 py-2 rounded pointer-events-none leading-relaxed">
            <span className="text-rose-200 font-medium">{cutMode ? '자유 컷 모드' : '3DGS 자유 컷'}</span> |{' '}
            {cutMode ? '좌클릭 드래그로 경로를 그리고 C' : '자유 컷 버튼 또는 Shift+드래그 후 C'}
            <br />
            <span className="text-gray-400">Esc: 경로 지우기 | 원본 복원: 초기 상태로 되돌리기</span>
          </div>
        )}

        <div className="hidden">
          {measureMode ? (
            <>
              <span className="text-yellow-300 font-medium">측정 모드</span> — 두 점을 클릭하세요 | 우클릭 드래그: 화면
              이동
            </>
          ) : (
            <>
              드래그: 박스 조정 | 우클릭 드래그: 화면 이동 | 스크롤: 줌<br />
              <span className="text-gray-500">Ctrl+Z: 되돌리기 | 추출 미리보기 취소: 원본 복원</span>
            </>
          )}
        </div>

        <div className="absolute top-3 left-3 bg-black/70 border border-white/10 text-gray-200 text-xs px-2.5 py-2 rounded pointer-events-none leading-relaxed">
          {gdtMode ? (
            <>
              <span className="text-purple-300 font-medium">GD&T 모드</span> | 표면을 클릭해 공차 기호를 추가합니다.
              <br />
              <span className="text-gray-400">Esc: 모드 종료 | G: 토글</span>
            </>
          ) : measureMode ? (
            <>
              <span className="text-yellow-300 font-medium">측정 모드</span> | 점을 클릭해 거리를 잽니다.
              <br />
              <span className="text-gray-400">드래그 컷을 쓰려면 측정 모드를 끄세요.</span>
            </>
          ) : (
            <>
              <span className="text-rose-200 font-medium">{cutMode ? '드래그 컷 모드' : '드래그 컷 준비'}</span> |
              Shift+드래그 또는 컷 버튼 후 드래그, `C`로 적용
              <br />
              <span className="text-gray-400">Esc: 경로 지우기 | 원본 복원 버튼: 처음 상태로 되돌리기</span>
            </>
          )}
        </div>

        {/* 거리 측정 결과 오버레이 */}
        {measureMode && measureDistance !== null && (
          <div className="absolute top-3 right-3 bg-black/80 border border-yellow-500/60 text-yellow-300 text-sm px-4 py-2.5 rounded-lg pointer-events-none">
            <span className="text-gray-400 text-xs block mb-0.5">두 점 사이 거리</span>
            <span className="font-mono font-bold text-lg">{measureDistance.toFixed(3)}m</span>
          </div>
        )}
        {measureMode && measurePts.length === 1 && (
          <div className="absolute top-3 right-3 bg-black/70 border border-yellow-500/40 text-yellow-400 text-xs px-3 py-2 rounded-lg pointer-events-none">
            두 번째 점을 클릭하세요
          </div>
        )}

        {measureMode && measureDistanceRaw !== null && (
          <div className="absolute top-24 right-3 bg-black/85 border border-yellow-500/40 text-gray-100 text-xs px-3 py-3 rounded-lg shadow-lg">
            <div className="text-yellow-300 font-medium mb-2">실측 보정</div>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={0}
                step="0.001"
                value={calibrationInput}
                onChange={(e) => setCalibrationInput(e.target.value)}
                placeholder="실제 길이"
                className="w-24 rounded bg-black/30 border border-gray-700 px-2 py-1 text-xs text-gray-100 focus:outline-none focus:border-yellow-500"
              />
              <select
                value={calibrationUnit}
                onChange={(e) => setCalibrationUnit(e.target.value as 'm' | 'cm' | 'mm')}
                className="rounded bg-black/30 border border-gray-700 px-1.5 py-1 text-xs text-gray-100 focus:outline-none focus:border-yellow-500"
              >
                <option value="m">m</option>
                <option value="cm">cm</option>
                <option value="mm">mm</option>
              </select>
              <button
                onClick={() => void handleSaveCalibration()}
                disabled={!canSaveCalibration}
                className="px-2 py-1 text-xs rounded bg-yellow-500 text-black hover:bg-yellow-400 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {calibrationSaving ? '저장 중..' : '저장'}
              </button>
              {false && (
                <button
                  type="button"
                  onClick={handleCancelVersionEdit}
                  disabled={versionSaving}
                  className="w-full rounded-xl border border-gray-700 px-3 py-2 text-sm font-medium text-gray-200 hover:bg-gray-800 disabled:opacity-40"
                >
                  수정 취소
                </button>
              )}
            </div>
            <div className="mt-2 text-[11px] text-gray-400">현재 보정 배율: {calibrationScale.toFixed(4)}</div>
          </div>
        )}

        {toast && (
          <div
            className={`absolute top-3 right-3 text-white text-xs px-3 py-2 rounded shadow-lg pointer-events-none ${toast.type === 'ok' ? 'bg-emerald-600' : 'bg-red-600'}`}
          >
            {toast.msg}
          </div>
        )}
        </div>

        {isVersionPanelOpen && !isExtracted && (
          <aside className="w-[360px] shrink-0 border-l border-gray-800 bg-gray-950 text-gray-100 flex flex-col">
            <div className="px-4 py-4 border-b border-gray-800 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-white">버전 관리</p>
                  <p className="text-xs text-gray-400">
                    현재 박스 상태를 저장하고 이전 버전을 다시 적용할 수 있습니다.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsVersionPanelOpen(false)}
                  className="rounded-lg border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800"
                >
                  닫기
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 rounded-xl bg-gray-900 p-1 mx-4 mt-4">
              <button
                type="button"
                onClick={() => setVersionPanelTab('save')}
                className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  versionPanelTab === 'save'
                    ? 'bg-sky-500 text-slate-950'
                    : 'text-gray-300 hover:bg-gray-800'
                }`}
              >
                저장
              </button>
              <button
                type="button"
                onClick={() => setVersionPanelTab('load')}
                className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  versionPanelTab === 'load'
                    ? 'bg-sky-500 text-slate-950'
                    : 'text-gray-300 hover:bg-gray-800'
                }`}
              >
                <span className="inline-flex items-center gap-1.5">
                  불러오기
                  {versions.length > 0 && (
                    <span className="rounded-full bg-black/15 px-1.5 py-0.5 text-[10px] leading-none">
                      {versions.length}
                    </span>
                  )}
                </span>
              </button>
              {editingVersion && (
                <button
                  type="button"
                  onClick={handleCancelVersionEdit}
                  disabled={versionSaving}
                  className="w-full rounded-xl border border-gray-700 px-3 py-2 text-sm font-medium text-gray-200 hover:bg-gray-800 disabled:opacity-40"
                >
                  수정 취소
                </button>
              )}
            </div>

            {versionPanelTab === 'save' ? (
            <div className="px-4 py-4 border-b border-gray-800 space-y-3">
              <p className="text-xs text-gray-400">
                {editingVersion
                  ? '선택한 버전을 현재 박스 상태로 수정합니다.'
                  : '현재 박스 상태를 새 버전으로 저장합니다.'}
              </p>
              <label className="block space-y-1">
                <span className="text-xs font-medium text-gray-300">설명</span>
                <textarea
                  value={versionDescription}
                  onChange={(e) => setVersionDescription(e.target.value)}
                  placeholder="예: 바닥 기준으로 다시 맞춘 버전"
                  maxLength={200}
                  rows={3}
                  className="w-full resize-none rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder:text-gray-500 focus:outline-none focus:border-sky-500"
                />
              </label>
              <button
                type="button"
                onClick={() => void handleCreateVersion()}
                disabled={busy || versionSaving || (editingVersionId ? !onUpdateVersion : !onCreateVersion)}
                className="w-full rounded-xl bg-sky-500 px-3 py-2.5 text-sm font-medium text-slate-950 hover:bg-sky-400 disabled:opacity-40"
              >
                {versionSaving ? '저장 중...' : '현재 상태 저장'}
              </button>
              {editingVersion && (
                <button
                  type="button"
                  onClick={handleCancelVersionEdit}
                  disabled={versionSaving}
                  className="w-full rounded-xl border border-gray-700 px-3 py-2 text-sm font-medium text-gray-200 hover:bg-gray-800 disabled:opacity-40"
                >
                  수정 취소
                </button>
              )}
            </div>
            ) : (
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
              <p className="text-xs text-gray-400">
                버전 리스트를 클릭하면 해당 버전 상태로 바로 조회됩니다.
              </p>
              {versions.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-gray-700 bg-gray-900/50 px-4 py-6 text-center text-sm text-gray-400">
                  저장된 버전이 없습니다.
                </div>
              ) : (
                versions.map((version) => {
                  const isCurrentVersion = version.id === currentVersionId;

                  return (
                    <div
                      key={version.id}
                      role="button"
                      tabIndex={isCurrentVersion ? -1 : 0}
                      onClick={() => {
                        if (!busy && !isCurrentVersion) applyVersion(version);
                      }}
                      onKeyDown={(event) => {
                        if ((event.key === 'Enter' || event.key === ' ') && !busy && !isCurrentVersion) {
                          event.preventDefault();
                          applyVersion(version);
                        }
                      }}
                      className={`w-full rounded-2xl border px-4 py-3 text-left transition-colors ${
                        isCurrentVersion
                          ? 'cursor-default border-sky-500 bg-sky-500/10'
                          : 'cursor-pointer border-gray-800 bg-gray-900/60 hover:border-sky-500/60 hover:bg-gray-900'
                      } ${busy ? 'opacity-60' : ''}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-white">
                            {version.description.trim() || '설명 없음'}
                          </p>
                          <p className="mt-1 text-xs text-gray-400">{formatVersionDate(version.createdAt)}</p>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap justify-end">
                          {onSetRepresentative && (
                            (() => {
                              const isRep = version.sceneObject
                                ? representativeSceneObject === version.sceneObject
                                : !representativeSceneObject;
                              return isRep ? (
                                <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-medium text-amber-300 border border-amber-500/30">
                                  대표
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void onSetRepresentative(version);
                                  }}
                                  disabled={busy}
                                  className="rounded-lg border border-amber-500/40 px-2 py-1 text-[11px] font-medium text-amber-300 hover:bg-amber-950/40 disabled:opacity-40"
                                >
                                  대표 설정
                                </button>
                              );
                            })()
                          )}
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              handleStartVersionEdit(version);
                            }}
                            disabled={busy || deletingVersionId === version.id}
                            className="rounded-lg border border-gray-700 px-2 py-1 text-[11px] font-medium text-gray-200 hover:bg-gray-800 disabled:opacity-40"
                          >
                            수정
                          </button>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleDeleteVersion(version);
                            }}
                            disabled={busy || deletingVersionId === version.id || !onDeleteVersion}
                            className="rounded-lg border border-red-400/50 px-2 py-1 text-[11px] font-medium text-red-200 hover:bg-red-950/40 disabled:opacity-40"
                          >
                            {deletingVersionId === version.id ? '삭제 중...' : '삭제'}
                          </button>
                        </div>
                        {isCurrentVersion && (
                          <span className="rounded-full bg-sky-500/20 px-2 py-0.5 text-[10px] font-medium text-sky-200">
                            현재
                          </span>
                        )}
                      </div>

                      <div className="mt-3 space-y-1 text-[11px] text-gray-400">
                        <p>중심 {fmt(version.obb.center)}</p>
                        <p>회전 {fmt(version.obb.rotation)}</p>
                        <p>크기 {fmt(version.obb.scale)}</p>
                      </div>

                      <p className="mt-3 text-[11px] font-medium text-gray-300">
                        {isCurrentVersion ? '현재 적용 중' : '이 버전 적용'}
                      </p>
                    </div>
                  );
                })
              )}
            </div>
            )}
          </aside>
        )}
      </div>

      {/* ── 하단 값 ── */}
      <div className="flex items-center gap-6 px-4 py-2 bg-gray-900 border-t border-gray-700 text-xs text-gray-400 shrink-0">
        {gdtMode ? (
          <>
            <span className="text-purple-400 font-medium">GD&T 공차 모드</span>
            <span>표면을 클릭해 공차 기호를 추가하세요</span>
            {gdtAnnotations.length > 0 && <span className="text-purple-300">{gdtAnnotations.length}개 어노테이션</span>}
            <button
              onClick={() => setGdtAnnotations([])}
              className="ml-auto text-gray-500 hover:text-gray-300 px-2 py-0.5 rounded hover:bg-gray-700"
            >
              전체 삭제
            </button>
          </>
        ) : measureMode ? (
          <>
            <span className="text-yellow-400 font-medium">측정 모드</span>
            {measurePts.length === 0 && <span>첫 번째 점을 클릭하세요</span>}
            {measurePts.length === 1 && <span>두 번째 점을 클릭하세요</span>}
            {measureDistance !== null && (
              <span className="font-mono text-yellow-300 font-bold text-sm">거리: {measureDistance.toFixed(3)}m</span>
            )}
            <button
              onClick={() => setMeasurePts([])}
              className="ml-auto text-gray-500 hover:text-gray-300 px-2 py-0.5 rounded hover:bg-gray-700"
            >
              초기화
            </button>
          </>
        ) : (
          <>
            {/*
              <>
                <span className={`${cutMode ? 'text-rose-300' : 'text-gray-300'} font-medium`}>
                  {cutMode ? '자유 컷 활성화' : '자유 컷 대기'}
                </span>
                <span><span className="text-gray-500 mr-1">경로 포인트</span>{cutStroke.length}</span>
                <span><span className="text-gray-500 mr-1">브러시</span>{CUT_BRUSH_RADIUS_PX}px</span>
                {hasLocalSceneEdits && <span className="text-rose-300">현재 장면에 로컬 컷이 적용된 상태입니다.</span>}
                {!hasLocalSceneEdits && <span className="text-gray-500">원본 장면 상태입니다.</span>}
                <span className="ml-auto text-gray-500">Shift+드래그 또는 자유 컷 모드에서 좌클릭 드래그 후 C</span>
              </>
            ) : (
              <>
                <span><span className="text-gray-500 mr-1">중심</span>{fmt(liveObb.center)}</span>
                <span><span className="text-gray-500 mr-1">회전°</span>{fmt(liveObb.rotation)}</span>
                <span><span className="text-gray-500 mr-1">크기</span>{fmt(liveObb.scale)}</span>
                {isExtracted && <span className="ml-auto text-emerald-400">● 추출 미리보기 상태입니다. 다운로드하거나 취소할 수 있습니다.</span>}
                {!isExtracted && (isDirty || isLiveDirty) && <span className="ml-auto text-orange-400">● 미저장 박스 선택 범위 변경</span>}
              </>
            )}
            {/*
            <span className={`${cutMode ? 'text-rose-300' : 'text-gray-300'} font-medium`}>
              {cutMode ? '드래그 컷 모드' : '편집 대기'}
            </span>
            <span><span className="text-gray-500 mr-1">경로 포인트</span>{cutStroke.length}</span>
            <span><span className="text-gray-500 mr-1">브러시</span>{CUT_BRUSH_RADIUS_PX}px</span>
            {cutSelectionPreview?.kind === 'points' && (
              <span className="text-rose-300">선택 포인트 {cutSelectionPreview.selectedCount.toLocaleString()}개</span>
            )}
            {cutSelectionPreview?.kind === 'mesh' && (
              <span className="text-rose-300">선택 면 {cutSelectionPreview.removedFaceCount.toLocaleString()}개</span>
            )}
            {!isGlb && <span><span className="text-gray-500 mr-1">중심</span>{fmt(liveObb.center)}</span>}
            {!isGlb && <span><span className="text-gray-500 mr-1">회전</span>{fmt(liveObb.rotation)}</span>}
            {!isGlb && <span><span className="text-gray-500 mr-1">크기</span>{fmt(liveObb.scale)}</span>}
            {isExtracted && <span className="ml-auto text-emerald-400">영역 미리보기 상태입니다. 다운로드하거나 취소할 수 있습니다.</span>}
            {!isExtracted && hasLocalSceneEdits && <span className="ml-auto text-rose-300">현재 장면에 드래그 컷 편집이 적용되어 있습니다.</span>}
            {!isExtracted && !hasLocalSceneEdits && !cutSelectionPreview && (isDirty || isLiveDirty) && <span className="ml-auto text-orange-400">저장되지 않은 OBB 변경이 있습니다.</span>}
            {!isExtracted && cutStroke.length === 0 && <span className="ml-auto text-gray-500">Shift+드래그 또는 컷 버튼 후 드래그, `C`로 자르기</span>}
            */}
            {/*
            <span className={`${cutMode ? 'text-rose-300' : 'text-gray-300'} font-medium`}>
              {cutMode ? '드래그 컷 모드' : '편집 대기'}
            </span>
            <span><span className="text-gray-500 mr-1">경로 포인트</span>{cutStroke.length}</span>
            <span><span className="text-gray-500 mr-1">브러시</span>{CUT_BRUSH_RADIUS_PX}px</span>
            {cutSelectionPreview?.kind === 'points' && (
              <span className="text-rose-300">선택 포인트 {cutSelectionPreview.selectedCount.toLocaleString()}개</span>
            )}
            {cutSelectionPreview?.kind === 'mesh' && (
              <span className="text-rose-300">선택 면 {cutSelectionPreview.removedFaceCount.toLocaleString()}개</span>
            )}
            {!isGlb && <span><span className="text-gray-500 mr-1">중심</span>{fmt(liveObb.center)}</span>}
            {!isGlb && <span><span className="text-gray-500 mr-1">회전</span>{fmt(liveObb.rotation)}</span>}
            {!isGlb && <span><span className="text-gray-500 mr-1">크기</span>{fmt(liveObb.scale)}</span>}
            {isExtracted && <span className="ml-auto text-emerald-400">영역 미리보기 상태입니다. 다운로드하거나 취소할 수 있습니다.</span>}
            {!isExtracted && hasLocalSceneEdits && <span className="ml-auto text-rose-300">현재 장면에 드래그 컷 편집이 적용되어 있습니다.</span>}
            {!isExtracted && !hasLocalSceneEdits && !cutSelectionPreview && (isDirty || isLiveDirty) && <span className="ml-auto text-orange-400">저장되지 않은 OBB 변경이 있습니다.</span>}
            {!isExtracted && cutStroke.length === 0 && <span className="ml-auto text-gray-500">Shift+드래그 또는 컷 버튼 후 드래그, `C`로 자르기</span>}
            */}
            <span className={`${cutMode ? 'text-rose-300' : 'text-gray-300'} font-medium`}>
              {cutMode ? 'Drag Cut' : 'Ready'}
            </span>
            <span>Path {cutStroke.length}</span>
            <span>Brush {CUT_BRUSH_RADIUS_PX}px</span>
            {cutSelectionPreview?.kind === 'points' && (
              <span className="text-rose-300">
                Selected points {cutSelectionPreview.selectedCount.toLocaleString()}
              </span>
            )}
            {cutSelectionPreview?.kind === 'mesh' && (
              <span className="text-rose-300">
                Selected faces {cutSelectionPreview.removedFaceCount.toLocaleString()}
              </span>
            )}
            {!isGlb && <span>Center {fmt(liveObb.center)}</span>}
            {!isGlb && <span>Rotate {fmt(liveObb.rotation)}</span>}
            {!isGlb && <span>Scale {fmt(liveObb.scale)}</span>}
            {isExtracted && (
              <span className="ml-auto text-emerald-400">Preview active. You can download or cancel it.</span>
            )}
            {!isExtracted && hasLocalSceneEdits && (
              <span className="ml-auto text-rose-300">A drag-cut edit is applied to the current scene.</span>
            )}
            {!isExtracted && !hasLocalSceneEdits && !cutSelectionPreview && (isDirty || isLiveDirty) && (
              <span className="ml-auto text-orange-400">There are unsaved OBB changes.</span>
            )}
            {!isExtracted && cutStroke.length === 0 && (
              <span className="ml-auto text-gray-500">Shift+drag or enable cut mode, then drag and press C.</span>
            )}
          </>
        )}
      </div>
    </div>
  );

  return createPortal(editorLayout, document.body);
}
