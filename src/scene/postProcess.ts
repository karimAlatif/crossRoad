import {
  ColorCurves,
  Color4,
  DefaultRenderingPipeline,
  DepthOfFieldEffectBlurLevel,
  ImageProcessingConfiguration,
  SSAO2RenderingPipeline,
  type ArcRotateCamera,
  type Mesh,
  type Scene,
} from "@babylonjs/core";
import { POST, QUALITY } from "./config";

export type PostFx = {
  pipeline: DefaultRenderingPipeline;
  ssao: SSAO2RenderingPipeline | null;
  /** Opts a mesh into the glow layer when it is restricted to the signal. */
  addGlowing: (mesh: Mesh) => void;
  setDepthOfField: (on: boolean) => void;
  setAmbientOcclusion: (on: boolean) => void;
  dispose: () => void;
};

export function createPostProcess(scene: Scene, camera: ArcRotateCamera): PostFx {
  // Contact darkening, when it is switched on: SSAO runs before the beauty
  // pipeline so bloom and grading see an already-grounded image. It costs a
  // whole extra geometry pass, so QUALITY decides whether it is built at all.
  let ssao: SSAO2RenderingPipeline | null = null;
  if (QUALITY.ambientOcclusion) {
    ssao = new SSAO2RenderingPipeline("ssao", scene, { ssaoRatio: 0.5, blurRatio: 1 }, [camera]);
    ssao.totalStrength = POST.ssao.strength;
    ssao.radius = POST.ssao.radius;
    ssao.samples = POST.ssao.samples;
    ssao.maxZ = POST.ssao.maxZ;
    ssao.minZAspect = 0.25;
    ssao.expensiveBlur = false;
    ssao.base = 0.1;
  }

  const pipeline = new DefaultRenderingPipeline("beauty", true, scene, [camera]);

  // FXAA alone. Stacking MSAA on top costs a full resolve for a difference you
  // cannot see once bloom and the tilt-shift have run.
  pipeline.samples = QUALITY.msaa;
  pipeline.fxaaEnabled = true;

  // Bloom off the revived window emissives and the sun hitting glass.
  pipeline.bloomEnabled = true;
  pipeline.bloomThreshold = POST.bloom.threshold;
  pipeline.bloomWeight = POST.bloom.weight;
  pipeline.bloomKernel = POST.bloom.kernel;
  pipeline.bloomScale = POST.bloom.scale;

  pipeline.glowLayerEnabled = true;
  if (pipeline.glowLayer) pipeline.glowLayer.intensity = POST.glow;

  pipeline.sharpenEnabled = true;
  pipeline.sharpen.edgeAmount = POST.sharpen.edgeAmount;
  pipeline.sharpen.colorAmount = POST.sharpen.colorAmount;

  // Tilt-shift. Shallow focus is the single biggest cue that turns a city block
  // into a toy set, which is the look we want for the game.
  pipeline.depthOfFieldEnabled = QUALITY.depthOfField;
  pipeline.depthOfFieldBlurLevel = DepthOfFieldEffectBlurLevel.Low as number;
  pipeline.depthOfField.fStop = POST.dof.fStop;
  pipeline.depthOfField.focalLength = POST.dof.focalLength;
  pipeline.depthOfField.focusDistance = camera.radius * 1000;

  // Grain and chromatic aberration are a full-screen pass each for an effect
  // that barely registers at this scale, so they default to off.
  pipeline.grainEnabled = QUALITY.filmGrain;
  pipeline.grain.intensity = POST.grain;
  pipeline.grain.animated = true;

  pipeline.chromaticAberrationEnabled = QUALITY.chromaticAberration;
  pipeline.chromaticAberration.aberrationAmount = POST.chromaticAberration;
  pipeline.chromaticAberration.radialIntensity = 0.6;

  // Grade: filmic roll-off, punchy contrast, warm highlights against cool shade.
  const ip = pipeline.imageProcessing;
  ip.toneMappingEnabled = true;
  ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  ip.exposure = POST.image.exposure;
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

  // Keep the junction pin-sharp however far the player dollies out.
  const keepFocus = () => {
    pipeline.depthOfField.focusDistance = camera.radius * 1000;
  };
  if (QUALITY.depthOfField) scene.onBeforeRenderObservable.add(keepFocus);

  return {
    pipeline,
    ssao,
    // Babylon treats an empty include list as "every mesh", so the first call
    // here is also what switches the glow layer from city-wide to signal-only.
    addGlowing: (mesh) => {
      if (QUALITY.glowOnlySignal) pipeline.glowLayer?.addIncludedOnlyMesh(mesh);
    },
    setDepthOfField: (on) => (pipeline.depthOfFieldEnabled = on),
    setAmbientOcclusion: (on) => {
      if (!ssao) return;
      // Detaching stops the AO passes outright rather than just muting them.
      const manager = scene.postProcessRenderPipelineManager;
      if (on) manager.attachCamerasToRenderPipeline("ssao", camera, true);
      else manager.detachCamerasFromRenderPipeline("ssao", camera);
    },
    dispose: () => {
      scene.onBeforeRenderObservable.removeCallback(keepFocus);
      ssao?.dispose();
      pipeline.dispose();
    },
  };
}
