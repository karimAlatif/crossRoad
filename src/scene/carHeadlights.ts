import {
  Color3,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  Texture,
  type AbstractMesh,
  type Scene,
  type TransformNode,
} from "@babylonjs/core";
import { HEADLIGHT } from "./config";

export type Headlights = {
  /** Hangs a set of lights on one car. */
  attach: (root: TransformNode, carLength: number, carWidth: number) => void;
  dispose: () => void;
};

/** Holds the first mesh of its kind; everything after it is an instance. */
type Source = { mesh: Mesh | null };

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
 * lamps at the bumper and a pair at the tail — and every car after the first
 * instances those same three meshes. Hardware instancing then draws the whole
 * fleet in three calls whether that is ten cars or a hundred.
 *
 * The cones hang off the car's lane node so they stay flat on the road: light
 * lying on tarmac should not pitch up with the nose when the car dives, or it
 * cuts through it. The lamps sit at lamp height and turn to face the camera,
 * which is what keeps them reading as lights *on* the car rather than as glows
 * pooled underneath it.
 */
export function createHeadlights(scene: Scene): Headlights | null {
  if (!HEADLIGHT.enabled) return null;

  const { beam, lamp, tail } = HEADLIGHT;

  // Colour is baked into each texture rather than set on the material. See the
  // note on `additive` below — StandardMaterial adds its emissive texture to
  // `emissiveColor` instead of multiplying, so a white texture would force the
  // result to white no matter what colour the material asked for.
  const cone = beamTexture(scene, HEADLIGHT.frontColour, beam.brightness);
  const frontBulb = bulbTexture(scene, "headlight.lampTex", HEADLIGHT.frontColour, lamp.brightness);
  const tailBulb = bulbTexture(scene, "headlight.tailTex", HEADLIGHT.tailColour, tail.brightness);

  const beamMaterial = additive(scene, "headlight.beamMat", cone);
  const lampMaterial = additive(scene, "headlight.lampMat", frontBulb);
  const tailMaterial = additive(scene, "headlight.tailMat", tailBulb);

  const beamSource: Source = { mesh: null };
  const lampSource: Source = { mesh: null };
  const tailSource: Source = { mesh: null };
  const parts: AbstractMesh[] = [];

  const place = (
    source: Source,
    name: string,
    material: StandardMaterial,
    width: number,
    height: number,
    parent: TransformNode,
    x: number,
    y: number,
    z: number,
    /** Flat lies on the road; upright turns to face the camera. */
    flat: boolean,
  ) => {
    let mesh: AbstractMesh;
    if (source.mesh) {
      mesh = source.mesh.createInstance(name);
    } else {
      const created = MeshBuilder.CreatePlane(name, { width, height }, scene);
      created.material = material;
      created.isPickable = false;
      created.receiveShadows = false;
      // A glow is not dimmed by haze the way a surface is, and letting the fog
      // eat these defeats the point of lighting the road at all.
      created.applyFog = false;
      created.doNotSyncBoundingInfo = true;
      source.mesh = created;
      mesh = created;
    }

    mesh.parent = parent;
    mesh.position.set(x, y, z);
    // Both faces draw, so which way the normal ended up pointing does not matter.
    if (flat) mesh.rotation.set(Math.PI / 2, 0, 0);
    else mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
    parts.push(mesh);
  };

  const attach = (root: TransformNode, carLength: number, carWidth: number) => {
    const nose = carLength / 2;
    const side = (carWidth / 2) * lamp.apart;

    for (const dx of [-side, side]) {
      // One cone per lamp rather than one down the middle. Where the pair
      // overlaps ahead of the car they sum, which is what a real pair does.
      place(
        beamSource,
        "headlight.beam",
        beamMaterial,
        beam.endWidth,
        beam.length,
        root,
        dx,
        ROAD_CLEARANCE,
        nose + beam.length / 2,
        true,
      );

      // Clear of the bodywork and at lamp height, so the glow sits on the car
      // rather than spilling out from under it.
      place(lampSource, "headlight.lamp", lampMaterial, lamp.size, lamp.size, root, dx, lamp.height, nose + 0.15, false);
      place(tailSource, "headlight.tail", tailMaterial, tail.size, tail.size, root, dx, tail.height, -nose - 0.15, false);
    }
  };

  return {
    attach,
    dispose: () => {
      for (const part of parts) part.dispose();
      beamMaterial.dispose();
      lampMaterial.dispose();
      tailMaterial.dispose();
      cone.dispose();
      frontBulb.dispose();
      tailBulb.dispose();
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

  const red = channel(colour.r, brightness);
  const green = channel(colour.g, brightness);
  const blue = channel(colour.b, brightness);

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
      data[i + 3] = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
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
function bulbTexture(
  scene: Scene,
  name: string,
  colour: Color3,
  brightness: number,
): DynamicTexture {
  const size = 64;
  const texture = new DynamicTexture(name, size, scene, true);
  const ctx = texture.getContext() as CanvasRenderingContext2D;
  const rgb = `${channel(colour.r, brightness)},${channel(colour.g, brightness)},${channel(colour.b, brightness)}`;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, `rgba(${rgb},1)`);
  gradient.addColorStop(0.2, `rgba(${rgb},0.55)`);
  gradient.addColorStop(0.45, `rgba(${rgb},0.16)`);
  gradient.addColorStop(0.72, `rgba(${rgb},0.04)`);
  gradient.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  texture.update();
  texture.hasAlpha = true;
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  return texture;
}

/** One colour channel, baked at its brightness and clamped to what the shader
 *  can carry. */
export function channel(value: number, brightness: number): number {
  return Math.round(Math.max(0, Math.min(1, value * brightness)) * 255);
}

/**
 * Additive, depth-write off, unlit, and — the part that matters — carrying no
 * emissive colour of its own.
 *
 * StandardMaterial *adds* its emissive texture to `emissiveColor` rather than
 * multiplying by it, and then clamps the sum to 1:
 *
 *   emissiveColor = vEmissiveColor + texture.rgb;   // default.fragment
 *   finalDiffuse  = clamp(... + emissiveColor ..., 0.0, 1.0)
 *
 * So a white texture pins every channel at 1 and the light comes out pure white
 * however warm a colour the material was given — which is why raising the
 * saturation on the material had no effect at all. The colour has to live in the
 * texture's RGB instead, leaving `emissiveColor` black.
 */
export function additive(scene: Scene, name: string, texture: Texture): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();
  material.emissiveColor = Color3.Black();
  material.disableLighting = true;
  material.emissiveTexture = texture;
  material.opacityTexture = texture;
  material.alphaMode = 1; // additive: src.rgb * src.a + dst
  material.backFaceCulling = false;
  material.disableDepthWrite = true;
  material.freeze();
  return material;
}
