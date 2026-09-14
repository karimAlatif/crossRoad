import { Color3, Color4, Vector3 } from "@babylonjs/core";

/**
 * Every visual knob for the crossroad view lives here.
 *
 * The city is the Synty POLYGON City block exported from Unity. Its main
 * intersection sits at glTF (0, 0, -5) — the four `SM_Prop_LightPole_CrossLights`
 * poles mark its corners at (-10,-11), (-6,5), (6,-15) and (10,1). Babylon's glTF
 * loader converts right- to left-handed by parenting everything under a `__root__`
 * node scaled (1, 1, -1), so that centre lands on Babylon world (0, 0, 5).
 *
 * We still resolve the anchor from those poles at runtime (see `city.ts`) so the
 * framing survives a re-export; CROSSROAD is only the fallback.
 */
export const CROSSROAD = new Vector3(0, 0, 5);

/** Names used to locate the intersection in the loaded hierarchy, best first. */
export const CROSSROAD_MARKERS = [
  "SM_Prop_LightPole_CrossLights",
  "SM_Prop_LightPole_CrossButton",
] as const;

/** Top-level group in the .glb holding the 30 traffic vehicles. */
export const CARS_GROUP = "Cars";

export const ASSET_URL = "/scene.glb";

/** The locked-off 3/4 game view, and how far the player may stray from it. */
export const CAMERA = {
  /** Horizontal orbit, radians. Puts the sun off to the left and the crossing in frame. */
  alpha: -Math.PI * 0.62,
  /** Pitch from straight up. ~52° reads as a chunky toy-city view. */
  beta: 1.02,
  radius: 50,
  lowerRadiusLimit: 20,
  upperRadiusLimit: 82,
  /** Never let the camera dip below the street or fly straight overhead. */
  lowerBetaLimit: 0.22,
  upperBetaLimit: 1.32,
  minZ: 0.8,
  maxZ: 900,
  fov: 0.72,
  /** Where the intro fly-in starts. */
  introRadius: 165,
  introBeta: 0.48,
  introAlphaOffset: -0.85,
  introDurationMs: 3200,
} as const;

/** Mid-morning sun: long shadows across the asphalt, warm key, cool sky fill. */
export const SUN = {
  /** Direction the sun *points*, i.e. light travel direction (normalised in code). */
  direction: new Vector3(-0.48, -0.7, 0.33),
  color: new Color3(1.0, 0.95, 0.84),
  intensity: 5.6,
  shadow: {
    mapSize: 1536,
    cascades: 2,
    lambda: 0.86,
    maxZ: 110,
    darkness: 0.22,
    bias: 0.012,
    normalBias: 0.018,
    /** Only meshes within this radius of the crossroad cast shadows. */
    casterRadius: 48,
    /**
     * Shadow casting is paid once per cascade, so the map is worth spending only
     * on geometry that casts a shadow you can actually see. Road tiles, painted
     * markings and sidewalk panels are flat; trash bags, flowers and hydrants are
     * tiny. Both are skipped.
     */
    casterMinHeight: 0.7,
    casterMinFootprint: 1.1,
  },
} as const;

/** Sky-dome bounce light. Keeps shadowed façades blue instead of black. */
export const FILL = {
  skyColor: new Color3(0.62, 0.78, 1.0),
  groundColor: new Color3(0.42, 0.36, 0.3),
  intensity: 0.6,
} as const;

export const SKY = {
  turbidity: 3.4,
  luminance: 1.0,
  rayleigh: 1.6,
  mieCoefficient: 0.006,
  mieDirectionalG: 0.82,
  size: 900,
  /** Resolution of the cube baked off the sky dome and used as the IBL. */
  probeSize: 256,
  /** How much the baked sky contributes to ambient + reflections. */
  environmentIntensity: 1.5,
};

/** Haze that dissolves the far city and keeps the eye on the junction. */
export const FOG = {
  color: new Color3(0.72, 0.83, 0.95),
  density: 0.003,
};

/** Matches the sky horizon, so any sliver the dome misses is invisible. */
export const CLEAR_COLOR = new Color4(0.68, 0.81, 0.95, 1);

export const POST = {
  bloom: { weight: 0.36, threshold: 0.82, kernel: 48, scale: 0.6 },
  /** Tilt-shift: shallow depth of field is what makes a city read as a toy. */
  dof: { fStop: 1.4, focalLength: 62, blurLevel: 0 },
  image: { exposure: 1.5, contrast: 1.25, saturation: 44, vignetteWeight: 1.8 },
  sharpen: { edgeAmount: 0.22, colorAmount: 1.0 },
  grain: 4,
  chromaticAberration: 3.5,
  ssao: { strength: 1.15, radius: 1.6, samples: 16, maxZ: 260 },
  glow: 0.55,
} as const;

/** Synty's Unity export writes emissiveFactor = 0, which kills the window glow
 *  baked into `Emissive_01.jpg`. We put it back — this is the night-window /
 *  neon-sign sparkle that bloom then picks up. */
export const EMISSIVE_REVIVE = new Color3(1, 0.96, 0.88);
export const EMISSIVE_STRENGTH = 0.35;

/* -------------------------------------------------------------------- props -- */

/**
 * Marker hierarchy authored into the `.glb` under the `props` group. Every one
 * of these is a placeholder cube; `props.ts` reads their transforms and hides
 * the geometry.
 *
 *   props
 *     ├── traffic light
 *     ├── roodOne   → start, end
 *     └── roodTwo   → start, end, cross
 */
export const PROPS = {
  group: "props",
  trafficLight: "traffic light",
  roadOne: "roodOne",
  roadTwo: "roodTwo",
  start: "start",
  end: "end",
  cross: "cross",
} as const;

/* ------------------------------------------------------------------ traffic -- */

/**
 * Settings shared by both roads. Everything that differs between them lives in
 * ROAD_ONE and ROAD_TWO below.
 */
export const TRAFFIC = {
  /** The hidden `Cars` group doubles as the model library the traffic clones. */
  carsGroup: "Cars",
  /**
   * How far each row sits either side of its road's centre line — shared, because
   * both roads are painted the same width. 2.5 is where the authored parked cars
   * sit (x = ±2.5 on roodOne, z = ±2.5 on roodTwo), so the rows land in the lanes.
   */
  laneOffset: 2.5,
  /** Hitboxes are shrunk a little so bumper-to-bumper queueing is not a crash. */
  hitboxScale: 0.88,
};

/**
 * The cross traffic. It never stops — not for the signal and not for the car in
 * front — so it has no following model at all: every car simply holds its speed.
 *
 * The gaps the player needs are built in when a car joins the road rather than
 * created by braking, which is why this road cannot rear-end itself.
 */
export const ROAD_ONE = {
  /** How many cars travel together in one wave. */
  carsPerWave: { min: 4, max: 8 },
  /**
   * Cruise speed, drawn once per wave rather than per car.
   *
   * It has to be per wave: this road has no following model, so two cars in the
   * same wave at different speeds would simply drive into each other. Varying it
   * between waves is what keeps the stream from looking metronomic.
   */
  speed: { min: 20, max: 23 },
  /**
   * Seconds of empty road between one wave and the next. This is the window to
   * run the junction in, so it is the main dial for how hard the game is:
   * longer means more room to cross.
   */
  breakTime: { min: 1, max: 2 },
  /**
   * Bumper gap between cars inside a wave, drawn once per wave like `speed`, so
   * one wave runs tight and the next runs loose.
   *
   * The entry point itself is fixed at `max` behind the road's start marker —
   * nothing is ever created further back than that, whichever gap a wave draws.
   *
   * A car takes up about `spawnGap + 5` metres and roodOne is 77 m long, so this
   * also decides whether a wave reads as a clump: around 8 the road holds six
   * cars a row and a wave is plainly a group; at 40 it holds two, and a wave of
   * eight is spread over more road than exists.
   */
  spawnGap: { min: 2, max: 10 },
};

/**
 * The road the signal governs. These cars queue behind the stop line, behind each
 * other, and pull away when the light goes green, so they need the full model.
 */
export const ROAD_TWO = {
  speed: { min: 20, max: 20 },
  /** Bumper-to-bumper distance a queued car keeps. */
  minGap: .85,
  /** Bumper gap left when a car joins the back of the road. */
  spawnGap: 10,
  /** How briskly a car pulls away, in units per second squared. */
  accel: 80,
  /** How hard it can slow down. Needed by `comfort` below. */
  brake: 60,
  /**
   * Fraction of `brake` a driver plans with when deciding how early to slow for
   * the car ahead or for the stop line. Below 1 so there is always braking left
   * in reserve; approach speed is sqrt(2 * brake * comfort * distance), which —
   * unlike a flat gain — still stops in time however fast `speed` is set.
   */
  comfort: 0.7,
};

export const CRASH = {
  /** How long a wreck spins in the road, blocking it, before it poofs away. */
  holdSeconds: 1,
  poofSeconds: 0.45,
  spin: { min: 1.5, max: 3 },
  hop: { min: 2.8, max: 5.2 },
  gravity: 15,
  bounce: 0.45,
};

export const LIGHT = {
  poleHeight: 4.6,
  head: { width: 1.6, height: 3.0, depth: 0.26 },
  lampSize: 0.86,
  lampGap: 0.68,
  haloSize: 3.6,
  red: new Color3(1, 0.17, 0.22),
  green: new Color3(0.32, 1, 0.38),
  /** Emissive level of the lit lamp versus the dark one. */
  onGlow: 1,
  offGlow: 0.06,
  /** Coloured spill the lit lamp throws onto the asphalt. */
  spill: { intensity: 2.6, range: 16 },
  /** Starts red, so opening the junction is something the player does. */
  startsGreen: false,
};

/* ------------------------------------------------------------------ quality -- */

/**
 * The knobs that decide how much work a frame costs. Defaults are tuned for a
 * smooth frame rate rather than maximum fidelity.
 */
export const QUALITY = {
  /** Cap the render resolution: a 2x display would otherwise shade 4x the pixels. */
  maxPixelRatio: 1.5,
  /**
   * Restrict the glow layer to the signal lamps. Left unrestricted it re-renders
   * every mesh with an emissive material — most of the city, once the window
   * emissives are revived — into its own buffer, for a halo only the traffic
   * light actually needs.
   */
  glowOnlySignal: true,
  /** MSAA on top of FXAA buys very little here and costs a full resolve. */
  msaa: 1,
  /**
   * SSAO2 renders its own geometry pass before the beauty pass. The cascaded
   * shadows already ground the scene, so it is off by default.
   */
  ambientOcclusion: false,
  /** The tilt-shift that makes the city read as a toy. Worth its cost. */
  depthOfField: true,
  filmGrain: false,
  chromaticAberration: false,
};

/* ---------------------------------------------------------------- animation -- */

/**
 * Car animation. There are two clips, each an authored keyframe loop played by
 * its own AnimationGroup on its own node.
 *
 * A moving car plays nothing at all — only its wheels turn — so the whole cost
 * of this falls on the handful of cars that are actually stopped at any moment.
 */
export const ANIM = {
  /** Seconds to fade the shake in as a car stops, and out again as it pulls away. */
  blend: 0.25,

  /** Standing still: the car shudders left and right, impatient to go. */
  idle: {
    /** Full left-right shakes per second. Raise it for a more agitated car. */
    speed: .9,
    /** How far it swings to each side, in radians. 0.1 is a clear, readable wiggle. */
    swing: 0.2,
  },

  /** Pulling up: the nose slopes down and springs back out of it. */
  brake: {
    /** Playback rate of the dive. Higher is snappier. */
    speed: .85,
    /** How far the nose drops, in radians. 0.2 is a strong dive. */
    dip: 0.45,
    /**
     * How hard a car must be braking for the dive to play, as a fraction of that
     * road's own `brake` rate. 0.6 means "shedding speed at 60% of flat out".
     *
     * A fraction rather than a deceleration on purpose: an absolute figure has to
     * be kept in step by hand with `ROAD_TWO.brake`, and the moment that rate is
     * retuned the trigger silently becomes far too eager or far too deaf.
     */
    trigger: 0.6,
  },

  /**
   * Pulling away: the mirror of the dive. The nose lifts as the car squats on
   * its back wheels, then settles. Plays once, the moment a stopped car starts
   * moving again — so on roodTwo it is what a green light looks like.
   *
   * Deliberately slower and softer than `brake`: stopping is an event, setting
   * off is a roll.
   */
  move: {
    /** Playback rate of the lift. Lower is smoother. */
    speed: 0.85,
    /** How far the nose rises, in radians. The mirror of `brake.dip`. */
    lift: 0.45,
  },
};
