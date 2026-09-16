import { Animation, EasingFunction, SineEase } from "@babylonjs/core";
import { ANIM } from "../config";

/**
 * The three keyframe clips a car can play: shuddering while it waits, diving on
 * its nose as it pulls up, and lifting it again as it sets off. A car already
 * rolling along plays none of them.
 *
 * Both are authored as keyframes rather than computed per frame so the motion
 * can have cartoon timing, and so `ANIM` can drive them with two numbers each —
 * how far, and how fast.
 *
 * Each clip is built exactly once and shared by every car: an AnimationGroup per
 * car per state points these same Animation objects at that car's own node, so
 * twenty cars still cost one copy of the keyframes.
 */
export type CarClips = {
  idle: Animation[];
  brake: Animation[];
  move: Animation[];
};

/**
 * Clip lengths are fixed, and `ANIM.*.speed` is applied as the group's playback
 * rate. That way "speed" means exactly what it says — cycles per second for the
 * shake — instead of being tangled up in the keyframe spacing.
 */
const IDLE_FRAMES = 60;
const BRAKE_FRAMES = 45;
/** Longer than the dive on purpose: pulling away should read as smoother. */
const MOVE_FRAMES = 55;

/**
 * Where in each one-shot the pose reaches its extreme, as a fraction of the clip.
 *
 * Named rather than written into the keyframes twice over, because the particle
 * effects key off exactly these moments: the tyre smoke belongs at the bottom of
 * the dive, not at the start of it. Retune a peak here and the smoke follows.
 */
const BRAKE_PEAK = 0.22;
const MOVE_PEAK = 0.3;

export function createCarClips(): CarClips {
  return { idle: idleClip(), brake: brakeClip(), move: moveClip() };
}

export const IDLE_LENGTH = IDLE_FRAMES;

/**
 * When things happen in each clip, in seconds of real time.
 *
 * The clips are authored at 60 frames a second and played back at `ANIM.*.speed`
 * as a rate, so a peak that sits at frame 10 of a clip playing at half speed
 * arrives after a third of a second. Anything that has to land *with* the
 * animation — the particle effects do — has to work that out rather than guess,
 * and has to work it out again whenever a speed is retuned.
 */
export function clipTiming() {
  return {
    /** Seconds from the start of the dive to the bottom of it. */
    brakePeak: (BRAKE_FRAMES * BRAKE_PEAK) / 60 / ANIM.brake.speed,
    /** Seconds from the start of the pull-away to the top of the lift. */
    movePeak: (MOVE_FRAMES * MOVE_PEAK) / 60 / ANIM.move.speed,
    /**
     * Seconds between one extreme of the idle shake and the next. The car is at
     * full lock left, then full lock right, twice per cycle.
     */
    idleBeat: 0.5 / ANIM.idle.speed,
  };
}

function clip(
  name: string,
  property: string,
  loop: number,
  keys: { frame: number; value: number }[],
): Animation {
  const animation = new Animation(
    name,
    property,
    60,
    Animation.ANIMATIONTYPE_FLOAT,
    loop,
  );
  animation.setKeys(keys);
  const ease = new SineEase();
  ease.setEasingMode(EasingFunction.EASINGMODE_EASEINOUT);
  animation.setEasingFunction(ease);
  return animation;
}

/**
 * Standing still: a left-right shudder, rocking the car on its springs.
 */
function idleClip(): Animation[] {
  const F = IDLE_FRAMES;
  const { swing } = ANIM.idle;

  return [
    clip("idle.rotZ", "rotation.z", Animation.ANIMATIONLOOPMODE_CYCLE, [
      { frame: 0, value: 0 },
      { frame: F * 0.25, value: swing },
      { frame: F * 0.5, value: 0 },
      { frame: F * 0.75, value: -swing },
      { frame: F, value: 0 },
    ]),
    clip("idle.rotY", "rotation.y", Animation.ANIMATIONLOOPMODE_CYCLE, [
      { frame: 0, value: 0 },
      { frame: F * 0.25, value: swing / 1.5 },
      { frame: F * 0.5, value: 0 },
      { frame: F * 0.75, value: -swing / 1.5 },
      { frame: F, value: 0 },
    ]),
    clip("idle.scalingY", "scaling.y", Animation.ANIMATIONLOOPMODE_CYCLE, [
      { frame: 0, value: 1 },
      { frame: F * 0.25, value: 1 + swing * 2 },
      { frame: F * 0.5, value: 1 },
      { frame: F * 0.75, value: 1 + swing * 2 },
      { frame: F, value: 1 },
    ]),
  ];
}

/**
 * Pulling up: the nose slopes down hard, rebounds past level, and settles.
 *
 * Positive rotation.x pitches the car's +Z nose downward, so `dip` is the amount
 * the front end drops.
 */
function brakeClip(): Animation[] {
  const F = BRAKE_FRAMES;
  const { dip } = ANIM.brake;

  return [
    clip("brake.rotX", "rotation.x", Animation.ANIMATIONLOOPMODE_CONSTANT, [
      { frame: 0, value: 0 },
      { frame: F * BRAKE_PEAK, value: dip },
      { frame: F * 0.55, value: -dip * 0.35 },
      { frame: F * 0.78, value: dip * 0.15 },
      { frame: F, value: 0 },
    ]),
    clip("brake.scalingY", "scaling.z", Animation.ANIMATIONLOOPMODE_CONSTANT, [
      { frame: 0, value: 1 },
      { frame: F * BRAKE_PEAK, value: .85 },
      { frame: F * 0.55, value: 1.05 },
      { frame: F, value: 1 },
    ]),
  ];
}

/**
 * Pulling away: the mirror of the dive.
 *
 * Negative rotation.x pitches the nose up, so the car squats on its back wheels
 * as it sets off and then settles. The keyframes are the brake's, reflected and
 * stretched out — a later peak and a much smaller rebound — because a standing
 * start should look smooth where a stop looks abrupt.
 */
function moveClip(): Animation[] {
  const F = MOVE_FRAMES;
  const { lift } = ANIM.move;

  return [
    clip("move.lift", "rotation.x", Animation.ANIMATIONLOOPMODE_CONSTANT, [
      { frame: 0, value: 0 },
      { frame: F * MOVE_PEAK, value: -lift },
      { frame: F * 0.62, value: lift * 0.22 },
      { frame: F * 0.84, value: -lift * 0.07 },
      { frame: F, value: 0 },
    ]),
    clip("move.scalingZ", "scaling.z", Animation.ANIMATIONLOOPMODE_CONSTANT, [
      { frame: 0, value: 1 },
      { frame: F * MOVE_PEAK, value: 1.15 },
      { frame: F, value: 1 },
    ]),
  ];
}
