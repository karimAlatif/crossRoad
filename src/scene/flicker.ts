import type { AbstractMesh, Observer, Scene } from "@babylonjs/core";

/** How a faulty light behaves. Both the cars and the street lamps use these. */
export type FlickerRules = {
  /** Seconds of normal light between bouts. */
  steady: { min: number; max: number };
  /** How long one bout of stuttering lasts, in seconds. */
  stutter: { min: number; max: number };
  /** On-off flickers per second during a bout. */
  rate: number;
};

export type Flicker = {
  /**
   * Registers one light that stutters as a unit.
   *
   * Everything in `lights` goes dark together, which is the whole point of
   * taking a group rather than a mesh: a headlamp and the cone it throws are two
   * meshes and one light, and so are a street lamp's bulb and the pool below it.
   * A cone of light left lying on the road under a bulb that has just gone out
   * is exactly what would give the trick away.
   */
  add: (lights: AbstractMesh[]) => void;
  dispose: () => void;
};

/** One registered light, mid-stutter. */
type Fault = {
  lights: AbstractMesh[];
  /** Clock reading at which the current phase ends and the other begins. */
  until: number;
  stuttering: boolean;
  lit: boolean;
};

/** A long frame (an alt-tab, a GC pause) must not fast-forward a stutter. */
const MAX_STEP = 1 / 20;

/**
 * Lights with a bad connection.
 *
 * A faulty light is mostly fine, then stutters for a fraction of a second, then
 * settles again — which is what a loose contact actually looks like, and reads
 * far better than a steady strobe. Each one keeps its own schedule, so no two
 * are ever in step.
 *
 * Going dark costs nothing extra to draw. These are all instanced meshes, and a
 * disabled instance is simply left out of its buffer for the frames it is out —
 * no extra draw call, no material change, nothing to recompile.
 */
export function createFlicker(scene: Scene, rules: FlickerRules): Flicker {
  const faults: Fault[] = [];
  let clock = 0;

  const tick = () => {
    const dt = Math.min(scene.getEngine().getDeltaTime() / 1000, MAX_STEP);
    // Two frames can share a timestamp; there is nothing to advance.
    if (dt <= 0) return;
    clock += dt;

    for (const fault of faults) {
      if (clock >= fault.until) {
        fault.stuttering = !fault.stuttering;
        fault.until = clock + between(fault.stuttering ? rules.stutter : rules.steady);
      }

      // A square wave off the shared clock while it is playing up, steady
      // otherwise. There is no per-light phase to carry and no randomness per
      // frame, so one light keeps one rhythm for the length of a bout.
      const lit = !fault.stuttering || Math.floor(clock * rules.rate) % 2 === 0;
      if (lit === fault.lit) continue;
      fault.lit = lit;
      for (const light of fault.lights) light.setEnabled(lit);
    }
  };

  const observer: Observer<Scene> | null = scene.onBeforeRenderObservable.add(tick);

  return {
    add: (lights) => {
      if (lights.length === 0) return;
      faults.push({
        lights,
        // Scattered over a whole steady period, so nothing faults in unison on
        // the first frame.
        until: Math.random() * rules.steady.max,
        stuttering: false,
        lit: true,
      });
    },
    dispose: () => {
      scene.onBeforeRenderObservable.remove(observer);
      faults.length = 0;
    },
  };
}

/** A number somewhere in an inclusive range. */
function between(range: { min: number; max: number }): number {
  return range.min + Math.random() * (range.max - range.min);
}
