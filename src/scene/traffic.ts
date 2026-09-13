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
  /** Seconds of empty road left behind each car. Free lanes only. */
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
  /** Ordered from the car furthest along the lane to the one furthest back. */
  cars: Car[];
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
    for (const side of [1, -1] as const) {
      lanes.push(buildLane(road, side, () => factory.spawn(picked++)));
    }
  }

  const cars = lanes.flatMap((lane) => lane.cars);

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
      recycle(lane, 0);
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

  const recycle = (lane: Lane, index: number) => {
    const [car] = lane.cars.splice(index, 1);
    const tail = lane.cars[lane.cars.length - 1];
    const gap = joinGap(lane.rules, car.cruise);

    car.s = tail ? tail.s - gap - (tail.rig.length + car.rig.length) / 2 : -gap;
    car.v = lane.rules.free ? car.cruise : Math.min(car.v, car.cruise);
    car.yaw = 0;
    car.braking = false;
    car.crash = null;
    car.rig.crash.position.setAll(0);
    car.rig.crash.rotation.setAll(0);
    car.rig.crash.scaling.setAll(1);
    lane.cars.push(car);
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
      const settled = car.v < 0.35 ? 1 : 0;
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

  type Box = { car: Car; x: number; z: number; fx: number; fz: number; hf: number; hr: number };
  const boxes: Box[] = cars.map((car) => ({ car, x: 0, z: 0, fx: 0, fz: 0, hf: 0, hr: 0 }));

  const collide = () => {
    for (const box of boxes) {
      const car = box.car;
      const heading = car.lane.yaw + car.yaw;
      box.x = car.lane.originX + car.lane.dirX * car.s;
      box.z = car.lane.originZ + car.lane.dirZ * car.s;
      box.fx = Math.sin(heading);
      box.fz = Math.cos(heading);
      box.hf = (car.rig.length / 2) * TRAFFIC.hitboxScale;
      box.hr = (car.rig.width / 2) * TRAFFIC.hitboxScale;
    }

    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (a.car.crash && b.car.crash) continue;

        // Cheap reject on bounding circles before the exact test.
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const reach = a.hf + a.hr + b.hf + b.hr;
        if (dx * dx + dz * dz > reach * reach) continue;
        if (!overlaps(a, b, dx, dz)) continue;

        impact(a.car, b.car);
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

  const update = (dt: number, isGreen: boolean) => {
    for (const lane of lanes) drive(lane, dt, isGreen);

    // Clear wrecks that have finished poofing, back to front so splicing is safe.
    for (const lane of lanes) {
      for (let i = lane.cars.length - 1; i >= 0; i--) {
        const crash = lane.cars[i].crash;
        if (crash && crash.t >= CRASH.holdSeconds + CRASH.poofSeconds) {
          effects.puff(lane.cars[i].rig.root.getAbsolutePosition());
          recycle(lane, i);
        }
      }
    }

    for (const car of cars) place(car, dt);
    collide();
  };

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
    breakTime: ROAD_ONE.breakTime,
    minGap: 0,
    accel: 0,
    brake: 0,
    comfort: 0,
  };
}

/**
 * Distance to leave in front of a car joining the back of a lane.
 *
 * On roodOne that is a bumper gap plus the break — the seconds of empty road the
 * player gets to cross in — turned into a distance at the joining car's own
 * speed. That is the whole gap mechanism: roodOne never brakes, so its openings
 * have to be built in at the moment a car joins.
 */
function joinGap(rules: Rules, cruise: number): number {
  const pause = rules.breakTime ? between(rules.breakTime) * cruise : 0;
  return rules.spawnGap + pause;
}

/** The same gap with the break at its average — used to size a lane's car pool,
 *  which must not come out differently on every run. */
function meanJoinGap(rules: Rules): number {
  const pause = rules.breakTime ? mid(rules.breakTime) * mid(rules.speed) : 0;
  return rules.spawnGap + pause;
}

function buildLane(road: RoadSpec, side: 1 | -1, make: () => CarRig): Lane {
  const delta = road.end.subtract(road.start);
  delta.y = 0;
  const length = delta.length();
  const dir = delta.scale(1 / length);

  // Rotate the direction 90 degrees in the ground plane to step off the centre line.
  const perp = new Vector3(dir.z, 0, -dir.x);
  const origin = road.start.add(perp.scale(side * TRAFFIC.laneOffset));
  const rules = rulesFor(road);

  const lane: Lane = {
    name: `${road.name}${side > 0 ? "A" : "B"}`,
    originX: origin.x,
    originZ: origin.z,
    dirX: dir.x,
    dirZ: dir.z,
    // A Y rotation of atan2(x, z) is exactly what points a model's +Z along dir,
    // and every car model faces +Z: its front wheels sit at positive z.
    yaw: Math.atan2(dir.x, dir.z),
    length,
    stopS: road.cross ? Vector3.Dot(road.cross.subtract(road.start), dir) : null,
    rules,
    cars: [],
  };

  // Seed the lane so the road is busy on the very first frame.
  //
  // A lane the light governs is seeded from its stop line backwards rather than
  // from the far end: seeding past the line would drop cars into the junction
  // while the signal is red, and the cross traffic — which never stops — would
  // pile straight into them before the player had touched anything.
  const gated = lane.stopS !== null && !LIGHT.startsGreen;
  const top = gated ? lane.stopS! : length;

  // Size the pool from the pitch a joining car is given, so the lane fills at the
  // density it will actually settle into. A free lane gets one spare, to keep a
  // car ready to enter while the road ahead is still emptying.
  const meanPitch = meanJoinGap(rules) + APPROX_CAR_LENGTH;
  const count = Math.max(3, Math.ceil(length / meanPitch) + (rules.free ? 1 : 0));

  let s = top;
  let previous: { rig: CarRig; s: number } | null = null;

  for (let i = 0; i < count; i++) {
    const rig = make();
    const cruise = between(rules.speed);

    if (!previous) {
      // `s` is a car's centre but the stop line is judged against its nose, so
      // the first car of a queue has to be pulled back half its own length.
      // Seeding it centred on the line put its nose past it, which read as
      // "already committed" and sent the lead car through a red light.
      if (gated) s = top - rig.length / 2 - QUEUE_CLEARANCE;
    } else {
      s -= joinGap(rules, cruise) + (previous.rig.length + rig.length) / 2;
    }

    // Seed the speed from the same braking law the simulation drives by, so the
    // opening state is one the physics could actually have produced. Handing a
    // car cruise speed while parking it on the stop line gave it no room to pull
    // up, and it drove straight through the red into the cross traffic.
    let v = cruise;
    if (!rules.free) {
      const nose = s + rig.length / 2;
      const toStop = gated ? approach(lane.stopS! - nose - 0.25, rules) : Infinity;
      const toLeader = previous
        ? approach(previous.s - previous.rig.length / 2 - nose - rules.minGap, rules)
        : Infinity;
      v = Math.min(cruise, toStop, toLeader);
    }

    lane.cars.push({
      rig,
      lane,
      s,
      v,
      cruise,
      roll: Math.random() * Math.PI * 2,
      settle: 0,
      braking: false,
      yaw: 0,
      crash: null,
    });
    previous = { rig, s };
  }

  return lane;
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

/** Rough car length, used only to size a lane's car pool before any exist. */
const APPROX_CAR_LENGTH = 5;

/**
 * Slack left between the lead car's nose and the stop line when a queue is
 * seeded. Parking it flush put the nose exactly on the line, where the strict
 * "has it crossed yet" test came down to floating-point noise — and on the side
 * that lost, the lead car treated itself as committed and drove the red.
 */
const QUEUE_CLEARANCE = 0.6;

const mid = (range: Range) => (range.min + range.max) / 2;

const between = (range: Range) => range.min + Math.random() * (range.max - range.min);

const moveTowards = (from: number, to: number, step: number) =>
  from < to ? Math.min(to, from + step) : Math.max(to, from - step);
