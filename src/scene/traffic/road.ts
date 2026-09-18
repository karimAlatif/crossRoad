import { Vector3 } from "@babylonjs/core";
import { LIGHT, PROPS, ROAD_ONE, ROAD_TWO, TRAFFIC } from "../config";
import { between, mid } from "../core/maths";
import type { Range } from "../core/types";
import type { RoadSpec } from "../world/props";
import type { CarRig } from "./carFactory";
import { createFlow, enter, rowPool, type Flow } from "./flow";

/**
 * The road as the simulation sees it: what a lane is, what a car on it knows,
 * and the rules that decide when the next one is let on.
 *
 * Everything here is either a plain shape or a pure function of one. The driving
 * itself — who brakes for whom, what happens on impact — lives in `traffic.ts`,
 * which owns the per-frame state. Keeping the two apart means the fiddly part
 * of this road, the wave and gate arithmetic, can be read on its own.
 */

/**
 * A lane's driving rules, flattened from ROAD_ONE or ROAD_TWO so the update loop
 * reads one shape instead of branching on which road it is on.
 */
export type Rules = {
  /** True for roodOne: holds its speed, yields to nothing, queues for nothing. */
  free: boolean;
  /**
   * Cruise speed. On a free row this is only the range a joining car draws from
   * — `flow.ts` has the last word, because it also has to keep the car off the
   * back of the one in front.
   */
  speed: Range;
  /** Bumper gap a joining car leaves. Queued rows only; free rows work in time. */
  spawnGap: number;
  /** Everything below is the following model, and is unused on a free lane. */
  minGap: number;
  accel: number;
  brake: number;
  comfort: number;
};

export type Crash = { t: number; spin: number; y: number; vy: number };

export type Car = {
  rig: CarRig;
  lane: Lane;
  /** Distance travelled along the lane, from `start` towards `end`. */
  s: number;
  v: number;
  cruise: number;
  /** Accumulated wheel rotation. */
  roll: number;
  /** How far the car has settled into the idle shudder, 0 to 1. */
  settle: number;
  /** Latches the one-shot brake dive so it fires once per stop, not per frame. */
  braking: boolean;
  /** Extra heading picked up by spinning out. */
  yaw: number;
  crash: Crash | null;
  /** Reused collision footprint, so a frame allocates nothing. */
  box: Box;
};

export type Box = { x: number; z: number; fx: number; fz: number; hf: number; hr: number };

export type Lane = {
  name: string;
  originX: number;
  originZ: number;
  dirX: number;
  dirZ: number;
  yaw: number;
  length: number;
  /** Distance along the lane of the stop line, or null if the light never stops it. */
  stopS: number | null;
  /**
   * Distance along the lane of the junction itself — where the other road
   * crosses this one. `stopS` is where the light holds a car; this is where a
   * car is *in the way*, which is what the cross traffic has to reason about.
   */
  crossS: number | null;
  rules: Rules;
  /** The row's own rhythm, on the free road. Null on the road that queues. */
  flow: Flow | null;
  /**
   * The earliest this row may admit its next car, on the road that queues.
   *
   * A time, not a distance, and that is the point: a distance check can only
   * measure against a car that is still on the road, so once a row emptied it
   * would admit the next car instantly. The free road keeps the same idea in
   * `flow.openAt`.
   */
  gateFreeAt: number;
  /** True while the signal is holding this row short of the junction. */
  gated: boolean;
  /** How many cars this row runs. */
  poolSize: number;
  /** Ordered from the car furthest along the lane to the one furthest back. */
  cars: Car[];
  /** Cars off the road, hidden, waiting their turn at the entry gate. */
  waiting: Car[];
};


export function rulesFor(road: RoadSpec): Rules {
  if (road.name === PROPS.roadTwo) {
    return {
      free: false,
      speed: ROAD_TWO.speed,
      spawnGap: ROAD_TWO.spawnGap,
      minGap: ROAD_TWO.minGap,
      accel: ROAD_TWO.accel,
      brake: ROAD_TWO.brake,
      comfort: ROAD_TWO.comfort,
    };
  }
  return {
    free: true,
    speed: ROAD_ONE.speed,
    spawnGap: 0,
    minGap: 0,
    accel: 0,
    brake: 0,
    comfort: 0,
  };
}

/**
 * Where a car enters its row: just short of the road's start marker.
 *
 * A fixed point, not a gap measured backwards from the last car — laying each
 * new car out behind the previous one used to push the tail of a busy road
 * hundreds of metres off the back of it. What keeps cars apart is the gate: time
 * on the free road, distance on the road that queues.
 */
export function entryPoint(lane: Lane, rig: CarRig): number {
  const back = lane.rules.free ? ENTRY_MARGIN : lane.rules.spawnGap;
  return -(back + rig.length / 2);
}

/**
 * Lets one waiting car onto the road if its row will have it.
 *
 * The two roads decide that differently — the free road in time, from its own
 * rhythm (`flow.ts`), and the queueing road in distance, from the car already
 * there — so each returns the speed the car should take, or null to wait.
 */
export function admit(lane: Lane, now: number): void {
  const car = lane.waiting[0];
  if (!car) return;

  const tail = lane.cars[lane.cars.length - 1] ?? null;
  const speed = lane.rules.free ? enter(lane, car, tail, now) : queue(lane, car, tail, now);
  if (speed === null) return;

  lane.waiting.shift();
  car.s = entryPoint(lane, car.rig);
  car.cruise = speed;
  car.v = speed;
  car.yaw = 0;
  car.settle = 0;
  car.braking = false;
  car.crash = null;
  car.rig.crash.position.setAll(0);
  car.rig.crash.rotation.setAll(0);
  car.rig.crash.scaling.setAll(1);
  car.rig.root.setEnabled(true);
  lane.cars.push(car);
}

/**
 * The queueing road's gate: one car length plus its spawn gap behind whatever is
 * already there, and never faster than the road's own speed.
 *
 * The clock and the ruler are both needed. The clock keeps the spacing when the
 * row is empty, where there is nothing to measure against; the ruler covers what
 * the clock cannot, which is traffic that stopped after it entered — a queue
 * backs up to the gate, and only a real distance check stops the next car being
 * dropped on top of it.
 */
function queue(lane: Lane, car: Car, tail: Car | null, now: number): number | null {
  if (now < lane.gateFreeAt) return null;

  const s = entryPoint(lane, car.rig);
  if (tail && tail.s - tail.rig.length / 2 - (s + car.rig.length / 2) < lane.rules.spawnGap) {
    return null;
  }

  const speed = between(lane.rules.speed);
  lane.gateFreeAt = now + (lane.rules.spawnGap + car.rig.length) / Math.max(speed, 0.1);
  return speed;
}

/**
 * How many cars one row runs.
 *
 * Enough to fill the row at its busiest: bumper to bumper at the tightest
 * headway the difficulty dial allows, on the free road, or nose to tail at
 * `spawnGap` on the one that queues. The gate decides how many are actually out
 * there at any moment, so this only has to be an upper bound — cars over it sit
 * hidden and cost nothing, which makes erring high free and erring low a silent
 * cap on the settings.
 */
export function poolSize(rules: Rules, length: number): number {
  if (rules.free) return Math.max(3, rowPool(length));
  return Math.max(3, Math.ceil(length / (rules.spawnGap + APPROX_CAR_LENGTH)) + 1);
}

export function createLane(road: RoadSpec, side: 1 | -1, crossing: RoadSpec | null): Lane {
  const delta = road.end.subtract(road.start);
  delta.y = 0;
  const length = delta.length();
  const dir = delta.scale(1 / length);

  // Rotate the direction 90 degrees in the ground plane to step off the centre line.
  const perp = new Vector3(dir.z, 0, -dir.x);
  const origin = road.start.add(perp.scale(side * TRAFFIC.laneOffset));
  const rules = rulesFor(road);
  const stopS = road.cross ? Vector3.Dot(road.cross.subtract(road.start), dir) : null;
  const crossS = crossing ? meets(road.start, dir, crossing) : stopS;

  return {
    name: `${road.name}${side > 0 ? "A" : "B"}`,
    originX: origin.x,
    originZ: origin.z,
    dirX: dir.x,
    dirZ: dir.z,
    // A Y rotation of atan2(x, z) is exactly what points a model's +Z along dir,
    // and every car model faces +Z: its front wheels sit at positive z.
    yaw: Math.atan2(dir.x, dir.z),
    length,
    stopS,
    crossS,
    rules,
    flow: rules.free ? createFlow() : null,
    gateFreeAt: 0,
    gated: stopS !== null && !LIGHT.startsGreen,
    poolSize: poolSize(rules, length),
    cars: [],
    waiting: [],
  };
}

/**
 * How far along this lane the other road crosses it.
 *
 * Two straight centre lines in the ground plane, solved for where they meet.
 * Without this the cross traffic has no idea where the junction is, and "how
 * long until the junction is blocked" — which is the whole game — cannot be
 * asked. Null if the two are parallel, which would mean they never cross at all.
 */
function meets(start: Vector3, dir: Vector3, other: RoadSpec): number | null {
  const across = other.end.subtract(other.start);
  const denominator = dir.x * across.z - dir.z * across.x;
  if (Math.abs(denominator) < 1e-6) return null;
  const dx = other.start.x - start.x;
  const dz = other.start.z - start.z;
  return (dx * across.z - dz * across.x) / denominator;
}

/** Builds one car for a row's pool. It starts off the road, hidden. */
export function makeCar(lane: Lane, rig: CarRig): Car {
  rig.root.setEnabled(false);
  return {
    rig,
    lane,
    s: entryPoint(lane, rig),
    v: 0,
    cruise: mid(lane.rules.speed),
    roll: Math.random() * Math.PI * 2,
    settle: 0,
    braking: false,
    yaw: 0,
    crash: null,
    box: { x: 0, z: 0, fx: 0, fz: 0, hf: 0, hr: 0 },
  };
}

/**
 * The fastest a car may travel and still pull up in `distance`, braking at the
 * comfortable fraction of its maximum. Falls out of v² = 2·a·d.
 *
 * A flat "speed = distance × gain" cannot be made safe at every speed: raise the
 * cruise and cars start braking too late to stop, which is how the queue used to
 * roll through a red light and into the cross traffic.
 */
export function approach(distance: number, rules: Rules): number {
  return Math.sqrt(2 * rules.brake * rules.comfort * Math.max(0, distance));
}

/** At or below this a car counts as standing still: it shudders, and the next
 *  time it moves it plays the pull-away lift. */
export const STOPPED = 0.35;

/** Rough car length, used only to size a lane's car pool before any exist. */
const APPROX_CAR_LENGTH = 5;

/** How far behind the start marker a car on the free road appears. */
const ENTRY_MARGIN = 1.5;
