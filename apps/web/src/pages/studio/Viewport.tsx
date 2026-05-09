import React, { useRef, useEffect, useMemo, Suspense, useState, useCallback, Component, type ReactNode } from 'react';
import { Canvas, useThree, ThreeEvent, useFrame } from '@react-three/fiber';
import { OrbitControls, TransformControls, useGLTF, GizmoHelper, GizmoViewport, Html, Line, calculateScaleFactor, Environment } from '@react-three/drei';
import * as THREE from 'three';
import { SceneObject, SceneData, DEFAULT_SCENE_DATA, SceneUnit } from '@/api/scenes';
import { assetsApi } from '@/api/assets';
import { formatDisplayLength } from './sceneUnits';

type AnnotationPoint = {
  position: THREE.Vector3;
  baseSize: number;
};

const DEFAULT_ANNOTATION_BASE_SIZE = 0.04;
const MIN_ANNOTATION_BASE_SIZE = 0.006;
const MAX_ANNOTATION_BASE_SIZE = 0.1;

function getAnnotationBaseSizeFromBox(box: THREE.Box3) {
  if (box.isEmpty()) return DEFAULT_ANNOTATION_BASE_SIZE;
  const size = box.getSize(new THREE.Vector3());
  const maxAxis = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(maxAxis) || maxAxis <= 0) return DEFAULT_ANNOTATION_BASE_SIZE;
  return THREE.MathUtils.clamp(maxAxis * 0.04, MIN_ANNOTATION_BASE_SIZE, MAX_ANNOTATION_BASE_SIZE);
}

function getAnnotationDistanceFactor(baseSize: number) {
  return THREE.MathUtils.clamp(baseSize * 40, 0.35, 2.5);
}

function getAnnotationHtmlScale(baseSize: number) {
  return THREE.MathUtils.clamp(baseSize / DEFAULT_ANNOTATION_BASE_SIZE, 0.2, 1);
}

// ── 측정 포인트 마커 (펄스 애니메이션) ──────────────────────────
function MeasureMarker({ position, color, label, baseSize }: {
  position: THREE.Vector3;
  color: string;
  label: string;
  baseSize: number;
}) {
  const outerRef = useRef<THREE.Mesh>(null);
  const ringRadius = baseSize * 2;
  const ringTube = Math.max(baseSize * 0.3, 0.002);
  const crossHalfLength = baseSize * 3;
  useFrame(({ clock }) => {
    if (outerRef.current) {
      const s = 1 + Math.sin(clock.getElapsedTime() * 4) * 0.3;
      outerRef.current.scale.setScalar(s);
      (outerRef.current.material as THREE.MeshBasicMaterial).opacity = 0.6 - Math.sin(clock.getElapsedTime() * 4) * 0.3;
    }
  });

  return (
    <group position={position}>
      {/* 중심 구체 */}
      <mesh>
        <sphereGeometry args={[baseSize, 16, 16]} />
        <meshBasicMaterial color={color} />
      </mesh>
      {/* 펄스 링 */}
      <mesh ref={outerRef}>
        <torusGeometry args={[ringRadius, ringTube, 8, 24]} />
        <meshBasicMaterial color={color} transparent opacity={0.6} />
      </mesh>
      {/* 십자 라인 */}
      <Line points={[[-crossHalfLength, 0, 0], [crossHalfLength, 0, 0]]} color={color} lineWidth={1.5} />
      <Line points={[[0, 0, -crossHalfLength], [0, 0, crossHalfLength]]} color={color} lineWidth={1.5} />
      <Line points={[[0, -crossHalfLength, 0], [0, crossHalfLength, 0]]} color={color} lineWidth={1.5} />
      {/* 라벨 */}
      <Html distanceFactor={getAnnotationDistanceFactor(baseSize)} center>
        <div
          style={{
            background: color,
            transform: `scale(${getAnnotationHtmlScale(baseSize)})`,
            transformOrigin: 'center center',
          }}
          className="text-black text-[10px] font-bold px-1.5 py-0.5 rounded pointer-events-none whitespace-nowrap shadow-lg"
        >
          {label}
        </div>
      </Html>
    </group>
  );
}

// ── 거리 측정 시각화 ─────────────────────────────────────────────
function MeasureVisual({ points, unit }: { points: AnnotationPoint[]; unit: SceneUnit }) {
  if (points.length === 0) return null;

  const midpoint = points.length === 2
    ? new THREE.Vector3().addVectors(points[0].position, points[1].position).multiplyScalar(0.5)
    : null;
  const distance = points.length === 2 ? points[0].position.distanceTo(points[1].position) : null;
  const averageBaseSize = points.length === 2
    ? (points[0].baseSize + points[1].baseSize) / 2
    : points[0].baseSize;

  return (
    <>
      {points[0] && <MeasureMarker position={points[0].position} color="#00ff88" label="P1" baseSize={points[0].baseSize} />}
      {points[1] && <MeasureMarker position={points[1].position} color="#ff4466" label="P2" baseSize={points[1].baseSize} />}

      {points.length === 2 && (
        <Line
          points={[points[0].position.toArray() as [number, number, number], points[1].position.toArray() as [number, number, number]]}
          color="#ffdd00"
          lineWidth={2}
          dashed
          dashSize={averageBaseSize * 3.75}
          gapSize={averageBaseSize * 2}
        />
      )}

      {midpoint && distance !== null && (
        <Html position={midpoint} distanceFactor={getAnnotationDistanceFactor(averageBaseSize)} center>
          <div
            style={{
              transform: `scale(${getAnnotationHtmlScale(averageBaseSize)})`,
              transformOrigin: 'center center',
            }}
            className="bg-yellow-400 text-black text-sm font-bold px-3 py-1.5 rounded-xl
                          shadow-xl pointer-events-none whitespace-nowrap border-2 border-yellow-600"
          >
            📏 {formatDisplayLength(distance, unit)} {unit}
          </div>
        </Html>
      )}
    </>
  );
}

// ── GD&T 기하 공차 어노테이션 ────────────────────────────────────
const GDT_SYMBOLS: Record<string, string> = {
  '평면도': '⏥',
  '진직도': '⏤',
  '진원도': '○',
  '원통도': '⌭',
  '직각도': '⊥',
  '평행도': '∥',
  '경사도': '∠',
  '위치도': '⊕',
  '동심도': '◎',
  '흔들림': '↗',
};

function GdtAnnotation({ position, symbol, label, tolerance, baseSize }: {
  position: THREE.Vector3;
  symbol: string;
  label: string;
  tolerance: string;
  baseSize: number;
}) {
  return (
    <group position={position}>
      <mesh>
        <sphereGeometry args={[Math.max(baseSize * 0.875, 0.005), 12, 12]} />
        <meshBasicMaterial color="#c084fc" />
      </mesh>
      <Html distanceFactor={getAnnotationDistanceFactor(baseSize)} center>
        <div style={{
          background: '#1e1b4b',
          border: '1.5px solid #a855f7',
          borderRadius: 6,
          padding: '3px 8px',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
          boxShadow: '0 2px 8px rgba(168,85,247,0.4)',
          transform: `scale(${getAnnotationHtmlScale(baseSize)})`,
          transformOrigin: 'center center',
        }}>
          <span style={{ fontSize: 13, color: '#e9d5ff', fontWeight: 700 }}>{symbol}</span>
          <span style={{ fontSize: 10, color: '#d8b4fe' }}>{label}</span>
          <span style={{
            fontSize: 10, color: '#a855f7',
            borderLeft: '1px solid #6d28d9', paddingLeft: 4,
          }}>{tolerance} mm</span>
        </div>
      </Html>
    </group>
  );
}

function GdtVisual({ annotations }: {
  annotations: { position: THREE.Vector3; type: string; tolerance: string; baseSize: number }[];
}) {
  if (annotations.length === 0) return null;
  return (
    <>
      {annotations.map((a, i) => (
        <GdtAnnotation
          key={i}
          position={a.position}
          symbol={GDT_SYMBOLS[a.type] ?? '⊕'}
          label={a.type}
          tolerance={a.tolerance}
          baseSize={a.baseSize}
        />
      ))}
    </>
  );
}

// ── GD&T 유형 선택 팝업 ──────────────────────────────────────────
function GdtPicker({ onPick, onCancel }: {
  onPick: (type: string, tolerance: string) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<string>('flatness');
  const [tol, setTol] = useState('0.05');
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
    }} onClick={onCancel}>
      <div style={{
        background: '#0f1117', border: '1px solid #2a2f42', borderRadius: 12,
        padding: 20, minWidth: 260, boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
      }} onClick={e => e.stopPropagation()}>
        <p style={{ color: '#e2e8f0', fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
          GD&T 공차 기호 선택
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 14 }}>
          {Object.entries(GDT_SYMBOLS).map(([key, sym]) => (
            <button key={key} onClick={() => setSelected(key)}
              style={{
                background: selected === key ? '#581c87' : '#1a1f2e',
                border: `1px solid ${selected === key ? '#a855f7' : '#2a2f42'}`,
                borderRadius: 6, padding: '5px 8px', color: selected === key ? '#e9d5ff' : '#9ca3af',
                fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5,
              }}>
              <span style={{ fontSize: 14 }}>{sym}</span> {key}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <span style={{ color: '#9ca3af', fontSize: 11 }}>공차 (mm)</span>
          <input value={tol} onChange={e => setTol(e.target.value)}
            style={{
              flex: 1, background: '#1a1f2e', border: '1px solid #2a2f42',
              borderRadius: 6, padding: '4px 8px', color: '#e2e8f0', fontSize: 12,
            }} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onCancel}
            style={{ flex: 1, background: '#1a1f2e', border: '1px solid #2a2f42', borderRadius: 6, padding: '6px 0', color: '#9ca3af', fontSize: 12, cursor: 'pointer' }}>
            취소
          </button>
          <button onClick={() => onPick(selected, tol)}
            style={{ flex: 1, background: '#7c3aed', border: 'none', borderRadius: 6, padding: '6px 0', color: '#fff', fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>
            추가
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 커스텀 스케일 핸들 상수 ──────────────────────────────────────
const CORNER_SIGNS: [number, number, number][] = [
  [-1,-1,-1],[1,-1,-1],[-1,1,-1],[1,1,-1],
  [-1,-1, 1],[1,-1, 1],[-1,1, 1],[1,1, 1],
];
const FACE_SIGNS: [number, number, number][] = [
  [-1,0,0],[1,0,0],[0,-1,0],[0,1,0],[0,0,-1],[0,0,1],
];
// 8개 코너 인덱스 기준 12개 엣지 (서로 정확히 1개 부호만 다른 쌍)
const BOX_EDGE_PAIRS: [number,number][] = [
  [0,1],[2,3],[4,5],[6,7],   // x 방향
  [0,2],[1,3],[4,6],[5,7],   // y 방향
  [0,4],[1,5],[2,6],[3,7],   // z 방향
];

// ── 커스텀 스케일 핸들 ────────────────────────────────────────────
function ScaleHandles({
  group, scaleLocked, area, placementStep, onScaleEnd, onScaleExceedsArea, displayOnly = false, usePlacementBounds = false,
  onHitboxPointerDown,
}: {
  group: THREE.Group;
  scaleLocked: boolean; // 페이스 핸들에만 적용 (코너는 항상 비율 잠금)
  area?: { width: number; depth: number };
  placementStep: number;
  onScaleEnd: (scl: [number, number, number]) => void;
  onScaleExceedsArea?: () => void;
  usePlacementBounds?: boolean;
  displayOnly?: boolean; // true이면 bbox 표시만 하고 핸들은 숨김
  onHitboxPointerDown?: (e: ThreeEvent<PointerEvent>) => void; // displayOnly 모드 전용
}) {
  const { camera, gl, size: viewportSize } = useThree();

  // 핸들 메시 refs (코너 8개, 페이스 6개)
  const cornerRefs = useRef<(THREE.Mesh | null)[]>(Array(8).fill(null));
  const faceRefs   = useRef<(THREE.Mesh | null)[]>(Array(6).fill(null));
  // 현재 bbox (드래그 시작 시 스냅샷)
  const bboxRef = useRef<{ center: THREE.Vector3; halfSize: THREE.Vector3 } | null>(null);

  // 와이어프레임 geometry & material (한 번만 생성)
  const wireGeo = useMemo(() => {
    const positions = new Float32Array(BOX_EDGE_PAIRS.length * 2 * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return geo;
  }, []);
  const wireMat  = useMemo(() => new THREE.LineBasicMaterial({ color: '#3b82f6' }), []);
  const wireObj  = useMemo(() => new THREE.LineSegments(wireGeo, wireMat), [wireGeo, wireMat]);
  const cornerMat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#3b82f6' }), []);
  const faceMat   = useMemo(() => new THREE.MeshBasicMaterial({ color: '#10b981' }), []);
  const cornerGeo = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
  const faceGeo   = useMemo(() => new THREE.SphereGeometry(0.5, 8, 8), []);
  // displayOnly 모드 전용: 투명 히트박스 (bbox 전체 영역에서 포인터 이벤트 수신)
  const hitboxRef = useRef<THREE.Mesh>(null);
  const hitboxGeo = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
  const hitboxMat = useMemo(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }), []);

  // 매 프레임: 핸들 위치를 bbox에 맞게 갱신 (React 렌더 없이 명령형으로)
  useFrame(() => {
    // computeBoundingBox 강제 호출 (Gaussian Splat 등 일부 에셋 대비)
    group.traverse(child => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        if (mesh.geometry && !mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      }
    });
    const actualBox = getGroupWorldBox(group, true);
    if (actualBox.isEmpty()) return;
    const box = usePlacementBounds ? getPlacementBounds(actualBox, placementStep) : actualBox;

    const center  = box.getCenter(new THREE.Vector3());
    const boxSize = box.getSize(new THREE.Vector3());
    const halfSize = boxSize.clone().multiplyScalar(0.5);
    bboxRef.current = { center, halfSize };

    // Keep handles readable without letting large assets create giant gizmos.
    const minDim = Math.max(0.001, Math.min(boxSize.x, boxSize.y, boxSize.z));
    const screenHandleSize = calculateScaleFactor(center, 18, camera, viewportSize);
    const minHandleSize = Math.max(0.008, minDim * 0.03);
    const maxHandleSize = Math.max(minHandleSize, minDim * 0.18);
    const hs = THREE.MathUtils.clamp(screenHandleSize, minHandleSize, maxHandleSize);

    // 와이어프레임 엣지 갱신
    const posAttr = wireGeo.getAttribute('position') as THREE.BufferAttribute;
    const arr = posAttr.array as Float32Array;
    BOX_EDGE_PAIRS.forEach(([ai, bi], ei) => {
      const a = CORNER_SIGNS[ai], b = CORNER_SIGNS[bi];
      const o = ei * 6;
      arr[o]   = center.x + a[0] * halfSize.x; arr[o+1] = center.y + a[1] * halfSize.y; arr[o+2] = center.z + a[2] * halfSize.z;
      arr[o+3] = center.x + b[0] * halfSize.x; arr[o+4] = center.y + b[1] * halfSize.y; arr[o+5] = center.z + b[2] * halfSize.z;
    });
    posAttr.needsUpdate = true;

    // 코너 핸들 위치 & 크기
    CORNER_SIGNS.forEach((signs, i) => {
      const m = cornerRefs.current[i];
      if (m) {
        m.position.set(center.x + signs[0]*halfSize.x, center.y + signs[1]*halfSize.y, center.z + signs[2]*halfSize.z);
        m.scale.setScalar(hs);
      }
    });

    // 페이스 핸들 위치 & 크기
    FACE_SIGNS.forEach((signs, i) => {
      const m = faceRefs.current[i];
      if (m) {
        m.position.set(center.x + signs[0]*halfSize.x, center.y + signs[1]*halfSize.y, center.z + signs[2]*halfSize.z);
        m.scale.setScalar(hs * 0.85);
      }
    });

    // displayOnly 히트박스 위치 & 크기 (bbox 전체 크기)
    if (hitboxRef.current) {
      hitboxRef.current.position.copy(center);
      hitboxRef.current.scale.set(boxSize.x, boxSize.y, boxSize.z);
    }
  });

  // 드래그 상태 (pointerdown 시 스냅샷)
  const dragRef = useRef<{
    signs: [number, number, number];
    initialScale: THREE.Vector3;
    initialPosition: THREE.Vector3;
    initialCenter: THREE.Vector3;
    initialHalfSize: THREE.Vector3;
    initialHandleWorld: THREE.Vector3; // 드래그 시작 시 핸들 월드 위치 (기준점)
    plane: THREE.Plane;
    scaleLocked: boolean;
    area?: { width: number; depth: number };
    lastValidScale: THREE.Vector3;
    lastValidPosition: THREE.Vector3;
    exceeded: boolean;
  } | null>(null);

  // 콜백 ref (stale closure 방지)
  const onScaleEndRef = useRef(onScaleEnd);
  const onExceedRef   = useRef(onScaleExceedsArea);
  useEffect(() => { onScaleEndRef.current = onScaleEnd; }, [onScaleEnd]);
  useEffect(() => { onExceedRef.current = onScaleExceedsArea; }, [onScaleExceedsArea]);

  const boxFitsArea = useCallback((box: THREE.Box3, nextArea?: { width: number; depth: number }) => {
    if (!nextArea || box.isEmpty()) return true;
    const placementBox = getPlacementBounds(box, placementStep);
    const EPS = 0.001;
    const hw = nextArea.width / 2;
    const hd = nextArea.depth / 2;
    return (
      placementBox.max.x <= hw + EPS &&
      placementBox.min.x >= -hw - EPS &&
      placementBox.max.z <= hd + EPS &&
      placementBox.min.z >= -hd - EPS
    );
  }, [placementStep]);

  const applyScaleCandidate = useCallback((
    scale: THREE.Vector3,
    basePosition: THREE.Vector3,
    nextArea?: { width: number; depth: number },
  ) => {
    group.position.set(basePosition.x, basePosition.y, basePosition.z);
    group.scale.copy(scale);

    let box = getGroupWorldBox(group, true);
    if (!box.isEmpty() && Math.abs(box.min.y) > 0.001) {
      group.position.y -= box.min.y;
      box.translate(new THREE.Vector3(0, -box.min.y, 0));
    }

    return {
      box,
      fitsArea: boxFitsArea(box, nextArea),
      position: group.position.clone(),
      scale: scale.clone(),
    };
  }, [boxFitsArea, group]);

  const fitScaleToArea = useCallback((
    fromScale: THREE.Vector3,
    toScale: THREE.Vector3,
    basePosition: THREE.Vector3,
    nextArea?: { width: number; depth: number },
  ) => {
    let best = applyScaleCandidate(fromScale, basePosition, nextArea);
    if (!best.fitsArea) return null;

    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      const candidateScale = fromScale.clone().lerp(toScale, mid);
      const candidate = applyScaleCandidate(candidateScale, basePosition, nextArea);
      if (candidate.fitsArea) {
        best = candidate;
        lo = mid;
      } else {
        hi = mid;
      }
    }

    group.position.copy(best.position);
    group.scale.copy(best.scale);
    return best;
  }, [applyScaleCandidate, group]);

  const handlePointerDown = useCallback((
    e: ThreeEvent<PointerEvent>,
    signs: [number, number, number],
    isCorner: boolean,
  ) => {
    e.stopPropagation();
    const bbox = bboxRef.current;
    if (!bbox) return;

    const { center, halfSize } = bbox;
    const handleWorld = new THREE.Vector3(
      center.x + signs[0] * halfSize.x,
      center.y + signs[1] * halfSize.y,
      center.z + signs[2] * halfSize.z,
    );
    const camDir = camera.getWorldDirection(new THREE.Vector3());
    const plane  = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir, handleWorld);

    dragRef.current = {
      signs,
      initialScale:       group.scale.clone(),
      initialPosition:    group.position.clone(),
      initialCenter:      center.clone(),
      initialHalfSize:    halfSize.clone(),
      initialHandleWorld: handleWorld.clone(),
      plane,
      scaleLocked: isCorner ? true : scaleLocked, // 코너 핸들은 항상 비율 잠금
      area,
      lastValidScale: group.scale.clone(),
      lastValidPosition: group.position.clone(),
      exceeded: false,
    };

    // OrbitControls 비활성화 신호
    gl.domElement.dispatchEvent(new CustomEvent('transform-dragging', { detail: true }));
    gl.domElement.setPointerCapture(e.pointerId);
  }, [camera, gl, group, scaleLocked, area]);

  // pointermove / pointerup (캔버스 레벨)
  useEffect(() => {
    const el = gl.domElement;

    const onMove = (e: PointerEvent) => {
      const ds = dragRef.current;
      if (!ds) return;

      const rect = el.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width)  * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      const ray = new THREE.Raycaster();
      ray.setFromCamera(mouse, camera);
      const hit = new THREE.Vector3();
      if (!ray.ray.intersectPlane(ds.plane, hit)) return;

      const { signs, initialScale, initialPosition, initialCenter, initialHalfSize, initialHandleWorld } = ds;

      // ▶ delta: 핸들 초기 위치 기준 변위 (클릭만 했을 때 delta=0 → factor=1)
      const delta = hit.clone().sub(initialHandleWorld);

      let newScale = initialScale.clone();

      if (ds.scaleLocked) {
        // 비율 잠금: 핸들→센터 방향에 변위를 투영하여 단일 배율 산출
        const cornerVec  = initialHandleWorld.clone().sub(initialCenter); // 센터→핸들 벡터
        const initialDist = cornerVec.length();
        if (initialDist > 0) {
          const cornerDir = cornerVec.clone().normalize();
          const proj   = delta.dot(cornerDir);           // 핸들 이동 거리 (해당 방향)
          const factor = Math.max(0.001, (initialDist + proj) / initialDist);
          newScale.set(
            Math.max(0.001, initialScale.x * factor),
            Math.max(0.001, initialScale.y * factor),
            Math.max(0.001, initialScale.z * factor),
          );
        }
      } else {
        // 축별 개별 스케일: 각 비-0 축의 이동량으로 해당 축만 변경
        for (let i = 0; i < 3; i++) {
          if (signs[i] !== 0) {
            const half = initialHalfSize.getComponent(i);
            const disp = delta.getComponent(i) * signs[i]; // 양수 = 바깥쪽
            if (half > 0) {
              const factor = Math.max(0.001, (half + disp) / half);
              newScale.setComponent(i, Math.max(0.001, initialScale.getComponent(i) * factor));
            }
          }
        }
      }

      const candidate = applyScaleCandidate(newScale, initialPosition, ds.area);

      // ── 바운딩박스 기반 후처리 ───────────────────────────────────
      if (!candidate.fitsArea) {
        const fitted = fitScaleToArea(ds.lastValidScale, newScale, initialPosition, ds.area);
        if (!fitted) {
          group.position.copy(ds.lastValidPosition);
          group.scale.copy(ds.lastValidScale);
          if (!ds.exceeded) {
            ds.exceeded = true;
            onExceedRef.current?.();
          }
          return;
        }

        ds.lastValidScale = fitted.scale.clone();
        ds.lastValidPosition = fitted.position.clone();
        if (!ds.exceeded) {
          ds.exceeded = true;
          onExceedRef.current?.();
        }
        return;
      }
      /*

      // ① 바닥 관통 방지: 스케일 변경으로 오브젝트가 y<0으로 내려가면 올림
        // position 변경 후 box 재계산
      }

      // ② 씬 경계 초과 검사 (XZ)
          group.scale.copy(ds.lastValidScale);
          if (!ds.exceeded) {
            ds.exceeded = true;
            onExceedRef.current?.();
          }
          return;
        }
      }

      */
      ds.exceeded = false;
      ds.lastValidScale = candidate.scale.clone();
      ds.lastValidPosition = candidate.position.clone();
    };

    const onUp = () => {
      if (!dragRef.current) return;
      const s = group.scale;
      onScaleEndRef.current([s.x, s.y, s.z]);
      dragRef.current = null;
      gl.domElement.dispatchEvent(new CustomEvent('transform-dragging', { detail: false }));
    };

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    return () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
    };
  }, [applyScaleCandidate, camera, fitScaleToArea, gl, group]);

  return (
    <>
      {/* 바운딩박스 와이어프레임 */}
      <primitive object={wireObj} />

      {displayOnly ? (
        /* displayOnly 모드: 투명 히트박스로 bbox 전체 영역에서 포인터 이벤트 수신 */
        <mesh
          ref={hitboxRef}
          geometry={hitboxGeo}
          material={hitboxMat}
          onPointerDown={onHitboxPointerDown}
        />
      ) : (
        <>
          {/* 코너 핸들 (8개) */}
          {CORNER_SIGNS.map((signs, i) => (
            <mesh
              key={`sc${i}`}
              ref={el => { cornerRefs.current[i] = el; }}
              geometry={cornerGeo}
              material={cornerMat}
              onPointerDown={e => handlePointerDown(e, signs, true)}
            />
          ))}

          {/* 페이스 핸들 (6개) */}
          {FACE_SIGNS.map((signs, i) => (
            <mesh
              key={`sf${i}`}
              ref={el => { faceRefs.current[i] = el; }}
              geometry={faceGeo}
              material={faceMat}
              onPointerDown={e => handlePointerDown(e, signs, false)}
            />
          ))}
        </>
      )}
    </>
  );
}

// ── 경계 내 그리드 (LineSegments 기반) ──────────────────────────
function BoundedGrid({
  area, yOffset, cellSize, sectionSize, cellColor, sectionColor,
}: {
  area?: { width: number; depth: number };
  yOffset: number;
  cellSize: number;
  sectionSize: number;
  cellColor: string;
  sectionColor: string;
}) {
  const { cellPoints, sectionPoints } = useMemo(() => {
    const hw = (area?.width  ?? 20) / 2;
    const hd = (area?.depth  ?? 20) / 2;
    const cellSegments: [number, number, number][] = [];
    const sectionSegments: [number, number, number][] = [];

    const snap = (v: number) => Math.round(v / cellSize) * cellSize;
    const EPS = cellSize * 0.01;
    const isSectionLine = (value: number) =>
      Math.abs(value % sectionSize) < EPS || Math.abs(Math.abs(value % sectionSize) - sectionSize) < EPS;

    for (let z = snap(-hd); z <= hd + EPS; z += cellSize) {
      const target = isSectionLine(z) ? sectionSegments : cellSegments;
      target.push([-hw, 0, z], [hw, 0, z]);
    }
    for (let x = snap(-hw); x <= hw + EPS; x += cellSize) {
      const target = isSectionLine(x) ? sectionSegments : cellSegments;
      target.push([x, 0, -hd], [x, 0, hd]);
    }

    return { cellPoints: cellSegments, sectionPoints: sectionSegments };
  }, [area?.width, area?.depth, cellSize, sectionSize, cellColor, sectionColor]);

  return (
    <group position={[0, yOffset, 0]} renderOrder={3}>
      {cellPoints.length > 0 && (
        <Line
          points={cellPoints}
          segments
          color={cellColor}
          lineWidth={1}
          transparent
          opacity={0.8}
          depthTest
          depthWrite={false}
        />
      )}
      {sectionPoints.length > 0 && (
        <Line
          points={sectionPoints}
          segments
          color={sectionColor}
          lineWidth={2}
          transparent
          opacity={0.95}
          depthTest
          depthWrite={false}
        />
      )}
    </group>
  );
}

// ── 배치 영역 경계선 ─────────────────────────────────────────────
function getGroundGuideOffset(width: number, depth: number) {
  const minDim = Math.min(width, depth);
  return Math.min(0.002, Math.max(minDim * 0.0025, 0.00025));
}

function AreaBoundary({ area }: { area: { width: number; depth: number } }) {
  const hw = area.width / 2;
  const hd = area.depth / 2;
  const tick = Math.min(1, Math.max(Math.min(area.width, area.depth) * 0.12, 0.02));
  const y = getGroundGuideOffset(area.width, area.depth) * 0.5;
  const corners: [number, number, number][] = [
    [-hw, y, -hd],
    [ hw, y, -hd],
    [ hw, y,  hd],
    [-hw, y,  hd],
    [-hw, y, -hd],
  ];
  // 모서리 눈금 표시
  const ticks: Array<[[number,number,number],[number,number,number]]> = [
    [[-hw, y, -hd], [-hw + tick, y, -hd]],
    [[-hw, y, -hd], [-hw, y, -hd + tick]],
    [[ hw, y, -hd], [ hw - tick, y, -hd]],
    [[ hw, y, -hd], [ hw, y, -hd + tick]],
    [[-hw, y,  hd], [-hw + tick, y,  hd]],
    [[-hw, y,  hd], [-hw, y,  hd - tick]],
    [[ hw, y,  hd], [ hw - tick, y,  hd]],
    [[ hw, y,  hd], [ hw, y,  hd - tick]],
  ];
  return (
    <>
      {/* 외곽 경계선 */}
      <Line points={corners} color="#3b82f6" lineWidth={2.5} />
      {/* 모서리 눈금 */}
      {ticks.map(([a, b], i) => (
        <Line key={i} points={[a, b]} color="#60a5fa" lineWidth={1.5} />
      ))}
    </>
  );
}

// ── 개별 3D 오브젝트 ─────────────────────────────────────────────
function getGroundPlaneSurfaceColor(backgroundColor: string) {
  const surfaceColor = new THREE.Color(backgroundColor);
  const hsl = { h: 0, s: 0, l: 0 };
  surfaceColor.getHSL(hsl);

  if (hsl.l >= 0.72) {
    surfaceColor.offsetHSL(0, -0.04, -0.12);
  } else if (hsl.l >= 0.45) {
    surfaceColor.offsetHSL(0, -0.02, -0.08);
  } else {
    surfaceColor.offsetHSL(0, 0.03, 0.09);
  }

  return `#${surfaceColor.getHexString()}`;
}

function GroundPlane({ size, y, color, surfaceDepth }: { size: number; y: number; color: string; surfaceDepth: number }) {
  const surfaceColor = useMemo(() => getGroundPlaneSurfaceColor(color), [color]);

  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, y - surfaceDepth, 0]} raycast={() => null} renderOrder={-2}>
        <planeGeometry args={[size, size]} />
        <meshBasicMaterial color={surfaceColor} side={THREE.DoubleSide} toneMapped={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, y, 0]} receiveShadow raycast={() => null} renderOrder={-1}>
        <planeGeometry args={[size, size]} />
        <shadowMaterial
          transparent
          opacity={0.22}
          side={THREE.DoubleSide}
          depthWrite={false}
          polygonOffset
          polygonOffsetFactor={-1}
          polygonOffsetUnits={-1}
        />
      </mesh>
    </>
  );
}

const BOX_CEIL_EPS = 1e-6;

function roundUpLengthToStep(length: number, step: number) {
  if (!Number.isFinite(length) || !Number.isFinite(step) || step <= 0) return length;
  return Math.ceil((length - BOX_CEIL_EPS) / step) * step;
}

function getPlacementBounds(sourceBox: THREE.Box3, placementStep: number) {
  if (sourceBox.isEmpty()) return sourceBox.clone();

  const size = sourceBox.getSize(new THREE.Vector3());
  const center = sourceBox.getCenter(new THREE.Vector3());
  const minY = sourceBox.min.y;

  const sizeX = roundUpLengthToStep(size.x, placementStep);
  const sizeY = roundUpLengthToStep(size.y, placementStep);
  const sizeZ = roundUpLengthToStep(size.z, placementStep);

  return new THREE.Box3(
    new THREE.Vector3(center.x - sizeX * 0.5, minY, center.z - sizeZ * 0.5),
    new THREE.Vector3(center.x + sizeX * 0.5, minY + sizeY, center.z + sizeZ * 0.5),
  );
}

function snapGroupPlacementToGrid(
  group: THREE.Group,
  cellSize: number,
  sourceBox?: THREE.Box3,
) {
  if (!Number.isFinite(cellSize) || cellSize <= 0) return false;

  const actualBox = sourceBox ?? getGroupWorldBox(group, true);
  const box = getPlacementBounds(actualBox, cellSize);
  if (box.isEmpty()) return false;

  const snappedMinX = Math.round(box.min.x / cellSize) * cellSize;
  const snappedMinZ = Math.round(box.min.z / cellSize) * cellSize;
  const dx = snappedMinX - box.min.x;
  const dz = snappedMinZ - box.min.z;

  if (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6) return false;

  group.position.x += dx;
  group.position.z += dz;
  return true;
}

function getGroupWorldBox(group: THREE.Group, precise = false) {
  return new THREE.Box3().setFromObject(group, precise);
}

function getTargetElevation(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function getBoxElevation(box: THREE.Box3) {
  if (box.isEmpty()) return 0;
  return getTargetElevation(box.min.y);
}

function alignGroupBottomToElevation(
  group: THREE.Group,
  elevation: number,
  sourceBox?: THREE.Box3,
  precise = true,
) {
  const box = sourceBox ?? getGroupWorldBox(group, precise);
  if (box.isEmpty()) return false;

  const dy = getTargetElevation(elevation) - box.min.y;
  if (Math.abs(dy) < 1e-6) return false;

  group.position.y += dy;
  return true;
}

function clampGroupPositionToArea(
  group: THREE.Group,
  area?: { width: number; depth: number },
  sourceBox?: THREE.Box3,
  placementStep = 0.001,
) {
  if (!area) return false;

  const EPS = 0.001;
  const actualBox = sourceBox ?? getGroupWorldBox(group, true);
  const box = getPlacementBounds(actualBox, placementStep);
  if (box.isEmpty()) return false;

  const hw = area.width / 2;
  const hd = area.depth / 2;
  let clamped = false;

  if (box.max.x > hw + EPS) {
    const dx = box.max.x - hw;
    group.position.x -= dx;
    box.translate(new THREE.Vector3(-dx, 0, 0));
    clamped = true;
  }
  if (box.min.x < -hw - EPS) {
    const dx = box.min.x + hw;
    group.position.x -= dx;
    box.translate(new THREE.Vector3(-dx, 0, 0));
    clamped = true;
  }
  if (box.max.z > hd + EPS) {
    const dz = box.max.z - hd;
    group.position.z -= dz;
    box.translate(new THREE.Vector3(0, 0, -dz));
    clamped = true;
  }
  if (box.min.z < -hd - EPS) {
    const dz = box.min.z + hd;
    group.position.z -= dz;
    box.translate(new THREE.Vector3(0, 0, -dz));
    clamped = true;
  }

  return clamped;
}

function alignGroupToAreaEdgeByIntent(
  group: THREE.Group,
  area: { width: number; depth: number } | undefined,
  intendedPosition: { x: number; z: number },
  sourceBox?: THREE.Box3,
  snapTolerance = 0,
  placementStep = 0.001,
) {
  if (!area) return false;

  const EPS = 0.001;
  const actualBox = sourceBox ?? getGroupWorldBox(group, true);
  const box = getPlacementBounds(actualBox, placementStep);
  if (box.isEmpty()) return false;

  const intendedDx = intendedPosition.x - group.position.x;
  const intendedDz = intendedPosition.z - group.position.z;
  if (Math.abs(intendedDx) < EPS && Math.abs(intendedDz) < EPS) return false;

  const intendedBox = box.clone().translate(new THREE.Vector3(intendedDx, 0, intendedDz));
  const hw = area.width / 2;
  const hd = area.depth / 2;
  let aligned = false;

  if (intendedBox.max.x > hw + EPS && box.max.x < hw - EPS) {
    const dx = hw - box.max.x;
    group.position.x += dx;
    box.translate(new THREE.Vector3(dx, 0, 0));
    aligned = true;
  }
  if (intendedBox.min.x < -hw - EPS && box.min.x > -hw + EPS) {
    const dx = -hw - box.min.x;
    group.position.x += dx;
    box.translate(new THREE.Vector3(dx, 0, 0));
    aligned = true;
  }
  if (intendedBox.max.z > hd + EPS && box.max.z < hd - EPS) {
    const dz = hd - box.max.z;
    group.position.z += dz;
    box.translate(new THREE.Vector3(0, 0, dz));
    aligned = true;
  }
  if (intendedBox.min.z < -hd - EPS && box.min.z > -hd + EPS) {
    const dz = -hd - box.min.z;
    group.position.z += dz;
    box.translate(new THREE.Vector3(0, 0, dz));
    aligned = true;
  }

  if (snapTolerance > EPS) {
    if (intendedDx > EPS) {
      const gap = hw - box.max.x;
      if (gap > EPS && gap <= snapTolerance) {
        group.position.x += gap;
        box.translate(new THREE.Vector3(gap, 0, 0));
        aligned = true;
      }
    } else if (intendedDx < -EPS) {
      const gap = box.min.x + hw;
      if (gap > EPS && gap <= snapTolerance) {
        group.position.x -= gap;
        box.translate(new THREE.Vector3(-gap, 0, 0));
        aligned = true;
      }
    }

    if (intendedDz > EPS) {
      const gap = hd - box.max.z;
      if (gap > EPS && gap <= snapTolerance) {
        group.position.z += gap;
        box.translate(new THREE.Vector3(0, 0, gap));
        aligned = true;
      }
    } else if (intendedDz < -EPS) {
      const gap = box.min.z + hd;
      if (gap > EPS && gap <= snapTolerance) {
        group.position.z -= gap;
        box.translate(new THREE.Vector3(0, 0, -gap));
        aligned = true;
      }
    }
  }

  return aligned;
}

function SceneModelInner({
  obj, selected, transformMode, snapEnabled,
  measureMode, gdtMode, area, scaleLocked, gridCellSize,
  readOnly,
  onSelect, onTransformEnd, onMeasurePoint, onGdtPoint, onRegisterRef,
  onExceedsArea, onRemoveSelf, onScaleExceedsArea,
}: {
  obj: SceneObject;
  selected: boolean;
  transformMode: 'translate' | 'rotate' | 'scale';
  snapEnabled: boolean;
  measureMode: boolean;
  gdtMode: boolean;
  area?: { width: number; depth: number };
  scaleLocked: boolean;
  gridCellSize: number;
  readOnly?: boolean;
  onSelect: () => void;
  onTransformEnd: (pos: [number, number, number], rot: [number, number, number], scl: [number, number, number]) => void;
  onMeasurePoint: (p: THREE.Vector3, baseSize: number) => void;
  onGdtPoint: (p: THREE.Vector3, baseSize: number) => void;
  onRegisterRef: (id: string, group: THREE.Group | null) => void;
  onExceedsArea?: (name: string, sizeX: number, sizeZ: number) => void;
  onRemoveSelf?: () => void;
  onScaleExceedsArea?: () => void;
}) {
  const url = assetsApi.getStreamUrl(obj.sourceObject);
  const { scene } = useGLTF(url);
  const cloned = useMemo(() => {
    const clone = scene.clone(true);
    clone.traverse(child => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        // 재질을 복제하여 다른 Canvas(ModelViewer Stage)가 수정한
        // envMap 참조가 이 Canvas의 scene.environment를 덮어쓰지 않도록 함
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const clonedMats = mats.map(m => {
          const c = (m as THREE.Material).clone() as THREE.MeshStandardMaterial;
          c.envMap = null; // scene.environment로 IBL 사용
          c.needsUpdate = true;
          return c;
        });
        mesh.material = Array.isArray(mesh.material) ? clonedMats : clonedMats[0];
      }
    });
    return clone;
  }, [scene]);
  const groupRef = useRef<THREE.Group>(null);
  const transformRef = useRef<any>(null);
  const footprintRef = useRef<THREE.Mesh>(null);
  const footprintGeometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    return geometry;
  }, []);
  const draggingRef = useRef(false);
  // 모델 로드 후 바닥 자동 정렬 완료 여부
  const floorAlignedRef = useRef(false);
  // translate 모드 드래그 이동 상태
  const dragMoveRef = useRef<{
    startPos: THREE.Vector3;
    startHit: THREE.Vector3;
    plane: THREE.Plane;
  } | null>(null);
  const { gl, camera } = useThree();

  // 에셋(GLTF)이 교체될 때 자동 정렬 플래그 리셋
  useEffect(() => {
    floorAlignedRef.current = false;
  }, [cloned]);

  useEffect(() => () => {
    footprintGeometry.dispose();
  }, [footprintGeometry]);

  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;

    // ── ① 최초 1회: 씬 영역 크기 초과 검사 + 바닥 자동 정렬 ───────
    if (!floorAlignedRef.current) {
      const box = getGroupWorldBox(group, true);
      if (!box.isEmpty()) {
        if (area) {
          const placementBox = getPlacementBounds(box, gridCellSize);
          const sizeX = placementBox.max.x - placementBox.min.x;
          const sizeZ = placementBox.max.z - placementBox.min.z;
          if (sizeX > area.width || sizeZ > area.depth) {
            onExceedsArea?.(obj.name, sizeX, sizeZ);
            onRemoveSelf?.();
            return;
          }
        }
        const targetElevation = getTargetElevation(obj.position[1]);
        alignGroupBottomToElevation(group, targetElevation, box);

        // ② XZ: GLTF 모델 origin이 시각적 중심이 아닌 경우, cloned의 로컬 위치를
        //        조정해 group origin이 항상 시각적 중심이 되도록 함.
        //        group.position은 obj.position 그대로 유지해 재로드 시 이중 보정 방지.
        const centerX = (box.max.x + box.min.x) / 2;
        const centerZ = (box.max.z + box.min.z) / 2;
        cloned.position.x -= (centerX - group.position.x);
        cloned.position.z -= (centerZ - group.position.z);

        const alignedBox = getGroupWorldBox(group, true);
        snapGroupPlacementToGrid(group, gridCellSize, alignedBox);
        const snappedBox = getGroupWorldBox(group, true);
        clampGroupPositionToArea(group, area, snappedBox, gridCellSize);

        const finalBox = getGroupWorldBox(group, true);
        const p = group.position;
        const r = group.rotation;
        const s = group.scale;
        onTransformEnd(
          [p.x, getBoxElevation(finalBox), p.z],
          [THREE.MathUtils.radToDeg(r.x), THREE.MathUtils.radToDeg(r.y), THREE.MathUtils.radToDeg(r.z)],
          [s.x, s.y, s.z],
        );
        floorAlignedRef.current = true;
      }
      return;
    }

    // ── ② 바운딩 박스 계산 (풋프린트 + 클램프 공용) ─────────────
    // computeBoundingBox 강제 호출: Gaussian Splat 등 일부 에셋은 기본 bbox가 빈 상태
    group.traverse(child => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        if (mesh.geometry && !mesh.geometry.boundingBox) {
          mesh.geometry.computeBoundingBox();
        }
      }
    });
    let box = getGroupWorldBox(group, selected || draggingRef.current);
    if (box.isEmpty()) return;

    // ── ③ 풋프린트 업데이트 ──────────────────────────────────────
    let clamped = false;
    const EPS = 0.001;
    const targetElevation = getTargetElevation(obj.position[1]);
    if (Math.abs(box.min.y - targetElevation) > EPS) {
      alignGroupBottomToElevation(group, targetElevation, box);
      clamped = true;
      box = getGroupWorldBox(group, selected || draggingRef.current);
      if (box.isEmpty()) return;
    }

    // XZ 영역 제한은 이동 중일 때만 유지한다.
    if (draggingRef.current && clampGroupPositionToArea(group, area, box, gridCellSize)) clamped = true;

    if (footprintRef.current) {
      const footprintBox = getPlacementBounds(box, gridCellSize);
      const y = 0;
      const geometry = footprintRef.current.geometry as THREE.BufferGeometry;
      const position = geometry.getAttribute('position') as THREE.BufferAttribute;
      position.setXYZ(0, footprintBox.min.x, y, footprintBox.min.z);
      position.setXYZ(1, footprintBox.max.x, y, footprintBox.min.z);
      position.setXYZ(2, footprintBox.max.x, y, footprintBox.max.z);
      position.setXYZ(3, footprintBox.min.x, y, footprintBox.max.z);
      position.needsUpdate = true;
      geometry.computeBoundingSphere();
    }

    if (clamped && !draggingRef.current) {
      const p = group.position, r = group.rotation, s = group.scale;
      onTransformEnd(
        [p.x, getBoxElevation(box), p.z],
        [THREE.MathUtils.radToDeg(r.x), THREE.MathUtils.radToDeg(r.y), THREE.MathUtils.radToDeg(r.z)],
        [s.x, s.y, s.z],
      );
    }
  });

  // TransformControls 드래그 신호 (translate / rotate 전용)
  useEffect(() => {
    const tc = transformRef.current;
    if (!tc) return;
    const onDragging = (e: any) => {
      draggingRef.current = e.value;
      gl.domElement.dispatchEvent(new CustomEvent('transform-dragging', { detail: e.value }));
    };
    tc.addEventListener('dragging-changed', onDragging);
    return () => tc.removeEventListener('dragging-changed', onDragging);
  }, [gl]);

  const commitGroupTransform = useCallback((options?: { snapToGrid?: boolean }) => {
    const group = groupRef.current;
    if (!group) return;
    let box = getGroupWorldBox(group, true);
    const targetElevation = getTargetElevation(obj.position[1]);
    if (alignGroupBottomToElevation(group, targetElevation, box)) {
      box = getGroupWorldBox(group, true);
    }
    if (options?.snapToGrid && gridCellSize > 0) {
      snapGroupPlacementToGrid(group, gridCellSize, box);
      box = getGroupWorldBox(group, true);
    }
    if (clampGroupPositionToArea(group, area, box, gridCellSize)) {
      box = getGroupWorldBox(group, true);
    }
    const p = group.position, r = group.rotation, s = group.scale;
    onTransformEnd(
      [p.x, getBoxElevation(box), p.z],
      [THREE.MathUtils.radToDeg(r.x), THREE.MathUtils.radToDeg(r.y), THREE.MathUtils.radToDeg(r.z)],
      [s.x, s.y, s.z],
    );
  }, [area, gridCellSize, obj.position[1], onTransformEnd]);

  const handleTransformEnd = useCallback(() => {
    commitGroupTransform();
  }, [commitGroupTransform]);

  // ScaleHandles 드래그 완료 시 호출
  const handleScaleEnd = useCallback((_scl: [number, number, number]) => {
    commitGroupTransform();
  }, [commitGroupTransform]);

  const getCurrentAnnotationBaseSize = useCallback(() => {
    const group = groupRef.current;
    if (!group) return DEFAULT_ANNOTATION_BASE_SIZE;
    return getAnnotationBaseSizeFromBox(getGroupWorldBox(group, true));
  }, []);

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const annotationBaseSize = getCurrentAnnotationBaseSize();
    if (measureMode) onMeasurePoint(e.point.clone(), annotationBaseSize);
    else if (gdtMode) onGdtPoint(e.point.clone(), annotationBaseSize);
    else onSelect();
  };

  // translate 모드: 에셋 자체를 클릭&드래그하면 XZ 평면에서 이동
  const handleDragPointerDown = useCallback((e: ThreeEvent<PointerEvent>) => {
    if (transformMode !== 'translate' || measureMode || gdtMode) return;
    if (e.button !== 0) return;
    e.stopPropagation();
    const group = groupRef.current;
    if (!group) return;

    // 바닥 평면 (y=0) 기준 드래그
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const raycaster = new THREE.Raycaster();
    const rect = gl.domElement.getBoundingClientRect();
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(new THREE.Vector2(nx, ny), camera);
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(groundPlane, hit)) return;

    dragMoveRef.current = {
      startPos: group.position.clone(),
      startHit: hit.clone(),
      plane: groundPlane,
    };
    draggingRef.current = true;
    gl.domElement.dispatchEvent(new CustomEvent('transform-dragging', { detail: true }));
    // setPointerCapture은 R3F 내부 재렌더를 유발하므로 사용하지 않음
    onSelect();
  }, [transformMode, measureMode, gdtMode, gl, camera, onSelect]);

  const finishTranslateDrag = useCallback(() => {
    if (!dragMoveRef.current) return;
    dragMoveRef.current = null;
    draggingRef.current = false;
    gl.domElement.dispatchEvent(new CustomEvent('transform-dragging', { detail: false }));
    commitGroupTransform({ snapToGrid: true });
  }, [gl, commitGroupTransform]);

  // translate 드래그 pointermove / pointerup
  useEffect(() => {
    if (transformMode !== 'translate') return;
    const el = gl.domElement;
    const ownerWindow = el.ownerDocument?.defaultView ?? window;

    const onMove = (e: PointerEvent) => {
      const dm = dragMoveRef.current;
      if (!dm) return;
      const group = groupRef.current;
      if (!group) return;

      const rect = el.getBoundingClientRect();
      const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2(nx, ny), camera);
      const hit = new THREE.Vector3();
      if (!raycaster.ray.intersectPlane(dm.plane, hit)) return;

      const delta = hit.clone().sub(dm.startHit);
      const intendedX = dm.startPos.x + delta.x;
      const intendedZ = dm.startPos.z + delta.z;
      group.position.x = intendedX;
      group.position.z = intendedZ;
      let dragBox = getGroupWorldBox(group, true);

      // 씬 영역 클램프 (드래그 중 스냅 없이 부드럽게 이동)
      const snapTolerance = 0.15;
      alignGroupToAreaEdgeByIntent(group, area, { x: intendedX, z: intendedZ }, dragBox, snapTolerance, gridCellSize);
      dragBox = getGroupWorldBox(group, true);
      clampGroupPositionToArea(group, area, dragBox, gridCellSize);
    };

    const onUp = () => finishTranslateDrag();

    /*
      if (!dragMoveRef.current) return;
      dragMoveRef.current = null;
      draggingRef.current = false;
      el.dispatchEvent(new CustomEvent('transform-dragging', { detail: false }));
      // 드롭 시 그리드 스냅 적용
      const group = groupRef.current;
      if (group && gridCellSize > 0) {
        const box = getGroupWorldBox(group, true);
        snapGroupPlacementToGrid(group, gridCellSize, box);
      }
      handleTransformEnd();
    */

    ownerWindow.addEventListener('pointermove', onMove);
    ownerWindow.addEventListener('pointerup', onUp);
    ownerWindow.addEventListener('pointercancel', onUp);
    return () => {
      ownerWindow.removeEventListener('pointermove', onMove);
      ownerWindow.removeEventListener('pointerup', onUp);
      ownerWindow.removeEventListener('pointercancel', onUp);
    };
  }, [transformMode, gl, camera, area, gridCellSize, finishTranslateDrag]);

  // ref 등록
  useEffect(() => {
    if (groupRef.current) onRegisterRef(obj.id, groupRef.current);
    return () => onRegisterRef(obj.id, null);
  }, [obj.id]);

  // position 명령형 제어: React prop 대신 useEffect로 직접 설정
  // 드래그 중에는 실행하지 않아야 하지만 deps 변경이 없으면 effect는 실행 안 됨
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    // 드래그 중에는 React가 position을 덮어쓰지 않도록 함
    if (draggingRef.current) return;
    const targetElevation = getTargetElevation(obj.position[1]);
    group.position.x = obj.position[0];
    group.position.z = obj.position[2];
    alignGroupBottomToElevation(group, targetElevation);
    if (!floorAlignedRef.current) return;
    const wasClamped = clampGroupPositionToArea(group, area, undefined, gridCellSize);
    const normalizedElevation = Math.abs(targetElevation - obj.position[1]) > 0.001;
    if (!wasClamped && !normalizedElevation) return;

    const box = getGroupWorldBox(group, true);
    const p = group.position;
    const r = group.rotation;
    const s = group.scale;
    onTransformEnd(
      [p.x, getBoxElevation(box), p.z],
      [THREE.MathUtils.radToDeg(r.x), THREE.MathUtils.radToDeg(r.y), THREE.MathUtils.radToDeg(r.z)],
      [s.x, s.y, s.z],
    );
  }, [
    obj.position[0], obj.position[1], obj.position[2],
    obj.rotation[0], obj.rotation[1], obj.rotation[2],
    obj.scale[0], obj.scale[1], obj.scale[2],
    area, gridCellSize, onTransformEnd,
  ]);


  if (!obj.visible) return null;

  return (
    <>
      <group
        ref={groupRef}
        rotation={[
          THREE.MathUtils.degToRad(obj.rotation[0]),
          THREE.MathUtils.degToRad(obj.rotation[1]),
          THREE.MathUtils.degToRad(obj.rotation[2]),
        ]}
        scale={obj.scale}
        onClick={readOnly ? undefined : handleClick}
        onPointerDown={readOnly ? undefined : handleDragPointerDown}
      >
        <primitive object={cloned} />
      </group>

      {/* ── 에셋 풋프린트: 선택 시 바닥에 점유 면적 표시 ── */}
      {selected && (
        <mesh ref={footprintRef} geometry={footprintGeometry} renderOrder={2}>
          <meshBasicMaterial
            color="#38bdf8"
            transparent
            opacity={0.18}
            depthWrite={false}
            side={THREE.DoubleSide}
            polygonOffset
            polygonOffsetFactor={-2}
            polygonOffsetUnits={-2}
          />
        </mesh>
      )}

      {/* ── scale 모드: 커스텀 바운딩박스 핸들 ── */}
      {selected && transformMode === 'scale' && groupRef.current && (
        <ScaleHandles
          group={groupRef.current}
          scaleLocked={scaleLocked}
          area={area}
          placementStep={gridCellSize}
          onScaleEnd={handleScaleEnd}
          onScaleExceedsArea={onScaleExceedsArea}
        />
      )}

      {/* ── translate 모드: bbox 표시 + 에셋/박스 드래그로 이동 ── */}
      {selected && transformMode === 'translate' && groupRef.current && (
        <ScaleHandles
          group={groupRef.current}
          scaleLocked={false}
          area={area}
          placementStep={gridCellSize}
          onScaleEnd={() => {}}
          onScaleExceedsArea={onScaleExceedsArea}
          usePlacementBounds
          displayOnly
          onHitboxPointerDown={handleDragPointerDown}
        />
      )}

      {/* ── rotate 모드: TransformControls ── */}
      {selected && transformMode === 'rotate' && groupRef.current && (
        <TransformControls
          ref={transformRef}
          object={groupRef.current}
          mode="rotate"
          rotationSnap={snapEnabled ? THREE.MathUtils.degToRad(15) : null}
          onMouseUp={handleTransformEnd}
        />
      )}
    </>
  );
}

// ── SceneModel 에러 경계 ─────────────────────────────────────────
class SceneModelBoundary extends Component<{ name: string; children: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  render() {
    if (this.state.error) {
      return (
        <Html center>
          <div className="bg-red-900/80 text-red-200 text-xs px-2 py-1 rounded whitespace-nowrap pointer-events-none">
            로드 실패: {this.props.name}
          </div>
        </Html>
      );
    }
    return this.props.children;
  }
}

function SceneModel(props: Parameters<typeof SceneModelInner>[0]) {
  return (
    <SceneModelBoundary name={props.obj.name}>
      <SceneModelInner {...props} />
    </SceneModelBoundary>
  );
}

// ── 카메라 컨트롤러 ──────────────────────────────────────────────
export interface ViewportRef {
  getCameraState: () => { position: [number, number, number]; target: [number, number, number] };
  setCameraState: (pos: [number, number, number], target: [number, number, number]) => void;
  normalizeObject: (id: string) => [number, number, number] | null;
  fitObjectScaleToArea: (id: string, scale: [number, number, number]) => [number, number, number] | null;
  getGroundPosition: (clientX: number, clientY: number) => [number, number, number];
  getObjectBoundingBoxes: () => Map<string, {
    sizeX: number;
    sizeY: number;
    sizeZ: number;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
  }>;
}

function CameraController({ initialCamera, onRef, objectGroupRefs, area, maxAreaDim, placementStep }: {
  initialCamera: SceneData['camera'];
  onRef: (ref: ViewportRef) => void;
  objectGroupRefs: React.RefObject<Map<string, THREE.Group>>;
  area?: { width: number; depth: number };
  maxAreaDim: number;
  placementStep: number;
}) {
  const { camera, gl } = useThree();
  const orbitRef = useRef<any>(null);

  useEffect(() => {
    camera.position.set(...initialCamera.position);
    if (orbitRef.current) {
      orbitRef.current.target.set(...initialCamera.target);
      orbitRef.current.update();
    }
  }, [camera, initialCamera.position, initialCamera.target]);

  useEffect(() => {
    const boxFitsArea = (box: THREE.Box3) => {
      if (!area || box.isEmpty()) return true;
      const placementBox = getPlacementBounds(box, placementStep);
      const EPS = 0.001;
      const hw = area.width / 2;
      const hd = area.depth / 2;
      return (
        placementBox.max.x <= hw + EPS &&
        placementBox.min.x >= -hw - EPS &&
        placementBox.max.z <= hd + EPS &&
        placementBox.min.z >= -hd - EPS
      );
    };

    onRef({
      getCameraState: () => {
        const p = camera.position;
        const t = orbitRef.current?.target ?? new THREE.Vector3();
        return { position: [p.x, p.y, p.z], target: [t.x, t.y, t.z] };
      },
      setCameraState: (pos, target) => {
        camera.position.set(...pos);
        if (orbitRef.current) {
          orbitRef.current.target.set(...target);
          orbitRef.current.update();
        }
      },
      normalizeObject: (id: string) => {
        const group = objectGroupRefs.current?.get(id);
        if (!group) return null;
        const box = getGroupWorldBox(group, true);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        if (maxDim === 0) return null;
        const s = 1.0 / maxDim;
        return [s, s, s];
      },
      fitObjectScaleToArea: (id, scale) => {
        const group = objectGroupRefs.current?.get(id);
        if (!group) return null;

        const originalPosition = group.position.clone();
        const originalScale = group.scale.clone();
        const requestedScale = new THREE.Vector3(
          Math.max(0.001, scale[0]),
          Math.max(0.001, scale[1]),
          Math.max(0.001, scale[2]),
        );

        const applyCandidate = (nextScale: THREE.Vector3) => {
          group.position.copy(originalPosition);
          group.scale.copy(nextScale);

          const box = getGroupWorldBox(group, true);
          if (!box.isEmpty() && Math.abs(box.min.y) > 0.001) {
            group.position.y -= box.min.y;
            box.translate(new THREE.Vector3(0, -box.min.y, 0));
          }

          return {
            fits: boxFitsArea(box),
            scale: group.scale.clone(),
          };
        };

        let best = applyCandidate(originalScale);
        if (best.fits) {
          const requested = applyCandidate(requestedScale);
          if (requested.fits) {
            best = requested;
          } else {
            let lo = 0;
            let hi = 1;
            for (let i = 0; i < 20; i++) {
              const mid = (lo + hi) / 2;
              const candidateScale = originalScale.clone().lerp(requestedScale, mid);
              const candidate = applyCandidate(candidateScale);
              if (candidate.fits) {
                best = candidate;
                lo = mid;
              } else {
                hi = mid;
              }
            }
          }
        }

        group.position.copy(originalPosition);
        group.scale.copy(originalScale);
        return [best.scale.x, best.scale.y, best.scale.z];
      },
      getObjectBoundingBoxes: () => {
        const result = new Map<string, {
          sizeX: number;
          sizeY: number;
          sizeZ: number;
          minX: number;
          maxX: number;
          minY: number;
          maxY: number;
          minZ: number;
          maxZ: number;
        }>();
        objectGroupRefs.current?.forEach((group, id) => {
          const box = getGroupWorldBox(group, true);
          if (!box.isEmpty()) {
            result.set(id, {
              sizeX: box.max.x - box.min.x,
              sizeY: box.max.y - box.min.y,
              sizeZ: box.max.z - box.min.z,
              minX: box.min.x,
              maxX: box.max.x,
              minY: box.min.y,
              maxY: box.max.y,
              minZ: box.min.z,
              maxZ: box.max.z,
            });
          }
        });
        return result;
      },
      getGroundPosition: (clientX: number, clientY: number) => {
        const canvas = gl.domElement;
        const rect = canvas.getBoundingClientRect();
        const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
        const ny = -((clientY - rect.top) / rect.height) * 2 + 1;
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(new THREE.Vector2(nx, ny), camera);
        const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        const hit = new THREE.Vector3();
        if (!raycaster.ray.intersectPlane(groundPlane, hit)) {
          return [0, 0, 0];
        }
        // 드롭 즉시 그리드에 스냅
        if (placementStep > 0) {
          hit.x = Math.round(hit.x / placementStep) * placementStep;
          hit.z = Math.round(hit.z / placementStep) * placementStep;
        }
        // 씬 허용 영역 내로 클램프
        if (area) {
          const hw = area.width / 2, hd = area.depth / 2;
          hit.x = Math.max(-hw, Math.min(hw, hit.x));
          hit.z = Math.max(-hd, Math.min(hd, hit.z));
        }
        return [hit.x, 0, hit.z];
      },
    });
  }, [area, camera, gl, objectGroupRefs, onRef, placementStep]);

  useEffect(() => {
    const handler = (e: any) => {
      if (orbitRef.current) orbitRef.current.enabled = !e.detail;
    };
    gl.domElement.addEventListener('transform-dragging', handler as any);
    return () => gl.domElement.removeEventListener('transform-dragging', handler as any);
  }, [gl]);

  // 그리드 전체가 항상 보이도록 최소 거리 = 영역 대각선 * 0.7, 최대 각도 = 75°
  const minDist = maxAreaDim * 0.7;
  const maxDist = maxAreaDim * 20;

  return (
    <OrbitControls
      ref={orbitRef}
      makeDefault
      enableDamping
      minPolarAngle={0.05}
      maxPolarAngle={Math.PI * 5 / 12}
      minDistance={minDist}
      maxDistance={maxDist}
      mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }}
    />
  );
}

// ── Viewport 메인 ────────────────────────────────────────────────
interface ViewportProps {
  sceneData: SceneData;
  selectedId: string | null;
  transformMode: 'translate' | 'rotate' | 'scale';
  measureMode: boolean;
  gdtMode: boolean;
  scaleLocked: boolean;
  readOnly?: boolean;
  onSelectObject: (id: string | null) => void;
  onTransformEnd: (id: string, pos: [number, number, number], rot: [number, number, number], scl: [number, number, number]) => void;
  onViewportRef: (ref: ViewportRef) => void;
  onDropAsset?: (position: [number, number, number]) => void;
  onObjectExceedsArea?: (name: string, sizeX: number, sizeZ: number) => void;
  onScaleExceedsArea?: () => void;
  onObjectRemove?: (id: string) => void;
}

export default function Viewport({
  sceneData, selectedId, transformMode, measureMode, gdtMode, scaleLocked,
  readOnly = false,
  onSelectObject, onTransformEnd, onViewportRef, onDropAsset,
  onObjectExceedsArea, onScaleExceedsArea, onObjectRemove,
}: ViewportProps) {
  const { lighting, grid, objects, backgroundColor } = sceneData;
  const maxAreaDim = Math.max(sceneData.area?.width ?? 20, sceneData.area?.depth ?? 20);
  const groundGuideOffset = sceneData.area ? getGroundGuideOffset(sceneData.area.width, sceneData.area.depth) : 0.00025;
  const defaultGridCellSize = maxAreaDim <= 0.5 ? 0.01 : maxAreaDim <= 2 ? 0.05 : maxAreaDim <= 10 ? 0.1 : maxAreaDim <= 50 ? 0.5 : 1;
  const gridCellSize = grid.snapSize > 0 ? grid.snapSize : defaultGridCellSize;
  const gridSectionSize = gridCellSize * 5;


  const gridYOffset = groundGuideOffset;
  const groundPlaneY = 0;
  const groundPlaneDepth = groundGuideOffset * 0.1;
  // 고정 크기 사용: 단위 변환 시 값이 바뀌면 planeGeometry가 재생성되어 한 프레임 깜빡임 발생
  const groundPlaneSize = 50000;
  const shadowFrustum = Math.max(maxAreaDim * 1.25, 8);
  const shadowFar = Math.max(shadowFrustum * 6, 80);
  const gridColor = grid.color ?? DEFAULT_SCENE_DATA.grid.color;
  const gridSectionColor = useMemo(() => {
    const color = new THREE.Color(gridColor);
    color.offsetHSL(0, 0, 0.18);
    return `#${color.getHexString()}`;
  }, [gridColor]);

  // 오브젝트 Three.js Group 레퍼런스 (정규화용)
  const objectGroupRefs = useRef<Map<string, THREE.Group>>(new Map());
  const registerRef = useCallback((id: string, group: THREE.Group | null) => {
    if (group) objectGroupRefs.current.set(id, group);
    else objectGroupRefs.current.delete(id);
  }, []);

  // 측정 포인트 (에셋 표면 기준)
  const [measurePoints, setMeasurePoints] = useState<AnnotationPoint[]>([]);

  useEffect(() => {
    if (!measureMode) setMeasurePoints([]);
  }, [measureMode]);

  const handleMeasurePoint = useCallback((position: THREE.Vector3, baseSize: number) => {
    const nextPoint = { position, baseSize };
    setMeasurePoints(prev => prev.length >= 2 ? [nextPoint] : [...prev, nextPoint]);
  }, []);

  // GD&T 어노테이션
  const [gdtMarkers, setGdtMarkers] = useState<{ position: THREE.Vector3; type: string; tolerance: string; baseSize: number }[]>([]);
  const [gdtPending, setGdtPending] = useState<AnnotationPoint | null>(null);

  useEffect(() => {
    if (!gdtMode) { setGdtPending(null); }
  }, [gdtMode]);

  const handleGdtPoint = useCallback((position: THREE.Vector3, baseSize: number) => {
    setGdtPending({ position, baseSize });
  }, []);

  const handleGdtPick = useCallback((type: string, tolerance: string) => {
    if (!gdtPending) return;
    setGdtMarkers(prev => [...prev, { position: gdtPending.position, type, tolerance, baseSize: gdtPending.baseSize }]);
    setGdtPending(null);
  }, [gdtPending]);

  const activeCursor = readOnly ? 'grab' : gdtMode ? 'crosshair' : measureMode ? 'crosshair' : 'default';
  const [isDragOver, setIsDragOver] = useState(false);
  const viewportRefLocal = useRef<ViewportRef | null>(null);

  const handleViewportRef = (ref: ViewportRef) => {
    viewportRefLocal.current = ref;
    onViewportRef(ref);
  };

  return (
    <div
      className="w-full h-full relative"
      onDragOver={e => {
        if (readOnly || !onDropAsset) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setIsDragOver(true);
      }}
      onDragLeave={() => {
        if (readOnly) return;
        setIsDragOver(false);
      }}
      onDrop={e => {
        e.preventDefault();
        setIsDragOver(false);
        if (readOnly || !onDropAsset || !viewportRefLocal.current) return;
        const pos = viewportRefLocal.current.getGroundPosition(e.clientX, e.clientY);
        onDropAsset(pos);
      }}
    >
      {isDragOver && (
        <div className="absolute inset-0 border-2 border-sky-400/60 bg-sky-400/5 pointer-events-none z-10 rounded" />
      )}
      <Canvas
        shadows
        camera={{
          fov: 60,
          near: Math.max(0.01, maxAreaDim * 0.0005),
          far: Math.max(2000, maxAreaDim * 200),
        }}
        gl={{ antialias: true, localClippingEnabled: true }}
        onPointerMissed={() => !readOnly && !measureMode && !gdtMode && onSelectObject(null)}
        style={{ background: backgroundColor ?? '#1a1a2e', cursor: activeCursor }}
      >
        {/* GLB PBR 재질(MeshStandardMaterial)의 텍스처·색상이 IBL 없이 사라지는 문제 방지 */}
        <Environment preset="city" background={false} />
        <ambientLight intensity={lighting.ambient.intensity} color={lighting.ambient.color} />
        <directionalLight
          castShadow
          intensity={lighting.directional.intensity}
          color={lighting.directional.color}
          position={lighting.directional.position}
          shadow-mapSize={[2048, 2048]}
          shadow-camera-left={-shadowFrustum}
          shadow-camera-right={shadowFrustum}
          shadow-camera-top={shadowFrustum}
          shadow-camera-bottom={-shadowFrustum}
          shadow-camera-near={0.5}
          shadow-camera-far={shadowFar}
          shadow-bias={-0.0002}
          shadow-normalBias={0.0005}
        />

        <GroundPlane size={groundPlaneSize} y={groundPlaneY} color={backgroundColor ?? '#1a1a2e'} surfaceDepth={groundPlaneDepth} />

        {grid.enabled && (
          <BoundedGrid
            area={sceneData.area}
            yOffset={gridYOffset}
            cellSize={gridCellSize}
            sectionSize={gridSectionSize}
            cellColor={gridColor}
            sectionColor={gridSectionColor}
          />
        )}

        {/* 배치 영역 경계선 */}
        {sceneData.area && <AreaBoundary area={sceneData.area} />}

        {/* 측정 시각화 */}
        <MeasureVisual points={measurePoints} unit={sceneData.unit} />

        {/* GD&T 어노테이션 시각화 */}
        <GdtVisual annotations={gdtMarkers} />

        {/* 오브젝트 */}
        <Suspense fallback={null}>
          {objects.map(obj => (
            <SceneModel
              key={obj.id}
              obj={obj}
              selected={!readOnly && !measureMode && !gdtMode && selectedId === obj.id}
              transformMode={transformMode}
              snapEnabled={grid.snap}
              measureMode={measureMode}
              gdtMode={gdtMode}
              area={sceneData.area}
              scaleLocked={scaleLocked}
              gridCellSize={gridCellSize}
              readOnly={readOnly}
              onSelect={() => onSelectObject(obj.id)}
              onTransformEnd={(pos, rot, scl) => onTransformEnd(obj.id, pos, rot, scl)}
              onMeasurePoint={handleMeasurePoint}
              onGdtPoint={handleGdtPoint}
              onRegisterRef={registerRef}
              onExceedsArea={onObjectExceedsArea}
              onScaleExceedsArea={onScaleExceedsArea}
              onRemoveSelf={() => onObjectRemove?.(obj.id)}
            />
          ))}
        </Suspense>

        <CameraController initialCamera={sceneData.camera} onRef={handleViewportRef} objectGroupRefs={objectGroupRefs} area={sceneData.area} maxAreaDim={maxAreaDim} placementStep={gridCellSize} />

        <GizmoHelper alignment="bottom-right" margin={[80, 80]}>
          <GizmoViewport axisColors={['#ff4060', '#80ff60', '#4080ff']} labelColor="white" />
        </GizmoHelper>
      </Canvas>

      {/* GD&T 공차 선택 팝업 */}
      {gdtPending && (
        <GdtPicker
          onPick={handleGdtPick}
          onCancel={() => setGdtPending(null)}
        />
      )}
    </div>
  );
}
