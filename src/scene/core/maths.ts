import type { Range } from "./types";

/** Clamps to 0…1. Used wherever a fraction is about to become a colour or a fade. */
export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** A random number somewhere in an inclusive range. */
export function between(range: Range): number {
  return range.min + Math.random() * (range.max - range.min);
}

/** The centre of a range. */
export function mid(range: Range): number {
  return (range.min + range.max) / 2;
}

/**
 * Walks `from` towards `to` by at most `step`, without overshooting.
 *
 * This is how every gradual change in the scene is made — speeds, blend weights —
 * so that it is framerate-independent: the caller passes `rate * dt`.
 */
export function moveTowards(from: number, to: number, step: number): number {
  if (from < to) return Math.min(from + step, to);
  return Math.max(from - step, to);
}

/**
 * A 0…1 level as one byte of a texture, scaled by `strength` on the way.
 *
 * Every generated texture in the scene bakes its colour in this way rather than
 * tinting a white texture with a material colour — see `unlit` in `visuals.ts`
 * for why that does not work with StandardMaterial.
 */
export function byte(level: number, strength = 1): number {
  return Math.round(clamp01(level * strength) * 255);
}
