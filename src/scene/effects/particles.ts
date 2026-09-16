import { ParticleSystem, Vector3, type DynamicTexture, type Scene } from "@babylonjs/core";
import type { Range } from "../core/types";

/**
 * A particle system that only ever fires bursts.
 *
 * Every effect in the game works this way: `emitRate` stays at zero and
 * `manualEmitCount` does the work, so one system can serve the whole fleet
 * instead of one per car. See `carEffects` for how several cars share one on the
 * same frame.
 */
export function burstSystem(
  scene: Scene,
  name: string,
  texture: DynamicTexture,
  capacity: number,
): ParticleSystem {
  const particles = new ParticleSystem(name, Math.max(1, capacity), scene);
  particles.particleTexture = texture;
  particles.emitter = new Vector3();
  particles.emitRate = 0;
  particles.updateSpeed = 0.014;
  // Per-particle variation. This one multiplies the size, so it survives the
  // gradient `grow` puts on top.
  particles.minScaleX = 0.65;
  particles.minScaleY = 0.65;
  particles.maxScaleX = 1.35;
  particles.maxScaleY = 1.35;
  particles.start();
  return particles;
}

/**
 * Makes particles swell as they age, from `size.min` metres to `size.max` — or
 * shrink, if `max` is the smaller of the two, which is what a spark does.
 *
 * Size gradients *replace* `particle.size` rather than scaling it, so these are
 * absolute metres and `minSize`/`maxSize` would be overwritten on the first
 * update. It also has to be a size gradient and not a *start* size gradient:
 * those are measured against `targetStopDuration`, which a system that never
 * stops does not have, and Babylon rejects that outright at the first update.
 */
export function grow(particles: ParticleSystem, size: Range): void {
  particles.addSizeGradient(0, size.min);
  particles.addSizeGradient(1, size.max);
}
