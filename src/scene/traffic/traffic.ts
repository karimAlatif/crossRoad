import {
  Observable,
  Quaternion,
  Vector3,
  type ShadowGenerator,
  type Scene,
  type TransformNode,
} from "@babylonjs/core";
import { ANIM, CRASH, LIGHT } from "../config";
import type { Clock } from "../core/frame";
import { between, moveTowards } from "../core/maths";
import type { Disposable } from "../core/types";
import { createCrashEffects } from "../effects/crashEffects";
import type { RoadSpec } from "../world/props";
import { createCarFactory } from "./carFactory";
import { footprint, overlaps } from "./collisions";
import {
  admit,
  approach,
  createLane,
  makeCar,
  startWave,
  STOPPED,
  type Car,
  type Lane,
  type Wave,
} from "./road";

export type CrashEvent = {
  /** Where the impact happened, in world space. */
  at: Vector3;
  lanes: [string, string];
};

export type Traffic = Disposable & {
  update: (dt: number, isGreen: boolean) => void;
  onCrash: Observable<CrashEvent>;
  /**
   * A car setting off from a standstill, and a car starting to brake hard. Each
   * carries where the car is, in world space. The vector is reused: read it
   * straight away and copy it if it has to be kept.
   */
  onSetOff: Observable<Vector3>;
  onBrake: Observable<Vector3>;
};

export function createTraffic(
  scene: Scene,
  clock: Clock,
  space: TransformNode,
  roads: RoadSpec[],
  shadows: ShadowGenerator | null,
): Traffic {
  const factory = createCarFactory(scene, clock, space, shadows);
  const effects = createCrashEffects(scene);
  const onCrash = new Observable<CrashEvent>();
  const onSetOff = new Observable<Vector3>();
  const onBrake = new Observable<Vector3>();

  const lanes: Lane[] = [];
  let picked = 0;
  let crashes = 0;

  for (const road of roads) {
    const wave: Wave = { left: 0, speed: 0, spawnGap: 0, lanes: [] };
    const rows = ([1, -1] as const).map((side) => createLane(road, side, wave));
    wave.lanes = rows;
    // Open the first wave properly. Left at zero, the very first car admitted
    // would take the counter negative and end its own wave, so every road began
    // with a wave of exactly one car.
    startWave(wave, rows[0].rules);
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

  const drive = (lane: Lane, dt: number, isGreen: boolean, live: boolean) => {
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
        if (live && car.v <= STOPPED && next > STOPPED) {
          car.rig.playMove();
          onSetOff.notifyObservers(car.rig.root.getAbsolutePosition());
        }

        // Fire the dive once when a stop begins, and re-arm only after the car
        // has stopped shedding speed — otherwise it would retrigger every frame.
        //
        // The threshold is a fraction of this road's own brake rate, not a fixed
        // deceleration. An absolute figure has to be kept in step by hand with
        // `ROAD_TWO.brake`, and once that rate was raised to 60 a trigger of 1
        // meant any frame losing 0.017 of a unit counted as a brake — which is
        // noise in the following model, not braking.
        const decel = dt > 0 ? (car.v - next) / dt : 0;
        const hard = rules.brake * ANIM.brake.trigger;
        if (!car.braking && decel >= hard) {
          car.braking = true;
          if (live) {
            car.rig.playBrake();
            onBrake.notifyObservers(car.rig.root.getAbsolutePosition());
          }
        } else if (car.braking && decel < hard * 0.4) {
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
    car.rig.update(0, 0, 0);
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
      rig.update(0, dt, 0);
    } else {
      const settled = car.v <= STOPPED ? 1 : 0;
      car.settle = moveTowards(car.settle, settled, dt / ANIM.blend);
      rig.update(car.settle, dt, car.v);
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
        footprint(car, lane);
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

  const step = (dt: number, isGreen: boolean, live: boolean) => {
    now += dt;

    for (const lane of lanes) drive(lane, dt, isGreen, live);

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
      admit(lane, now);
      for (const car of lane.cars) place(car, dt);
    }

    if (live) collide();
  };

  // Fill the road by running the real rules forward before the first frame.
  //
  // Nothing "live" happens during it: no collisions, so the opening state can
  // never contain a wreck, and no animation clips, because the scene is not
  // rendering yet. A clip fired here would simply sit queued and then play on the
  // first visible frame — which is how every car that had braked in the warm-up
  // ended up diving in unison the moment the page appeared.
  for (let i = 0; i < Math.round(WARM_UP_SECONDS * 60); i++) {
    step(1 / 60, LIGHT.startsGreen, false);
  }

  const update = (dt: number, isGreen: boolean) => step(dt, isGreen, true);

  return {
    update,
    onCrash,
    onSetOff,
    onBrake,
    dispose: () => {
      onCrash.clear();
      onSetOff.clear();
      onBrake.clear();
      effects.dispose();
      for (const car of cars) car.rig.dispose();
      factory.dispose();
    },
  };
}

/**
 * Simulated seconds run at construction so the road opens busy. Long enough for a
 * car to cross the longest road several times over and for the queue to settle.
 */
const WARM_UP_SECONDS = 25;


