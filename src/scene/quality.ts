import type { Engine } from "@babylonjs/core";
import { GRAPHICS, type GraphicsLevel, type GraphicsSettings } from "./config";
import type { Clock } from "./core/frame";

/**
 * Deciding how much work this device can do, and noticing when we got it wrong.
 *
 * Two halves. `chooseLevel` guesses from what the machine says about itself,
 * before a single frame has been drawn, because the level has to be known while
 * the scene is still being built — a shadow generator cannot be resized later,
 * and a headlight cone not built costs nothing forever.
 *
 * Then `watchFrameRate` measures. A guess from a renderer string is a guess; the
 * frame rate is a fact, and a device that cannot hold the rate gets dropped a
 * level whatever it claimed to be.
 */

/** The settings in force. Read it, never write it — `useLevel` owns it. */
export let graphics: GraphicsSettings = GRAPHICS.levels.high;

/** Which level that is. */
export let level: GraphicsLevel = "high";

/** Cheapest first, which is also the order the governor walks backwards along. */
const LADDER: GraphicsLevel[] = ["low", "medium", "high"];

/** Puts a level in force. Everything that draws reads `graphics` afterwards. */
export function useLevel(next: GraphicsLevel): GraphicsSettings {
  level = next;
  graphics = GRAPHICS.levels[next];
  return graphics;
}

/** The level below this one, or null at the bottom. */
export function levelBelow(of: GraphicsLevel): GraphicsLevel | null {
  const at = LADDER.indexOf(of);
  return at > 0 ? LADDER[at - 1] : null;
}

/**
 * What this device looks like it can take.
 *
 * Nothing here is authoritative — there is no browser API that says "this GPU is
 * slow" — so it reads three weak signals and takes the worst answer:
 *
 *   - **The renderer string.** The only strong signal in the set: a software
 *     renderer (SwiftShader, llvmpipe, a headless CI box) will not hold a frame
 *     rate at any setting, and Apple's GPUs in the opposite direction are fast
 *     enough that a phone carrying one is not a low-end device.
 *   - **Cores and memory.** A 4-core, 4 GB phone is a different machine from an
 *     8-core one, and `hardwareConcurrency` is the closest thing to a CPU class
 *     the browser will admit to.
 *   - **Whether it is a phone at all.** A coarse pointer with no fine one is the
 *     honest test — far better than sniffing the user-agent, which lies.
 *
 * Erring low is deliberate. A strong phone that starts at medium looks good and
 * runs cold; a weak one that starts at high spends its first seconds dropping
 * back down, in full view of the player.
 */
export function chooseLevel(engine: Engine): GraphicsLevel {
  if (GRAPHICS.force) return GRAPHICS.force;

  const renderer = rendererName(engine);
  // Software rasterisers: nothing on this ladder makes them fast, but the bottom
  // rung at least keeps them moving.
  if (/swiftshader|llvmpipe|software|basic render/i.test(renderer)) return "low";

  const cores = navigator.hardwareConcurrency || 4;
  const memory = (navigator as { deviceMemory?: number }).deviceMemory ?? 4;
  const phone = matchMedia("(pointer: coarse)").matches && !matchMedia("(pointer: fine)").matches;

  // Apple's mobile GPUs are in a class of their own; an iPhone is not a low-end
  // device and treating it as one wastes a good screen.
  const apple = /apple/i.test(renderer);

  if (cores <= 4 || memory <= 2) return apple ? "medium" : "low";
  if (phone) return apple && cores >= 6 ? "high" : "medium";
  // A desktop with WebGL 1 is old hardware or a forced fallback; either way it is
  // not a high-end path.
  if (engine.webGLVersion < 2 || cores <= 6) return "medium";
  return "high";
}

/**
 * Watches the frame rate and calls `struggling` when the device is not keeping
 * up — once per bad spell, never in the middle of one.
 *
 * It counts *slow frames* rather than averaging, because an average hides the
 * thing that actually ruins a game: a frame rate that is fine until a wave of
 * cars arrives. A spell is `windowSeconds` in which most frames missed the
 * target; `strikes` of those in a row and the caller is told.
 *
 * It times the frames itself rather than taking the clock's `dt`, for two
 * reasons. The clock clamps `dt` so that a long frame cannot teleport the
 * traffic — which would also flatten a 500 ms frame into a 50 ms one, hiding
 * exactly the device this is here to catch. And a window measured in clamped
 * time runs slower the worse things get: on a device at 5 fps a "four second"
 * window would take sixteen real seconds to fill, so the help would arrive last
 * where it was needed most.
 *
 * A gap longer than `PAUSE` is not a slow frame at all — it is a tab coming back
 * to the foreground, or a laptop waking up — and is thrown away rather than held
 * against the device.
 */
export function watchFrameRate(clock: Clock, struggling: () => boolean): () => void {
  const { enabled, targetFps, windowSeconds, strikes } = GRAPHICS.adapt;
  if (!enabled) return () => {};

  const budget = 1000 / targetFps;
  let last = performance.now();
  let since = 0;
  let frames = 0;
  let slow = 0;
  let bad = 0;

  const stop = clock.each(() => {
    const now = performance.now();
    const gap = now - last;
    last = now;
    if (gap > PAUSE) return;

    since += gap;
    frames++;
    if (gap > budget) slow++;
    if (since < windowSeconds * 1000) return;

    // More than half the window spent below the target counts as a bad spell.
    const struggled = slow > frames / 2;
    since = 0;
    frames = 0;
    slow = 0;

    if (!struggled) {
      // One good window wipes the slate: a single bad patch is not a verdict.
      bad = 0;
      return;
    }

    if (++bad < strikes) return;
    bad = 0;
    // Nothing left to give up — stop measuring rather than ask every window.
    if (!struggling()) stop();
  });

  return stop;
}

/** Longer than this between frames is a pause, not a slow device. */
const PAUSE = 2000;

/** The GPU's own name, where the browser is willing to say. */
function rendererName(engine: Engine): string {
  try {
    const info = engine.getGlInfo();
    return `${info.renderer ?? ""} ${info.vendor ?? ""}`;
  } catch {
    return "";
  }
}
