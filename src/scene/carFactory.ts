import {
  AnimationGroup,
  Matrix,
  Quaternion,
  TransformNode,
  Vector3,
  type AbstractMesh,
  type Animation,
  type CascadedShadowGenerator,
  type Mesh,
  type Scene,
} from "@babylonjs/core";
import { ANIM, HEADLIGHT, TRAFFIC } from "./config";
import { createCarClips, IDLE_LENGTH } from "./carAnimations";
import { createHeadlights, type LampMounts } from "./carHeadlights";

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
  /** Fires the one-shot pull-away lift. */
  playMove: () => void;
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
  dispose: () => void;
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
  // Likewise the lights: one set of source meshes the whole fleet instances from.
  const headlights = createHeadlights(scene);
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
    // The lamps hang off the bottom of the animation stack and inherit every clip
    // the car plays; the cones hang off `root`, stay flat on the road, and are
    // slid and swung to match the pose those same nodes are holding.
    headlights?.attach(
      root,
      [idle, brake, move, crash],
      lampMounts(template, body.position, length, width, height),
    );

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

    return {
      root,
      crash,
      wheels,
      length,
      width,
      wheelRadius: wheelRadius || 0.36,
      setIdle: (weight) => blend(idleLayer, weight),
      playBrake: () => fire(brakeLayer, moveLayer),
      playMove: () => fire(moveLayer, brakeLayer),
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

  return { templateCount: templates.length, spawn, dispose: () => headlights?.dispose() };
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

/**
 * Where a car's lamps belong, in its rig's own space.
 *
 * Read from marker nodes in the model first: a `forntLamp` and a `backLamp`
 * (that spelling is the model's, not a slip), each with a `left` and a `right`
 * child. A lamp goes at each of the four, exactly where the marker sits — the
 * models are different shapes, and a position measured off the bumper is only
 * ever right for some of them. Nothing is added to a marker's position.
 *
 * Markers are read from the *template* rather than the clone, so it makes no
 * difference whether Babylon carries empty nodes across when a mesh is cloned.
 * `offset` is the shift the clone's body was given to centre its footprint on
 * the rig; adding it is not a fudge but the same move the bodywork made, and
 * without it the lamps would sit where the car used to be parked in the city.
 *
 * 8 of the 20 models carry markers. The rest fall back to the bounding box, so
 * the two coexist: export a car with markers and it starts using them, with
 * nothing else to change. The fallback takes its height from the car's own roof
 * rather than a number in the config — a van and a hatchback do not carry their
 * lamps at the same height, and one figure for both is wrong for at least one.
 */
function lampMounts(
  template: Mesh,
  offset: Vector3,
  length: number,
  width: number,
  height: number,
): LampMounts {
  const { mounts, lamp } = HEADLIGHT;
  const toLocal = Matrix.Invert(template.getWorldMatrix());

  const pair = (group: string): Vector3[] => {
    const node = template.getDescendants(false, (child) => child.name === group)[0];
    if (!node) return [];

    return [mounts.left, mounts.right]
      .map((side) => node.getDescendants(false, (child) => child.name === side)[0])
      .filter((side): side is TransformNode => !!side)
      .map((side) => {
        side.computeWorldMatrix(true);
        // Into the template's space, then into the rig's by the same shift the
        // body was given.
        return Vector3.TransformCoordinates(side.getAbsolutePosition(), toLocal).addInPlace(offset);
      });
  };

  const nose = length / 2;
  const side = (width / 2) * lamp.apart;
  const front = pair(mounts.front);
  const back = pair(mounts.back);

  return {
    front: front.length > 0 ? front : [
      new Vector3(-side, height * FALLBACK_FRONT, nose),
      new Vector3(side, height * FALLBACK_FRONT, nose),
    ],
    back: back.length > 0 ? back : [
      new Vector3(-side, height * FALLBACK_BACK, -nose),
      new Vector3(side, height * FALLBACK_BACK, -nose),
    ],
  };
}

/**
 * Where the lamps go on a car with no markers, as a fraction of its own height.
 *
 * Both figures are the average of the eight models that *are* marked: their
 * headlamps sit at 0.42 of the roof and their rear lamps a little higher, at
 * 0.53. An unmarked car therefore lands where a marked car of its shape would.
 */
const FALLBACK_FRONT = 0.42;
const FALLBACK_BACK = 0.53;
