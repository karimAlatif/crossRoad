import { Animation, EasingFunction, SineEase } from "@babylonjs/core";
import { ANIM } from "./config";

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

export function createCarClips(): CarClips {
  return { idle: idleClip(), brake: brakeClip(), move: moveClip() };
}

export const IDLE_LENGTH = IDLE_FRAMES;

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
    clip("idle.shake", "rotation.z", Animation.ANIMATIONLOOPMODE_CYCLE, [
      { frame: 0, value: 0 },
      { frame: F * 0.25, value: swing },
      { frame: F * 0.5, value: 0 },
      { frame: F * 0.75, value: -swing },
      { frame: F, value: 0 },
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
    clip("brake.dip", "rotation.x", Animation.ANIMATIONLOOPMODE_CONSTANT, [
      { frame: 0, value: 0 },
      { frame: F * 0.22, value: dip },
      { frame: F * 0.55, value: -dip * 0.35 },
      { frame: F * 0.78, value: dip * 0.15 },
      { frame: F, value: 0 },
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
      { frame: F * 0.3, value: -lift },
      { frame: F * 0.62, value: lift * 0.22 },
      { frame: F * 0.84, value: -lift * 0.07 },
      { frame: F, value: 0 },
    ]),
  ];
}
