import {
  Observable,
  Quaternion,
  Vector3,
  type CascadedShadowGenerator,
  type Scene,
  type TransformNode,
} from "@babylonjs/core";
import { ANIM, CRASH, LIGHT, PROPS, ROAD_ONE, ROAD_TWO, TRAFFIC } from "./config";
import { createCarFactory, type CarRig } from "./carFactory";
import { createCrashEffects } from "./crashEffects";
import type { RoadSpec } from "./props";

export type CrashEvent = {
  /** Where the impact happened, in world space. */
  at: Vector3;
  lanes: [string, string];
};

export type Traffic = {
  update: (dt: number, isGreen: boolean) => void;
  onCrash: Observable<CrashEvent>;
  carCount: number;
  crashes: () => number;
  dispose: () => void;
};

type Range = { min: number; max: number };

/**
 * A lane's driving rules, flattened from ROAD_ONE or ROAD_TWO so the update loop
 * reads one shape instead of branching on which road it is on.
 */
type Rules = {
  /** True for roodOne: holds its speed, yields to nothing, queues for nothing. */
  free: boolean;
  speed: Range;
  spawnGap: number;
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

type Crash = { t: number; spin: number; y: number; vy: number };

type Car = {
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

type Box = { x: number; z: number; fx: number; fz: number; hf: number; hr: number };

/**
 * Wave state shared by every row of one road.
 *
 * It lives on the road rather than the row for two reasons. `carsPerWave` counts
 * cars across the whole road, not per row — a wave of four is four cars spread
 * over both rows, not four in each. And the break that ends a wave has to open
 * on both rows at once, or there is never a moment when the whole road is clear
 * and the player has nothing to cross into.
 */
type Wave = {
  /** Cars still owed to the wave being laid down, counted across the road. */
  left: number;
  /** Cruise speed shared by every car in the current wave. */
  speed: number;
  /** The road's rows, so the break holds all of them at once. */
  lanes: Lane[];
};

type Lane = {
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
   * Extra clearance this row waits for before its next car, on top of
   * `spawnGap` — the break between waves. Held per row rather than on the wave
   * so both rows open their gap, which is what makes the road clear right
   * across for a moment instead of one row at a time.
   */
  breakGap: number;
  /** True while the signal is holding this row short of the junction. */
  gated: boolean;
  /** How many cars this row runs. */
  poolSize: number;
  /** Ordered from the car furthest along the lane to the one furthest back. */
  cars: Car[];
  /** Cars off the road, hidden, waiting their turn at the entry gate. */
  waiting: Car[];
};

export function createTraffic(
  scene: Scene,
  space: TransformNode,
  roads: RoadSpec[],
  shadows: CascadedShadowGenerator | null,
): Traffic {
  const factory = createCarFactory(scene, space, shadows);
  const effects = createCrashEffects(scene);
  const onCrash = new Observable<CrashEvent>();

  const lanes: Lane[] = [];
  let picked = 0;
  let crashes = 0;

  for (const road of roads) {
    const wave: Wave = { left: 0, speed: 0, lanes: [] };
    const rows = ([1, -1] as const).map((side) => createLane(road, side, wave));
    wave.lanes = rows;
    // Open the first wave properly. Left at zero, the very first car admitted
    // would take the counter negative and end its own wave, so every road began
    // with a wave of exactly one car.
    startWave(wave, rows[0].rules, false);
    lanes.push(...rows);
  }

  // Every car starts off the road, hidden, queued at its row's gate. Nothing is
  // ever placed by hand: the opening state is produced by running the real rules
  // forward, so the road cannot start in a configuration its own logic would
  // never reach.
  const cars: Car[] = [];
  for (const lane of lanes) {
    for (let i = 0; i < lane.poolSize; i++) {
      const car = makeCar(lane, factory.spawn(picked++));
      lane.waiting.push(car);
      cars.push(car);
    }
  }

  /* ------------------------------------------------------------------ drive -- */

  const drive = (lane: Lane, dt: number, isGreen: boolean) => {
    const rules = lane.rules;

    for (let i = 0; i < lane.cars.length; i++) {
      const car = lane.cars[i];
      if (car.crash) {
        stepCrash(car, dt);
        continue;
      }

      if (rules.free) {
        // Holds its speed come what may: no leader to follow, no line to stop at.
        car.v = car.cruise;
      } else {
        let want = car.cruise;

        // Hold station behind whoever is ahead. A wreck reads as a stopped car,
        // so traffic piles up behind it exactly as it should.
        const leader = i > 0 ? lane.cars[i - 1] : null;
        if (leader) {
          const gap = leader.s - leader.rig.length / 2 - (car.s + car.rig.length / 2);
          want = Math.min(want, approach(gap - rules.minGap, rules));
        }

        // The light only governs cars that have not yet crossed the stop line.
        // Once a car is past it, it is committed and clears the junction.
        const nose = car.s + car.rig.length / 2;
        if (lane.stopS !== null && !isGreen && nose < lane.stopS) {
          want = Math.min(want, approach(lane.stopS - nose - 0.25, rules));
        }

        const rate = want > car.v ? rules.accel : rules.brake;
        const next = moveTowards(car.v, want, rate * dt);

        // The lift plays once, on the transition out of standstill — that is what
        // "when the car starts moving" means, and it keeps the clip off every
        // small mid-cruise adjustment.
        if (car.v <= STOPPED && next > STOPPED) car.rig.playMove();

        // Fire the dive once when a stop begins, and re-arm only after the car
        // has stopped shedding speed — otherwise it would retrigger every frame.
        const decel = dt > 0 ? (car.v - next) / dt : 0;
        if (!car.braking && decel >= ANIM.brake.trigger) {
          car.braking = true;
          car.rig.playBrake();
        } else if (car.braking && decel < ANIM.brake.trigger * 0.4) {
          car.braking = false;
        }

        car.v = next;
      }

      car.s += car.v * dt;
      car.roll += (car.v / car.rig.wheelRadius) * dt;
    }

    // Once the leader is clear of the end it becomes the new tail.
    const head = lane.cars[0];
    if (head && !head.crash && head.s - head.rig.length / 2 > lane.length) {
      retire(lane, 0);
    }
  };

  const stepCrash = (car: Car, dt: number) => {
    const crash = car.crash;
    if (!crash) return;
    crash.t += dt;
    crash.vy -= CRASH.gravity * dt;
    crash.y += crash.vy * dt;
    if (crash.y <= 0) {
      crash.y = 0;
      crash.vy = Math.abs(crash.vy) * CRASH.bounce;
      if (crash.vy < 1.1) crash.vy = 0;
    }
    car.yaw += crash.spin * dt;
    crash.spin *= 1 - Math.min(1, dt * 0.7);
    car.v = 0;
  };

  /** Takes a car off the road and puts it back in its row's queue, hidden. */
  const retire = (lane: Lane, index: number) => {
    const [car] = lane.cars.splice(index, 1);
    car.v = 0;
    car.yaw = 0;
    car.settle = 0;
    car.braking = false;
    car.crash = null;
    car.rig.setIdle(0);
    car.rig.root.setEnabled(false);
    lane.waiting.push(car);
  };

  /* ----------------------------------------------------------------- render -- */

  const spinQ = new Quaternion();

  const place = (car: Car, dt: number) => {
    const { lane, rig } = car;
    rig.root.position.set(lane.originX + lane.dirX * car.s, 0, lane.originZ + lane.dirZ * car.s);
    rig.root.rotation.y = lane.yaw;

    if (car.crash) {
      const crash = car.crash;
      const node = rig.crash;
      node.position.set(0, crash.y, 0);
      node.rotation.set(Math.sin(crash.t * 13) * 0.3, car.yaw, Math.cos(crash.t * 11) * 0.36);

      // A hard squash on impact that springs back over the first third of a second.
      const hit = Math.max(0, 1 - crash.t / 0.35);
      let sx = 1 + 0.4 * hit;
      let sy = 1 - 0.46 * hit;
      let sz = 1 + 0.24 * hit;

      if (crash.t > CRASH.holdSeconds) {
        const shrink = Math.max(0, 1 - (crash.t - CRASH.holdSeconds) / CRASH.poofSeconds);
        sx *= shrink;
        sy *= shrink;
        sz *= shrink;
      }
      node.scaling.set(sx, sy, sz);

      // A wreck does not shudder, so the clip stops costing anything.
      rig.setIdle(0);
    } else {
      const settled = car.v <= STOPPED ? 1 : 0;
      car.settle = moveTowards(car.settle, settled, dt / ANIM.blend);
      rig.setIdle(car.settle);
    }

    for (const wheel of rig.wheels) {
      wheel.node.rotationQuaternion ??= new Quaternion();
      Quaternion.RotationAxisToRef(wheel.axle, car.roll, spinQ);
      wheel.base.multiplyToRef(spinQ, wheel.node.rotationQuaternion);
    }
  };

  /* -------------------------------------------------------------- collisions -- */

  /** Rebuilt each frame from the cars actually on the road. */
  const active: Car[] = [];

  const collide = () => {
    active.length = 0;
    for (const lane of lanes) {
      for (const car of lane.cars) {
        const box = car.box;
        const heading = lane.yaw + car.yaw;
        box.x = lane.originX + lane.dirX * car.s;
        box.z = lane.originZ + lane.dirZ * car.s;
        box.fx = Math.sin(heading);
        box.fz = Math.cos(heading);
        box.hf = (car.rig.length / 2) * TRAFFIC.hitboxScale;
        box.hr = (car.rig.width / 2) * TRAFFIC.hitboxScale;
        active.push(car);
      }
    }

    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i];
        const b = active[j];
        if (a.crash && b.crash) continue;

        // Cheap reject on bounding circles before the exact test.
        const dx = b.box.x - a.box.x;
        const dz = b.box.z - a.box.z;
        const reach = a.box.hf + a.box.hr + b.box.hf + b.box.hr;
        if (dx * dx + dz * dz > reach * reach) continue;
        if (!overlaps(a.box, b.box, dx, dz)) continue;

        impact(a, b);
      }
    }
  };

  const impact = (a: Car, b: Car) => {
    a.rig.root.computeWorldMatrix(true);
    b.rig.root.computeWorldMatrix(true);
    const at = a.rig.root.getAbsolutePosition().add(b.rig.root.getAbsolutePosition()).scale(0.5);
    at.y += 0.7;

    effects.burst(at);
    startCrash(a);
    startCrash(b);
    crashes++;
    onCrash.notifyObservers({ at, lanes: [a.lane.name, b.lane.name] });
  };

  const startCrash = (car: Car) => {
    if (car.crash) return;
    car.crash = {
      t: 0,
      spin: between(CRASH.spin) * (Math.random() < 0.5 ? -1 : 1),
      y: 0,
      vy: between(CRASH.hop),
    };
    car.v = 0;
    car.braking = false;
  };

  /* ------------------------------------------------------------------- loop -- */

  let now = 0;

  const step = (dt: number, isGreen: boolean, collisions: boolean) => {
    now += dt;

    for (const lane of lanes) drive(lane, dt, isGreen);

    // Clear wrecks that have finished poofing, back to front so splicing is safe.
    for (const lane of lanes) {
      for (let i = lane.cars.length - 1; i >= 0; i--) {
        const crash = lane.cars[i].crash;
        if (crash && crash.t >= CRASH.holdSeconds + CRASH.poofSeconds) {
          effects.puff(lane.cars[i].rig.root.getAbsolutePosition());
          retire(lane, i);
        }
      }
    }

    for (const lane of lanes) {
      admit(lane);
      for (const car of lane.cars) place(car, dt);
    }

    if (collisions) collide();
  };

  // Fill the road by running the real rules forward before the first frame, with
  // collisions off so the opening state can never contain a wreck. Cheap: a few
  // hundred iterations of arithmetic over a couple of dozen cars.
  for (let i = 0; i < Math.round(WARM_UP_SECONDS * 60); i++) {
    step(1 / 60, LIGHT.startsGreen, false);
  }

  const update = (dt: number, isGreen: boolean) => step(dt, isGreen, true);

  return {
    update,
    onCrash,
    carCount: cars.length,
    crashes: () => crashes,
    dispose: () => {
      onCrash.clear();
      effects.dispose();
      for (const car of cars) car.rig.dispose();
    },
  };
}

/* --------------------------------------------------------------------------- */

function rulesFor(road: RoadSpec): Rules {
  if (road.name === PROPS.roadTwo) {
    return {
      free: false,
      speed: ROAD_TWO.speed,
      spawnGap: ROAD_TWO.spawnGap,
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
function entryPoint(lane: Lane, rig: CarRig): number {
  return -(lane.rules.spawnGap + rig.length / 2);
}

/**
 * Lets one waiting car onto the road if the gate is open.
 *
 * Two things hold it shut: the break between waves, which is timed and shared by
 * every row of the road, and the car already on the road, which has to be clear
 * of the entry by `spawnGap` before anything follows it through.
 */
function admit(lane: Lane): void {
  const car = lane.waiting[0];
  if (!car) return;

  const rules = lane.rules;
  const wave = lane.wave;
  const s = entryPoint(lane, car.rig);

  // The break is extra clearance *on top of* the normal spawn gap, not an
  // alternative to it. Expressed as a plain hold it silently vanished whenever
  // `spawnGap` was the larger of the two, which made every gap identical and the
  // waves impossible to see.
  const needed = rules.spawnGap + lane.breakGap;
  const tail = lane.cars[lane.cars.length - 1];
  if (tail && tail.s - tail.rig.length / 2 - (s + car.rig.length / 2) < needed) {
    return;
  }

  lane.waiting.shift();
  lane.breakGap = 0;
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

  if (!rules.carsPerWave) return;

  // One counter for the whole road, so `carsPerWave` is a count across both rows
  // rather than per row.
  wave.left--;
  if (wave.left <= 0) startWave(wave, rules, true);
}

/**
 * Begins the next wave: its size, the speed every car in it will share, and the
 * break that precedes it.
 */
function startWave(wave: Wave, rules: Rules, withBreak: boolean): void {
  if (!rules.carsPerWave) return;
  wave.left = Math.max(1, Math.round(between(rules.carsPerWave)));
  wave.speed = between(rules.speed);
  if (!withBreak || !rules.breakTime) return;

  // Arm every row, so the gap opens right across the road.
  const gap = between(rules.breakTime) * wave.speed;
  for (const row of wave.lanes) row.breakGap = gap;
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
function poolSize(rules: Rules, length: number): number {
  const density = Math.ceil(length / (rules.spawnGap + APPROX_CAR_LENGTH)) + 1;
  const share = rules.carsPerWave ? Math.ceil(rules.carsPerWave.max / ROWS_PER_ROAD) + 1 : 0;
  return Math.max(3, density, share);
}

/** Both roads run two rows, one either side of their centre line. */
const ROWS_PER_ROAD = 2;

function createLane(road: RoadSpec, side: 1 | -1, wave: Wave): Lane {
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
    breakGap: 0,
    gated: stopS !== null && !LIGHT.startsGreen,
    poolSize: poolSize(rules, length),
    cars: [],
    waiting: [],
  };
}

/** Builds one car for a row's pool. It starts off the road, hidden. */
function makeCar(lane: Lane, rig: CarRig): Car {
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
function approach(distance: number, rules: Rules): number {
  return Math.sqrt(2 * rules.brake * rules.comfort * Math.max(0, distance));
}

/** Separating-axis test between two ground-plane rectangles. */
function overlaps(
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

/** At or below this a car counts as standing still: it shudders, and the next
 *  time it moves it plays the pull-away lift. */
const STOPPED = 0.35;

/**
 * Simulated seconds run at construction so the road opens busy. Long enough for a
 * car to cross the longest road several times over and for the queue to settle.
 */
const WARM_UP_SECONDS = 25;

/** Rough car length, used only to size a lane's car pool before any exist. */
const APPROX_CAR_LENGTH = 5;


const mid = (range: Range) => (range.min + range.max) / 2;

const between = (range: Range) => range.min + Math.random() * (range.max - range.min);

const moveTowards = (from: number, to: number, step: number) =>
  from < to ? Math.min(to, from + step) : Math.max(to, from - step);
