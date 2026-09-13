import {
  Animation,
  ArcRotateCamera,
  CubicEase,
  EasingFunction,
  Vector3,
  type Scene,
} from "@babylonjs/core";
import { CAMERA } from "./config";

export function createCamera(scene: Scene, target: Vector3): ArcRotateCamera {
  const camera = new ArcRotateCamera(
    "crossroadCam",
    CAMERA.alpha,
    CAMERA.beta,
    CAMERA.radius,
    target.clone(),
    scene,
  );

  camera.fov = CAMERA.fov;
  camera.minZ = CAMERA.minZ;
  camera.maxZ = CAMERA.maxZ;

  // Keep the player inside the intended shot: orbit and dolly, never duck under
  // the road or drift off the junction.
  camera.lowerRadiusLimit = CAMERA.lowerRadiusLimit;
  camera.upperRadiusLimit = CAMERA.upperRadiusLimit;
  camera.lowerBetaLimit = CAMERA.lowerBetaLimit;
  camera.upperBetaLimit = CAMERA.upperBetaLimit;

  camera.wheelDeltaPercentage = 0.015;
  camera.pinchDeltaPercentage = 0.015;
  camera.useNaturalPinchZoom = true;
  camera.inertia = 0.86;
  camera.angularSensibilityX = 900;
  camera.angularSensibilityY = 900;
  // Panning would let the crossroad slide out of frame — the view is the game.
  camera.panningSensibility = 0;

  return camera;
}

/** Eases the camera from a wide establishing shot down into the game view. */
export function playIntro(camera: ArcRotateCamera, onDone?: () => void): void {
  const ease = new CubicEase();
  ease.setEasingMode(EasingFunction.EASINGMODE_EASEINOUT);

  const fps = 60;
  const frames = Math.round((CAMERA.introDurationMs / 1000) * fps);

  const leg = (property: string, from: number, to: number) => {
    const animation = new Animation(
      `intro_${property}`,
      property,
      fps,
      Animation.ANIMATIONTYPE_FLOAT,
      Animation.ANIMATIONLOOPMODE_CONSTANT,
    );
    animation.setKeys([
      { frame: 0, value: from },
      { frame: frames, value: to },
    ]);
    animation.setEasingFunction(ease);
    return animation;
  };

  // Relax the limits for the duration of the fly-in, then snap them back.
  const lowerBeta = camera.lowerBetaLimit;
  const upperRadius = camera.upperRadiusLimit;
  camera.lowerBetaLimit = null;
  camera.upperRadiusLimit = null;

  camera.animations = [
    leg("alpha", CAMERA.alpha + CAMERA.introAlphaOffset, CAMERA.alpha),
    leg("beta", CAMERA.introBeta, CAMERA.beta),
    leg("radius", CAMERA.introRadius, CAMERA.radius),
  ];

  camera.alpha = CAMERA.alpha + CAMERA.introAlphaOffset;
  camera.beta = CAMERA.introBeta;
  camera.radius = CAMERA.introRadius;

  camera.getScene().beginAnimation(camera, 0, frames, false, 1, () => {
    camera.lowerBetaLimit = lowerBeta;
    camera.upperRadiusLimit = upperRadius;
    onDone?.();
  });
}

/** Returns the camera to the authored game framing. */
export function resetView(camera: ArcRotateCamera, target: Vector3): void {
  const ease = new CubicEase();
  ease.setEasingMode(EasingFunction.EASINGMODE_EASEINOUT);
  camera.setTarget(target.clone());

  const ride = (property: string, to: number) =>
    Animation.CreateAndStartAnimation(
      `reset_${property}`,
      camera,
      property,
      60,
      42,
      (camera as unknown as Record<string, number>)[property],
      to,
      Animation.ANIMATIONLOOPMODE_CONSTANT,
      ease,
    );

  // Take the short way round the circle rather than unwinding a full turn.
  const alpha = CAMERA.alpha + Math.round((camera.alpha - CAMERA.alpha) / (Math.PI * 2)) * Math.PI * 2;
  ride("alpha", alpha);
  ride("beta", CAMERA.beta);
  ride("radius", CAMERA.radius);
}
