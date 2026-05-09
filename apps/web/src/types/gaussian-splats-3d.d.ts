declare module '@mkkellogg/gaussian-splats-3d' {
  import * as THREE from 'three';

  export const SceneFormat: {
    Splat: number;
    KSplat: number;
    Ply: number;
    Spz: number;
  };

  export const RenderMode: {
    Always: 0;
    OnChange: 1;
    Never: 2;
  };

  export interface DropInViewerOptions {
    gpuAcceleratedSort?: boolean;
    sharedMemoryForWorkers?: boolean;
    integerBasedSort?: boolean;
    selfDrivenMode?: boolean;
    ignoreDevicePixelRatio?: boolean;
    halfPrecisionCovariancesOnGPU?: boolean;
    renderMode?: number;
    inMemoryCompressionLevel?: 0 | 1 | 2;
    freeIntermediateSplatData?: boolean;
    antialiased?: boolean;
    useBuiltInControls?: boolean;
    [key: string]: unknown;
  }

  export interface SplatSceneOptions {
    format?: unknown;
    splatAlphaRemovalThreshold?: number;
    showLoadingUI?: boolean;
    position?: [number, number, number];
    rotation?: [number, number, number, number];
    scale?: [number, number, number];
    progressiveLoad?: boolean;
    [key: string]: unknown;
  }

  export class DropInViewer extends THREE.Group {
    constructor(options?: DropInViewerOptions);
    addSplatScene(path: string, options?: SplatSceneOptions): Promise<unknown>;
    addSplatScenes(
      sceneOptions: Array<SplatSceneOptions & { path: string }>,
      showLoadingUI?: boolean,
    ): Promise<unknown>;
    dispose(): Promise<void>;
  }
}
