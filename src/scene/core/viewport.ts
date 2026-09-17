import type { AbstractEngine } from "@babylonjs/core";
import { QUALITY } from "../config";
import type { Disposable } from "./types";

/**
 * Keeps the render surface honest on whatever the game is opened on.
 *
 * Three things have to agree with the canvas at all times, and all three are
 * settled here in one place, in one pass:
 *
 *   1. **How many pixels to render.** Not simply the device's own — see
 *      `renderScale` below.
 *   2. **The engine's idea of its size**, which is what `engine.resize()` is.
 *   3. **The framing**, passed in as `reframe`, because a narrower screen shows
 *      less of the world across than a wide one (`camera.ts#fitToScreen`).
 *
 * A `ResizeObserver` on the canvas is what watches, rather than `window.resize`.
 * The canvas can change size without the window doing anything — a CSS layout
 * change, a rotated phone, an address bar sliding away, a devtools pane opening —
 * and every one of those is a resize the scene has to answer. `window.resize` is
 * kept only as a backstop for the one case the observer misses: dragging the
 * window to a display with a different pixel ratio changes nothing about the
 * canvas's CSS size, only what a pixel is worth.
 *
 * The work is coalesced into the next animation frame because a drag-resize or a
 * rotation fires in bursts, and `engine.resize()` reallocates every render target
 * the post stack owns. Once per frame at the very most, no matter how loudly the
 * browser shouts.
 */
export function createViewport(
  engine: AbstractEngine,
  canvas: HTMLCanvasElement,
  reframe: () => void,
): Disposable {
  let queued = 0;

  const apply = () => {
    queued = 0;
    // This already resizes the engine; the explicit call after it is for the
    // case where the ratio has not changed but the canvas has.
    engine.setHardwareScalingLevel(1 / renderScale(canvas));
    engine.resize();
    reframe();
  };

  const schedule = () => {
    if (queued) return;
    queued = requestAnimationFrame(apply);
  };

  apply();

  const observer = new ResizeObserver(schedule);
  observer.observe(canvas);
  window.addEventListener("resize", schedule);
  window.addEventListener("orientationchange", schedule);

  return {
    dispose: () => {
      if (queued) cancelAnimationFrame(queued);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
    },
  };
}

/**
 * How many rendered pixels each CSS pixel is worth, which is the difference
 * between a phone running this at 60 fps and at 20.
 *
 * Three limits, smallest wins:
 *
 *   - the display's own ratio, because rendering above it is wasted work;
 *   - `QUALITY.maxPixelRatio`, because a 3x phone would otherwise shade nine
 *     times the pixels of a 1x one for a picture no one can see the difference
 *     in;
 *   - `QUALITY.maxPixels`, a flat budget on the total. This is the one that
 *     matters on desktop: a maximised 4K window asks for four times the shading
 *     of a 1080p one at the same ratio, and this scene is fill-rate bound.
 *
 * With a floor under all of it, because past a point a soft picture is worse
 * than a slow one.
 */
function renderScale(canvas: HTMLCanvasElement): number {
  const ratio = window.devicePixelRatio || 1;
  const pixels = Math.max(1, canvas.clientWidth * canvas.clientHeight);
  const budget = Math.sqrt(QUALITY.maxPixels / pixels);
  return Math.max(QUALITY.minRenderScale, Math.min(ratio, QUALITY.maxPixelRatio, budget));
}
