import {
  Color3,
  DynamicTexture,
  InstancedMesh,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  Texture,
  type AbstractMesh,
  type Scene,
} from "@babylonjs/core";
import { byte } from "./maths";

/**
 * How a flat, unlit surface is painted.
 *
 * Three kinds turn up in the scene and they differ by two flags:
 *
 *   glow  — light. Adds itself to whatever is behind it, so it can only ever
 *           brighten: headlight beams, lamp bulbs, light trails, signal lamps.
 *   plain — paint. Covers what is behind it: rubber on the tarmac.
 */
export type UnlitOptions = {
  /** Carries both the shape and the colour. See the note below on why. */
  texture?: Texture;
  /** A flat colour, for a surface with no texture. */
  colour?: Color3;
  /** Adds to the background instead of covering it. */
  glow?: boolean;
  /** Off by default: these are decoration, and should not occlude each other. */
  depthWrite?: boolean;
  /**
   * On by default. Turn it off for a material whose colour changes as the game
   * runs: a frozen one stops re-uploading its uniforms, so the change is never
   * seen. The signal's lamps are the only ones that do this.
   */
  frozen?: boolean;
};

/**
 * An unlit material, frozen and ready to instance.
 *
 * Note what is *not* here: a colour on the material alongside a white texture.
 * StandardMaterial adds its emissive texture to `emissiveColor` and clamps the
 * sum —
 *
 *   emissiveColor = vEmissiveColor + texture.rgb;   // default.fragment
 *   finalDiffuse  = clamp(... + emissiveColor ..., 0.0, 1.0)
 *
 * — so a white texture pins every channel at 1 and the surface comes out white
 * however warm a colour the material was given. Every generated texture in this
 * scene therefore bakes its own colour in, and the material's `emissiveColor`
 * stays black. This cost an afternoon once; it is why `byte()` takes a colour
 * channel and a strength.
 */
/**
 * Marks a mesh as receiving shadows — on its source, if it is an instance.
 *
 * An instance owns no material state, so setting `receiveShadows` on one does
 * nothing except print a warning, once per instance. Most of the city and every
 * car cloned from an instanced model arrive that way, and the flood — sixty-odd
 * lines at every start — buried everything else in the console. The source mesh
 * is the one that counts, so that is the one this sets.
 */
export function receiveShadows(mesh: AbstractMesh): void {
  if (mesh instanceof InstancedMesh) mesh.sourceMesh.receiveShadows = true;
  else mesh.receiveShadows = true;
}

export function unlit(scene: Scene, name: string, options: UnlitOptions): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();
  material.emissiveColor = options.colour ?? Color3.Black();
  material.disableLighting = true;
  material.disableDepthWrite = !options.depthWrite;
  // Decoration is drawn from both sides — a flat plane seen from behind should
  // still be there. Anything solid enough to write depth culls its back faces.
  material.backFaceCulling = options.depthWrite === true;

  if (options.texture) {
    material.opacityTexture = options.texture;
    if (options.glow) material.emissiveTexture = options.texture;
  }
  // Additive: src.rgb * src.a + dst. Commutative, so these never need sorting
  // against each other, which is what lets them all be instanced.
  if (options.glow) material.alphaMode = 1;

  if (options.frozen !== false) material.freeze();
  return material;
}

/** One stop of a radial fade: how far out, and how opaque there. */
export type Stop = [at: number, alpha: number];

/**
 * A round, soft blob — the shape behind every glow in the scene: lamp bulbs,
 * sparks, exhaust, the signal's halo.
 *
 * `colour` is baked into the pixels for the reason given on `unlit`.
 */
export function radialTexture(
  scene: Scene,
  name: string,
  stops: Stop[],
  colour: Color3 = Color3.White(),
  strength = 1,
  size = 64,
): DynamicTexture {
  const texture = new DynamicTexture(name, size, scene, true);
  const ctx = texture.getContext() as CanvasRenderingContext2D;
  const rgb = `${byte(colour.r, strength)},${byte(colour.g, strength)},${byte(colour.b, strength)}`;

  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [at, alpha] of stops) gradient.addColorStop(at, `rgba(${rgb},${alpha})`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  texture.update();
  texture.hasAlpha = true;
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  return texture;
}

/**
 * Holds the first plane of its kind. Everything after it is an instance of that
 * one, so a hundred of them are still a single draw call.
 */
export type PlaneSource = { mesh: Mesh | null };

export const planeSource = (): PlaneSource => ({ mesh: null });

/**
 * A flat plane from a source: the real mesh the first time, an instance after.
 *
 * The caller places it. Nothing here is billboarded, and that is deliberate:
 * billboarding writes the world matrix directly and cannot do it correctly
 * through a parent chain containing the glTF root's (1, 1, -1) mirror — it put
 * the car lamps under the road. A fixed rotation needs no special case and costs
 * nothing per frame.
 */
export function plane(
  scene: Scene,
  source: PlaneSource,
  name: string,
  material: StandardMaterial,
  width: number,
  height: number,
): AbstractMesh {
  if (source.mesh) {
    const instance = source.mesh.createInstance(name);
    // Only what an instance actually owns: `receiveShadows` and `applyFog`
    // belong to the source, and setting them here is ignored with a warning.
    instance.isPickable = false;
    return instance;
  }

  const mesh = MeshBuilder.CreatePlane(name, { width, height }, scene);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.receiveShadows = false;
  // A glow is not dimmed by haze the way a surface is, and letting the fog eat
  // these defeats the point of lighting the road at all.
  mesh.applyFog = false;
  mesh.doNotSyncBoundingInfo = true;
  source.mesh = mesh;
  return mesh;
}
