import { Color3, MeshBuilder, Scene, Vector3, type Mesh } from "@babylonjs/core";
import { SkyMaterial } from "@babylonjs/materials/sky";
import { CLEAR_COLOR, FOG, SKY, SUN } from "../config";
import { createAmbient } from "./ambient";

export type Environment = {
  skybox: Mesh;
  skyMaterial: SkyMaterial;
  /** Normalised direction *towards* the sun, for the key light to match. */
  sunDirection: Vector3;
};

/**
 * The night: the sky you can see, the light it casts, and the haze between.
 *
 * The dome is an atmospheric scattering shader, so there is no HDR to download.
 * What lights the city, though, is built rather than captured — see
 * `ambient.ts` for why a rendered sky probe is the wrong thing to depend on.
 */
export function createEnvironment(scene: Scene): Environment {
  scene.clearColor = CLEAR_COLOR;

  const sunDirection = SUN.direction.negate().normalize();

  const skyMaterial = new SkyMaterial("skyMaterial", scene);
  skyMaterial.backFaceCulling = false;
  skyMaterial.useSunPosition = true;
  // The sky's sun sits just *below* the horizon while the key light still comes
  // from above. That split is what makes a night: SkyMaterial renders the deep
  // blue of late dusk rather than flat black, and keeps a faint glow low down for
  // the skyline to sit against, while the moon above still shapes the buildings.
  skyMaterial.sunPosition = new Vector3(sunDirection.x, SKY.sunElevation, sunDirection.z)
    .normalize()
    .scale(100);
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

  // The light the city is actually lit by. Built on the CPU, so it is the same
  // on every device and ready before the first frame rather than a frame or two
  // later, which matters: the materials are compiled and frozen at startup and
  // an environment that arrives afterwards may never reach them.
  createAmbient(scene);

  // Haze tuned to the sky's horizon so the far city dissolves instead of ending.
  scene.fogMode = FOG.enabled ? Scene.FOGMODE_EXP2 : Scene.FOGMODE_NONE;
  scene.fogColor = FOG.color;
  scene.fogDensity = FOG.density;
  scene.ambientColor = new Color3(0.18, 0.2, 0.24);

  return { skybox, skyMaterial, sunDirection };
}
