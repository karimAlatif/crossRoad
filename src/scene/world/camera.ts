import {
  ArcRotateCamera,
  Camera,
  CubicEase,
  EasingFunction,
  Vector3,
  type AbstractEngine,
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
  framed = gameView();
  aim = CAMERA.view.target.clone();
  arrived = false;
  const view = framed;
  const camera = new ArcRotateCamera(
    "crossroadCam",
    view.alpha,
    view.beta,
    view.radius,
    CAMERA.view.target.clone(),
    scene,
  );

  camera.fov = CAMERA.fov * DEG;
  camera.minZ = CAMERA.minZ;
  camera.maxZ = CAMERA.maxZ;
  // `fov` is the vertical angle and the horizontal one follows from the aspect
  // ratio. `fitToScreen` does its arithmetic in those terms, so this is not the
  // default being left alone — it is the default being relied on.
  camera.fovMode = Camera.FOVMODE_VERTICAL_FIXED;
  // Nothing drives this camera but the intro. Clearing the inputs is what makes
  // that true no matter who calls attachControl afterwards: there is nothing
  // left for it to attach.
  camera.inputs.clear();

  return camera;
}

/**
 * The view as the screen in front of us needs it: the authored shot, at the
 * distance `fitToScreen` settled on. Module state, because there is exactly one
 * camera and one screen, and both the intro and the pin have to agree on where
 * the journey ends.
 */
let framed: Shot = gameView();

/**
 * Where the view looks, for this screen: `view.target` on a wide screen,
 * `portraitView.target` on a tall one, and a blend between. See `fitToScreen`.
 */
let aim = CAMERA.view.target.clone();

/** Whether the intro has handed over — i.e. whether `framed` is live on screen. */
let arrived = false;

/**
 * Frames the shot for the screen it is actually on.
 *
 * Call it once the camera exists, and again whenever the canvas changes size.
 *
 * A phone held upright and a 21:9 monitor cannot show the same picture through
 * the same lens: the narrower the screen, the less of the world fits across it,
 * so a view framed on a desktop loses the sides of the junction on a phone.
 * `CAMERA.frame` is the promise that fixes that — an area, in metres on the
 * plane through the view's target, that is visible on every screen.
 *
 * Two things can keep that promise, and they are used in that order.
 *
 * **Open the lens.** Costs nothing and moves nothing: same spot, same angle,
 * same distance, same fog — the same shot with a wider edge. It is capped at
 * `maxFov` because this camera looks down at 37°, and once the lens opens past
 * about 74° the top of the frame climbs over the horizon and the shot fills with
 * sky.
 *
 * **Then step back.** Whatever the capped lens cannot cover is made up with
 * distance, straight out along the same line, so the angle and the composition
 * hold and the junction simply sits a little further away. The depth of field
 * follows the camera's radius by itself, so the tilt-shift stays on the junction.
 *
 * On anything 4:3 or wider neither happens: `wanted` comes out under the
 * authored `fov` and nothing changes at all.
 *
 * The arithmetic is one line either side of the aspect ratio. A vertical field
 * of view `f` at distance `d` shows `d · tan(f / 2)` metres either side of the
 * target vertically, and `aspect` times that horizontally. So `need` is the
 * half-height the viewport must cover: the frame's own half-height, or its
 * half-width folded through the aspect ratio, whichever is larger.
 */
export function fitToScreen(camera: ArcRotateCamera, engine: AbstractEngine): void {
  const { width, portraitWidth, height, maxFov } = CAMERA.frame;
  const aspect = Math.max(0.05, engine.getAspectRatio(camera));

  // Which authored view is in force depends on the shape of the screen:
  // `view` on a wide one, `portraitView` on a tall one, and a smooth blend of the
  // two between — so a tablet turning on its side changes the shot gradually,
  // never in a jump. So does how much has to fit across: the city on a wide
  // screen, the junction on a tall one.
  const wide = landscape(aspect);
  const shot = authored(wide);
  const across = portraitWidth + (width - portraitWidth) * wide;
  const need = Math.max(height / 2, across / 2 / aspect);

  // Then the lens and the distance adapt, on top of that view, to this exact
  // screen — which is what makes every phone come out as close to the portrait
  // view as its shape allows, rather than each one the same by accident.
  const wanted = 2 * Math.atan(need / shot.radius);
  // Never tighter than the authored lens, never wider than the guard.
  const fov = Math.max(CAMERA.fov * DEG, Math.min(wanted, maxFov * DEG));
  camera.fov = fov;

  framed = { ...shot, radius: Math.max(shot.radius, need / Math.tan(fov / 2)) };
  // A resize after the intro: the camera is already sitting at the old distance,
  // so move it to the new one and close the limits again.
  if (arrived) pin(camera);
}

/**
 * The authored view for a screen this landscape: `portraitView` at 0, `view` at 1,
 * blended between — and it writes the target into `aim` as it goes.
 *
 * The swing is blended the short way round, so two views authored at 350° and
 * 10° meet at 0° rather than sweeping the long way through 180°.
 */
function authored(wide: number): Shot {
  const tall = CAMERA.portraitView;
  const view = CAMERA.view;
  Vector3.LerpToRef(tall.target, view.target, wide, aim);

  const from = tall.alpha;
  const to = from + ((((view.alpha - from) % 360) + 540) % 360) - 180;
  return {
    alpha: (from + (to - from) * wide) * DEG,
    beta: (tall.beta + (view.beta - tall.beta) * wide) * DEG,
    radius: tall.radius + (view.radius - tall.radius) * wide,
  };
}

/**
 * How landscape a screen is, from 0 — portrait, 3:4 or taller — to 1 — 16:10 or
 * wider — easing in and out so the framing has no corner in it anywhere.
 */
function landscape(aspect: number): number {
  const t = clamp01((aspect - PORTRAIT) / (LANDSCAPE - PORTRAIT));
  return t * t * (3 - 2 * t);
}

/** Aspect ratios, width over height, that count as fully portrait and fully landscape. */
const PORTRAIT = 0.75;
const LANDSCAPE = 1.6;

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
  const move = opening(path);
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
      pin(camera);
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
function opening(path: CameraPath | null): Move {
  const { flySeconds, settleSeconds, lookAhead, turnAt, fallback } = CAMERA.intro;
  const target = aim;
  // Where the journey ends is the screen's business as much as the config's: on
  // a narrow one the last pose is further back, and aimed at the junction. See
  // `fitToScreen`.
  const home = positionOf(framed, target);
  const fly = Math.max(0.001, flySeconds);
  const seconds = fly + Math.max(0.001, settleSeconds);

  if (!path) {
    const wide: Shot = {
      alpha: framed.alpha + fallback.alphaOffset * DEG,
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
function pin(camera: ArcRotateCamera): void {
  arrived = true;
  camera.setTarget(aim.clone(), false, false, true);
  camera.alpha = framed.alpha;
  camera.beta = framed.beta;

  if (!CAMERA.locked) {
    camera.radius = framed.radius;
    return;
  }
  camera.lowerAlphaLimit = camera.upperAlphaLimit = framed.alpha;
  camera.lowerBetaLimit = camera.upperBetaLimit = framed.beta;
  // Reopened before the distance is set, because the limits from the last screen
  // size would otherwise clamp the new one straight back to the old.
  camera.lowerRadiusLimit = null;
  camera.upperRadiusLimit = null;
  camera.radius = framed.radius;
  camera.lowerRadiusLimit = camera.upperRadiusLimit = framed.radius;
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
