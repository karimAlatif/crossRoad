import {
  Color4,
  DynamicTexture,
  ParticleSystem,
  Vector3,
  type Observer,
  type Scene,
} from "@babylonjs/core";
import { CAR_FX } from "./config";
import { clipTiming } from "./carAnimations";

/**
 * One effect for each of the three clips a car can play.
 *
 * Every call takes a world position and the direction the car is pointing, and
 * fires a burst there and then. Nothing is attached to the car: smoke does not
 * travel with the vehicle that made it, it hangs where it was made and gets left
 * behind, which is most of what makes it read as smoke at all.
 */
export type CarEffects = {
  /** `idle` — a cough from the tailpipe, on the beat of the shake. */
  exhaust: (at: Vector3, forward: Vector3) => void;
  /** `move` — dust thrown back off the driven wheels as the car pulls away. */
  launch: (at: Vector3, forward: Vector3) => void;
  /** `brake` — tyre smoke shoved forward as the car noses down. */
  skid: (at: Vector3, forward: Vector3) => void;
  dispose: () => void;
};

/**
 * The three particle effects, and the thing that keeps them honest: each one is
 * a *single* ParticleSystem shared by the whole fleet.
 *
 * That works because none of these is a continuous stream — they are all bursts.
 * A burst reads the emitter position and direction at the instant it is fired,
 * and every particle it makes then lives its own life in world space. So one
 * system can throw smoke under a car at one end of the junction on this frame
 * and under a different car at the other end on the next, and the two clouds sit
 * there independently. Forty cars cost the same three draw calls as one.
 *
 * The timing comes from `clipTiming()` rather than from numbers typed in here.
 * Each of the one-shots fires twice: once as the clip starts, and once at the
 * moment the pose peaks — the bottom of the brake dive, the top of the pull-away
 * lift. That second burst is what ties the smoke to the animation instead of
 * merely near it, and it moves on its own if the clips are ever retuned.
 */
export function createCarEffects(scene: Scene): CarEffects | null {
  if (!CAR_FX.enabled) return null;

  const dot = softDot(scene);
  const timing = clipTiming();

  // --- idle: a tired engine ticking over -----------------------------------
  //
  // Thin, slow and small. This one is running on every stopped car at the lights
  // at once, so it is deliberately the cheapest of the three: a couple of
  // particles a beat, drifting up and dying quickly.
  const exhaust = system(scene, "fx.exhaust", dot, CAR_FX.idle.capacity);
  exhaust.blendMode = ParticleSystem.BLENDMODE_STANDARD;
  grow(exhaust, 0.2, 0.75);
  exhaust.minLifeTime = 0.5;
  exhaust.maxLifeTime = 1.1;
  exhaust.color1 = new Color4(0.78, 0.82, 0.92, 0.6);
  exhaust.color2 = new Color4(0.6, 0.64, 0.75, 0.42);
  exhaust.colorDead = new Color4(0.5, 0.54, 0.62, 0);
  exhaust.gravity = new Vector3(0, 1.1, 0);
  exhaust.minEmitPower = 0.5;
  exhaust.maxEmitPower = 1.4;
  exhaust.minAngularSpeed = -1.2;
  exhaust.maxAngularSpeed = 1.2;

  // --- move: the car gets away -------------------------------------------
  //
  // Warm and low, thrown backwards hard. Dust off the road rather than smoke, so
  // it is sandier than the other two and drops rather than climbing.
  const launch = system(scene, "fx.launch", dot, CAR_FX.move.capacity);
  launch.blendMode = ParticleSystem.BLENDMODE_STANDARD;
  grow(launch, 0.35, 1.7);
  launch.minLifeTime = 0.3;
  launch.maxLifeTime = 0.8;
  launch.color1 = new Color4(0.95, 0.86, 0.68, 0.85);
  launch.color2 = new Color4(0.76, 0.68, 0.55, 0.55);
  launch.colorDead = new Color4(0.6, 0.56, 0.5, 0);
  launch.gravity = new Vector3(0, 0.5, 0);
  launch.minEmitPower = 2;
  launch.maxEmitPower = 5.5;
  launch.minAngularSpeed = -2.5;
  launch.maxAngularSpeed = 2.5;

  // --- brake: the car stops hard ------------------------------------------
  //
  // The loudest of the three, and the only white one. Tyre smoke is brighter and
  // fatter than dust, and it gets shoved *forward* past the bumper, because the
  // car is still travelling when the tyres stop turning.
  const skid = system(scene, "fx.skid", dot, CAR_FX.brake.capacity);
  skid.blendMode = ParticleSystem.BLENDMODE_STANDARD;
  grow(skid, 0.3, 1.9);
  skid.minLifeTime = 0.35;
  skid.maxLifeTime = 0.9;
  skid.color1 = new Color4(1, 1, 1, 0.95);
  skid.color2 = new Color4(0.85, 0.88, 0.96, 0.6);
  skid.colorDead = new Color4(0.78, 0.8, 0.88, 0);
  skid.gravity = new Vector3(0, 0.9, 0);
  skid.minEmitPower = 1.4;
  skid.maxEmitPower = 4;
  skid.minAngularSpeed = -2;
  skid.maxAngularSpeed = 2;

  /** A burst still owed, for the moment its clip reaches the pose it belongs to. */
  type Delayed = {
    due: number;
    particles: ParticleSystem;
    count: number;
    at: Vector3;
    aim: Vector3;
    spread: number;
  };

  const pending: Delayed[] = [];
  let clock = 0;

  /**
   * Points a system at a place and a direction, then makes it emit.
   *
   * `aim` is where the particles are thrown and `spread` how loosely — the two
   * direction vectors are a box around the aim, so a wide spread fans the burst
   * out and a tight one keeps it in a jet.
   */
  const fire = (
    particles: ParticleSystem,
    at: Vector3,
    aim: Vector3,
    spread: number,
    count: number,
  ) => {
    (particles.emitter as Vector3).copyFrom(at);
    particles.direction1.set(aim.x - spread, aim.y - spread * 0.4, aim.z - spread);
    particles.direction2.set(aim.x + spread, aim.y + spread, aim.z + spread);
    // manualEmitCount is a request, not a total: it is consumed on the next
    // update and reset. Two cars asking on the same frame is the one case this
    // cannot serve, and the cost of getting it wrong is a few missing puffs.
    particles.manualEmitCount = count;
  };

  const later = (
    particles: ParticleSystem,
    delay: number,
    at: Vector3,
    aim: Vector3,
    spread: number,
    count: number,
  ) => {
    pending.push({
      due: clock + delay,
      particles,
      count,
      // Copied, not held: the caller reuses its vectors every frame.
      at: at.clone(),
      aim: aim.clone(),
      spread,
    });
  };

  const tick = () => {
    const dt = scene.getEngine().getDeltaTime() / 1000;
    if (dt <= 0) return;
    clock += dt;

    for (let i = pending.length - 1; i >= 0; i--) {
      const owed = pending[i];
      if (clock < owed.due) continue;
      fire(owed.particles, owed.at, owed.aim, owed.spread, owed.count);
      pending.splice(i, 1);
    }
  };

  const observer: Observer<Scene> | null = scene.onBeforeRenderObservable.add(tick);

  // Scratch vectors, so firing an effect allocates nothing.
  const aim = new Vector3();

  return {
    exhaust: (at, forward) => {
      // Straight out of the back and slightly up: the tailpipe points astern.
      aim.set(-forward.x * 0.8, 0.9, -forward.z * 0.8);
      fire(exhaust, at, aim, CAR_FX.idle.spread, CAR_FX.idle.puff);
    },

    launch: (at, forward) => {
      // Thrown back under the car as the wheels bite.
      aim.set(-forward.x * 3, 0.5, -forward.z * 3);
      fire(launch, at, aim, CAR_FX.move.spread, CAR_FX.move.kick);
      // And again as the nose comes up, by which time the car has left its own
      // dust behind — which is exactly where this second burst stays.
      later(launch, timing.movePeak, at, aim, CAR_FX.move.spread, CAR_FX.move.trail);
    },

    skid: (at, forward) => {
      // Shoved forward past the bumper: the car is still moving when the tyres
      // stop turning.
      aim.set(forward.x * 1.6, 0.4, forward.z * 1.6);
      fire(skid, at, aim, CAR_FX.brake.spread, CAR_FX.brake.bite);
      // The big one lands at the bottom of the dive, when the weight goes onto
      // the front wheels — which is the moment the tyres would really let go.
      later(skid, timing.brakePeak, at, aim, CAR_FX.brake.spread, CAR_FX.brake.squeal);
    },

    dispose: () => {
      scene.onBeforeRenderObservable.remove(observer);
      pending.length = 0;
      exhaust.dispose();
      launch.dispose();
      skid.dispose();
      dot.dispose();
    },
  };
}

/**
 * Makes a system's particles swell as they age, from `from` metres to `to`.
 *
 * Size gradients *replace* `particle.size` rather than scaling it, so these are
 * absolute metres and setting `minSize`/`maxSize` alongside them would do
 * nothing at all — the gradient overwrites both on the first update. Variation
 * between particles comes from the scale range in `system` instead, which really
 * does multiply.
 *
 * It has to be a size gradient and not a *start* size gradient: the start ones
 * are measured against `targetStopDuration`, and a system that never stops has
 * none, which Babylon rejects outright at the first update.
 */
function grow(particles: ParticleSystem, from: number, to: number): void {
  particles.addSizeGradient(0, from);
  particles.addSizeGradient(1, to);
}

function system(
  scene: Scene,
  name: string,
  texture: DynamicTexture,
  capacity: number,
): ParticleSystem {
  const particles = new ParticleSystem(name, capacity, scene);
  particles.particleTexture = texture;
  particles.emitter = new Vector3();
  // Bursts only: emitRate stays at zero and manualEmitCount does the work.
  particles.emitRate = 0;
  particles.updateSpeed = 0.014;
  // Per-particle variation. This one *is* a multiplier on the size, so it
  // survives the gradient that `grow` puts on top.
  particles.minScaleX = 0.7;
  particles.minScaleY = 0.7;
  particles.maxScaleX = 1.25;
  particles.maxScaleY = 1.25;
  particles.start();
  return particles;
}

/** One soft round blob, shared by all three systems. Generated, not downloaded. */
function softDot(scene: Scene): DynamicTexture {
  const size = 64;
  const texture = new DynamicTexture("fx.dot", size, scene, false);
  const ctx = texture.getContext() as CanvasRenderingContext2D;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.35, "rgba(255,255,255,0.92)");
  gradient.addColorStop(0.7, "rgba(255,255,255,0.4)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  texture.update();
  texture.hasAlpha = true;
  return texture;
}
