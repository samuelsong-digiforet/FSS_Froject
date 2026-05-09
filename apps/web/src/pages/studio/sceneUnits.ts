import { SceneData, SceneUnit } from '@/api/scenes';

export const SCENE_LENGTH_VERSION = 2;

const UNIT_TO_METERS: Record<SceneUnit, number> = {
  m: 1,
  cm: 0.01,
  mm: 0.001,
  ft: 0.3048,
};

type ScaleSceneOptions = {
  includeObjects?: boolean;
  includeObjectScale?: boolean;
  includeCamera?: boolean;
  includeSavedViews?: boolean;
  includeLighting?: boolean;
};

const roundLength = (value: number) => {
  if (!Number.isFinite(value)) return value;
  return Math.round(value * 1_000_000) / 1_000_000;
};

export function getUnitMeters(unit: SceneUnit) {
  return UNIT_TO_METERS[unit];
}

export function toMeters(value: number, unit: SceneUnit) {
  return roundLength(value * getUnitMeters(unit));
}

export function fromMeters(value: number, unit: SceneUnit) {
  return roundLength(value / getUnitMeters(unit));
}

export function formatDisplayLength(valueInMeters: number, unit: SceneUnit, digits = 3) {
  const display = fromMeters(valueInMeters, unit);
  return String(Number(display.toFixed(digits)));
}

function scaleVec3(
  value: [number, number, number],
  factor: number,
): [number, number, number] {
  return [
    roundLength(value[0] * factor),
    roundLength(value[1] * factor),
    roundLength(value[2] * factor),
  ];
}

export function scaleSceneLengths(
  scene: SceneData,
  factor: number,
  options: ScaleSceneOptions = {},
): SceneData {
  const {
    includeObjects = true,
    includeObjectScale = false,
    includeCamera = true,
    includeSavedViews = true,
    includeLighting = true,
  } = options;

  return {
    ...scene,
    area: {
      width: roundLength(scene.area.width * factor),
      depth: roundLength(scene.area.depth * factor),
    },
    grid: {
      ...scene.grid,
      snapSize: roundLength(scene.grid.snapSize * factor),
    },
    objects: includeObjects
      ? scene.objects.map(obj => ({
        ...obj,
        position: scaleVec3(obj.position, factor),
        // Object scale is a multiplier, not a scene length.
        scale: includeObjectScale ? scaleVec3(obj.scale, factor) : obj.scale,
      }))
      : scene.objects,
    camera: includeCamera
      ? {
        position: scaleVec3(scene.camera.position, factor),
        target: scaleVec3(scene.camera.target, factor),
      }
      : scene.camera,
    savedViews: includeSavedViews
      ? scene.savedViews.map(view => ({
        ...view,
        position: scaleVec3(view.position, factor),
        target: scaleVec3(view.target, factor),
      }))
      : scene.savedViews,
    lighting: includeLighting
      ? {
        ...scene.lighting,
        directional: {
          ...scene.lighting.directional,
          position: scaleVec3(scene.lighting.directional.position, factor),
        },
      }
      : scene.lighting,
    lengthUnitVersion: SCENE_LENGTH_VERSION,
  };
}

export function normalizeSceneLengthData(scene: SceneData): SceneData {
  if (scene.lengthUnitVersion === SCENE_LENGTH_VERSION) {
    return {
      ...scene,
      lengthUnitVersion: SCENE_LENGTH_VERSION,
    };
  }

  const factor = getUnitMeters(scene.unit);
  return scaleSceneLengths(
    {
      ...scene,
      lengthUnitVersion: undefined,
    },
    factor,
    {
      includeObjects: true,
      includeCamera: true,
      includeSavedViews: true,
      includeLighting: true,
    },
  );
}
