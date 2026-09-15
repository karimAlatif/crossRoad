import {
  Color4,
  DynamicTexture,
  ParticleSystem,
  Vector3,
  type Scene,
} from "@babylonjs/core";
import { grow } from "./carEffects";
import { CRASH } from "./config";

export type CrashEffects = {
  burst: (at: Vector3) => void;
  puff: (at: Vector3) => void;
  dispose: () => void;
};

/**
 * The cartoon impact: a white flash, a spray of sparks and a slow smoke puff.
 * The sparks are tuned in `CRASH.sparks`.
 * All three share one generated dot texture, so nothing is downloaded.
 */
export function createCrashEffects(scene: Scene): CrashEffects {
  const dot = softDot(scene);

  const flash = system(scene, "crash.flash", dot, 12);
  flash.minSize = 2.4;
  flash.maxSize = 5.2;
  flash.minLifeTime = 0.1;
  flash.maxLifeTime = 0.22;
  flash.color1 = new Color4(1, 0.98, 0.8, 1);
  flash.color2 = new Color4(1, 0.75, 0.3, 1);
  flash.createSphereEmitter(0.2);
  flash.minEmitPower = 0.4;
  flash.maxEmitPower = 1.2;

  // The sparks that used to come off a car pulling away, moved here: fast, hot
  // and heavy, flung out in every direction and dragged straight back down.
  const sparks = system(scene, "crash.sparks", dot, CRASH.sparks.capacity);
  grow(sparks, CRASH.sparks.size);
  sparks.minLifeTime = 0.2;
  sparks.maxLifeTime = 0.55;
  sparks.color1 = new Color4(1, 0.95, 0.62, 1);
  sparks.color2 = new Color4(1, 0.5, 0.14, 1);
  sparks.colorDead = new Color4(0.8, 0.2, 0.04, 0);
  sparks.gravity = new Vector3(0, -26, 0);
  sparks.createSphereEmitter(0.6);
  sparks.minEmitPower = 4;
  sparks.maxEmitPower = 11;

  const smoke = system(scene, "crash.smoke", dot, 40);
  smoke.minSize = 1;
  smoke.maxSize = 2.6;
  smoke.minLifeTime = 0.7;
  smoke.maxLifeTime = 1.5;
  smoke.color1 = new Color4(0.95, 0.95, 1, 0.75);
  smoke.color2 = new Color4(0.72, 0.76, 0.85, 0.5);
  smoke.colorDead = new Color4(0.8, 0.84, 0.9, 0);
  smoke.blendMode = ParticleSystem.BLENDMODE_STANDARD;
  smoke.gravity = new Vector3(0, 1.6, 0);
  smoke.createSphereEmitter(0.7);
  smoke.minEmitPower = 1;
  smoke.maxEmitPower = 3;

  const fire = (particles: ParticleSystem, at: Vector3, count: number) => {
    (particles.emitter as Vector3).copyFrom(at);
    particles.manualEmitCount = count;
  };

  return {
    burst: (at) => {
      fire(flash, at, 6);
      fire(sparks, at, CRASH.sparks.count);
      fire(smoke, at, 18);
    },
    puff: (at) => fire(smoke, at, 22),
    dispose: () => {
      flash.dispose();
      sparks.dispose();
      smoke.dispose();
      dot.dispose();
    },
  };
}

function system(
  scene: Scene,
  name: string,
  texture: DynamicTexture,
  capacity: number,
): ParticleSystem {
  const particles = new ParticleSystem(name, capacity, scene);
  particles.particleTexture = texture;
  particles.emitter = new Vector3();
  particles.blendMode = ParticleSystem.BLENDMODE_ADD;
  // Bursts only: emitRate stays at zero and manualEmitCount does the work.
  particles.emitRate = 0;
  particles.updateSpeed = 0.014;
  particles.start();
  return particles;
}

function softDot(scene: Scene): DynamicTexture {
  const size = 64;
  const texture = new DynamicTexture("crash.dot", size, scene, false);
  const ctx = texture.getContext() as CanvasRenderingContext2D;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.4, "rgba(255,255,255,0.6)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  texture.update();
  texture.hasAlpha = true;
  return texture;
}
