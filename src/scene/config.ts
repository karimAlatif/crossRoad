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

/** The city model, served from `public/models/`. */
export const ASSET_URL = "/models/scene.glb";

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
  direction: new Vector3(-0.42, -0.62, 0.36),
  color: new Color3(0.62, 0.74, 1.0),
  intensity: 0.58,
  shadow: {
    mapSize: 1536,
    cascades: 2,
    lambda: 0.86,
    maxZ: 110,
    darkness: 0.34,
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
  skyColor: new Color3(0.2, 0.26, 0.42),
  groundColor: new Color3(0.07, 0.07, 0.11),
  intensity: 0.55,
} as const;

export const SKY = {
  turbidity: 8,
  luminance: 0.22,
  rayleigh: 0.35,
  mieCoefficient: 0.006,
  mieDirectionalG: 0.82,
  /**
   * Height of the sky's own sun. Negative puts it under the horizon, which is
   * what turns the dome to night; nearer zero leaves more dusk glow low down.
   */
  sunElevation: -0.18,
  size: 900,
  /** Resolution of the cube baked off the sky dome and used as the IBL. */
  probeSize: 256,
  /** How much the baked sky contributes to ambient + reflections. */
  environmentIntensity: 0.52,
};

/** Haze that dissolves the far city and keeps the eye on the junction. */
/**
 * Night haze. Turn `density` up and the far blocks dissolve into the dark, which
 * both frames the junction and hides how little is lit out there; turn it down
 * and the whole city stays visible.
 *
 * `color` is what the distance fades *to*, so it doubles as the colour of the
 * night itself — keep it close to CLEAR_COLOR or the horizon shows a seam.
 */
export const FOG = {
  enabled: true,
  color: new Color3(0.05, 0.07, 0.14),
  density: 0.011,
};

/** Matches the sky horizon, so any sliver the dome misses is invisible. */
export const CLEAR_COLOR = new Color4(0.028, 0.035, 0.07, 1);

export const POST = {
  bloom: { weight: 0.45, threshold: 0.75, kernel: 64, scale: 0.6 },
  /** Tilt-shift: shallow depth of field is what makes a city read as a toy. */
  dof: { fStop: 1.4, focalLength: 62, blurLevel: 0 },
  image: { exposure: 1.15, contrast: 1.28, saturation: 40, vignetteWeight: 2.6 },
  sharpen: { edgeAmount: 0.22, colorAmount: 1.0 },
  grain: 4,
  chromaticAberration: 3.5,
  ssao: { strength: 1.15, radius: 1.6, samples: 16, maxZ: 260 },
  glow: 0.9,
} as const;

/** Synty's Unity export writes emissiveFactor = 0, which kills the window glow
 *  baked into `Emissive_01.jpg`. We put it back — this is the night-window /
 *  neon-sign sparkle that bloom then picks up. */
export const EMISSIVE_REVIVE = new Color3(1, 0.87, 0.62);
export const EMISSIVE_STRENGTH = 1.25;

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
  carsPerWave: { min: 1, max: 8 },
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
  breakTime: { min: 1, max: 1.5 },
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
  spawnGap: { min: 2, max: 30 },
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
  /**
   * The spray of sparks thrown out on impact.
   *
   *   capacity  sparks alive at once, across every crash on the road
   *   count     sparks per impact
   *   size      how big a spark starts and ends, in metres
   */
  sparks: { capacity: 800, count: 45, size: { min: 8, max: 16 } },
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

/* -------------------------------------------------------- car particle FX -- */

/**
 * A particle effect for each of the three clips a car can play.
 *
 * There is one ParticleSystem behind each of these, shared by every car on the
 * road — they are all bursts, and a burst reads its position at the instant it
 * fires, so one system can throw smoke under a different car every frame. The
 * whole lot costs three draw calls whether ten cars are running or a hundred.
 * `capacity` is the ceiling on particles alive at once across the *fleet*, so it
 * is the one number here that decides how much this can ever cost.
 *
 * The timing is not set here. Each one-shot fires twice — once as the clip
 * starts and once at the moment the pose peaks — and those moments are worked
 * out from the keyframes and playback speed in ANIM, so retuning a clip carries
 * the smoke with it.
 */
export const CAR_FX = {
  enabled: true,

  /**
   * `idle` — a soft breath out of the back of a stopped car.
   *
   * One source, behind the car and low, halfway across between the two
   * `backLamp` markers. Deliberately faint and simple: every car waiting at the
   * lights is doing it at once.
   *
   *   every   seconds between breaths
   *   count   particles per breath
   *   size    how big a particle starts and how far it has spread when it dies
   *   spread  how loosely it drifts
   */
  idle: { capacity: 200, every: 0.35, count: 2, size: { min: 0.15, max: 0.8 }, spread: 0.15 },

  /**
   * `move` — the getaway cloud, out from under a car that sets off.
   *
   * Skid marks and the light trail are not part of this: every moving car has
   * those — see SKID_MARK and LIGHT_TRAIL.
   *
   *   count   lobes as the wheels bite
   *   after   more lobes at the top of the nose lift
   */
  move: {
    smoke: { capacity: 40, count: 10, after: 20, size: { min: .8, max: 1.5 }, spread: 1.3 },
  },

  /**
   * `brake` — the same cloud as `move`, thrown out ahead of the car instead of
   * behind it. Its own numbers, so the two can be tuned apart; they start equal.
   *
   *   count   lobes as the brakes go on
   *   after   more lobes at the bottom of the dive
   */
  brake: {
    smoke: { capacity: 20, count: 2, after: .25, size: { min: 1.5, max: 2 }, spread: 1 , maxPower: 2},
  },
};


/* --------------------------------------------------------------- skid marks -- */

/**
 * Rubber on the tarmac behind every car that sets off.
 *
 * Two lines, on the ground under the `backLamp` `left` and `right` markers, held
 * on to the car: the newest part of each line stretches from where it began to
 * wherever the car is now, so the mark runs right up to the back of the car.
 *
 * Every range is drawn fresh for each car each time it sets off — from the
 * lights, or onto the road — so no two cars lay quite the same rubber.
 *
 *   delay     seconds after setting off before the rubber starts
 *   duration  seconds it keeps going
 *   width     metres
 *   seconds   how long the rubber stays on the road
 *   every     metres per segment. Shorter follows the car more smoothly and
 *             uses more of the pool
 *   height    how far off the tarmac it lies — enough not to flicker against it
 *   strength  0 to 1, how dark
 *   fade      the last fraction of its life, over which it narrows away
 *   pool      segments down at once
 */
export const SKID_MARK = {
  enabled: true,
  delay: { min: 0.05, max: 0.3 },
  duration: { min: 0.3, max: 0.9 },
  width: { min: 0.22, max: 0.34 },
  seconds: { min: 4, max: 8 },
  every: 1.5,
  height: 0.05,
  colour: new Color3(0, 0, 0),
  strength: 0.5,
  fade: 0.35,
  pool: 400,
  glowing: false,
};

/* -------------------------------------------------------------- light trail -- */

/**
 * A smear of tail light behind every moving car.
 *
 * One ribbon from each `backLamp` marker, `left` and `right`, at the lamps' own
 * height, held on to the car so it starts right at the lamp. Any car faster than
 * `minSpeed` has one — pulling away from the lights or cruising through.
 *
 * Every range is drawn fresh for each car each time it sets off.
 *
 *   minSpeed  metres per second before a car trails light
 *   width     metres
 *   seconds   how long the light lingers, so how long the trail is: at 20 m/s a
 *             0.1 s trail is two metres
 *   every     metres per segment
 *   strength  0 to 1. Near 1 the additive layers clamp and wash out to white
 *   fade      the last fraction of its life, over which it thins away
 *   pool      segments alive at once. A moving car needs speed x seconds / every
 *             per lamp, plus the one being stretched
 */
export const LIGHT_TRAIL = {
  enabled: true,
  minSpeed: 15,
  width: { min: 0.25, max: 0.5 },
  seconds: { min: 0.01, max: 0.08 },
  every: 0.3,
  colour: new Color3(1, 0.3, 0.1),
  strength: 0.2,
  fade: 5,
  pool: 600,
  glowing: true,
};



/* -------------------------------------------------------------------- sound -- */

/**
 * The game's sound. Every file lives in `public/sounds/` and is written here as
 * a path from the web root:
 *
 *   files: ["/sounds/brake.mp3"]
 *
 * Leave `files` empty until the sound exists; an empty sound is simply silent and
 * costs nothing. List several files and each play picks one at random, which is
 * the easiest way to stop a sound that happens often from getting repetitive.
 * MP3, OGG and WAV all work.
 *
 * Nothing can be heard until the player first clicks or presses a key — browsers
 * do not allow sound before that — so the theme starts on that first click.
 *
 * Sounds that overlap are handled for you:
 *
 *   merge      hits of the same sound closer together than this many seconds
 *              become one, a little louder, rather than a pile of copies. A whole
 *              queue pulling away on one green is one sound, not twelve
 *   maxVoices  how many of this sound can play at once. A new one past the limit
 *              fades out the oldest and takes its place
 *   pitch      each play is sped up or slowed down by a random amount in this
 *              range, so repeats do not sound identical
 *   duck       while this sound plays, the theme drops to `amount` of its volume
 *              for `seconds`, then comes back
 *
 * Volumes are 0 to 1.
 */
export const SOUND = {
  enabled: true,
  /** Everything together. */
  master: 1,
  /** The most sound effects playing at once, across all of them. */
  maxVoices: 12,

  /** Background music, looping for the whole game, faded in over `fadeIn` seconds. */
  theme: { files: [] as string[], volume: 0.6, fadeIn: 2.5 },

  /** A car pulling away from the lights. */
  move: {
    files: [] as string[],
    volume: 0.5,
    maxVoices: 3,
    merge: 0.18,
    pitch: { min: 0.92, max: 1.08 },
  },

  /** A car braking hard. */
  brake: {
    files: [] as string[],
    volume: 0.55,
    maxVoices: 3,
    merge: 0.18,
    pitch: { min: 0.9, max: 1.1 },
  },

  /** Two cars colliding. */
  accident: {
    files: [] as string[],
    volume: 0.9,
    maxVoices: 3,
    merge: 0.06,
    pitch: { min: 0.95, max: 1.05 },
    duck: { amount: 0.45, seconds: 1.2 },
  },

  /**
   * Where a sound happened changes how it sounds, gently.
   *
   *   pan       how far towards the left or right speaker a sound at the edge of
   *             the screen goes. 0 keeps everything centred
   *   near      metres from the junction within which a sound plays at full volume
   *   far       metres at which it has dropped to `quietest`
   */
  space: { pan: 0.6, near: 18, far: 70, quietest: 0.3 },
};

/* --------------------------------------------------------------- headlights -- */

/**
 * Car lights.
 *
 * None of these is a real light. A Babylon light is priced per *material*, not
 * per light, so thirty headlights would recompile every shader in the city for
 * thirty lights and pay for all of them on every pixel. These are additive
 * planes instead, and every car after the first instances the same few meshes —
 * so the whole fleet costs a handful of draw calls however many cars there are.
 *
 * Colour is baked into each light's texture rather than set on its material,
 * because StandardMaterial *adds* an emissive texture to `emissiveColor` and
 * clamps the sum: a white texture pins the result to white whatever colour it is
 * given. That is also why `brightness` stops being useful above 1 — past there
 * the shader clamps and the hue washes out.
 */
export const HEADLIGHT = {
  enabled: true,

  /** Warm gold at the front, deep red at the back. */
  frontColour: new Color3(1, 0.68, 0.3),
  backColour: new Color3(1, 0.12, 0.04),

  /**
   * The cone of light each headlamp throws down the road. There are two, one per
   * lamp, so this is the size of *one* of them.
   *
   * It begins at the bumper — not a little way in front of it — as a narrow spot
   * the width of the lamp, and fans out from there.
   *
   *   length     how far down the road it reaches, in metres
   *   startWidth how wide it is where it leaves the car, in metres
   *   endWidth   how wide it has opened out to at the far end, in metres
   *   fade       where along its length it has died away, 0 to 1: lower ends it
   *              sooner, which is what keeps the far end soft instead of cut off
   *   brightness 0 to 1
   *   follow     how far the pool slides as the car pitches, in metres per
   *              radian. The beams always swing with the car's yaw; they cannot
   *              also tilt with its nose, because a flat cone tipped by a 0.45
   *              rad dive ends up under the road. Sliding is what a real dipping
   *              headlight does anyway: a dive throws the light short and pulls
   *              the pool in towards the bumper. 0 pins it.
   */
  beam: { length: 6, startWidth: 0.45, endWidth: 5.5, fade: 0.9, brightness: 0.8, follow: 3 },

  /**
   * Where the lamps sit on each car.
   *
   * Taken from marker nodes in the model. The cars are different shapes, so a
   * position measured off the bumper is only ever right for some of them — a
   * taxi's headlamps and a van's are not in the same place, and nothing in a
   * bounding box knows that. A marked car carries a `forntLamp` and a `backLamp`
   * node, each with a `left` and a `right` child, and a lamp goes at each of the
   * four, exactly where the marker is. Nothing is added to those positions.
   *
   *   SM_Veh_Car_Taxi_03
   *     forntLamp → left, right      a headlamp at each
   *     backLamp  → left, right      a rear lamp at each
   *
   * `front` really is spelled "forntLamp": that is the name in scene.glb. Fix it
   * in the model and this string has to follow, or the marked cars quietly drop
   * back to the measured fallback below.
   *
   * 8 of the 20 models carry markers. The other 12 fall back to positions
   * measured off their own bounding box — see `lampMounts` in carFactory.ts —
   * so the two can coexist: export a car with markers and it starts using them
   * with nothing else to change.
   */
  mounts: { front: "forntLamp", back: "backLamp", left: "left", right: "right" },

  /**
   * The glow at each lamp. The same size and brightness front and back; only the
   * colour differs, so there is one set of numbers to tune rather than two.
   *
   *   size   width of the glow in metres
   *   apart  fallback spacing either side of the centreline, as a fraction of
   *          the car's own width. Only unmarked models use it
   *   tilt   which way the glow faces: 0 lies it flat on its back, 1 stands it
   *          upright facing down the road.
   *
   *          Flat, it sits in the same plane as the road and the bonnet, so it
   *          reads as a stain on the paintwork rather than a lamp. Upright, it
   *          stands proud of the bodywork and reads as a bulb — but it turns
   *          with the car, so a car crossing the view shows it more edge-on.
   *
   *          Measured against this camera, the fraction of a lamp it can see is
   *          about half at 0 whichever road the car is on; at 1 it is 0.79 for
   *          cars coming up the near road and 0.31 for cars crossing. 0.8 is the
   *          evenest of the standing values (0.59 / 0.48). The ones to avoid are
   *          in the middle: around 0.4 a lamp on the far road goes edge-on and
   *          all but disappears.
   *   brightness 0 to 1
   */
  lamp: { size: 0.8, apart: 0.64, tilt: 1, brightness: 1 },

  /**
   * A dodgy connection on a few cars: their headlamps stutter on and off.
   *
   * Only the headlamps do this, and a lamp always takes its beam with it — a
   * cone of light left lying on the road under a lamp that has just gone out is
   * the one thing that would give the trick away.
   *
   *   cars    how much of the fleet has a fault at all, 0 to 1. 0 turns it off
   *   both    of those cars, how many lose both lamps rather than just one
   *   steady  seconds of normal light between bouts (a range)
   *   stutter how long one bout lasts, in seconds (a range)
   *   rate    on-off flickers per second during a bout. Higher reads as a loose
   *           contact, lower as a lamp on its way out
   */
  flicker: {
    cars: 0.25,
    both: 0.4,
    steady: { min: 1.2, max: 6 },
    stutter: { min: 0.3, max: 0.75 },
    rate: 14,
  },
};

/* ------------------------------------------------------------- street lamps -- */

/**
 * The city's own lamp posts, lit the same way the cars are: additive planes
 * instanced off one source each, no real lights.
 *
 * Their positions are not guessed. Every `SM_Prop_LightPole_Base` in the .glb
 * carries a child node named `spot`, sitting at the end of the arm where the
 * lamp actually hangs — so the light goes exactly where the model says it should.
 */
export const STREET_LAMP = {
  enabled: true,

  /** The node inside each lamp post that marks where its light belongs. */
  marker: "spot",

  /** Warm sodium. */
  colour: new Color3(1, 0.62, 0.22),

  /** The glow at the lamp head itself. `size` is its diameter in metres. */
  bulb: { size: 2.4, brightness: 1 },

  /**
   * The pool it casts on the ground below.
   *
   *   height  how far off the ground it lies — enough to clear a kerb
   */
  pool: { size: 9, height: 0.12, brightness: 0.62 },

  /**
   * Lamps on their way out. Same idea as the cars' headlamps, but slower and
   * rarer: a street lamp that stuttered as often as a loose car connection
   * would pull the eye away from the junction.
   *
   * A lamp's bulb and the pool under it always go dark together.
   *
   *   lamps   how many of the posts are faulty, 0 to 1. 0 turns it off
   *   steady  seconds of normal light between bouts (a range)
   *   stutter how long one bout lasts, in seconds (a range)
   *   rate    on-off flickers per second during a bout
   */
  flicker: {
    lamps: 0.3,
    steady: { min: 3, max: 11 },
    stutter: { min: 0.2, max: 0.9 },
    rate: 9,
  },
};
