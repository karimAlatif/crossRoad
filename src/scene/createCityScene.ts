import {
  Engine,
  PointerEventTypes,
  Scene,
  Vector3,
  type ArcRotateCamera,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF/2.0";

import { createCamera, fitToScreen, frameJunction, playIntro, readCameraPath } from "./world/camera";
import { loadCity, type LoadProgress } from "./world/city";
import { createEnvironment } from "./world/environment";
import { createLighting, registerShadowCasters } from "./world/lighting";
import { createClock } from "./core/frame";
import type { Disposable } from "./core/types";
import { createViewport } from "./core/viewport";
import { announce, calibrate, chooseLevel, level, useLevel } from "./quality";
import { CAMERA, type GraphicsLevel } from "./config";
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
  /** The graphics level in force, which the device chose and may yet lower. */
  quality: () => GraphicsLevel;
};

export async function createCityScene(
  canvas: HTMLCanvasElement,
  onProgress: LoadProgress,
): Promise<CityScene> {
  const engine = new Engine(canvas, false, {
    // The scene is drawn into the post stack's own buffer and only blitted to
    // the canvas, so multisampling the canvas would smooth the edges of a
    // full-screen quad — nothing. Anti-aliasing is FXAA inside the pipeline.
    antialias: false,
    // Nothing here uses a stencil, and on mobile the buffer is bandwidth.
    stencil: false,
    preserveDrawingBuffer: false,
    // The game runs its own Web Audio graph; Babylon's would be a second
    // AudioContext that never plays anything, which iOS in particular counts.
    audioEngine: false,
    powerPreference: "high-performance",
  });

  // What this device can take, settled before anything is built: a shadow map
  // cannot be resized later and a headlight cone never built costs nothing
  // forever. See quality.ts.
  useLevel(chooseLevel(engine));

  const scene = new Scene(engine);
  scene.skipPointerMovePicking = true;
  scene.blockMaterialDirtyMechanism = true;

  // One heartbeat for the whole scene: every per-frame system hangs off this
  // rather than registering an observer of its own.
  const clock = createClock(scene);

  const camera = createCamera(scene);
  // Resolution and framing both follow the canvas, on every device: see
  // core/viewport.ts.
  const viewport = createViewport(engine, canvas, () => fitToScreen(camera, engine));

  // Started first so the sound files download alongside the city rather than
  // after it. Nothing plays until the player's first click.
  const sound = createSound(scene);

  const environment = createEnvironment(scene);
  const lighting = createLighting(scene, environment.sunDirection);

  const city = await loadCity(scene, onProgress);

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

  // The junction is only known now the city is in, and a tall screen frames
  // around it — so reframe before the opening shot works out where it ends.
  frameJunction(camera, engine, city.crossroad);
  playIntro(camera, clock, readCameraPath(scene));

  const render = () => scene.render();
  engine.runRenderLoop(render);

  // Babylon's inspector is around 10 MB of editor UI — node editors, the GUI
  // designer, the whole toolchain — and importing it at the top of this file put
  // every byte of it in the bundle a phone downloads before it sees a single
  // frame. It is worth having and not worth shipping, so it is fetched on
  // demand: press `i`, or call `inspect()` from the console.
  const inspect = async () => {
    await import("@babylonjs/inspector");
    const shown = scene.debugLayer.isVisible();
    if (shown) scene.debugLayer.hide();
    else await scene.debugLayer.show({ overlay: true });
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "i" && !event.ctrlKey && !event.metaKey && !event.altKey) void inspect();
  };
  window.addEventListener("keydown", onKey);
  (window as unknown as Record<string, unknown>).inspect = inspect;

  // The safety net under the guess: the opening shot doubles as a benchmark. If
  // the device cannot hold its level, the right one is chosen once, while the
  // camera is still moving — and after that the picture never changes again.
  const stopCalibrating = calibrate(
    clock,
    CAMERA.intro.flySeconds + CAMERA.intro.settleSeconds,
    (next) => {
      useLevel(next);
      postFx.apply();
      lighting.apply();
      viewport.refresh();
    },
  );
  announce();

  // A backgrounded tab or a phone with the screen off should not be drawing a
  // city. Browsers throttle animation frames on their own, but not all of them
  // and not immediately.
  const onVisibility = () => {
    if (document.hidden) engine.stopRenderLoop(render);
    else engine.runRenderLoop(render);
  };
  document.addEventListener("visibilitychange", onVisibility);

  return {
    engine,
    scene,
    camera,
    onCrash: (handler) => traffic.onCrash.add(handler),
    isGreen: light.isGreen,
    toggleLight: light.toggle,
    quality: () => level,
    dispose: () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVisibility);
      stopCalibrating();
      viewport.dispose();
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
