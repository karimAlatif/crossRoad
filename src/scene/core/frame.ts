import type { Observer, Scene } from "@babylonjs/core";
import type { Disposable } from "./types";

/** What a per-frame system is handed: the length of this frame, and the clock. */
export type Tick = (dt: number, elapsed: number) => void;

export type Clock = Disposable & {
  /** Runs `tick` every frame, in the order subscribed. Returns an unsubscribe. */
  each: (tick: Tick) => () => void;
  /** Seconds since the first frame. */
  now: () => number;
};

/**
 * A long frame — an alt-tab, a garbage collection pause, a breakpoint — must not
 * teleport the traffic or fast-forward every animation at once. Past this, the
 * frame is treated as this long and the world simply runs slow for a moment.
 */
const MAX_STEP = 1 / 20;

/**
 * The scene's heartbeat: one Babylon observer that every per-frame system hangs
 * off.
 *
 * Six systems used to register their own `onBeforeRenderObservable` callback and
 * each work out the frame length for itself, with three different opinions about
 * clamping it. One clock means one opinion, one place to reason about ordering,
 * and one `getDeltaTime()` call a frame instead of six.
 *
 * Order is subscription order, and it matters in one place: the traffic moves the
 * cars, so anything that reads where a car *is* should subscribe after it.
 */
export function createClock(scene: Scene): Clock {
  const engine = scene.getEngine();
  const ticks: (Tick | null)[] = [];
  let elapsed = 0;
  let removed = false;

  const frame = () => {
    const dt = Math.min(engine.getDeltaTime() / 1000, MAX_STEP);
    // Two frames can share a timestamp; there is nothing to advance.
    if (dt <= 0) return;
    elapsed += dt;

    for (let i = 0; i < ticks.length; i++) ticks[i]?.(dt, elapsed);

    // A tick is allowed to unsubscribe itself — the camera intro does exactly
    // that when it finishes — so removals leave a hole and the list is closed up
    // afterwards rather than shifting under the loop that is still running.
    if (!removed) return;
    removed = false;
    for (let i = ticks.length - 1; i >= 0; i--) if (!ticks[i]) ticks.splice(i, 1);
  };

  const observer: Observer<Scene> | null = scene.onBeforeRenderObservable.add(frame);

  return {
    each: (tick) => {
      ticks.push(tick);
      return () => {
        const at = ticks.indexOf(tick);
        if (at < 0) return;
        ticks[at] = null;
        removed = true;
      };
    },
    now: () => elapsed,
    dispose: () => {
      scene.onBeforeRenderObservable.remove(observer);
      ticks.length = 0;
    },
  };
}
