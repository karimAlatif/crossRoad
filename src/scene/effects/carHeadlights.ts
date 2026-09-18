import {
  DynamicTexture,
  Matrix,
  Texture,
  TransformNode,
  Vector3,
  type AbstractMesh,
  type Color3,
  type Mesh,
  type Scene,
  type StandardMaterial,
} from "@babylonjs/core";
import { HEADLIGHT } from "../config";
import type { Clock } from "../core/frame";
import { byte } from "../core/maths";
import type { Disposable } from "../core/types";
import { plane, planeSource, radialTexture, unlit, type PlaneSource } from "../core/visuals";
import { graphics } from "../quality";
import { createFlicker } from "./flicker";

/**
 * Where one car's lamps go, in its own rig space. Read from marker nodes in the
 * model where they exist, measured off the bumper where they do not.
 */
export type LampMounts = {
  /** A headlamp, and a beam, at each of these. */
  front: Vector3[];
  /** A rear lamp at each of these. No beam: a tail light lights nothing. */
  back: Vector3[];
};

export type Headlights = Disposable & {
  /**
   * Hangs a set of lights on one car.
   *
   * `road` is the car's lane node, carrying only its position and heading.
   * `anim` is the chain of animated nodes below it, outermost first — the lamps
   * hang off the last of them, and the beams read their pose off all of them.
   */
  attach: (road: TransformNode, anim: TransformNode[], mounts: LampMounts) => void;
};

/** One car's beams, and the animated nodes whose pose they answer to. */
type BeamRig = { node: TransformNode; anim: TransformNode[] };

/**
 * Car lights, done without a single real light.
 *
 * A Babylon light is priced per *material*, not per light: thirty headlights
 * would recompile every shader in the city for thirty lights and then pay for
 * all of them on every pixel of every surface. Nothing about this view needs
 * that. What it needs is for the lights to *read*, and additive geometry reads
 * just as well from a camera locked above the junction.
 *
 * Every car carries six planes — a cone of light from each headlamp, a pair of
 * lamps at the bumper and a pair at the back — and every car after the first
 * instances those same three meshes. Hardware instancing then draws the whole
 * fleet in three calls whether that is ten cars or a hundred.
 *
 * The lamps hang off the bottom of the car's animation stack, so they rock with
 * the idle shudder, dip with the brake and tumble with a wreck — a lamp that
 * stays level while the car it is bolted to rolls around reads as painted on.
 * They sit exactly where the model's own marker nodes put them, front and back
 * alike, with nothing added: a headlamp belongs where the car has a headlamp.
 *
 * The cones follow the same motion but cannot be hung the same way. A cone is a
 * patch of light lying on the road, and the car's pitch is large: a 0.45 rad
 * nose-dive swings the centre of a six-metre cone 1.78 m *below* the tarmac,
 * taking the whole thing out of sight. So the beams hang off the lane node and
 * are handed the car's pose as a slide instead of a tilt — they swing with its
 * yaw, and a dive pulls the pool of light in towards the bumper rather than
 * tipping it under the road. Which is what a dipping headlight really does.
 *
 * Finally, a quarter of the fleet has a bad connection and stutters. That costs
 * nothing extra to draw — a faulty lamp is simply left out of its instance
 * buffer for the frames it is dark.
 */
export function createHeadlights(scene: Scene, clock: Clock): Headlights | null {
  if (!HEADLIGHT.enabled) return null;

  const { beam, lamp, flicker } = HEADLIGHT;
  /** 0 stands the glow upright facing the road, a quarter turn lies it flat. */
  const lampPitch = (Math.PI / 2) * (1 - lamp.tilt);

  // Colour is baked into every texture rather than set on the material — see
  // `unlit` in core/visuals for why that is the only thing that works.
  const cone = beamTexture(scene, HEADLIGHT.frontColour, beam.brightness);
  const frontBulb = bulb(scene, "headlight.frontTex", HEADLIGHT.frontColour, lamp.brightness);
  const backBulb = bulb(scene, "headlight.backTex", HEADLIGHT.backColour, lamp.brightness);

  const beamMaterial = unlit(scene, "headlight.beamMat", { texture: cone, glow: true });
  const frontMaterial = unlit(scene, "headlight.frontMat", { texture: frontBulb, glow: true });
  const backMaterial = unlit(scene, "headlight.backMat", { texture: backBulb, glow: true });

  const beamSource = planeSource();
  const frontSource = planeSource();
  const backSource = planeSource();
  const parts: AbstractMesh[] = [];
  const rigs: BeamRig[] = [];
  const faults = createFlicker(clock, flicker);

  const place = (
    source: PlaneSource,
    name: string,
    material: StandardMaterial,
    width: number,
    height: number,
    parent: TransformNode,
    x: number,
    y: number,
    z: number,
    /** Quarter turn lies the plane flat; 0 leaves it upright facing the road. */
    pitch: number,
  ): AbstractMesh => {
    const mesh = plane(scene, source, name, material, width, height);
    mesh.parent = parent;
    mesh.position.set(x, y, z);
    // Both faces draw, so which way the normal ended up pointing does not matter.
    mesh.rotation.set(pitch, 0, 0);
    parts.push(mesh);
    return mesh;
  };

  const attach = (road: TransformNode, anim: TransformNode[], mounts: LampMounts) => {
    // The bottom of the animation stack. Anything parented here inherits every
    // clip the car plays, and the mount coordinates work unchanged: every node
    // in between is at rest until an animation moves it.
    const body = anim[anim.length - 1] ?? road;

    // The beams get a node of their own under the lane, driven by `sync` below.
    const beams = new TransformNode(`${road.name}.beams`, scene);
    beams.parent = road;
    rigs.push({ node: beams, anim });

    // Each headlamp and the cone it throws, kept together so a stutter takes
    // both. Built even when this car turns out to be sound — it is two array
    // pushes, and it saves branching inside the loop.
    const headlamps: AbstractMesh[][] = [];

    for (const at of mounts.front) {
      // The cone is a big additive quad per lamp — a lot of overdraw for a phone
      // to carry sixty times over — so a low graphics level keeps the lamps and
      // drops the light they throw.
      const cone = graphics.beams
        ? place(
            beamSource,
            "headlight.beam",
            beamMaterial,
            beam.endWidth,
            beam.length,
            beams,
            at.x,
            ROAD_CLEARANCE,
            at.z + beam.length / 2,
            Math.PI / 2,
          )
        : null;
      const bulb = place(
        frontSource,
        "headlight.lamp",
        frontMaterial,
        lamp.size,
        lamp.size,
        body,
        at.x,
        at.y,
        at.z,
        lampPitch,
      );
      headlamps.push(cone ? [bulb, cone] : [bulb]);
    }

    // The back gets the same treatment as the front, at its own markers, in red.
    // No cone: a rear lamp is something you see, not something that lights the
    // road, and a red pool behind every car would read as brake lights stuck on.
    for (const at of mounts.back) {
      place(
        backSource,
        "headlight.back",
        backMaterial,
        lamp.size,
        lamp.size,
        body,
        at.x,
        at.y,
        at.z,
        lampPitch,
      );
    }

    // Is this one of the cars with a bad connection? Each headlamp is registered
    // with the cone it throws, so the two always go out together.
    if (headlamps.length > 0 && Math.random() < flicker.cars) {
      if (Math.random() < flicker.both) {
        for (const pair of headlamps) faults.add(pair);
      } else {
        faults.add(headlamps[Math.floor(Math.random() * headlamps.length)]);
      }
    }
  };

  /**
   * Swings each car's beams round to match how that car is sitting.
   *
   * The angles are read straight off the animated nodes rather than decomposed
   * out of a world matrix: they are the values the clips actually wrote, they
   * cost nothing to fetch, and taking them this way touches none of Babylon's
   * dirty-matrix bookkeeping — so it makes no difference whether this lands
   * before or after the traffic step. Summing them is exact for yaw, where only
   * the shudder and a wreck's spin ever write, and near enough for pitch, where
   * the dive and the lift are one-shots that cancel each other on the way in.
   *
   * Cars are pooled, so this list stops growing the moment the roads are built;
   * the ones currently parked off-road are disabled, and skipped.
   */
  const sync = () => {
    for (const rig of rigs) {
      if (!rig.node.isEnabled()) continue;

      let pitch = 0;
      let yaw = 0;
      for (const node of rig.anim) {
        pitch += node.rotation.x;
        yaw += node.rotation.y;
      }

      rig.node.rotation.y = yaw;
      // Nose down throws the light short; nose up throws it long.
      rig.node.position.z = -pitch * beam.follow;
    }
  };

  const stop = clock.each(sync);

  return {
    attach,
    dispose: () => {
      stop();
      for (const rig of rigs) rig.node.dispose();
      rigs.length = 0;
      for (const part of parts) part.dispose();
      faults.dispose();
      beamMaterial.dispose();
      frontMaterial.dispose();
      backMaterial.dispose();
      cone.dispose();
      frontBulb.dispose();
      backBulb.dispose();
    },
  };
}

/** Just enough to keep a flat plane off the tarmac without it looking to float. */
const ROAD_CLEARANCE = 0.2;



/**
 * The cone a headlamp throws on the road: it leaves the bumper as a narrow spot
 * the width of the lamp, fans out with distance, and has faded to nothing before
 * its far edge.
 *
 * Written pixel by pixel rather than from canvas gradient stops. A radial
 * gradient can only ever make an ellipse — symmetric, hard-edged, and reading as
 * a blob dropped on the tarmac rather than light thrown forward. The falloff
 * wanted here differs per axis: across the width a cubed parabola, which has no
 * visible edge at all, and along the length a smooth rise to a peak just ahead
 * of the bumper followed by a long decay.
 */
function beamTexture(scene: Scene, colour: Color3, brightness: number): DynamicTexture {
  const size = 128;
  const texture = new DynamicTexture("headlight.cone", size, scene, true);
  const ctx = texture.getContext() as CanvasRenderingContext2D;
  const image = ctx.createImageData(size, size);
  const data = image.data;

  const red = byte(colour.r, brightness);
  const green = byte(colour.g, brightness);
  const blue = byte(colour.b, brightness);

  // The plane is as wide as the cone ever gets, so the two widths become
  // fractions of it: a narrow sliver where it leaves the lamp, opening to the
  // full half-width at the far end, where the falloff takes it to nothing right
  // at the edge.
  const { startWidth, endWidth, fade } = HEADLIGHT.beam;
  const near = Math.max(0.01, startWidth / 2 / endWidth);
  const far = 0.5;

  /**
   * How quickly it reaches full brightness, as a fraction of the length.
   *
   * Small on purpose: the light has to be there *at* the bumper, not a metre
   * ahead of it. It is not zero only because an instant start would put a hard
   * straight edge across the head of the cone. What stops that reading as an
   * edge anyway is `near` — a cone that leaves the car the width of its lamp has
   * nothing wide enough there to show a seam.
   */
  const peak = 0.03;

  for (let y = 0; y < size; y++) {
    /**
     * 0 at the bumper, 1 at the far end — and the flip is load-bearing.
     *
     * DynamicTexture defaults to invertY, so canvas row 0 arrives at V = 1;
     * CreatePlane puts V = 1 at local +Y; and the quarter turn that lays the
     * plane on the road sends local +Y to +Z, which is the *far* end. Writing
     * this the obvious way round therefore builds the cone backwards — wide and
     * dim against the car, narrow and bright out in the distance.
     */
    const t = 1 - y / (size - 1);

    // Smoothstepped on the way up: a straight ramp meeting a curved decay leaves
    // a kink at the peak, and on a gradient this wide the kink shows as a band.
    const rise = Math.min(1, t / peak);
    const along =
      t < peak
        ? rise * rise * (3 - 2 * rise)
        : Math.pow(Math.max(0, 1 - (t - peak) / (fade - peak)), 1.9);

    const half = near + (far - near) * t;

    for (let x = 0; x < size; x++) {
      const u = (x / (size - 1) - 0.5) / half;
      // Squared rather than cubed: cubing pinches the cone in so far that the
      // fan barely shows, which defeats the point of opening it out.
      const across = Math.max(0, 1 - u * u);
      const alpha = along * across * across;

      const i = (y * size + x) * 4;
      data[i] = red;
      data[i + 1] = green;
      data[i + 2] = blue;
      data[i + 3] = byte(alpha);
    }
  }

  ctx.putImageData(image, 0, 0);
  texture.update();
  texture.hasAlpha = true;
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  return texture;
}

/** A lamp seen head on: a small core inside a wide, very soft halo. */
function bulb(scene: Scene, name: string, colour: Color3, brightness: number): DynamicTexture {
  return radialTexture(
    scene,
    name,
    [
      [0, 1],
      [0.2, 0.55],
      [0.45, 0.16],
      [0.72, 0.04],
      [1, 0],
    ],
    colour,
    brightness,
  );
}

/**
 * Where a car's lamps belong, in its rig's own space.
 *
 * Read from marker nodes in the model first: a `forntLamp` and a `backLamp`
 * (that spelling is the model's, not a slip), each with a `left` and a `right`
 * child. A lamp goes at each of the four, exactly where the marker sits — the
 * models are different shapes, and a position measured off the bumper is only
 * ever right for some of them. Nothing is added to a marker's position.
 *
 * Markers are read from the *template* rather than the clone, so it makes no
 * difference whether Babylon carries empty nodes across when a mesh is cloned.
 * `offset` is the shift the clone's body was given to centre its footprint on
 * the rig; adding it is not a fudge but the same move the bodywork made, and
 * without it the lamps would sit where the car used to be parked in the city.
 *
 * 8 of the 20 models carry markers. The rest fall back to the bounding box, so
 * the two coexist: export a car with markers and it starts using them, with
 * nothing else to change. The fallback takes its height from the car's own roof
 * rather than a number in the config — a van and a hatchback do not carry their
 * lamps at the same height, and one figure for both is wrong for at least one.
 *
 * Left comes first in both cases. The marked models put `left` on +x of the rig,
 * so the fallback does the same: the idle puffs rely on index 0 being the left
 * side whichever kind of car it is.
 */
export function lampMounts(
  template: Mesh,
  offset: Vector3,
  length: number,
  width: number,
  height: number,
): LampMounts {
  const { mounts, lamp } = HEADLIGHT;
  const toLocal = Matrix.Invert(template.getWorldMatrix());

  const pair = (group: string): Vector3[] => {
    const node = template.getDescendants(false, (child) => child.name === group)[0];
    if (!node) return [];

    return [mounts.left, mounts.right]
      .map((side) => node.getDescendants(false, (child) => child.name === side)[0])
      .filter((side): side is TransformNode => !!side)
      .map((side) => {
        side.computeWorldMatrix(true);
        // Into the template's space, then into the rig's by the same shift the
        // body was given.
        return Vector3.TransformCoordinates(side.getAbsolutePosition(), toLocal).addInPlace(offset);
      });
  };

  const nose = length / 2;
  const side = (width / 2) * lamp.apart;
  const front = pair(mounts.front);
  const back = pair(mounts.back);

  return {
    front: front.length > 0 ? front : [
      new Vector3(side, height * FALLBACK_FRONT, nose),
      new Vector3(-side, height * FALLBACK_FRONT, nose),
    ],
    back: back.length > 0 ? back : [
      new Vector3(side, height * FALLBACK_BACK, -nose),
      new Vector3(-side, height * FALLBACK_BACK, -nose),
    ],
  };
}

/**
 * Where the lamps go on a car with no markers, as a fraction of its own height.
 *
 * Both figures are the average of the eight models that *are* marked: their
 * headlamps sit at 0.42 of the roof and their rear lamps a little higher, at
 * 0.53. An unmarked car therefore lands where a marked car of its shape would.
 */
const FALLBACK_FRONT = 0.42;
const FALLBACK_BACK = 0.53;
