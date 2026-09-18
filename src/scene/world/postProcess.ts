import {
  ColorCurves,
  Color4,
  DefaultRenderingPipeline,
  DepthOfFieldEffectBlurLevel,
  ImageProcessingConfiguration,
  type ArcRotateCamera,
  type Mesh,
  type Scene,
} from "@babylonjs/core";
import { POST } from "../config";
import type { Clock } from "../core/frame";
import type { Disposable } from "../core/types";
import { graphics, mobileLift } from "../quality";

export type PostFx = Disposable & {
  pipeline: DefaultRenderingPipeline;
  /** Opts a mesh into the glow layer, which is restricted to the signal. */
  addGlowing: (mesh: Mesh) => void;
  /** Re-reads the graphics level. Called when the governor gives one up. */
  apply: () => void;
};

/**
 * The look: bloom, tilt-shift, grade, vignette — and the bill for it.
 *
 * Everything here is a full-screen pass or two, which is to say everything here
 * is paid per pixel. `POST` holds what each effect looks like and the graphics
 * level holds whether it runs at all and how big its buffers are, so the same
 * grade survives on a phone with fewer and smaller passes behind it.
 */
export function createPostProcess(scene: Scene, clock: Clock, camera: ArcRotateCamera): PostFx {
  const pipeline = new DefaultRenderingPipeline("beauty", true, scene, [camera]);
  pipeline.fxaaEnabled = true;

  pipeline.bloomThreshold = POST.bloom.threshold;
  pipeline.bloomWeight = POST.bloom.weight;

  // Tilt-shift. Shallow focus is the single biggest cue that turns a city block
  // into a toy set, and the most expensive thing in this file.
  pipeline.depthOfFieldBlurLevel = DepthOfFieldEffectBlurLevel.Low as number;
  pipeline.depthOfField.fStop = POST.dof.fStop;
  pipeline.depthOfField.focalLength = POST.dof.focalLength;
  pipeline.depthOfField.focusDistance = camera.radius * 1000;

  pipeline.sharpen.edgeAmount = POST.sharpen.edgeAmount;
  pipeline.sharpen.colorAmount = POST.sharpen.colorAmount;

  pipeline.grain.intensity = POST.grain;
  pipeline.grain.animated = true;

  pipeline.chromaticAberration.aberrationAmount = POST.chromaticAberration;
  pipeline.chromaticAberration.radialIntensity = 0.6;

  // Grade: filmic roll-off, punchy contrast, warm highlights against cool shade.
  const ip = pipeline.imageProcessing;
  ip.toneMappingEnabled = true;
  ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  ip.exposure = POST.image.exposure * mobileLift("exposure");
  ip.contrast = POST.image.contrast;

  const curves = new ColorCurves();
  curves.globalSaturation = POST.image.saturation;
  curves.highlightsHue = 40;
  curves.highlightsDensity = 22;
  curves.highlightsSaturation = 12;
  curves.shadowsHue = 220;
  curves.shadowsDensity = 26;
  curves.midtonesSaturation = 8;
  ip.colorCurves = curves;
  ip.colorCurvesEnabled = true;

  ip.vignetteEnabled = true;
  ip.vignetteWeight = POST.image.vignetteWeight;
  ip.vignetteStretch = 0.35;
  ip.vignetteCameraFov = camera.fov;
  ip.vignetteColor = new Color4(0.05, 0.06, 0.12, 0);

  /** Everything the graphics level has an opinion about, in one place. */
  const apply = () => {
    pipeline.samples = graphics.msaa;

    const bloom = graphics.bloom;
    pipeline.bloomEnabled = bloom !== null;
    if (bloom) {
      // Assigning either of these rebuilds the blur chain, so only on a change.
      if (pipeline.bloomKernel !== bloom.kernel) pipeline.bloomKernel = bloom.kernel;
      if (pipeline.bloomScale !== bloom.scale) pipeline.bloomScale = bloom.scale;
    }

    pipeline.glowLayerEnabled = graphics.glow;
    if (pipeline.glowLayer) pipeline.glowLayer.intensity = POST.glow;

    pipeline.depthOfFieldEnabled = graphics.depthOfField;
    pipeline.sharpenEnabled = graphics.sharpen;
    pipeline.grainEnabled = graphics.grain;
    pipeline.chromaticAberrationEnabled = graphics.chromaticAberration;
  };

  apply();

  // Both the camera's distance and its lens answer to the screen the game is on
  // (see `camera.ts#fitToScreen`), and two effects here are drawn in their terms:
  // the tilt-shift focuses at the camera's radius, and the vignette is shaped by
  // its field of view. One tick keeps both honest, and the lens is compared
  // before it is written because assigning it rebuilds the grade's uniforms.
  let lens = camera.fov;
  const stopFollow = clock.each(() => {
    if (graphics.depthOfField) pipeline.depthOfField.focusDistance = camera.radius * 1000;
    if (camera.fov === lens) return;
    lens = camera.fov;
    ip.vignetteCameraFov = lens;
  });

  return {
    pipeline,
    // Babylon treats an empty include list as "every mesh", so the first call
    // here is also what switches the glow layer from city-wide to signal-only.
    // Left unrestricted it re-renders most of the city — every window emissive —
    // into its own buffer, for a halo only the traffic light needs.
    addGlowing: (mesh) => pipeline.glowLayer?.addIncludedOnlyMesh(mesh),
    apply,
    dispose: () => {
      stopFollow();
      pipeline.dispose();
    },
  };
}
