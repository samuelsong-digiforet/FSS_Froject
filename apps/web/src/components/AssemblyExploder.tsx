import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, useGLTF } from '@react-three/drei';
import * as THREE from 'three';

type AssemblyMode = 'assembled' | 'exploded';

type AssemblyInfo = {
  partCount: number;
  canExplode: boolean;
  rootName?: string;
};

type AssemblyPart = {
  object: THREE.Object3D;
  assembledPosition: THREE.Vector3;
  explodedPosition: THREE.Vector3;
  originalQuaternion: THREE.Quaternion;
  originalScale: THREE.Vector3;
  originalWorldPosition: THREE.Vector3;
  direction: THREE.Vector3;
  distance: number;
};

type PreparedAssembly = {
  scene: THREE.Group;
  parts: AssemblyPart[];
  radius: number;
  rootName?: string;
};

const MIN_EXPLODE_PARTS = 2;
const ASSEMBLY_ANIMATION_MS = 700;

function isMeshLike(object: THREE.Object3D): boolean {
  const candidate = object as THREE.Mesh & { isSkinnedMesh?: boolean };
  return candidate.isMesh || candidate.isSkinnedMesh === true;
}

function hasRenderableMesh(object: THREE.Object3D): boolean {
  let found = false;
  object.traverse((child) => {
    if (!found && child.visible && isMeshLike(child)) found = true;
  });
  return found;
}

function getRenderableChildren(object: THREE.Object3D): THREE.Object3D[] {
  return object.children.filter((child) => child.visible && hasRenderableMesh(child));
}

function findBranchRoot(root: THREE.Object3D): THREE.Object3D {
  let current = root;

  while (!isMeshLike(current)) {
    const children = getRenderableChildren(current);
    if (children.length !== 1) return current;
    current = children[0];
  }

  return current;
}

function collectPartObjects(root: THREE.Object3D, scene: THREE.Object3D): THREE.Object3D[] {
  const directParts = getRenderableChildren(root);
  if (directParts.length >= MIN_EXPLODE_PARTS) return directParts;

  const meshParts: THREE.Object3D[] = [];
  scene.traverse((child) => {
    if (child !== scene && child.visible && isMeshLike(child)) meshParts.push(child);
  });
  return meshParts;
}

function fallbackDirection(index: number, count: number): THREE.Vector3 {
  const angle = (index / Math.max(count, 1)) * Math.PI * 2;
  const y = ((index % 5) - 2) * 0.18;
  return new THREE.Vector3(Math.cos(angle), y, Math.sin(angle)).normalize();
}

function easeInOutCubic(value: number): number {
  return value < 0.5
    ? 4 * value * value * value
    : 1 - Math.pow(-2 * value + 2, 3) / 2;
}

function cloneScene(sourceScene: THREE.Group): THREE.Group {
  const scene = sourceScene.clone(true);
  return scene;
}

function freezeSceneMatrices(scene: THREE.Object3D) {
  scene.traverse((object) => {
    object.updateMatrix();
    object.matrixAutoUpdate = false;
  });
}

function prepareAssembly(sourceScene: THREE.Group): PreparedAssembly {
  const scene = cloneScene(sourceScene);
  const box = new THREE.Box3().setFromObject(scene);
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  box.getCenter(center);
  box.getSize(size);

  scene.position.sub(center);
  scene.updateMatrixWorld(true);

  const centeredBox = new THREE.Box3().setFromObject(scene);
  const centeredCenter = new THREE.Vector3();
  const centeredSize = new THREE.Vector3();
  centeredBox.getCenter(centeredCenter);
  centeredBox.getSize(centeredSize);

  const radius = Math.max(centeredSize.length() * 0.5, 1);
  const maxAxis = Math.max(centeredSize.x, centeredSize.y, centeredSize.z, 1);
  const branchRoot = findBranchRoot(scene);
  const partObjects = collectPartObjects(branchRoot, scene);

  const parts = partObjects.map((object, index) => {
    const parent = object.parent;
    const partBox = new THREE.Box3().setFromObject(object);
    const partCenter = new THREE.Vector3();
    const partSize = new THREE.Vector3();
    partBox.getCenter(partCenter);
    partBox.getSize(partSize);

    let direction = partCenter.sub(centeredCenter);
    if (direction.lengthSq() < 0.000001) {
      direction = fallbackDirection(index, partObjects.length);
    } else {
      direction.normalize();
    }

    const originalWorldPosition = object.getWorldPosition(new THREE.Vector3());
    const targetWorldPosition = originalWorldPosition
      .clone()
      .add(direction.clone().multiplyScalar(maxAxis * 0.75 + Math.min(partSize.length() * 0.25, maxAxis * 0.35)));

    return {
      object,
      assembledPosition: object.position.clone(),
      explodedPosition: parent ? parent.worldToLocal(targetWorldPosition) : object.position.clone(),
      originalQuaternion: object.quaternion.clone(),
      originalScale: object.scale.clone(),
      originalWorldPosition,
      direction,
      distance: maxAxis * 0.75 + Math.min(partSize.length() * 0.25, maxAxis * 0.35),
    };
  });

  freezeSceneMatrices(scene);

  return {
    scene,
    parts,
    radius,
    rootName: branchRoot.name || undefined,
  };
}

function setAssemblyProgress(assembly: PreparedAssembly, progress: number) {
  const amount = THREE.MathUtils.clamp(progress, 0, 1);

  assembly.parts.forEach((part) => {
    part.object.position.set(
      THREE.MathUtils.lerp(part.assembledPosition.x, part.explodedPosition.x, amount),
      THREE.MathUtils.lerp(part.assembledPosition.y, part.explodedPosition.y, amount),
      THREE.MathUtils.lerp(part.assembledPosition.z, part.explodedPosition.z, amount),
    );
    part.object.quaternion.copy(part.originalQuaternion);
    part.object.scale.copy(part.originalScale);
    part.object.updateMatrix();
    part.object.matrixWorldNeedsUpdate = true;
  });

  assembly.scene.updateMatrix();
  assembly.scene.updateMatrixWorld(true);
}

function getModeProgress(mode: AssemblyMode, assembly: PreparedAssembly): number {
  return mode === 'exploded' && assembly.parts.length >= MIN_EXPLODE_PARTS ? 1 : 0;
}

function CameraFit({ radius }: { radius: number }) {
  const { camera, controls } = useThree();

  useEffect(() => {
    const perspectiveCamera = camera as THREE.PerspectiveCamera;
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(perspectiveCamera.fov) / 2);

    camera.position.set(distance * 0.55, distance * 0.35, distance * 0.85);
    camera.near = Math.max(distance * 0.001, 0.001);
    camera.far = distance * 20;
    camera.lookAt(0, 0, 0);
    perspectiveCamera.updateProjectionMatrix();

    if (controls) {
      const orbitControls = controls as unknown as { minDistance: number; maxDistance: number };
      orbitControls.minDistance = radius * 0.5;
      orbitControls.maxDistance = distance * 5;
    }
  }, [camera, controls, radius]);

  return null;
}

function AssemblyModel({
  url,
  mode,
  onInfo,
}: {
  url: string;
  mode: AssemblyMode;
  onInfo: (info: AssemblyInfo) => void;
}) {
  const { scene: sourceScene } = useGLTF(url);
  const { invalidate } = useThree();
  const assembly = useMemo(() => prepareAssembly(sourceScene), [sourceScene]);
  const progressRef = useRef(getModeProgress(mode, assembly));
  const animationRef = useRef<{
    from: number;
    to: number;
    start: number;
  } | null>(null);

  useLayoutEffect(() => {
    const progress = getModeProgress(mode, assembly);
    progressRef.current = progress;
    animationRef.current = null;
    setAssemblyProgress(assembly, progress);
    invalidate();
  }, [assembly, invalidate]);

  useEffect(() => {
    const target = getModeProgress(mode, assembly);
    const current = progressRef.current;

    if (Math.abs(current - target) < 0.001) {
      setAssemblyProgress(assembly, target);
      progressRef.current = target;
      animationRef.current = null;
      invalidate();
      return;
    }

    animationRef.current = {
      from: current,
      to: target,
      start: performance.now(),
    };
    invalidate();
  }, [assembly, invalidate, mode]);

  useFrame(() => {
    const animation = animationRef.current;
    if (!animation) return;

    const elapsed = performance.now() - animation.start;
    const rawProgress = THREE.MathUtils.clamp(elapsed / ASSEMBLY_ANIMATION_MS, 0, 1);
    const eased = easeInOutCubic(rawProgress);
    const nextProgress = THREE.MathUtils.lerp(animation.from, animation.to, eased);

    progressRef.current = nextProgress;
    setAssemblyProgress(assembly, nextProgress);

    if (rawProgress >= 1) {
      progressRef.current = animation.to;
      setAssemblyProgress(assembly, animation.to);
      animationRef.current = null;
    } else {
      invalidate();
    }
  });

  useEffect(() => {
    onInfo({
      partCount: assembly.parts.length,
      canExplode: assembly.parts.length >= MIN_EXPLODE_PARTS,
      rootName: assembly.rootName,
    });
  }, [assembly, onInfo]);

  return (
    <>
      <CameraFit radius={assembly.radius} />
      <primitive object={assembly.scene} />
    </>
  );
}

function LoadingFallback() {
  return (
    <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-400">
      모델을 불러오는 중...
    </div>
  );
}

function InvalidateOnChange({ value }: { value: string | number }) {
  const { invalidate } = useThree();

  useEffect(() => {
    invalidate();
  }, [invalidate, value]);

  return null;
}

export default function AssemblyExploder({
  url,
  title,
  onClose,
}: {
  url: string;
  title: string;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<AssemblyMode>('assembled');
  const [info, setInfo] = useState<AssemblyInfo>({ partCount: 0, canExplode: false });
  const [bgColor, setBgColor] = useState('#ffffff');

  useEffect(() => {
    setMode('assembled');
    setInfo({ partCount: 0, canExplode: false });
  }, [url]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const handleInfo = useCallback((nextInfo: AssemblyInfo) => {
    setInfo((prev) => (
      prev.partCount === nextInfo.partCount &&
      prev.canExplode === nextInfo.canExplode &&
      prev.rootName === nextInfo.rootName
        ? prev
        : nextInfo
    ));
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-[60] m-0 flex h-screen w-screen flex-col overflow-hidden bg-gray-950"
      style={{ inset: 0, minHeight: '100dvh' }}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-800 bg-gray-900 px-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-white">분해/조립</div>
          <div className="truncate text-xs text-gray-400">{title}</div>
        </div>

        <span className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300">
          파트 {info.partCount.toLocaleString()}개
        </span>

        <div className="flex overflow-hidden rounded border border-gray-700">
          <button
            type="button"
            onClick={() => setMode('assembled')}
            disabled={mode === 'assembled'}
            className={`px-3 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
              mode === 'assembled'
                ? 'bg-emerald-500 text-white'
                : 'bg-gray-800 text-gray-200 hover:bg-gray-700'
            }`}
          >
            조립
          </button>
          <button
            type="button"
            onClick={() => setMode('exploded')}
            disabled={!info.canExplode || mode === 'exploded'}
            className={`border-l border-gray-700 px-3 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
              mode === 'exploded'
                ? 'bg-orange-500 text-white'
                : 'bg-gray-800 text-gray-200 hover:bg-gray-700'
            }`}
          >
            해체
          </button>
        </div>

        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-gray-400">
          배경색
          <input
            type="color"
            value={bgColor}
            onChange={(event) => setBgColor(event.target.value)}
            className="h-5 w-7 cursor-pointer rounded border-0 bg-transparent"
          />
        </label>

        <button
          type="button"
          onClick={onClose}
          className="rounded border border-gray-700 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-800"
        >
          닫기
        </button>
      </div>

      {!info.canExplode && info.partCount > 0 && (
        <div className="shrink-0 border-b border-amber-900/60 bg-amber-950/50 px-4 py-2 text-xs text-amber-200">
          이 GLB는 분해 가능한 하위 파트가 충분하지 않습니다. 부품별 Mesh/Group이 포함된 GLB에서 해체가 동작합니다.
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <Suspense fallback={<LoadingFallback />}>
          <Canvas
            camera={{ position: [3, 2, 5], fov: 45 }}
            dpr={[1, 1.25]}
            frameloop="demand"
            gl={{ antialias: false, powerPreference: 'high-performance' }}
          >
            <InvalidateOnChange value={bgColor} />
            <color attach="background" args={[bgColor]} />
            <ambientLight intensity={0.8} />
            <directionalLight position={[5, 8, 6]} intensity={1.3} />
            <directionalLight position={[-5, 3, -4]} intensity={0.45} />
            <AssemblyModel url={url} mode={mode} onInfo={handleInfo} />
            <OrbitControls makeDefault enableDamping={false} target={[0, 0, 0]} minDistance={0.5} maxDistance={500} />
          </Canvas>
        </Suspense>
      </div>
    </div>,
    document.body,
  );
}
