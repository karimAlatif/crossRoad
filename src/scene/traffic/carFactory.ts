import {
  AnimationGroup,
  Quaternion,
  TransformNode,
  Vector3,
  type AbstractMesh,
  type Animation,
  type CascadedShadowGenerator,
  type Mesh,
  type Scene,
} from "@babylonjs/core";
import { ANIM, CAR_FX, CARS_GROUP, LIGHT_TRAIL, SKID_MARK } from "../config";
import { createCarClips, IDLE_LENGTH } from "./carAnimations";
import { createCarEffects } from "../effects/carEffects";
import type { Clock } from "../core/frame";
import { between } from "../core/maths";
import type { Disposable } from "../core/types";
import { createHeadlights, lampMounts } from "../effects/carHeadlights";

/**
 * One drivable car.
 *
 * The rig is a stack of transform nodes, each with exactly one writer:
 *
 *   root   — lane position and heading. The simulation owns this.
 *   idle   — the left-right shudder.   AnimationGroup, only while stopped.
 *   brake  — the one-shot nose dive.   AnimationGroup.
 *   move   — the one-shot nose lift.   AnimationGroup.
 *   crash  — the spin and tumble.      Written per frame, only while wrecked.
 *   body   — the model, aligned so forward is +Z and the wheels sit on y = 0.
 *
 * Giving every animation its own node is what lets a shudder and a dive overlap
 * and compose, instead of two writers fighting over one transform — and it keeps
 * either of them from corrupting the lane maths on `root`.
 *
 * A car that is moving animates nothing here at all.
 */
export type CarRig = Disposable & {
  root: TransformNode;
  /** The crash layer, written directly by the simulation. */
  crash: TransformNode;
  wheels: Wheel[];
  /** Footprint, measured from the model rather than guessed. */
  length: number;
  width: number;
  wheelRadius: number;
  /**
   * The per-frame tick. `idle` is how far the car has settled into its shudder —
   * 0 while it is moving, and the clip is paused outright at that point — `dt` is
   * the length of the frame, and `speed` is how fast the car is going.
   *
   * The effects need all three: the idle breath runs only on a settled car, and
   * the light trail and the rubber are held on to the car as it travels.
   */
  update: (idle: number, dt: number, speed: number) => void;
  /** Fires the one-shot brake dive. */
  playBrake: () => void;
  /** Fires the one-shot pull-away lift. */
  playMove: () => void;
};

type Wheel = {
  node: TransformNode;
  base: Quaternion;
  /** Axle in the wheel's own local space, found from its flattest dimension. */
  axle: Vector3;
};

/** A clip, the node it drives, and whether it is currently costing anything. */
type Layer = {
  node: TransformNode;
  group: AnimationGroup;
  running: boolean;
};

const WHEEL_NAME = /_Wheel_(fl|fr|rl|rr)$/i;

/**
 * Parts that are never visible from a camera locked above the junction: the
 * steering wheel sits inside the cabin and the number plates are a few pixels.
 * Dropping them takes each car from nine meshes to seven, across every car and
 * every pass.
 */
const HIDDEN_PART = /(_SteeringW|_Plates|Steering_Wheel)/i;

/** Below this a layer is treated as off, and stops being animated at all. */
const OFF = 0.002;

/**
 * How far into the idle blend a car has to be before its exhaust starts up.
 *
 * High on purpose. `setIdle` is fed a weight that ramps over `ANIM.blend`, so a
 * car that merely dipped below the walking pace the simulation calls stopped
 * would trail smoke as it rolled through the junction. Only a car that has
 * properly settled smokes.
 */
const IDLE_SMOKING = 0.75;

/** The rig's own nose, before any of the city's transforms are applied. */
const FORWARD = new Vector3(0, 0, 1);

/** Metres per second above which a car counts as moving, for the ribbons. */
const MOVING = 0.5;

export type CarFactory = Disposable & {
  templateCount: number;
  spawn: (index: number) => CarRig;
};

/**
 * Turns the hidden `Cars` group into a model library. Each of the 30 vehicles
 * carries its own baked colour, so cloning across all of them is what gives the
 * traffic its variety.
 */
export function createCarFactory(
  scene: Scene,
  clock: Clock,
  space: TransformNode,
  shadows: CascadedShadowGenerator | null,
): CarFactory {
  const group = scene.getNodeByName(CARS_GROUP);
  if (!group) throw new Error(`The .glb has no "${CARS_GROUP}" group`);

  // Direct children of the group are the 30 car roots; each carries its own
  // geometry plus the wheels and glass as children.
  const templates = group
    .getChildren(undefined, true)
    .filter((node): node is Mesh => ((node as Mesh).getTotalVertices?.() ?? 0) > 0);

  if (templates.length === 0) throw new Error("No car models found to clone");

  // Built once and shared by every car's AnimationGroups.
  const clips = createCarClips();
  // Likewise the lights: one set of source meshes the whole fleet instances from.
  const headlights = createHeadlights(scene, clock);
  // And the smoke: one ParticleSystem per effect for the whole road.
  const effects = createCarEffects(scene, clock);
  let serial = 0;

  const spawn = (index: number): CarRig => {
    const template = templates[index % templates.length];
    const id = serial++;

    const root = new TransformNode(`car${id}`, scene);
    const idle = new TransformNode(`car${id}.idle`, scene);
    const brake = new TransformNode(`car${id}.brake`, scene);
    const move = new TransformNode(`car${id}.move`, scene);
    const crash = new TransformNode(`car${id}.crash`, scene);
    idle.parent = root;
    brake.parent = idle;
    move.parent = brake;
    crash.parent = move;

    const body = template.clone(`car${id}.body`, crash, false);
    if (!body) throw new Error(`Could not clone ${template.name}`);

    // Drop the model's placement in the city; the rig positions it from now on.
    body.rotationQuaternion = null;
    body.rotation.setAll(0);
    body.position.setAll(0);
    body.scaling.setAll(1);
    body.setEnabled(true);

    for (const part of body.getChildMeshes(false)) {
      if (HIDDEN_PART.test(part.name)) part.dispose(false, false);
    }

    const parts = [body, ...body.getChildMeshes(false)];
    for (const part of parts) {
      part.isPickable = false;
      part.setEnabled(true);
      part.receiveShadows = true;
    }

    // Measure while the rig hangs at the origin with no parent, so the numbers
    // come back in the rig's own space rather than the city's.
    for (const part of parts) part.computeWorldMatrix(true);
    const bounds = body.getHierarchyBoundingVectors(true);
    const length = bounds.max.z - bounds.min.z;
    const width = bounds.max.x - bounds.min.x;
    const height = bounds.max.y - bounds.min.y;

    // Centre the footprint on the rig and rest the wheels on the road.
    body.position.set(
      -(bounds.min.x + bounds.max.x) / 2,
      -bounds.min.y,
      -(bounds.min.z + bounds.max.z) / 2,
    );

    const wheels: Wheel[] = [];
    let wheelRadius = 0;
    for (const node of body.getDescendants(false)) {
      if (!WHEEL_NAME.test(node.name)) continue;
      const wheel = node as AbstractMesh;
      const extend = wheel.getBoundingInfo?.().boundingBox.extendSize;
      if (!extend) continue;

      // A wheel is a disc: its thinnest dimension is the axle it turns on.
      const sizes = [extend.x, extend.y, extend.z];
      const axleIndex = sizes.indexOf(Math.min(...sizes));
      const axle = new Vector3(
        axleIndex === 0 ? 1 : 0,
        axleIndex === 1 ? 1 : 0,
        axleIndex === 2 ? 1 : 0,
      );
      wheelRadius = Math.max(wheelRadius, ...sizes.filter((_, i) => i !== axleIndex));

      wheels.push({
        node: wheel,
        base: wheel.rotationQuaternion?.clone() ?? Quaternion.FromEulerVector(wheel.rotation),
        axle,
      });
    }

    root.parent = space;
    // Where this car's lamps are. The headlights use them, and so do most of the
    // effects: the idle breath, the brake cloud, the rubber and the light trail
    // are all placed off these same four markers.
    const mounts = lampMounts(template, body.position, length, width, height);
    // The lamps hang off the bottom of the animation stack and inherit every clip
    // the car plays; the cones hang off `root`, stay flat on the road, and are
    // slid and swung to match the pose those same nodes are holding.
    headlights?.attach(root, [idle, brake, move, crash], mounts);

    const idleLayer = loopingLayer(scene, `car${id}.idle`, clips.idle, idle, ANIM.idle.speed);
    const brakeLayer = oneShotLayer(scene, `car${id}.brake`, clips.brake, brake, ANIM.brake.speed);
    const moveLayer = oneShotLayer(scene, `car${id}.move`, clips.move, move, ANIM.move.speed);

    // Only the shell casts. Wheels, glass and trim sit inside the body's own
    // shadow, so adding them would cost a draw per cascade for nothing.
    const casters: AbstractMesh[] = [body];
    if (shadows) {
      const map = shadows.getShadowMap();
      if (map?.renderList) map.renderList.push(...casters);
    }

    // Where each effect comes from, in the rig's own space.
    const radius = wheelRadius || 0.36;
    const [backLeft, backRight = backLeft] = mounts.back;
    const [frontLeft, frontRight = frontLeft] = mounts.front;

    // The idle breath: one source, low down behind the middle of the car.
    const tailpipe = Vector3.Center(backLeft, backRight);
    tailpipe.y = radius * 0.5;
    tailpipe.z -= 0.1;
    // The getaway cloud, from under the car; the brake cloud, from its nose.
    const belly = new Vector3(0, radius * 0.3, -length * 0.1);
    const nose = Vector3.Center(frontLeft, frontRight);
    nose.y = radius * 0.6;
    nose.z += 0.25;
    // The two ribbons hang off the back lamps: the light at the lamps' own
    // height, the rubber on the ground directly beneath them.
    const lamps = [backLeft, backRight];

    // Scratch, reused every frame: none of this allocates once the road is built.
    const matrix = { current: root.getWorldMatrix() };
    const where = new Vector3();
    const heading = new Vector3();

    /** Reads the car's pose once. Everything placed this frame uses it. */
    const pose = () => {
      matrix.current = root.computeWorldMatrix(true);
      Vector3.TransformNormalToRef(FORWARD, matrix.current, heading);
      heading.normalize();
    };

    /** A rig-local point, in the world, off the pose read by `pose()`. */
    const at = (local: Vector3): Vector3 => {
      Vector3.TransformCoordinatesToRef(local, matrix.current, where);
      return where;
    };

    /**
     * One ribbon being laid behind one lamp: the segment currently being
     * stretched, and where that segment began.
     */
    type Ribbon = { handle: number; anchor: Vector3; open: boolean };
    const ribbon = (): Ribbon => ({ handle: -1, anchor: new Vector3(), open: false });
    const lightRibbons = [ribbon(), ribbon()];
    const rubberRibbons = [ribbon(), ribbon()];

    /** Lets go of a ribbon. What has been laid stays and fades; nothing new joins it. */
    const close = (ribbons: Ribbon[]) => {
      for (const r of ribbons) {
        r.handle = -1;
        r.open = false;
      }
    };

    /**
     * Pulls a ribbon out to wherever its lamp is this frame.
     *
     * The newest segment runs from its anchor to the lamp, so the ribbon always
     * reaches the car. Once that segment is `every` long it is let go, and the
     * next one starts from the same point — so the joins line up exactly.
     */
    const extend = (
      r: Ribbon,
      local: Vector3,
      every: number,
      lay: (handle: number, from: Vector3, to: Vector3) => number,
    ) => {
      const lamp = at(local);
      let gap = Math.hypot(lamp.x - r.anchor.x, lamp.z - r.anchor.z);
      // A fresh start, or a car that has jumped — recycled onto the start of the
      // road, say — rather than driven there: begin again from where it is.
      if (!r.open || gap > every * 4) {
        r.anchor.copyFrom(lamp);
        r.handle = -1;
        r.open = true;
        gap = 0;
      }
      const handle = lay(r.handle, r.anchor, lamp);
      if (handle < 0) {
        r.open = false;
        return;
      }
      r.handle = handle;
      if (gap >= every) {
        r.anchor.copyFrom(lamp);
        r.handle = -1;
      }
    };

    /**
     * This car's own draw from every range in SKID_MARK and LIGHT_TRAIL. Drawn
     * again each time it sets off, so a car pulled out of the pool for another
     * run does not lay the same marks as last time.
     */
    const look = { skidDelay: 0, skidDuration: 0, skidWidth: 0, skidSeconds: 0, lightWidth: 0, lightSeconds: 0 };
    const draw = () => {
      look.skidDelay = between(SKID_MARK.delay);
      look.skidDuration = between(SKID_MARK.duration);
      look.skidWidth = between(SKID_MARK.width);
      look.skidSeconds = between(SKID_MARK.seconds);
      look.lightWidth = between(LIGHT_TRAIL.width);
      look.lightSeconds = between(LIGHT_TRAIL.seconds);
    };
    draw();

    // Laid through `effects`, with this car's widths and lifetimes baked in.
    const layLight = (handle: number, from: Vector3, to: Vector3) =>
      effects ? effects.trail(handle, from, to, to.y, look.lightWidth, look.lightSeconds) : -1;
    const layRubber = (handle: number, from: Vector3, to: Vector3) =>
      effects ? effects.rubber(handle, from, to, look.skidWidth, look.skidSeconds) : -1;

    let moving = false;
    /** Seconds since this car last set off. */
    let travelled = 0;
    /** Seconds until the next idle breath. */
    let nextBreath = Math.random() * CAR_FX.idle.every;

    return {
      root,
      crash,
      wheels,
      length,
      width,
      wheelRadius: radius,
      update: (weight, dt, speed) => {
        blend(idleLayer, weight);
        if (!effects) return;
        pose();

        // Setting off — from the lights, or onto the road from the pool.
        const nowMoving = speed > MOVING;
        if (nowMoving && !moving) {
          draw();
          travelled = 0;
        }
        moving = nowMoving;
        travelled += dt;

        // --- light trail: any car that is moving ------------------------------
        if (speed > LIGHT_TRAIL.minSpeed) {
          for (let i = 0; i < 2; i++) extend(lightRibbons[i], lamps[i], LIGHT_TRAIL.every, layLight);
        } else {
          close(lightRibbons);
        }

        // --- rubber: for this car's window after it sets off -----------------
        const rubberOn =
          moving && travelled >= look.skidDelay && travelled <= look.skidDelay + look.skidDuration;
        if (rubberOn) {
          for (let i = 0; i < 2; i++) extend(rubberRibbons[i], lamps[i], SKID_MARK.every, layRubber);
        } else {
          close(rubberRibbons);
        }

        // --- idle: a soft breath out of the back, every so often -------------
        if (weight > IDLE_SMOKING) {
          nextBreath -= dt;
          if (nextBreath <= 0) {
            nextBreath += CAR_FX.idle.every;
            effects.exhaust(at(tailpipe), heading);
          }
        } else {
          nextBreath = Math.random() * CAR_FX.idle.every;
        }
      },
      playBrake: () => {
        fire(brakeLayer, moveLayer);
        if (!effects) return;
        pose();
        effects.brake(at(nose), heading);
      },
      playMove: () => {
        fire(moveLayer, brakeLayer);
        if (!effects) return;
        pose();
        effects.launch(at(belly), heading);
      },
      dispose: () => {
        idleLayer.group.dispose();
        brakeLayer.group.dispose();
        moveLayer.group.dispose();
        if (shadows) {
          const map = shadows.getShadowMap();
          if (map?.renderList) {
            map.renderList = map.renderList.filter((mesh) => !casters.includes(mesh));
          }
        }
        root.dispose(false, false);
      },
    };
  };

  return {
    templateCount: templates.length,
    spawn,
    dispose: () => {
      headlights?.dispose();
      effects?.dispose();
    },
  };
}

/**
 * A looping clip, wired to its node and left paused.
 *
 * `speed` is applied as the group's playback rate, so the number in `ANIM` means
 * cycles per second directly. Each car starts at a random point in the cycle —
 * the phase, not the tempo — so a queue shudders out of step without any car
 * drifting away from the speed that was asked for.
 */
function loopingLayer(
  scene: Scene,
  name: string,
  clips: Animation[],
  node: TransformNode,
  speed: number,
  length = IDLE_LENGTH,
): Layer {
  const group = new AnimationGroup(name, scene);
  for (const clip of clips) group.addTargetedAnimation(clip, node);

  group.speedRatio = speed;
  group.play(true);
  group.goToFrame(Math.random() * length);
  group.weight = 0;
  group.pause();

  // Starting the group parks a pose on the node before it is paused, and a car
  // that never stops would carry that pose forever — the blend below only clears
  // the node on the way down, which this layer never travels.
  reset(node);

  return { node, group, running: false };
}

/** A one-shot clip, left unstarted until it is asked for. */
function oneShotLayer(
  scene: Scene,
  name: string,
  clips: Animation[],
  node: TransformNode,
  speed: number,
): Layer {
  const group = new AnimationGroup(name, scene);
  for (const clip of clips) group.addTargetedAnimation(clip, node);
  group.speedRatio = speed;
  return { node, group, running: false };
}

/**
 * Plays a one-shot clip from the start, and clears its opposite number.
 *
 * The dive and the lift both pitch the car, and a car can go from braking to
 * pulling away in well under the length of either. Cancelling the other one —
 * and resetting its node, since a stopped group keeps writing nothing but leaves
 * its last pose behind — is what stops a half-finished dive from being frozen
 * into the car as it sets off.
 */
function fire(target: Layer, opposite: Layer): void {
  opposite.group.stop();
  reset(opposite.node);

  target.group.stop();
  target.group.play(false);
  target.group.weight = 1;
}

/**
 * Fades the shudder in and out, and — the point of the exercise — stops animating
 * it entirely once the car is moving again.
 *
 * Pausing preserves the phase, so resuming does not restart the cycle. The reset
 * matters because Babylon's weighted blend leaves a little of the last pose
 * behind at weight zero, which would hold the car at a permanent slight tilt;
 * this write lands after the scene's animation step, so identity wins.
 */
function blend(target: Layer, weight: number): void {
  if (weight <= OFF) {
    if (!target.running) return;
    target.running = false;
    target.group.pause();
    reset(target.node);
    return;
  }

  if (!target.running) {
    target.running = true;
    target.group.play(true);
  }
  target.group.weight = weight;
}

function reset(node: TransformNode): void {
  node.position.setAll(0);
  node.rotation.setAll(0);
  node.scaling.setAll(1);
}
