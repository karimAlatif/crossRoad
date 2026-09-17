import {
  ArcRotateCamera,
  CubicEase,
  EasingFunction,
  Vector3,
  type AbstractMesh,
  type Node,
  type Scene,
  type TransformNode,
} from "@babylonjs/core";
import { CAMERA } from "../config";
import type { Clock } from "../core/frame";
import { clamp01 } from "../core/maths";

const DEG = Math.PI / 180;

/** Where the camera is, expressed the way an ArcRotateCamera thinks. */
type Shot = { alpha: number; beta: number; radius: number };

/** The opening move as the model authors it: two ends, and a point to turn onto. */
export type CameraPath = { start: Vector3; end: Vector3; view: Vector3 | null };

/** One keyframe of one track: a position, at a moment in the intro. */
type Key = { at: number; value: Vector3 };

/** The opening, as the two things a camera does: stand somewhere, look at something. */
type Move = { stands: Key[]; looks: Key[]; seconds: number };

/**
 * The camera never moves on its own and the player never moves it.
 *
 * There is one view — the one in `CAMERA.view` — and one journey into it. After
 * the intro the camera is pinned there: its inputs are removed and its limits
 * are closed onto the exact angles it holds, so nothing can shift it, whatever
 * else in the project decides to attach a control later.
 */
export function createCamera(scene: Scene): ArcRotateCamera {
  const view = gameView();
  const camera = new ArcRotateCamera(
    "crossroadCam",
    view.alpha,
    view.beta,
    view.radius,
    CAMERA.view.target.clone(),
    scene,
  );

  camera.fov = CAMERA.fov;
  camera.minZ = CAMERA.minZ;
  camera.maxZ = CAMERA.maxZ;
  // Nothing drives this camera but the intro. Clearing the inputs is what makes
  // that true no matter who calls attachControl afterwards: there is nothing
  // left for it to attach.
  camera.inputs.clear();

  return camera;
}

/**
 * The opening move, authored in the model.
 *
 * A `cameraPath` node holds it: `start` and `end` are the two ends of the drive,
 * and `view` — optional — is the point the camera turns onto part-way along it.
 * The markers are placeholders, so any of them carrying geometry is taken off
 * screen once read.
 *
 * Returns null if the model has no path — the intro then flies a wide
 * establishing shot worked out from the game view instead, so the opening still
 * happens and nothing has to change here when the markers arrive.
 */
export function readCameraPath(scene: Scene): CameraPath | null {
  const group = scene.getNodeByName(CAMERA.intro.group);
  if (!group) return null;

  const at = (name: string): Vector3 | null => {
    const node = group.getChildren((child: Node) => child.name === name, true)[0] as
      | TransformNode
      | undefined;
    if (!node) return null;
    node.computeWorldMatrix(true);
    const mesh = node as AbstractMesh;
    if (mesh.isVisible !== undefined) {
      mesh.isVisible = false;
      mesh.isPickable = false;
    }
    return node.getAbsolutePosition().clone();
  };

  const start = at(CAMERA.intro.start);
  const end = at(CAMERA.intro.end);
  return start && end ? { start, end, view: at(CAMERA.intro.view) } : null;
}

/**
 * Flies the camera in, then hands it to the game, pinned.
 *
 * A camera only ever does two things — stand somewhere, and look at something —
 * so the opening is written as exactly that: two tracks of keyframes that the
 * intro eases along.
 *
 *   stands   `start` → `end` → the game view
 *   looks    down the path, held until `turnAt` of the drive, then onto the
 *            `view` marker, then onto the game view's target
 *
 * Keeping the two apart is what lets the camera *start turning while it is still
 * driving* — the look-at track has a key at 80% of the drive that the position
 * track knows nothing about — without that key breaking the drive into two legs
 * and making it slow down in the middle.
 *
 * Working in positions at all, rather than in `alpha`/`beta`/`radius`, is what
 * keeps the rest simple. An ArcRotateCamera's position is a *consequence* of
 * those three numbers swung around its target, so animating them directly makes
 * every leg an arc and every change of target silently rewrites them. Here the
 * camera is placed where it should be and pointed where it should look, and
 * Babylon works the angles out backwards.
 *
 * It is one callback on the shared clock, and it unsubscribes itself the moment
 * it arrives. Nothing of the intro runs afterwards.
 */
export function playIntro(camera: ArcRotateCamera, clock: Clock, path: CameraPath | null): void {
  const view = gameView();
  const move = opening(view, path);
  const ease = easeInOut();

  // Scratch, so the intro allocates nothing per frame.
  const here = new Vector3();
  const look = new Vector3();
  let elapsed = 0;

  const place = (moment: number) => {
    sample(move.looks, moment, ease, look);
    sample(move.stands, moment, ease, here);
    // Target first, then position: `setPosition` reads the target to work the
    // angles out, so the two have to be set in that order to agree. The fourth
    // argument stops `setTarget` rebuilding those angles itself.
    camera.setTarget(look, false, false, true);
    camera.setPosition(here);
  };

  place(0);

  const stop = clock.each((dt) => {
    elapsed += dt;
    if (elapsed >= move.seconds) {
      stop();
      pin(camera, view);
      return;
    }
    place(elapsed);
  });
}

/** Where a track is at `moment`: the segment holding it, eased. */
function sample(keys: Key[], moment: number, ease: CubicEase, into: Vector3): void {
  let i = 1;
  while (i < keys.length - 1 && moment > keys[i].at) i++;
  const from = keys[i - 1];
  const to = keys[i];
  const span = to.at - from.at;
  const through = span <= 0 ? 1 : ease.ease(clamp01((moment - from.at) / span));
  Vector3.LerpToRef(from.value, to.value, through, into);
}

/**
 * The opening, keyed out.
 *
 * With a path in the model: forward along it, turning onto the `view` marker on
 * the way, then up into the game view. Without one: a wide establishing shot
 * swung off to one side of the view, easing straight in, so the opening still
 * happens.
 */
function opening(view: Shot, path: CameraPath | null): Move {
  const { flySeconds, settleSeconds, lookAhead, turnAt, fallback } = CAMERA.intro;
  const target = CAMERA.view.target;
  const home = positionOf(view, target);
  const fly = Math.max(0.001, flySeconds);
  const seconds = fly + Math.max(0.001, settleSeconds);

  if (!path) {
    const wide: Shot = {
      alpha: view.alpha + fallback.alphaOffset * DEG,
      beta: fallback.beta * DEG,
      radius: fallback.radius,
    };
    return {
      stands: [
        { at: 0, value: positionOf(wide, target) },
        { at: seconds, value: home },
      ],
      looks: [
        { at: 0, value: target.clone() },
        { at: seconds, value: target.clone() },
      ],
      seconds,
    };
  }

  // What the camera watches while it drives: straight on past the end of the
  // path. Far enough to read as looking ahead rather than at a spot on the road,
  // and never zero — arriving on top of your own target leaves an
  // ArcRotateCamera with no radius and no way to work out an angle.
  const ahead = path.end
    .subtract(path.start)
    .normalize()
    .scaleInPlace(Math.max(1, lookAhead))
    .addInPlace(path.end);

  // The `view` marker is where the camera turns to before it has finished
  // driving, so the crossroad swings into frame while the car is still moving.
  // Without one in the model it keeps looking ahead and turns on the way up.
  const anchor = path.view ?? ahead;

  return {
    stands: [
      { at: 0, value: path.start.clone() },
      { at: fly, value: path.end.clone() },
      { at: seconds, value: home },
    ],
    looks: [
      { at: 0, value: ahead },
      // Held: nothing turns until this moment.
      { at: fly * clamp01(turnAt), value: ahead.clone() },
      { at: fly, value: anchor.clone() },
      { at: seconds, value: target.clone() },
    ],
    seconds,
  };
}

/**
 * Closes the camera onto the game view and throws away the key.
 *
 * Both limits of each angle are set to the value it holds, so even something
 * writing `camera.alpha` directly is clamped straight back. `CAMERA.locked`
 * turns this off if the camera is ever wanted back.
 */
function pin(camera: ArcRotateCamera, view: Shot): void {
  camera.setTarget(CAMERA.view.target.clone(), false, false, true);
  camera.alpha = view.alpha;
  camera.beta = view.beta;
  camera.radius = view.radius;

  if (!CAMERA.locked) return;
  camera.lowerAlphaLimit = camera.upperAlphaLimit = view.alpha;
  camera.lowerBetaLimit = camera.upperBetaLimit = view.beta;
  camera.lowerRadiusLimit = camera.upperRadiusLimit = view.radius;
  camera.inputs.clear();
  camera.detachControl();
}

/** The game view, with its angles converted from the degrees the config uses. */
function gameView(): Shot {
  return {
    alpha: CAMERA.view.alpha * DEG,
    beta: CAMERA.view.beta * DEG,
    radius: CAMERA.view.radius,
  };
}

/**
 * Where a shot stands — the sum an ArcRotateCamera does for itself every frame:
 *
 *   x = target.x + radius · cos(alpha) · sin(beta)
 *   y = target.y + radius · cos(beta)
 *   z = target.z + radius · sin(alpha) · sin(beta)
 */
function positionOf(shot: Shot, target: Vector3): Vector3 {
  const flat = shot.radius * Math.sin(shot.beta);
  return new Vector3(
    target.x + flat * Math.cos(shot.alpha),
    target.y + shot.radius * Math.cos(shot.beta),
    target.z + flat * Math.sin(shot.alpha),
  );
}

function easeInOut(): CubicEase {
  const ease = new CubicEase();
  ease.setEasingMode(EasingFunction.EASINGMODE_EASEINOUT);
  return ease;
}
