import {
  CascadedShadowGenerator,
  DirectionalLight,
  HemisphericLight,
  ShadowGenerator,
  Vector3,
  type AbstractMesh,
  type Scene,
} from "@babylonjs/core";
import { FILL, SUN } from "../config";

export type Lighting = {
  sun: DirectionalLight;
  fill: HemisphericLight;
  shadows: CascadedShadowGenerator;
};

export function createLighting(scene: Scene, sunDirection: Vector3): Lighting {
  // Key light. Direction is the *travel* direction, so it is the inverse of the
  // vector pointing at the sun in the sky material.
  const sun = new DirectionalLight("sun", sunDirection.negate(), scene);
  sun.position = sunDirection.scale(140);
  sun.diffuse = SUN.color;
  sun.specular = SUN.color;
  sun.intensity = SUN.intensity;

  // Sky/ground bounce so shadowed façades stay blue rather than going black.
  const fill = new HemisphericLight("fill", Vector3.Up(), scene);
  fill.diffuse = FILL.skyColor;
  fill.groundColor = FILL.groundColor;
  fill.specular.set(0, 0, 0);
  fill.intensity = FILL.intensity;

  const shadows = new CascadedShadowGenerator(SUN.shadow.mapSize, sun);
  shadows.numCascades = SUN.shadow.cascades;
  shadows.lambda = SUN.shadow.lambda;
  shadows.shadowMaxZ = SUN.shadow.maxZ;
  shadows.stabilizeCascades = true;
  shadows.depthClamp = true;
  shadows.autoCalcDepthBounds = true;
  shadows.usePercentageCloserFiltering = true;
  shadows.filteringQuality = ShadowGenerator.QUALITY_HIGH;
  shadows.transparencyShadow = true;
  shadows.darkness = SUN.shadow.darkness;
  shadows.bias = SUN.shadow.bias;
  shadows.normalBias = SUN.shadow.normalBias;

  return { sun, fill, shadows };
}

/**
 * The camera never leaves the junction, so only nearby geometry needs to be in
 * the shadow map. Everything still *receives* shadows, which keeps the far city
 * looking lit rather than flat.
 */
export function registerShadowCasters(
  lighting: Lighting,
  meshes: AbstractMesh[],
  focus: Vector3,
): number {
  const map = lighting.shadows.getShadowMap();
  if (!map) return 0;

  const casters: AbstractMesh[] = [];
  const limit = SUN.shadow.casterRadius;

  for (const mesh of meshes) {
    // Everything receives, which is free; only a fraction needs to cast.
    mesh.receiveShadows = true;

    const bounds = mesh.getBoundingInfo().boundingBox;
    const sphere = mesh.getBoundingInfo().boundingSphere;
    if (Vector3.Distance(sphere.centerWorld, focus) - sphere.radiusWorld > limit) continue;

    const size = bounds.extendSizeWorld.scale(2);
    if (size.y < SUN.shadow.casterMinHeight) continue;
    if (Math.max(size.x, size.z) < SUN.shadow.casterMinFootprint) continue;

    casters.push(mesh);
  }

  map.renderList = casters;
  return casters.length;
}
