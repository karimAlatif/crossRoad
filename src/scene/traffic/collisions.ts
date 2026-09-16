import { TRAFFIC } from "../config";
import type { Box, Car, Lane } from "./road";

/**
 * Who has hit whom.
 *
 * Cars are rectangles on the ground, so this is a separating-axis test between
 * two rotated rectangles: the cheapest exact answer for the shape involved, and
 * exact matters here because a false positive wrecks two cars in front of the
 * player for no visible reason.
 */

/** Points a car's footprint at where it is now. */
export function footprint(car: Car, lane: Lane): Box {
  const box = car.box;
  const heading = lane.yaw + car.yaw;
  box.x = lane.originX + lane.dirX * car.s;
  box.z = lane.originZ + lane.dirZ * car.s;
  box.fx = Math.sin(heading);
  box.fz = Math.cos(heading);
  box.hf = (car.rig.length / 2) * TRAFFIC.hitboxScale;
  box.hr = (car.rig.width / 2) * TRAFFIC.hitboxScale;
  return box;
}

/** True if the two footprints are touching. `dx`/`dz` is b's centre minus a's. */
export function overlaps(
  a: { fx: number; fz: number; hf: number; hr: number },
  b: { fx: number; fz: number; hf: number; hr: number },
  dx: number,
  dz: number,
): boolean {
  // Each box contributes its forward axis and its right axis (forward turned 90 degrees).
  const axes = [
    [a.fx, a.fz],
    [a.fz, -a.fx],
    [b.fx, b.fz],
    [b.fz, -b.fx],
  ];

  for (const [nx, nz] of axes) {
    const reachA = a.hf * Math.abs(a.fx * nx + a.fz * nz) + a.hr * Math.abs(a.fz * nx - a.fx * nz);
    const reachB = b.hf * Math.abs(b.fx * nx + b.fz * nz) + b.hr * Math.abs(b.fz * nx - b.fx * nz);
    if (Math.abs(dx * nx + dz * nz) > reachA + reachB) return false;
  }
  return true;
}
