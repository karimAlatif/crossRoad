import { Vector3 } from "@babylonjs/core";
import { LIGHT, PROPS, ROAD_ONE, ROAD_TWO, TRAFFIC } from "../config";
import { between, mid } from "../core/maths";
import type { Range } from "../core/types";
import type { RoadSpec } from "../world/props";
import type { CarRig } from "./carFactory";

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
  speed: Range;
  /** A range even on roads without waves, where both ends are the same value. */
  spawnGap: Range;
  /** Cars per wave. Free lanes only; null means every car joins on its own. */
  carsPerWave: Range | null;
  /** Seconds of empty road left between waves. Free lanes only. */
  breakTime: Range | null;
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

/**
 * Wave state shared by every row of one road.
 *
 * It lives on the road rather than the row for two reasons. `carsPerWave` counts
 * cars across the whole road, not per row — a wave of four is four cars spread
 * over both rows, not four in each. And the break that ends a wave has to open
 * on both rows at once, or there is never a moment when the whole road is clear
 * and the player has nothing to cross into.
 */
export type Wave = {
  /** Cars still owed to the wave being laid down, counted across the road. */
  left: number;
  /** Cruise speed shared by every car in the current wave. */
  speed: number;
  /** Bumper gap shared by every car in the current wave. */
  spawnGap: number;
  /** The road's rows, so the break holds all of them at once. */
  lanes: Lane[];
};

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
  rules: Rules;
  wave: Wave;
  /**
   * The earliest this row may admit its next car.
   *
   * A time, not a distance, and that is the point: the distance check below can
   * only measure against a car that is still on the road, so once a row emptied
   * it admitted the next car instantly and the break between waves vanished
   * outright. This carries the break across an empty road.
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
      // No waves here, so the gap never varies: a range with one value in it.
      spawnGap: { min: ROAD_TWO.spawnGap, max: ROAD_TWO.spawnGap },
      carsPerWave: null,
      breakTime: null,
      minGap: ROAD_TWO.minGap,
      accel: ROAD_TWO.accel,
      brake: ROAD_TWO.brake,
      comfort: ROAD_TWO.comfort,
    };
  }
  return {
    free: true,
    speed: ROAD_ONE.speed,
    spawnGap: ROAD_ONE.spawnGap,
    carsPerWave: ROAD_ONE.carsPerWave,
    breakTime: ROAD_ONE.breakTime,
    minGap: 0,
    accel: 0,
    brake: 0,
    comfort: 0,
  };
}

/**
 * Where the next car joins the back of a lane, and how fast it travels.
 *
 * On roodOne this is the whole gap mechanism. Cars arrive in waves: the first of
 * a wave is held back by `breakTime` — the seconds of empty road the player gets
 * to cross in — and picks a fresh speed, and the rest of the wave follows it
 * nose to tail at `spawnGap` sharing that same speed.
 *
 * Sharing it is not cosmetic. This road has no following model, so two cars in
 * one wave at different speeds would close on each other and eventually collide.
 */
/**
 * Where a car enters its row: nose on the `spawnGap` offset, just short of the
 * road's start marker.
 *
 * This is a fixed point, not a gap measured backwards from the last car. That
 * distinction is the whole reason the gate exists — laying a wave out behind the
 * previous one used to push the tail of a busy road hundreds of metres off the
 * back of it.
 */
export function entryPoint(lane: Lane, rig: CarRig): number {
  // Deliberately the widest gap the config allows, not the current wave's. The
  // entry is a fixed place on the road — the guarantee is that nothing is ever
  // created further back than this — while the wave's own gap decides only how
  // long a car waits before it appears there.
  return -(lane.rules.spawnGap.max + rig.length / 2);
}

/**
 * Lets one waiting car onto the road if the gate is open.
 *
 * Two things hold it shut: the break between waves, which is timed and shared by
 * every row of the road, and the car already on the road, which has to be clear
 * of the entry by `spawnGap` before anything follows it through.
 */
export function admit(lane: Lane, now: number): void {
  const car = lane.waiting[0];
  if (!car) return;

  // Two gates, and both are needed.
  //
  // The clock carries the break between waves, and keeps working when the row is
  // empty — which a gap measured off the last car cannot do, because once that
  // car has gone there is nothing left to measure against.
  if (now < lane.gateFreeAt) return;

  const rules = lane.rules;
  const wave = lane.wave;
  const s = entryPoint(lane, car.rig);

  // The ruler covers what the clock cannot: traffic that slowed or stopped after
  // it entered. On roodTwo a queue backs up to the gate, and only a real distance
  // check stops the next car being dropped on top of it.
  const tail = lane.cars[lane.cars.length - 1];
  if (tail && tail.s - tail.rig.length / 2 - (s + car.rig.length / 2) < wave.spawnGap) {
    return;
  }

  lane.waiting.shift();
  car.s = s;
  car.cruise = rules.carsPerWave ? wave.speed : between(rules.speed);
  car.v = car.cruise;
  car.yaw = 0;
  car.settle = 0;
  car.braking = false;
  car.crash = null;
  car.rig.crash.position.setAll(0);
  car.rig.crash.rotation.setAll(0);
  car.rig.crash.scaling.setAll(1);
  car.rig.root.setEnabled(true);
  lane.cars.push(car);

  // Hold the gate for exactly as long as this car needs to clear it: the time to
  // travel its own length plus the wave's gap. That makes the in-wave headway
  // `(spawnGap + length) / speed`, and the break adds to it in plain seconds.
  lane.gateFreeAt = now + (wave.spawnGap + car.rig.length) / Math.max(car.cruise, 0.1);

  if (!rules.carsPerWave) return;

  // One counter for the whole road, so `carsPerWave` is a count across both rows
  // rather than per row.
  wave.left--;
  if (wave.left <= 0) startWave(wave, rules, now);
}

/**
 * Begins the next wave: its size, and the speed and spacing every car in it will
 * share. `now` is omitted for the very first wave, which opens with no break.
 */
export function startWave(wave: Wave, rules: Rules, now?: number): void {
  if (!rules.carsPerWave) {
    wave.spawnGap = rules.spawnGap.min;
    return;
  }

  wave.left = Math.max(1, Math.round(between(rules.carsPerWave)));
  wave.speed = between(rules.speed);
  wave.spawnGap = between(rules.spawnGap);
  if (now === undefined || !rules.breakTime) return;

  // Hold every row, so the gap opens right across the road at once. Measured from
  // whenever each row's gate was next going to open, so the break is added to the
  // normal spacing rather than overlapping it.
  const pause = between(rules.breakTime);
  for (const row of wave.lanes) row.gateFreeAt = Math.max(now, row.gateFreeAt) + pause;
}

/**
 * How many cars one row runs.
 *
 * Two things set the floor. Density is the obvious one: enough to fill the row
 * nose to tail at `spawnGap`. The second is easy to miss and was what broke the
 * waves — a row must also be able to hold its share of the *largest* wave. With
 * a wide `spawnGap` the density term alone came out at three cars a row, so a
 * wave of eight simply had no cars to be made of.
 *
 * The gate decides how many are actually on the road at any moment, so this only
 * has to be an upper bound. Cars over it sit hidden and cost nothing, which makes
 * erring high free and erring low a silent cap on the wave settings.
 */
export function poolSize(rules: Rules, length: number): number {
  // The tightest gap the config allows is what sets the most cars a row can hold.
  const density = Math.ceil(length / (rules.spawnGap.min + APPROX_CAR_LENGTH)) + 1;
  const share = rules.carsPerWave ? Math.ceil(rules.carsPerWave.max / ROWS_PER_ROAD) + 1 : 0;
  return Math.max(3, density, share);
}

/** Both roads run two rows, one either side of their centre line. */
const ROWS_PER_ROAD = 2;

export function createLane(road: RoadSpec, side: 1 | -1, wave: Wave): Lane {
  const delta = road.end.subtract(road.start);
  delta.y = 0;
  const length = delta.length();
  const dir = delta.scale(1 / length);

  // Rotate the direction 90 degrees in the ground plane to step off the centre line.
  const perp = new Vector3(dir.z, 0, -dir.x);
  const origin = road.start.add(perp.scale(side * TRAFFIC.laneOffset));
  const rules = rulesFor(road);
  const stopS = road.cross ? Vector3.Dot(road.cross.subtract(road.start), dir) : null;

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
    rules,
    wave,
    gateFreeAt: 0,
    gated: stopS !== null && !LIGHT.startsGreen,
    poolSize: poolSize(rules, length),
    cars: [],
    waiting: [],
  };
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
