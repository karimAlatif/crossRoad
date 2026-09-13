import {
  Engine,
  PointerEventTypes,
  Scene,
  Vector3,
  type ArcRotateCamera,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF/2.0";

import { createCamera, playIntro } from "./camera";
import { loadCity, type LoadProgress } from "./city";
import { createEnvironment } from "./environment";
import { createLighting, registerShadowCasters } from "./lighting";
import { QUALITY } from "./config";
import { createPostProcess } from "./postProcess";
import { readProps } from "./props";
import { createTraffic, type CrashEvent } from "./traffic";
import { createTrafficLight } from "./trafficLight";

export type CityScene = {
  engine: Engine;
  scene: Scene;
  camera: ArcRotateCamera;
  /** Fires on every impact, so game logic can hook the crashes. */
  onCrash: (handler: (event: CrashEvent) => void) => void;
  isGreen: () => boolean;
  toggleLight: () => void;
  dispose: () => void;
};

/** Aim at road level: the junction is the subject, not the skyline. */
const TARGET_LIFT = 0;

/** A long frame (an alt-tab, a GC pause) must not teleport the traffic. */
const MAX_STEP = 1 / 20;

export async function createCityScene(
  canvas: HTMLCanvasElement,
  onProgress: LoadProgress,
): Promise<CityScene> {
  const engine = new Engine(canvas, true, {
    antialias: true,
    stencil: true,
    preserveDrawingBuffer: false,
    powerPreference: "high-performance",
  });
  // A 2x display would otherwise shade four times the pixels for a scene that
  // is already fill-rate bound through the post stack.
  engine.setHardwareScalingLevel(
    1 / Math.min(window.devicePixelRatio || 1, QUALITY.maxPixelRatio),
  );

  const scene = new Scene(engine);
  scene.skipPointerMovePicking = true;
  scene.blockMaterialDirtyMechanism = true;

  const environment = createEnvironment(scene);
  const lighting = createLighting(scene, environment.sunDirection);

  const city = await loadCity(scene, onProgress);

  onProgress(1, "Placing the camera");
  const target = city.crossroad.add(new Vector3(0, TARGET_LIFT, 0));
  const camera = createCamera(scene, target);
  camera.attachControl(canvas, true);

  onProgress(1, "Casting shadows");
  registerShadowCasters(lighting, city.meshes, city.crossroad);

  // The authored markers drive everything below: where the signal stands, and
  // where each road starts, ends and meets the junction.
  onProgress(1, "Reading the junction");
  const props = readProps(scene);

  onProgress(1, "Wiring the signal");
  const light = createTrafficLight(
    scene,
    Vector3.TransformCoordinates(props.trafficLight, props.space.getWorldMatrix()),
  );

  onProgress(1, "Filling the roads");
  const traffic = createTraffic(scene, props.space, props.roads, lighting.shadows);

  onProgress(1, "Lighting the block");
  const postFx = createPostProcess(scene, camera);
  for (const mesh of light.glowing) postFx.addGlowing(mesh);
  scene.blockMaterialDirtyMechanism = false;

  // Compile every shader before the first visible frame so the reveal is smooth
  // rather than a stutter of materials warming up one by one.
  onProgress(1, "Compiling shaders");
  await scene.whenReadyAsync(true);

  // Now that the sky shader exists, capture it into the IBL cube for real.
  environment.bake();

  // One click anywhere works the signal. POINTERTAP only fires when the pointer
  // did not travel, so orbiting the camera never trips it.
  const pointer = scene.onPointerObservable.add((info) => {
    if (info.type === PointerEventTypes.POINTERTAP) light.toggle();
  });

  let elapsed = 0;
  const tick = scene.onBeforeRenderObservable.add(() => {
    const dt = Math.min(engine.getDeltaTime() / 1000, MAX_STEP);
    // Two frames can share a timestamp; there is nothing to advance.
    if (dt <= 0) return;
    elapsed += dt;
    light.update(dt, elapsed);
    traffic.update(dt, light.isGreen());
  });

  playIntro(camera);

  const render = () => scene.render();
  engine.runRenderLoop(render);

  const onResize = () => engine.resize();
  window.addEventListener("resize", onResize);

  return {
    engine,
    scene,
    camera,
    onCrash: (handler) => traffic.onCrash.add(handler),
    isGreen: light.isGreen,
    toggleLight: light.toggle,
    dispose: () => {
      window.removeEventListener("resize", onResize);
      engine.stopRenderLoop(render);
      scene.onBeforeRenderObservable.remove(tick);
      scene.onPointerObservable.remove(pointer);
      traffic.dispose();
      light.dispose();
      postFx.dispose();
      scene.dispose();
      engine.dispose();
    },
  };
}
