import type { Engine } from "@babylonjs/core";
import { GRAPHICS, MOBILE_LIGHT, type GraphicsLevel, type GraphicsSettings } from "./config";
import type { Clock } from "./core/frame";

/**
 * Deciding how much work this device can do, and noticing when we got it wrong.
 *
 * Two halves. `chooseLevel` guesses from what the machine says about itself,
 * before a single frame has been drawn, because the level has to be known while
 * the scene is still being built — a shadow generator cannot be resized later,
 * and a headlight cone not built costs nothing forever.
 *
 * Then `calibrate` measures, once, during the opening shot. A guess from a
 * renderer string is a guess; the frame rate is a fact, and a device that cannot
 * hold it gets a cheaper level whatever it claimed to be — but only then, and
 * never again. See `calibrate` for why that matters more than it sounds.
 */

/** The settings in force. Read it, never write it — `useLevel` owns it. */
export let graphics: GraphicsSettings = GRAPHICS.levels.high;

/** Which level that is. */
export let level: GraphicsLevel = "high";

/** The GPU the browser is actually drawing with, as a person would name it. */
let gpu = "";

/** Cheapest first, which is also the order the governor walks backwards along. */
const LADDER: GraphicsLevel[] = ["low", "medium", "high"];

/** Puts a level in force. Everything that draws reads `graphics` afterwards. */
export function useLevel(next: GraphicsLevel): GraphicsSettings {
  level = next;
  graphics = GRAPHICS.levels[next];
  return graphics;
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
  const renderer = rendererName(engine);
  gpu = readable(renderer);
  if (GRAPHICS.force) return GRAPHICS.force;

  // Software rasterisers: nothing on this ladder makes them fast, but the bottom
  // rung at least keeps them moving.
  if (/swiftshader|llvmpipe|software|basic render/i.test(renderer)) return "low";

  const cores = navigator.hardwareConcurrency || 4;
  const memory = (navigator as { deviceMemory?: number }).deviceMemory ?? 4;
  const phone = onTouchScreen();

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
 * Listens to the first seconds of the game, settles the graphics level once, and
 * stops listening for good.
 *
 * This used to be a governor that watched the whole session and dropped a level
 * whenever two bad spells came in a row. It worked, and it was wrong: every drop
 * rebuilds the bloom, switches off the tilt-shift and the shadows and changes the
 * resolution, all in one frame, so the whole picture visibly lurched — in the
 * middle of play, sometimes twice. Worse, it was listening from the very first
 * frame, and the first frames of *any* game hitch while textures upload and the
 * last shaders compile, so a perfectly good machine could talk itself down a
 * level before the player had done anything.
 *
 * So now it listens during the opening shot and nowhere else:
 *
 *   - It **skips the first moments**, which hitch on every device and say
 *     nothing about how fast this one is.
 *   - It **judges the median frame**, not the worst ones. One slow frame is a
 *     hiccup; a slow median is a slow device.
 *   - It **picks the right level in one step**, from what each level was
 *     measured to cost, rather than stepping down one at a time and being seen
 *     twice.
 *   - It **finishes before the camera settles**, so the change happens while
 *     the whole view is moving anyway, and the game view the player actually
 *     plays in is never repainted in front of them.
 *
 * Then it unsubscribes. Whatever it chose is the level for the session.
 *
 * `introSeconds` is how long the opening shot runs. Time here is the clock's,
 * which is also the intro's, so on a slow device — where the clock runs behind
 * real time — the listening still lines up with the camera move.
 */
export function calibrate(
  clock: Clock,
  introSeconds: number,
  settle: (next: GraphicsLevel) => void,
): () => void {
  const { enabled, targetFps, skip } = GRAPHICS.adapt;
  // A pinned level is a decision already made. Second-guessing it would make
  // `force` useless for the one thing it is for: seeing a level as it is.
  if (!enabled || GRAPHICS.force) return () => {};

  // Stop a beat before the camera does, so the change has motion to hide in; but
  // always listen for long enough to have a verdict worth acting on.
  const until = Math.max(skip + MIN_LISTEN, introSeconds - SETTLE_MARGIN);
  const frames: number[] = [];
  let elapsed = 0;
  let last = performance.now();

  const stop = clock.each((dt) => {
    elapsed += dt;
    const now = performance.now();
    const gap = now - last;
    last = now;

    if (elapsed < skip) return;
    // A tab switched away and back is a pause, not a slow frame.
    if (gap < PAUSE) frames.push(gap);
    if (elapsed < until) return;

    stop();
    const typical = median(frames);
    const next = fit(level, typical, 1000 / targetFps);
    if (next === level) return;
    report(level, next, typical, 1000 / targetFps);
    settle(next);
  });

  return stop;
}

/**
 * One line in the console saying what the game is drawing with and at what
 * level, so "why does it look worse on my machine" has an answer that does not
 * need a debugger.
 */
export function announce(): void {
  console.info(`Graphics: ${level} on ${gpu || "an unnamed GPU"}${GRAPHICS.force ? " (pinned)" : ""}.`);
}

/**
 * Why the level just went down — and, when the GPU is a built-in one, the fix
 * that is almost always the real answer.
 *
 * Laptops with a dedicated graphics card still hand web browsers the built-in
 * chip by default, to save battery, and a web page cannot choose otherwise:
 * `powerPreference: "high-performance"` is a hint, and Chrome on Windows ignores
 * it. Measured on an RTX 4060 laptop, the same scene ran at 92 fps on the card
 * and 16 fps on the Intel chip Chrome had picked — so a lowered level on a
 * built-in GPU is worth one sentence telling the player how to switch.
 */
function report(from: GraphicsLevel, to: GraphicsLevel, frameMs: number, budgetMs: number): void {
  console.info(
    `Graphics: lowered from ${from} to ${to} — frames took ${Math.round(frameMs)} ms during the ` +
      `opening, against ${Math.round(budgetMs)} ms to hold ${GRAPHICS.adapt.targetFps} fps, on ${gpu || "this GPU"}.`,
  );
  if (BUILT_IN.test(gpu)) {
    console.info(
      "Graphics: that is a built-in graphics chip. If this machine also has a dedicated graphics card, " +
        "set the browser to use it — Windows: Settings › System › Display › Graphics › your browser › " +
        "High performance — then restart the browser.",
    );
  }
}

/** Renderer names that mean a GPU built into the processor rather than a card. */
const BUILT_IN = /intel|uhd|iris|radeon\(tm\) graphics|radeon graphics|vega \d/i;

/**
 * "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028E0) Direct3D11
 * vs_5_0 ps_5_0, D3D11)" is what Chrome reports; "NVIDIA GeForce RTX 4060 Laptop
 * GPU" is what a person calls it.
 */
function readable(renderer: string): string {
  const angle = /ANGLE \([^,]+, (.+?)(?: \(0x[0-9a-f]+\))?(?: Direct3D| OpenGL| Vulkan| Metal|,)/i.exec(renderer);
  return (angle ? angle[1] : renderer).trim();
}

/**
 * What each level costs to draw, relative to the top one. Measured on the same
 * machine by timing each level's steady frame rate: medium runs at about 70% of
 * high's frame time and low at about a third. Only the ratios matter here.
 */
const COST: Record<GraphicsLevel, number> = { high: 1, medium: 0.7, low: 0.33 };

/**
 * The best level that would hold the budget, given how long frames take at the
 * current one.
 *
 * A little tolerance above the budget, because a browser capped at 30 fps — a
 * laptop on battery, a power-saving mode — produces frames of exactly 33 ms that
 * are perfectly smooth, and taking quality away from it would buy nothing: the
 * cap is not ours to lift.
 */
function fit(current: GraphicsLevel, frameMs: number, budget: number): GraphicsLevel {
  if (!(frameMs > budget * TOLERANCE)) return current;
  for (let at = LADDER.indexOf(current); at >= 0; at--) {
    const candidate = LADDER[at];
    if ((frameMs * COST[candidate]) / COST[current] <= budget) return candidate;
  }
  return LADDER[0];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Whether the game is on a phone or a tablet.
 *
 * A coarse pointer with no fine one is the honest test — a finger and nothing
 * else — and far better than sniffing the user-agent, which lies. A laptop with a
 * touch screen also has a trackpad, so it counts as a desktop, which it is.
 */
export function onTouchScreen(): boolean {
  return matchMedia("(pointer: coarse)").matches && !matchMedia("(pointer: fine)").matches;
}

/** How much this part of the lighting is lifted on this device: 1 anywhere but a phone. */
export function mobileLift(part: keyof typeof MOBILE_LIGHT): number {
  return onTouchScreen() ? MOBILE_LIGHT[part] : 1;
}

/** Longer than this between frames is a pause, not a slow device. */
const PAUSE = 2000;

/** How far over the budget a median frame has to be before anything changes. */
const TOLERANCE = 1.1;

/** Seconds before the camera settles that the verdict is due. */
const SETTLE_MARGIN = 0.5;

/** Never judge on less than this many seconds of frames. */
const MIN_LISTEN = 1.2;

/** The GPU's own name, where the browser is willing to say. */
function rendererName(engine: Engine): string {
  try {
    const info = engine.getGlInfo();
    return `${info.renderer ?? ""} ${info.vendor ?? ""}`;
  } catch {
    return "";
  }
}
