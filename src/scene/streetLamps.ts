import {
  Color3,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  Texture,
  Vector3,
  type AbstractMesh,
  type Scene,
} from "@babylonjs/core";
import { STREET_LAMP } from "./config";
import { additive, channel } from "./carHeadlights";
import { createFlicker } from "./flicker";

export type StreetLamps = { count: number; dispose: () => void } | null;

/**
 * Lights the city's own lamp posts, on the same terms as the car headlights: no
 * real lights, just additive geometry instanced off one source mesh each.
 *
 * As Babylon lights they would be unthinkable — every material in the city
 * recompiled and re-shaded for all of them. As two instanced planes apiece, a
 * bulb and a pool on the pavement below, they cost two draw calls for the whole
 * set and nothing at all in shader complexity.
 *
 * A few of them are on their way out and stutter, on the same terms as the cars'
 * headlamps. A lamp's bulb and its pool always go dark together — a circle of
 * light on the pavement under a dead bulb would look like a mistake.
 */
export function createStreetLamps(scene: Scene): StreetLamps {
  if (!STREET_LAMP.enabled) return null;

  // Every lamp post in the .glb carries a child node named `spot`, sitting at the
  // end of its arm where the lamp actually hangs. Reading those beats measuring
  // the post's bounding box: the box's centre is halfway along the arm, which is
  // out over the road rather than under the light.
  const spots = scene.transformNodes.filter((node) => node.name === STREET_LAMP.marker);
  if (spots.length === 0) return null;

  const { bulb, pool } = STREET_LAMP;
  const bulbGlow = softDot(scene, "lamp.bulbTex", STREET_LAMP.colour, bulb.brightness);
  const poolGlow = softDot(scene, "lamp.poolTex", STREET_LAMP.colour, pool.brightness);
  const bulbMaterial = additive(scene, "lamp.bulbMat", bulbGlow);
  const poolMaterial = additive(scene, "lamp.poolMat", poolGlow);

  const bulbSource: Source = { mesh: null };
  const poolSource: Source = { mesh: null };
  const parts: AbstractMesh[] = [];
  const faults = createFlicker(scene, STREET_LAMP.flicker);

  const place = (
    source: Source,
    name: string,
    material: StandardMaterial,
    size: number,
    at: Vector3,
  ): AbstractMesh => {
    let mesh: AbstractMesh;
    if (source.mesh) {
      mesh = source.mesh.createInstance(name);
    } else {
      const created = MeshBuilder.CreatePlane(name, { size }, scene);
      created.material = material;
      created.isPickable = false;
      created.receiveShadows = false;
      created.applyFog = false;
      created.doNotSyncBoundingInfo = true;
      source.mesh = created;
      mesh = created;
    }
    mesh.position.copyFrom(at);
    // Both the bulb and its pool lie flat, facing up. The bulb was billboarded
    // before, which is meaningless next to the frozen matrix below — a frozen
    // world matrix is never recomputed, so it would have held whatever the
    // camera happened to be doing at load and then stopped tracking it.
    mesh.rotation.set(Math.PI / 2, 0, 0);
    mesh.freezeWorldMatrix();
    parts.push(mesh);
    return mesh;
  };

  for (const spot of spots) {
    spot.computeWorldMatrix(true);
    const at = spot.getAbsolutePosition();
    const head = place(bulbSource, "lamp.bulb", bulbMaterial, bulb.size, at);
    const below = place(poolSource, "lamp.pool", poolMaterial, pool.size, new Vector3(at.x, pool.height, at.z));
    // Freezing the world matrix is what makes these free to draw, and it is
    // untouched by this: a disabled mesh is skipped before its matrix is ever
    // read, so a lamp can stutter without being unfrozen.
    if (Math.random() < STREET_LAMP.flicker.lamps) faults.add([head, below]);
  }

  return {
    count: spots.length,
    dispose: () => {
      faults.dispose();
      for (const part of parts) part.dispose();
      bulbMaterial.dispose();
      poolMaterial.dispose();
      bulbGlow.dispose();
      poolGlow.dispose();
    },
  };
}

/** Holds the first mesh of its kind; everything after it is an instance. */
type Source = { mesh: Mesh | null };

function softDot(scene: Scene, name: string, colour: Color3, strength: number): DynamicTexture {
  const size = 128;
  const texture = new DynamicTexture(name, size, scene, false);
  const ctx = texture.getContext() as CanvasRenderingContext2D;
  const rgb = `${channel(colour.r, strength)},${channel(colour.g, strength)},${channel(colour.b, strength)}`;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, `rgba(${rgb},1)`);
  gradient.addColorStop(0.22, `rgba(${rgb},0.55)`);
  gradient.addColorStop(0.55, `rgba(${rgb},0.15)`);
  gradient.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  texture.update();
  texture.hasAlpha = true;
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  return texture;
}
