import {
  Engine,
  PointerEventTypes,
  Scene,
  Vector3,
  type ArcRotateCamera,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF/2.0";

import { createCamera, playIntro } from "./world/camera";
import { loadCity, type LoadProgress } from "./world/city";
import { createEnvironment } from "./world/environment";
import { createLighting, registerShadowCasters } from "./world/lighting";
import { QUALITY } from "./config";
import { createClock } from "./core/frame";
import type { Disposable } from "./core/types";
import { createPostProcess } from "./world/postProcess";
import { createSound } from "./audio/sound";
import { readProps } from "./world/props";
import { createStreetLamps } from "./world/streetLamps";
import { createTraffic, type CrashEvent } from "./traffic/traffic";
import { createTrafficLight } from "./world/trafficLight";

export type CityScene = Disposable & {
  engine: Engine;
  scene: Scene;
  camera: ArcRotateCamera;
  /** Fires on every impact, so game logic can hook the crashes. */
  onCrash: (handler: (event: CrashEvent) => void) => void;
  isGreen: () => boolean;
  toggleLight: () => void;
};

/** Aim at road level: the junction is the subject, not the skyline. */
const TARGET_LIFT = 0;

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

  // One heartbeat for the whole scene: every per-frame system hangs off this
  // rather than registering an observer of its own.
  const clock = createClock(scene);

  // Started first so the sound files download alongside the city rather than
  // after it. Nothing plays until the player's first click.
  const sound = createSound(scene);

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
  onProgress(1, "Lighting the street");
  const lamps = createStreetLamps(scene, clock);

  onProgress(1, "Reading the junction");
  const props = readProps(scene);

  onProgress(1, "Wiring the signal");
  const light = createTrafficLight(
    scene,
    Vector3.TransformCoordinates(props.trafficLight, props.space.getWorldMatrix()),
  );

  onProgress(1, "Filling the roads");
  const traffic = createTraffic(scene, clock, props.space, props.roads, lighting.shadows);
  traffic.onSetOff.add((at) => sound.play("move", at));
  traffic.onBrake.add((at) => sound.play("brake", at));
  traffic.onCrash.add((event) => sound.play("accident", event.at));

  onProgress(1, "Lighting the block");
  const postFx = createPostProcess(scene, clock, camera);
  for (const mesh of light.glowing) postFx.addGlowing(mesh);
  scene.blockMaterialDirtyMechanism = false;

  // Compile every shader before the first visible frame so the reveal is smooth
  // rather than a stutter of materials warming up one by one.
  onProgress(1, "Compiling shaders");
  await scene.whenReadyAsync(true);

  // Now that the sky shader exists, capture it into the IBL cube for real.
  environment.bake();

  // The city never changes after this: freezing its materials skips the
  // per-draw check for whether each one still needs recompiling.
  for (const material of city.container.materials) material.freeze();

  // One click anywhere works the signal. POINTERTAP only fires when the pointer
  // did not travel, so orbiting the camera never trips it.
  const pointer = scene.onPointerObservable.add((info) => {
    if (info.type === PointerEventTypes.POINTERTAP) light.toggle();
  });

  // Last in line, so the traffic has already moved everything this frame.
  clock.each((dt, elapsed) => {
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
      clock.dispose();
      scene.onPointerObservable.remove(pointer);
      lamps?.dispose();
      traffic.dispose();
      sound.dispose();
      light.dispose();
      postFx.dispose();
      scene.dispose();
      engine.dispose();
    },
  };
}
