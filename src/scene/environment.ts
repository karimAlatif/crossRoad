import {
  Color3,
  MeshBuilder,
  ReflectionProbe,
  RenderTargetTexture,
  Scene,
  Vector3,
  type Mesh,
} from "@babylonjs/core";
import { SkyMaterial } from "@babylonjs/materials/sky";
import { CLEAR_COLOR, FOG, SKY, SUN } from "./config";

export type Environment = {
  skybox: Mesh;
  skyMaterial: SkyMaterial;
  /** Normalised direction *towards* the sun, for the key light to match. */
  sunDirection: Vector3;
  /** Re-renders the sky into the IBL cube. Must run once the sky shader is compiled. */
  bake: () => void;
};

/**
 * Builds an atmospheric scattering sky and bakes it into a cube map that
 * becomes the scene's IBL.
 *
 * Doing it this way means zero external HDR downloads: the ambient light and
 * every PBR reflection are derived from the exact sky the player is looking at,
 * so sky, reflections and the sun all agree by construction.
 */
export function createEnvironment(scene: Scene): Environment {
  scene.clearColor = CLEAR_COLOR;

  const sunDirection = SUN.direction.negate().normalize();

  const skyMaterial = new SkyMaterial("skyMaterial", scene);
  skyMaterial.backFaceCulling = false;
  skyMaterial.useSunPosition = true;
  skyMaterial.sunPosition = sunDirection.scale(100);
  skyMaterial.turbidity = SKY.turbidity;
  skyMaterial.luminance = SKY.luminance;
  skyMaterial.rayleigh = SKY.rayleigh;
  skyMaterial.mieCoefficient = SKY.mieCoefficient;
  skyMaterial.mieDirectionalG = SKY.mieDirectionalG;
  skyMaterial.dithering = true;

  const skybox = MeshBuilder.CreateBox("skybox", { size: SKY.size }, scene);
  skybox.material = skyMaterial;
  skybox.infiniteDistance = true;
  skybox.applyFog = false;
  skybox.isPickable = false;
  skybox.doNotSyncBoundingInfo = true;

  // Render the dome once into a cube and hand it to the PBR pipeline as the
  // environment. Mips give us a usable roughness fallback without prefiltering.
  const probe = new ReflectionProbe("sky-ibl", SKY.probeSize, scene, true);
  probe.renderList = [skybox];
  scene.environmentTexture = probe.cubeTexture;
  scene.environmentIntensity = SKY.environmentIntensity;

  // The bake is deferred: on frame one the sky shader is still compiling, and a
  // probe fired then captures pure black — which would silently leave the whole
  // city with no ambient light at all. Assigning refreshRate resets the counter,
  // so the caller re-arms this once shaders are ready.
  const bake = () => {
    probe.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
  };
  bake();

  // Haze tuned to the sky's horizon so the far city dissolves instead of ending.
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogColor = FOG.color;
  scene.fogDensity = FOG.density;
  scene.ambientColor = new Color3(0.18, 0.2, 0.24);

  return { skybox, skyMaterial, sunDirection, bake };
}
