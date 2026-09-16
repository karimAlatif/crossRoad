import {
  Color4,
  DynamicTexture,
  ParticleSystem,
  Vector3,
  type Observer,
  type Scene,
} from "@babylonjs/core";
import { CAR_FX, LIGHT_TRAIL, SKID_MARK } from "../config";
import type { Clock } from "../core/frame";
import type { Disposable, Range } from "../core/types";
import { radialTexture } from "../core/visuals";
import { clipTiming } from "../traffic/carAnimations";
import { burstSystem, grow } from "./particles";
import { createMarkPool, type MarkPool } from "./roadMarks";

/**
 * Everything a car leaves behind it.
 *
 * The smoke calls take world positions and fire there and then. Nothing smoky is
 * attached to the car: smoke hangs where it was made and gets left behind, which
 * is most of what makes it read as smoke. The two ribbons are the opposite —
 * they are held on to the car, and the caller keeps the handles that do it.
 */
export type CarEffects = Disposable & {
  /** `idle` — a soft breath out of the back of the car. */
  exhaust: (at: Vector3, forward: Vector3) => void;
  /** `move` — the getaway cloud. */
  launch: (at: Vector3, forward: Vector3) => void;
  /** `brake` — the same cloud, thrown out ahead of the car. */
  brake: (at: Vector3, forward: Vector3) => void;
  /**
   * One segment of light trail, from `from` to `to` at height `y`. Returns the
   * handle to pass back next frame, or -1 if nothing could be laid.
   */
  trail: (handle: number, from: Vector3, to: Vector3, y: number, width: number, seconds: number) => number;
  /** One segment of skid mark, on the tarmac. Same contract as `trail`. */
  rubber: (handle: number, from: Vector3, to: Vector3, width: number, seconds: number) => number;
};

/**
 * One queued burst: where, which way, how loosely, and how many particles of it
 * are still to be made.
 */
type Burst = { at: Vector3; aim: Vector3; spread: number; left: number };

/**
 * A particle system that several cars can fire on the same frame.
 *
 * The obvious way to fire a burst — move the emitter, set `manualEmitCount` —
 * holds exactly one burst per frame. A second car asking on the same frame moves
 * the emitter again and overwrites the count, so only the last car of the frame
 * gets any smoke. That is what used to happen when a queue pulled away on a green.
 *
 * So each system keeps a queue instead. Every request is appended, the count is
 * the total of the queue, and Babylon's custom position and direction hooks hand
 * each new particle to the burst it belongs to. Babylon creates a particle's
 * position before its direction, so the position hook picks the burst and the
 * direction hook reuses it.
 */
type Emitter = {
  particles: ParticleSystem;
  queue: Burst[];
  /** Bursts from earlier frames, kept for reuse so a busy junction allocates nothing. */
  spare: Burst[];
  cursor: number;
  current: Burst | null;
  owed: number;
};

/**
 * The car effects: three particle systems shared by the whole fleet, and two
 * ribbon pools — five draw calls for every effect on every car.
 *
 * The move and brake clouds are the same smoke with their own numbers; the brake
 * one is simply thrown forward from the nose instead of backward from under the
 * car. Each fires twice: once as its clip starts, and again at the moment the
 * pose peaks — the top of the lift, the bottom of the dive — worked out by
 * `clipTiming()` from the keyframes themselves.
 */
export function createCarEffects(scene: Scene, clock: Clock): CarEffects | null {
  if (!CAR_FX.enabled) return null;

  const { idle, move, brake } = CAR_FX;
  const cloud = cloudTexture(scene);
  const haze = hazeTexture(scene);
  const timing = clipTiming();

  const skids: MarkPool | null = SKID_MARK.enabled
    ? createMarkPool(scene, "skid.mark", SKID_MARK)
    : null;
  const trails: MarkPool | null = LIGHT_TRAIL.enabled
    ? createMarkPool(scene, "trail.mark", LIGHT_TRAIL)
    : null;

  // --- idle: barely there ---------------------------------------------------
  //
  // A soft, pale breath with no outline at all: small, faint, slow, and gone in
  // a second or so. It is the one effect every stopped car is running at once, so
  // it should sit in the background rather than draw the eye.
  const exhaust = burstSystem(scene, "fx.exhaust", haze, idle.capacity);
  exhaust.blendMode = ParticleSystem.BLENDMODE_STANDARD;
  grow(exhaust, idle.size);
  exhaust.color1 = new Color4(0.85, 0.87, 0.92, 0.32);
  exhaust.color2 = new Color4(0.7, 0.73, 0.8, 0.2);
  exhaust.colorDead = new Color4(0.6, 0.63, 0.7, 0);
  exhaust.gravity = new Vector3(0, 0.6, 0);
  exhaust.minLifeTime = 0.8;
  exhaust.maxLifeTime = 1.5;
  exhaust.minEmitPower = 0.3;
  exhaust.maxEmitPower = 0.8;

  // --- move and brake: the cartoon cloud -----------------------------------
  const launch = cartoonSmoke(scene, "fx.launch", cloud, move.smoke);
  const skid = cartoonSmoke(scene, "fx.brake", cloud, brake.smoke);

  const emitters = [exhaust, launch, skid].map(queued);
  const [exhaustQ, launchQ, brakeQ] = emitters;

  /** A burst still owed, for the moment its clip reaches the pose it belongs to. */
  type Delayed = { due: number; emitter: Emitter; burst: Burst };
  const pending: Delayed[] = [];
  let elapsed = 0;

  /**
   * Nothing fires until the first real frame.
   *
   * The traffic runs twenty-five seconds of warm-up synchronously before anything
   * is drawn, and every car's `update` runs through all of it. Without this gate
   * each puff from that warm-up would queue up with no frame to empty the queue,
   * and the ribbons would be joined up to places the cars left long ago.
   */
  let running = false;

  const request = (emitter: Emitter, at: Vector3, aim: Vector3, spread: number, count: number): Burst => {
    const burst = emitter.spare.pop() ?? { at: new Vector3(), aim: new Vector3(), spread: 0, left: 0 };
    burst.at.copyFrom(at);
    burst.aim.copyFrom(aim);
    burst.spread = spread;
    burst.left = count;
    return burst;
  };

  const fire = (emitter: Emitter, at: Vector3, aim: Vector3, spread: number, count: number) => {
    if (!running || count <= 0) return;
    emitter.queue.push(request(emitter, at, aim, spread, count));
    emitter.owed += count;
    emitter.particles.manualEmitCount = emitter.owed;
  };

  const later = (emitter: Emitter, delay: number, at: Vector3, aim: Vector3, spread: number, count: number) => {
    if (!running || count <= 0) return;
    pending.push({ due: elapsed + delay, emitter, burst: request(emitter, at, aim, spread, count) });
  };

  const tick = (dt: number) => {
    running = true;
    elapsed += dt;
    skids?.update(dt);
    trails?.update(dt);

    for (let i = pending.length - 1; i >= 0; i--) {
      const owed = pending[i];
      if (elapsed < owed.due) continue;
      const { emitter, burst } = owed;
      emitter.queue.push(burst);
      emitter.owed += burst.left;
      emitter.particles.manualEmitCount = emitter.owed;
      pending.splice(i, 1);
    }
  };

  // Once the frame is drawn every queued burst has either been emitted or run
  // into the system's capacity. Either way it is done: clear the queues.
  const flush = () => {
    for (const emitter of emitters) {
      for (const burst of emitter.queue) emitter.spare.push(burst);
      emitter.queue.length = 0;
      emitter.cursor = 0;
      emitter.current = null;
      emitter.owed = 0;
    }
  };

  const stop = clock.each(tick);
  // The flush has to land after the frame is drawn, which is the one thing the
  // shared clock cannot do: it runs before the draw.
  const after: Observer<Scene> | null = scene.onAfterRenderObservable.add(flush);

  // Scratch, so firing an effect allocates nothing.
  const aim = new Vector3();

  return {
    exhaust: (at, forward) => {
      // Out of the back, and drifting up.
      aim.set(-forward.x * 0.6, 0.5, -forward.z * 0.6);
      fire(exhaustQ, at, aim, idle.spread, idle.count);
    },

    launch: (at, forward) => {
      // Squeezed out from under the car and backwards, so it spills either side.
      aim.set(-forward.x * 2.2, 0.35, -forward.z * 2.2);
      fire(launchQ, at, aim, move.smoke.spread, move.smoke.count);
      later(launchQ, timing.movePeak, at, aim, move.smoke.spread, move.smoke.after);
    },

    brake: (at, forward) => {
      // The mirror of the getaway: the same cloud, thrown out ahead of the car.
      aim.set(forward.x * 2.2, 0.35, forward.z * 2.2);
      fire(brakeQ, at, aim, brake.smoke.spread, brake.smoke.count);
      later(brakeQ, timing.brakePeak, at, aim, brake.smoke.spread, brake.smoke.after);
    },

    trail: (handle, from, to, y, width, seconds) =>
      running && trails ? trails.span(handle, from, to, width, seconds, y) : -1,

    rubber: (handle, from, to, width, seconds) =>
      running && skids ? skids.span(handle, from, to, width, seconds) : -1,

    dispose: () => {
      stop();
      scene.onAfterRenderObservable.remove(after);
      pending.length = 0;
      skids?.dispose();
      trails?.dispose();
      exhaust.dispose();
      launch.dispose();
      skid.dispose();
      cloud.dispose();
      haze.dispose();
    },
  };
}

/** Wires a system's emission to a queue of bursts. See `Emitter`. */
function queued(particles: ParticleSystem): Emitter {
  const emitter: Emitter = { particles, queue: [], spare: [], cursor: 0, current: null, owed: 0 };

  particles.startPositionFunction = (_matrix, position) => {
    const { queue } = emitter;
    while (emitter.cursor < queue.length && queue[emitter.cursor].left <= 0) emitter.cursor++;
    const burst = queue[emitter.cursor] ?? queue[queue.length - 1] ?? null;
    emitter.current = burst;
    if (!burst) return;
    burst.left--;
    position.copyFrom(burst.at);
  };

  particles.startDirectionFunction = (_matrix, direction) => {
    const burst = emitter.current;
    if (!burst) {
      direction.set(0, 1, 0);
      return;
    }
    // A box around the aim: as wide either side as `spread`, and biased upward,
    // so a burst fans out and lifts rather than digging into the road.
    const { aim, spread } = burst;
    direction.set(
      aim.x + (Math.random() * 2 - 1) * spread,
      aim.y + (Math.random() * 1.4 - 0.4) * spread,
      aim.z + (Math.random() * 2 - 1) * spread,
    );
  };

  return emitter;
}

/** What the cartoon cloud needs from the config. */
type SmokeRules = { capacity: number; size: Range; maxPower?: number };

/**
 * The cartoon cloud: a warm, lobed, tumbling puff. Move and brake both use it,
 * each with its own capacity and size.
 */
function cartoonSmoke(scene: Scene, name: string, texture: DynamicTexture, rules: SmokeRules): ParticleSystem {
  const particles = burstSystem(scene, name, texture, rules.capacity);
  particles.blendMode = ParticleSystem.BLENDMODE_STANDARD;
  grow(particles, rules.size);
  particles.color1 = new Color4(1, 0.9, 0.72, 0.95);
  particles.color2 = new Color4(0.82, 0.73, 0.58, 0.6);
  particles.colorDead = new Color4(0.6, 0.56, 0.5, 0);
  particles.gravity = new Vector3(0, 0.7, 0);
  particles.minLifeTime = 0.4;
  particles.maxLifeTime = 1;
  particles.minEmitPower = 2;
  particles.maxEmitPower = rules?.maxPower ?? 4;
  // A tumble. Cartoon smoke has a silhouette, and a silhouette that never turns
  // stamps the same shape over and over.
  particles.minAngularSpeed = -2.2;
  particles.maxAngularSpeed = 2.2;
  particles.minInitialRotation = 0;
  particles.maxInitialRotation = Math.PI * 2;
  return particles;
}

/**
 * A drawn puff of smoke: a clump of overlapping round lobes, each solid almost to
 * its rim. The outline is what the eye reads as cartoon smoke; a single soft
 * gradient has none, and a pile of those is fog.
 */
function cloudTexture(scene: Scene): DynamicTexture {
  const size = 128;
  const texture = new DynamicTexture("fx.cloud", size, scene, true);
  const ctx = texture.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, size, size);

  const lobes: [number, number, number][] = [
    [0.5, 0.52, 0.3],
    [0.29, 0.44, 0.2],
    [0.71, 0.45, 0.22],
    [0.4, 0.71, 0.19],
    [0.63, 0.7, 0.17],
    [0.52, 0.27, 0.19],
    [0.24, 0.63, 0.14],
  ];

  for (const [cx, cy, r] of lobes) {
    const x = cx * size;
    const y = cy * size;
    const radius = r * size;
    const lobe = ctx.createRadialGradient(x, y, radius * 0.55, x, y, radius);
    lobe.addColorStop(0, "rgba(255,255,255,1)");
    lobe.addColorStop(0.75, "rgba(255,255,255,0.93)");
    lobe.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = lobe;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  texture.update();
  texture.hasAlpha = true;
  return texture;
}

/** A soft blur with no edge anywhere, for the idle breath. */
function hazeTexture(scene: Scene): DynamicTexture {
  return radialTexture(scene, "fx.haze", [
    [0, 0.7],
    [0.45, 0.32],
    [1, 0],
  ]);
}
