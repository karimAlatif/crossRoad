import { Vector3, type AbstractMesh, type Scene } from "@babylonjs/core";
import { STREET_LAMP } from "../config";
import type { Clock } from "../core/frame";
import type { Disposable } from "../core/types";
import { plane, planeSource, radialTexture, unlit } from "../core/visuals";
import { createFlicker } from "../effects/flicker";

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
export function createStreetLamps(scene: Scene, clock: Clock): Disposable | null {
  if (!STREET_LAMP.enabled) return null;

  // Every lamp post in the .glb carries a child node named `spot`, sitting at the
  // end of its arm where the lamp actually hangs. Reading those beats measuring
  // the post's bounding box: the box's centre is halfway along the arm, which is
  // out over the road rather than under the light.
  const spots = scene.transformNodes.filter((node) => node.name === STREET_LAMP.marker);
  if (spots.length === 0) return null;

  const { bulb, pool, colour } = STREET_LAMP;
  const bulbGlow = radialTexture(scene, "lamp.bulbTex", GLOW, colour, bulb.brightness, 128);
  const poolGlow = radialTexture(scene, "lamp.poolTex", GLOW, colour, pool.brightness, 128);
  const bulbMaterial = unlit(scene, "lamp.bulbMat", { texture: bulbGlow, glow: true });
  const poolMaterial = unlit(scene, "lamp.poolMat", { texture: poolGlow, glow: true });

  const bulbSource = planeSource();
  const poolSource = planeSource();
  const parts: AbstractMesh[] = [];
  const faults = createFlicker(clock, STREET_LAMP.flicker);

  const place = (
    source: ReturnType<typeof planeSource>,
    name: string,
    material: ReturnType<typeof unlit>,
    size: number,
    at: Vector3,
  ): AbstractMesh => {
    const mesh = plane(scene, source, name, material, size, size);
    mesh.position.copyFrom(at);
    // Both the bulb and its pool lie flat, facing up.
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
    // Freezing the world matrix is what makes these free to draw, and a stutter
    // is untouched by it: a disabled mesh is skipped before its matrix is read.
    if (Math.random() < STREET_LAMP.flicker.lamps) faults.add([head, below]);
  }

  return {
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

/** A hot centre falling away to nothing: the shape of every lamp in the city. */
const GLOW = [
  [0, 1],
  [0.22, 0.55],
  [0.55, 0.15],
  [1, 0],
] as [number, number][];
