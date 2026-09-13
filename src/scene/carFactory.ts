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
import { ANIM, TRAFFIC } from "./config";
import { createCarClips, IDLE_LENGTH } from "./carAnimations";

/**
 * One drivable car.
 *
 * The rig is a stack of transform nodes, each with exactly one writer:
 *
 *   root   — lane position and heading. The simulation owns this.
 *   idle   — the left-right shudder.  AnimationGroup, only while stopped.
 *   brake  — the one-shot nose dive.  AnimationGroup.
 *   crash  — the spin and tumble.     Written per frame, only while wrecked.
 *   body   — the model, aligned so forward is +Z and the wheels sit on y = 0.
 *
 * Giving every animation its own node is what lets a shudder and a dive overlap
 * and compose, instead of two writers fighting over one transform — and it keeps
 * either of them from corrupting the lane maths on `root`.
 *
 * A car that is moving animates nothing here at all.
 */
export type CarRig = {
  root: TransformNode;
  /** The crash layer, written directly by the simulation. */
  crash: TransformNode;
  wheels: Wheel[];
  /** Footprint, measured from the model rather than guessed. */
  length: number;
  width: number;
  wheelRadius: number;
  /**
   * How far the car has settled into its idle shudder: 0 while it is moving (and
   * the clip is paused outright), 1 once it has stopped.
   */
  setIdle: (weight: number) => void;
  /** Fires the one-shot brake dive. */
  playBrake: () => void;
  dispose: () => void;
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

export type CarFactory = {
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
  space: TransformNode,
  shadows: CascadedShadowGenerator | null,
): CarFactory {
  const group = scene.getNodeByName(TRAFFIC.carsGroup);
  if (!group) throw new Error(`The .glb has no "${TRAFFIC.carsGroup}" group`);

  // Direct children of the group are the 30 car roots; each carries its own
  // geometry plus the wheels and glass as children.
  const templates = group
    .getChildren(undefined, true)
    .filter((node): node is Mesh => ((node as Mesh).getTotalVertices?.() ?? 0) > 0);

  if (templates.length === 0) throw new Error("No car models found to clone");

  // Built once and shared by every car's AnimationGroups.
  const clips = createCarClips();
  let serial = 0;

  const spawn = (index: number): CarRig => {
    const template = templates[index % templates.length];
    const id = serial++;

    const root = new TransformNode(`car${id}`, scene);
    const idle = new TransformNode(`car${id}.idle`, scene);
    const brake = new TransformNode(`car${id}.brake`, scene);
    const crash = new TransformNode(`car${id}.crash`, scene);
    idle.parent = root;
    brake.parent = idle;
    crash.parent = brake;

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

    const idleLayer = loopingLayer(scene, `car${id}.idle`, clips.idle, idle, ANIM.idle.speed);
    const brakeLayer = oneShotLayer(scene, `car${id}.brake`, clips.brake, brake);

    // Only the shell casts. Wheels, glass and trim sit inside the body's own
    // shadow, so adding them would cost a draw per cascade for nothing.
    const casters: AbstractMesh[] = [body];
    if (shadows) {
      const map = shadows.getShadowMap();
      if (map?.renderList) map.renderList.push(...casters);
    }

    return {
      root,
      crash,
      wheels,
      length,
      width,
      wheelRadius: wheelRadius || 0.36,
      setIdle: (weight) => blend(idleLayer, weight),
      playBrake: () => {
        brakeLayer.group.stop();
        brakeLayer.group.play(false);
        brakeLayer.group.weight = 1;
      },
      dispose: () => {
        idleLayer.group.dispose();
        brakeLayer.group.dispose();
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

  return { templateCount: templates.length, spawn };
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
): Layer {
  const group = new AnimationGroup(name, scene);
  for (const clip of clips) group.addTargetedAnimation(clip, node);
  group.speedRatio = ANIM.brake.speed;
  return { node, group, running: false };
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
