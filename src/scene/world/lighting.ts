import {
  CascadedShadowGenerator,
  DirectionalLight,
  HemisphericLight,
  RenderTargetTexture,
  ShadowGenerator,
  Vector3,
  type AbstractMesh,
  type Scene,
} from "@babylonjs/core";
import { FILL, SUN } from "../config";
import { receiveShadows } from "../core/visuals";
import { graphics, mobileLift } from "../quality";

export type Lighting = {
  sun: DirectionalLight;
  fill: HemisphericLight;
  /**
   * Null when the graphics level asks for no shadow pass at all, and a plain
   * single-map generator rather than a cascaded one when it asks for one pass.
   */
  shadows: ShadowGenerator | null;
  /** Re-reads the graphics level. Called when the governor gives one up. */
  apply: () => void;
};

/**
 * Three lights for the whole city: a key, a fill, and the shadows the key casts.
 *
 * The shadow pass is the most expensive thing in the frame that is not a
 * full-screen effect — every caster is drawn again, once per cascade — so the
 * graphics level decides both how big the map is and whether it exists. Nothing
 * else in the scene is a real light: every glow, beam and lamp is additive
 * geometry, because a Babylon light costs per *material* and thirty headlights
 * would recompile every shader in the city.
 */
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
  fill.intensity = FILL.intensity * mobileLift("fill");

  const wanted = graphics.shadows;
  const shadows = wanted.cascades > 0 ? shadowPass(sun, wanted) : null;

  /**
   * A shadow map cannot change size or cascade count after it is built, so all
   * a later drop can do is stop it: the light stops sampling and the map stops
   * re-rendering, which is the whole cost gone.
   */
  const apply = () => {
    const on = graphics.shadows.cascades > 0 && shadows !== null;
    sun.shadowEnabled = on;
    const map = shadows?.getShadowMap();
    if (map) {
      map.refreshRate = on
        ? RenderTargetTexture.REFRESHRATE_RENDER_ONEVERYFRAME
        : RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
    }
  };

  return { sun, fill, shadows, apply };
}

/**
 * One shadow map, or several.
 *
 * Cascades are the quality option: the map is split by distance so the shadows
 * near the camera are crisp without the far ones costing a huge texture. They
 * are also the expensive option, because every caster is drawn once per cascade
 * — and Babylon will not go below two of them, so anything cheaper has to be a
 * plain generator instead. That is exactly what the middle level asks for: one
 * depth pass, one map, hard edges.
 */
function shadowPass(
  sun: DirectionalLight,
  wanted: { cascades: number; mapSize: number; soft: boolean },
): ShadowGenerator {
  const shadows =
    wanted.cascades > 1
      ? new CascadedShadowGenerator(wanted.mapSize, sun)
      : new ShadowGenerator(wanted.mapSize, sun);

  if (shadows instanceof CascadedShadowGenerator) {
    shadows.numCascades = wanted.cascades;
    shadows.lambda = SUN.shadow.lambda;
    shadows.shadowMaxZ = SUN.shadow.maxZ;
    shadows.stabilizeCascades = true;
    shadows.autoCalcDepthBounds = true;
    // Only the cascaded generator has this; it keeps far casters from being
    // clipped out of their split.
    shadows.depthClamp = true;
  }

  // Percentage-closer filtering is several taps per pixel. Worth it on a desktop
  // for a soft edge; a phone gets the one-tap version instead.
  shadows.usePercentageCloserFiltering = wanted.soft;
  shadows.filteringQuality = wanted.soft
    ? ShadowGenerator.QUALITY_HIGH
    : ShadowGenerator.QUALITY_LOW;
  shadows.transparencyShadow = true;
  shadows.darkness = SUN.shadow.darkness;
  shadows.bias = SUN.shadow.bias;
  shadows.normalBias = SUN.shadow.normalBias;
  return shadows;
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
  const map = lighting.shadows?.getShadowMap();
  if (!map) {
    // No shadow pass on this device, but receiving is free and the material
    // needs to know either way.
    for (const mesh of meshes) receiveShadows(mesh);
    return 0;
  }

  const casters: AbstractMesh[] = [];
  const limit = graphics.shadows.casterRadius;

  for (const mesh of meshes) {
    // Everything receives, which is free; only a fraction needs to cast.
    receiveShadows(mesh);

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
