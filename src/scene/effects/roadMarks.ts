import {
  DynamicTexture,
  MeshBuilder,
  Texture,
  type AbstractMesh,
  type Color3,
  type Scene,
  type Vector3,
} from "@babylonjs/core";
import { byte } from "../core/maths";
import type { Disposable } from "../core/types";
import { unlit } from "../core/visuals";

/** What a pool needs to know to draw and age one kind of ribbon. */
export type MarkRules = {
  /** How many segments can be down at once. Also the recycling limit. */
  pool: number;
  /** How far off the tarmac a segment lies, when `span` is not given a height. */
  height?: number;
  /** The last fraction of a segment's life, over which it narrows away. */
  fade: number;
  colour: Color3;
  /** 0 to 1. For rubber this is how dark; for light, how bright. */
  strength: number;
  /** Light adds to what is behind it; rubber covers it. */
  glowing: boolean;
};

export type MarkPool = Disposable & {
  /**
   * Lays or updates one segment of a ribbon, running from `from` to `to`.
   *
   * Pass the handle this returned last frame to keep stretching the same
   * segment, or -1 to start a new one. That is what keeps a ribbon attached to
   * the car: the newest segment is not dropped and left behind, it is pulled out
   * from wherever it began to wherever the lamp is *now*, every frame, and only
   * let go once it is long enough — at which point the next one starts from the
   * same spot.
   *
   * A segment being stretched does not age. It starts its `seconds` once it is
   * let go.
   *
   * The returned handle goes stale if the pool has since had to recycle that
   * slot; passing a stale one simply starts a new segment.
   */
  span: (
    handle: number,
    from: Vector3,
    to: Vector3,
    width: number,
    seconds: number,
    y?: number,
  ) => number;
  /** Ages every segment. Called once a frame. */
  update: (dt: number) => void;
};

/**
 * A few centimetres of overlap at each joint. Two segments that meet exactly
 * leave a hairline between them wherever rounding lands the two edges a fraction
 * apart, and on a glowing ribbon that hairline reads as a dark stitch.
 */
const OVERLAP = 0.04;

/**
 * A pool of flat ribbon segments: rubber on the tarmac, and light behind the
 * lamps.
 *
 * Both are the same thing in different paint, so they share this. Each pool is
 * a fixed set of 1 x 1 planes instanced off one source mesh, stretched to length
 * and width per segment — so every segment of its kind on the whole junction is
 * one draw call, and nothing is allocated after startup.
 *
 * The pool is a ring. When it is full the next segment takes the oldest slot, so
 * the road can never accumulate without bound.
 *
 * Segments fade by narrowing rather than by going transparent. Per-instance
 * alpha needs an instanced colour buffer and a material set up to read it; a
 * width that closes up costs nothing and reads correctly anyway — rubber wears
 * from the edges in, and a light trail thins as it goes.
 */
export function createMarkPool(scene: Scene, name: string, rules: MarkRules): MarkPool {
  const texture = strip(scene, `${name}.tex`, rules);
  // Light adds to the road; rubber covers it. Otherwise they are the same thing.
  const material = unlit(scene, `${name}.mat`, { texture, glow: rules.glowing });

  // Unit size: each segment scales it to its own length and width.
  const source = MeshBuilder.CreatePlane(name, { width: 1, height: 1 }, scene);
  source.material = material;
  source.isPickable = false;
  source.receiveShadows = false;
  source.applyFog = false;
  source.doNotSyncBoundingInfo = true;
  source.rotation.set(Math.PI / 2, 0, 0);
  source.setEnabled(false);

  /** One slot: a segment, its width, its life, and which lay it belongs to. */
  type Mark = { mesh: AbstractMesh; left: number; life: number; width: number; gen: number };
  const marks: Mark[] = [];
  for (let i = 0; i < rules.pool; i++) {
    const mesh = source.createInstance(`${name}${i}`);
    mesh.isPickable = false;
    mesh.setEnabled(false);
    marks.push({ mesh, left: 0, life: 0, width: 0, gen: 0 });
  }

  const size = marks.length;
  let next = 0;
  let generation = 0;

  /** A handle packs the slot and the lay it came from into one number. */
  const find = (handle: number): Mark | null => {
    if (handle < 0) return null;
    const mark = marks[handle % size];
    return mark.gen === Math.floor(handle / size) ? mark : null;
  };

  return {
    span: (handle, from, to, width, seconds, y = rules.height ?? 0) => {
      let mark = find(handle);
      if (!mark) {
        const slot = next;
        next = (next + 1) % size;
        mark = marks[slot];
        mark.gen = ++generation;
        handle = mark.gen * size + slot;
        mark.mesh.setEnabled(true);
      }

      const dx = to.x - from.x;
      const dz = to.z - from.z;
      const length = Math.hypot(dx, dz);
      const mesh = mark.mesh;
      mesh.position.set((from.x + to.x) / 2, y, (from.z + to.z) / 2);
      // Flat on the road, then turned along the segment. Babylon composes this as
      // roll, then pitch, then yaw, so the quarter turn that lays the plane down
      // happens inside the yaw and the segment points along the road instead of
      // rolling onto its side. A segment with no length yet keeps its last yaw.
      if (length > 1e-4) mesh.rotation.set(Math.PI / 2, Math.atan2(dx, dz), 0);
      mesh.scaling.set(width, length + OVERLAP, 1);

      mark.width = width;
      mark.life = seconds;
      // Held at full life while it is still being laid.
      mark.left = seconds;
      return handle;
    },

    update: (dt) => {
      for (const mark of marks) {
        if (mark.left <= 0) continue;
        mark.left -= dt;
        if (mark.left <= 0) {
          mark.mesh.setEnabled(false);
          continue;
        }
        const fading = mark.life * rules.fade;
        const factor = mark.left >= fading ? 1 : Math.max(0, mark.left / fading);
        mark.mesh.scaling.x = mark.width * factor;
      }
    },

    dispose: () => {
      for (const mark of marks) mark.mesh.dispose();
      source.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}

/**
 * One segment: full down the middle, soft along both edges.
 *
 * Unlike a mark that stands on its own, a ribbon segment does not taper at its
 * ends. Its ends are joints with the segments either side, and a taper there
 * would dim every joint into a row of dashes. The ribbon's own tail is softened
 * by the fade instead, which narrows the oldest segments away first.
 *
 * The colour is baked into the texture's RGB rather than set on the material.
 * StandardMaterial *adds* an emissive texture to `emissiveColor` and clamps the
 * sum, so a white texture would come out white whatever colour it was given —
 * see the note on `additive` in carHeadlights.
 */
function strip(scene: Scene, name: string, rules: MarkRules): DynamicTexture {
  const size = 64;
  const texture = new DynamicTexture(name, size, scene, true);
  const ctx = texture.getContext() as CanvasRenderingContext2D;
  const image = ctx.createImageData(size, size);
  const data = image.data;

  const red = byte(rules.colour.r);
  const green = byte(rules.colour.g);
  const blue = byte(rules.colour.b);

  for (let x = 0; x < size; x++) {
    const u = Math.abs(x / (size - 1) - 0.5) * 2;
    const across = Math.max(0, 1 - u * u * u);
    const alpha = byte(across, rules.strength);

    for (let y = 0; y < size; y++) {
      const i = (y * size + x) * 4;
      data[i] = red;
      data[i + 1] = green;
      data[i + 2] = blue;
      data[i + 3] = alpha;
    }
  }

  ctx.putImageData(image, 0, 0);
  texture.update();
  texture.hasAlpha = true;
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  return texture;
}
