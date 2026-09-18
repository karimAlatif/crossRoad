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
  /**
   * The one view the game is played from.
   *
   * `alpha` and `beta` are in degrees, the way they read off a scene inspector:
   * alpha swings the camera round the target, beta tilts it down from straight
   * overhead. `target` is a world position — the point the camera looks at, and
   * the point everything orbits.
   */
  view: {
    target: new Vector3(-4, 0, 2),
    alpha: 254,
    beta: 53,
    radius: 50,
  },

  minZ: 0.8,
  maxZ: 900,

  /**
   * The lens, in degrees — the vertical angle — on a screen wide enough not to
   * need any help. This is the tightest the camera will ever be; `frame` below
   * only ever widens it.
   */
  fov: 41,

  /**
   * What must stay in shot, whatever the screen.
   *
   * A phone held upright and a 21:9 monitor cannot show the same picture: with a
   * fixed lens, the narrower the screen the less of the world fits across it. So
   * the frame is fixed and the camera adapts to it — by opening the lens first,
   * which moves nothing, and then, if that is not enough, by stepping straight
   * back along the same line.
   *
   * The catch is that one width cannot serve both shapes. Enough city to fill a
   * wide monitor, guaranteed across a phone held upright, means showing the world
   * three or four times taller than it is wide — and everything shrinks until the
   * junction is a tile in the middle of the screen. A tall screen has height to
   * spare and width to none, so what it has to fit across is the *junction*, not
   * the city; and the extra height it shows is a gift, because it is more of the
   * cross traffic coming, which is the thing the player is actually reading.
   *
   *   width          metres across, at the view's target, that a wide screen
   *                  shows. The desktop framing
   *   portraitWidth  metres across that a tall screen must fit: the junction
   *                  corner to corner, and not a lot more. On a tall screen the
   *                  camera also aims at the junction's own centre rather than
   *                  `view.target`, which is a wide-screen composition and sits
   *                  off to one side — so the junction is framed tightly without
   *                  losing an edge. Lower is closer: at 35 it fills 86% of an
   *                  upright phone's width with the signal and the first waiting
   *                  cars still in view; much below 33 the queue starts to leave
   *                  the frame. Screens between the two shapes blend smoothly, so
   *                  rotating a tablet never jumps
   *   height         metres top to bottom that any screen shows
   *   maxFov         the widest the lens may open, in degrees, before the camera
   *                  steps back instead. It looks down at 37°, so past about 74°
   *                  the top of the frame climbs over the horizon into sky — and
   *                  well before that a wide lens starts to look like a fisheye,
   *                  which is what "too far away" on a phone really was
   */
  frame: {
    width: 82,
    portraitWidth: 35,
    height: 32,
    maxFov: 70,
  },

  /**
   * The opening shot.
   *
   * The move is authored in the model: a `cameraPath` node holding a `start`, an
   * `end` and a `view`. The camera drives from `start` to `end`, turns onto the
   * `view` marker on the way, and then eases into the view above. If the model
   * has no such node the fly-in happens anyway, from a wide establishing shot
   * worked out from the view itself.
   *
   *   flySeconds     time spent driving from `start` to `end`
   *   lookAhead      metres past the end of the path that the camera watches
   *                  while it drives. This is what makes the opening a drive up
   *                  the street rather than a slow approach to a junction that
   *                  is already in frame
   *   turnAt         how far through the drive the camera starts turning onto
   *                  the `view` marker, 0 to 1. At 0.8 it spends the last fifth
   *                  of the drive swinging the crossroad into frame, so it is
   *                  already looking at it when it arrives. The drive itself is
   *                  untouched by this — only the direction the camera faces
   *   settleSeconds  time spent rising off the road into the view above, the
   *                  look-at easing the rest of the way onto `view.target`
   *   fallback       the establishing shot used when the model has no path.
   *                  `alphaOffset` and `beta` are degrees
   */
  intro: {
    group: "cameraPath",
    start: "start",
    end: "end",
    view: "view",
    flySeconds: 3,
    lookAhead: 30,
    turnAt: 0.01,
    settleSeconds: .6,
    fallback: { alphaOffset: -49, beta: 27, radius: 165 },
  },

  /**
   * Pins the camera on the view once the intro is over: inputs removed, limits
   * closed onto the exact angles it holds. Nothing moves it after that.
   */
  locked: true,
};

/** Mid-morning sun: long shadows across the asphalt, warm key, cool sky fill. */
export const SUN = {
  /** Direction the sun *points*, i.e. light travel direction (normalised in code). */
  direction: new Vector3(-0.42, -0.62, 0.36),
  color: new Color3(0.62, 0.74, 1.0),
  intensity: 0.58,
  shadow: {
    /** Map size and cascade count are per device: see `GRAPHICS.levels`. */
    lambda: 0.86,
    maxZ: 110,
    darkness: 0.34,
    bias: 0.012,
    normalBias: 0.018,
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
  skyColor: new Color3(0.24, 0.3, 0.46),
  groundColor: new Color3(0.12, 0.12, 0.16),
  intensity: 0.50,
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
};

/**
 * The light the world itself gives off — and the reason the streets are legible.
 *
 * Every surface in the city is PBR, and a PBR surface takes most of its light
 * from its environment rather than from lights. At night that environment is
 * three things: the sky overhead, the warm band along the horizon where a city
 * throws its light back off the haze, and the dark bounce off the asphalt. Take
 * it away and only the things that light themselves survive — windows, signs,
 * headlamps — which is exactly how this scene used to look on some devices, when
 * the sky probe it used to be baked from came back black. See `world/ambient.ts`.
 *
 * These are *linear* colours, not sRGB, so they read darker here than they look.
 *
 *   sky        straight up
 *   horizon    at eye level. A road's normal points at the sky, so this and
 *              `sky` are what actually brighten the streets — and a warm horizon
 *              against a cold sky is most of the night-city atmosphere
 *   ground     straight down: what the asphalt bounces back
 *   intensity  the whole thing at once. The single knob for "brighter"
 *   size       the cube's edge in pixels. It is only ever seen as a reflection
 *              in rough surfaces, so it does not need to be big; 32 is a few
 *              kilobytes and a couple of milliseconds to build
 */
export const AMBIENT = {
  sky: new Color3(0.1, 0.14, 0.27),
  horizon: new Color3(0.3, 0.23, 0.18),
  ground: new Color3(0.05, 0.05, 0.07),
  intensity: 1,
  size: 64,
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
  density: 0.0085,
};

/** Matches the sky horizon, so any sliver the dome misses is invisible. */
export const CLEAR_COLOR = new Color4(0.028, 0.035, 0.07, 1);

export const POST = {
  bloom: { weight: 0.45, threshold: 0.75, kernel: 64, scale: 0.6 },
  /** Tilt-shift: shallow depth of field is what makes a city read as a toy. */
  dof: { fStop: 1.4, focalLength: 62, blurLevel: 0 },
  image: { exposure: 2.25, contrast: 1.4, saturation: 40, vignetteWeight: 2.6 },
  sharpen: { edgeAmount: 0.22, colorAmount: 1.0 },
  grain: 4,
  chromaticAberration: 3.5,
  glow: 0.9,
} as const;

/** Synty's Unity export writes emissiveFactor = 0, which kills the window glow
 *  baked into `Emissive_01.jpg`. We put it back — this is the night-window /
 *  neon-sign sparkle that bloom then picks up. */
export const EMISSIVE_REVIVE = new Color3(1, 0.87, 0.62);
export const EMISSIVE_STRENGTH = 2.5;

/**
 * How the city's own materials are corrected on the way in.
 *
 * The .glb is a Unity export of a stylised atlas, and it arrives with two
 * settings that make a night scene much darker than it needs to be.
 *
 *   maxMetallic  Unity writes `metallic: 1` on the main city atlas. A fully
 *                metallic surface has *no diffuse response at all* — it is only
 *                ever the reflection of its surroundings — so the pavements, the
 *                props and the building faces take nothing from the moon or the
 *                fill and go dark, while the emissive windows carry on glowing.
 *                That is the single biggest reason this scene reads as "black
 *                city, lit windows". Glass is exempt: it is *meant* to be a
 *                mirror, and `city.ts` sets it deliberately
 *   minRoughness the same export writes roughness 1, which spreads what little
 *                specular there is into nothing. Backing it off leaves a faint
 *                sheen on wet-looking asphalt
 *   roadTint     the road atlas is nearly black by design, which is fine in
 *                daylight and far too dark at night. This multiplies its albedo,
 *                so it is the knob for "the streets are too dark" specifically
 */
export const CITY_MATERIALS = {
  maxMetallic: 0.08,
  minRoughness: 0.8,
  roadTint: 1.7,
};

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
 * The cross traffic: the road the player has to read.
 *
 * It never stops — not for the signal, not for the car in front — so it has no
 * following model at all and every car simply holds the speed it arrived with.
 * That is a design decision rather than a saving: a road that brakes is a road
 * whose future is hidden, and this one has to be legible three seconds ahead or
 * the player is being asked to guess. The gaps are built in when a car joins,
 * not created by braking, which is also why this road cannot rear-end itself.
 *
 * `traffic/flow.ts` is where the behaviour lives, and the long comment at the
 * top of it explains the shape of it. The short version: cars arrive in runs
 * with a gap after each, the two rows keep their own rhythms so what the player
 * judges is the overlap of two unrelated streams, every car has its own speed,
 * and the road clears itself completely every so often — sooner if the dice have
 * been unkind.
 */
export const ROAD_ONE = {
  /**
   * How hard the crossing is, from 0 to 1.
   *
   * Every pair written `{ easy, hard }` below is read through this one number,
   * so it is the only thing that has to move to retune the whole road. 0 is a
   * quiet street with long openings and short runs; 1 is rush hour — long runs,
   * tight headways, mostly teasing gaps, and a road that takes its time before
   * standing aside.
   *
   * It is a dial rather than three named settings on purpose: the difference
   * between 0.5 and 0.65 is exactly the kind of thing that needs trying rather
   * than deciding.
   */
  difficulty: 0.95,

  /**
   * Cruise speed, drawn per car — which is what makes a gap something to judge
   * rather than count, because the same opening is a different problem with a
   * quick car behind it. Nothing may catch the car in front whatever this says:
   * `flow.ts` clamps a joining car to a speed that still lets the leader leave.
   *
   * On the difficulty dial like everything else, because pace is the most honest
   * kind of hard there is: at the top end a car covers the whole road in under
   * two and a half seconds, so a gap has to be seen and taken, not considered.
   * Measured, raising the pace was the one change that made crossing harder
   * *without* turning the openings back into the road clearing itself.
   */
  speed: {
    easy: { min: 16, max: 24 },
    hard: { min: 21, max: 32 },
  },

  /**
   * How much a long vehicle is pulled towards the slow end, 0 to 1. This is what
   * makes vans lumber and hatchbacks nip, so the traffic reads as traffic rather
   * than as a random number per car.
   */
  lumber: 0.6,

  /** Cars in one run, per row. */
  run: {
    easy: { min: 1, max: 3 },
    hard: { min: 3, max: 8 },
  },

  /** Seconds between the cars of a run. Drawn once per run, so runs differ. */
  headway: {
    easy: { min: 0.9, max: 1.5 },
    hard: { min: 0.48, max: 1 },
  },

  /**
   * The gap a row leaves after a run — and whether it lines up across the road.
   *
   * This is where the crossings come from. A gap in one row is useless while the
   * other row is still going past, and two unrelated rows almost never leave a
   * gap in the same place: measured, about once every two and a half minutes. So
   * a fair gap has a chance to *line up* — the other row leaves one at the same
   * moment, the way traffic does downstream of a light — and that is the opening
   * the player is looking for: a car's width of road between cars, there for a
   * moment, that has to be spotted and taken.
   *
   *   tease       looks like an opening, closes before a car could use it. A road
   *               where every gap is crossable is a road you never have to watch
   *   fair        long enough for one car, maybe two, if the road lines up
   *   fairChance  how often a row's gap is a fair one rather than a tease
   *   pairChance  how often a fair gap lines up across the road. The main dial
   *               for how often the player gets a chance at all
   */
  gap: {
    tease: { min: 1.2, max: 2.2 },
    fair: { min: 3.0, max: 4.8 },
    fairChance: { easy: 0.8, hard: 0.3 },
    pairChance: { easy: 0.65, hard: 0.22 },
  },

  /**
   * The road standing aside on its own — both rows at once — which is the
   * generous version of an opening, and deliberately rare at the hard end.
   *
   *   seconds   how long the junction stays clear when it happens. Short at the
   *             hard end: one car's worth, so it reads as a gap rather than a
   *             road being emptied for you
   *   every     how long between one and the next. Long at the hard end, so the
   *             openings the player gets are overwhelmingly the gaps above
   *   patience  the promise: if the junction has not offered an opening worth the
   *             name for this long, one is made now — and it is always at least
   *             `counts` long, whatever `seconds` says. Setting `seconds` near
   *             zero used to hollow this out entirely: measured, a careful player
   *             waited nearly two minutes and got nobody across
   *   counts    what "an opening worth the name" means, in seconds of clear
   *             junction. About what one car needs to pull away and get across
   */
  clear: {
    seconds: {
      easy: { min: 5.0, max: 7.0 },
      hard: { min: .2, max: .4 },
    },
    every: {
      easy: { min: 6, max: 10 },
      hard: { min: 60, max: 80 },
    },
    patience: { easy: 9, hard: 35 },
    counts: 1,
  },
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
  spawnGap: 20,
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
  holdSeconds: .4,
  poofSeconds: 0.45,
  spin: { min: 1.5, max: 4 },
  hop: { min: 2.8, max: 5.2 },
  gravity: .25,
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
  lampSize: 0.9,
  lampGap: 0.68,
  haloSize: 1.6,
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

/* ----------------------------------------------------------------- graphics -- */

/**
 * The knobs that decide how much work a frame costs. Defaults are tuned for a
 * smooth frame rate rather than maximum fidelity.
 */
/**
 * What the scene looks like, per class of device.
 *
 * This is the one place that decides how much work a frame is allowed to be.
 * `quality.ts` picks a level when the engine starts — from what the device
 * actually says about itself — and drops to a cheaper one later if the frame
 * rate will not hold. Everything downstream reads the level in force, never
 * this table directly.
 *
 * Levels only ever *take away*. A feature switched off in its own block —
 * `CAR_FX.enabled`, `SKID_MARK.enabled`, `STREET_LAMP.enabled` — stays off at
 * every level; the level cannot turn something on that you have turned off.
 */
export type GraphicsLevel = "low" | "medium" | "high";

export type GraphicsSettings = {
  /**
   * The render resolution budget, in the terms `core/viewport.ts` uses:
   * a cap on the device ratio, a flat cap on total pixels, and a floor so a
   * huge window never goes to mush.
   */
  maxPixelRatio: number;
  maxPixels: number;
  minRenderScale: number;

  /**
   * The shadow pass, measured at about 8% of a frame at its best setting.
   *
   *   cascades      2+ splits the map by distance, which is what keeps a shadow
   *                 crisp near the camera and cheap far away. 1 is a single
   *                 plain map — one depth pass instead of two, so roughly half
   *                 the cost. 0 builds no generator at all and costs nothing
   *   mapSize       the depth buffer's edge, in pixels
   *   soft          percentage-closer filtering: several taps per pixel for a
   *                 soft edge. Off is one tap
   *   casterRadius  only geometry within this many metres of the junction is
   *                 drawn into the map. The narrower it is, the fewer draws and
   *                 the sharper what remains
   */
  shadows: { cascades: number; mapSize: number; soft: boolean; casterRadius: number };

  /**
   * The full-screen passes, roughly in the order of what they cost.
   *
   * `depthOfField` is the tilt-shift that makes the city read as a toy — the
   * most expensive thing here by some way, and the first to go. `bloom` is the
   * night glow off the windows and signs; `scale` is the resolution its blur
   * runs at and `kernel` how wide it reaches, so both are cost as much as look.
   * `null` turns it off. `msaa` on top of FXAA buys very little at this scale.
   */
  depthOfField: boolean;
  bloom: { scale: number; kernel: number } | null;
  sharpen: boolean;
  glow: boolean;
  msaa: number;
  grain: boolean;
  chromaticAberration: boolean;

  /**
   * Scene content that can be left out rather than drawn cheaply. All three are
   * additive transparencies, which is fill rate — the scarce thing on a phone.
   *
   *   beams      the cones of light thrown by every headlamp. Measured at 0.3%
   *              of a frame for all sixty of them, so they survive everywhere:
   *              a night street without headlights is not worth the 0.3%
   *   roadMarks  skid marks and light trails, about 2%
   *   smoke      the idle, pull-away and braking clouds
   */
  beams: boolean;
  roadMarks: boolean;
  smoke: boolean;

  /** Texture filtering. 8 is crisp road markings at a glance; 1 is free. */
  anisotropy: number;
};

export const GRAPHICS = {
  /**
   * Pin a level instead of detecting one. Useful for seeing what a phone gets
   * without owning one: set it to "low" and reload.
   */
  force: null as GraphicsLevel | null,

  /**
   * The safety net under the detection: one listen, one decision, then silence.
   *
   * No amount of guessing from a renderer string beats measuring, so the opening
   * shot doubles as a benchmark. The scene listens to its own frames while the
   * camera flies in, and if the typical frame is too slow for `targetFps` it
   * picks the level that would fit — in one step, and before the camera settles,
   * so the change happens while the whole view is moving anyway.
   *
   * After that it never changes again. A picture that shifts in front of the
   * player, mid-game, looks far worse than one that is simply a notch lower; an
   * earlier version that kept watching all session did exactly that, and it read
   * as the whole scene flickering.
   *
   *   targetFps  the rate a device has to hold to keep its level. 30, not 60:
   *              this is for devices that are genuinely struggling, and a browser
   *              capped at 30 is smooth, not slow
   *   skip       seconds at the start that are ignored, because the first frames
   *              of any game hitch while the GPU warms up and say nothing about
   *              how fast the device really is
   *
   * A level pinned with `force` is never second-guessed.
   */
  adapt: {
    enabled: true,
    targetFps: 20,
    skip: 0.9,
  },

  levels: {
    /** Desktops and Apple silicon: everything on, at full resolution. */
    high: {
      maxPixelRatio: 1.5,
      maxPixels: 2_500_000,
      minRenderScale: 0.6,
      shadows: { cascades: 2, mapSize: 1536, soft: true, casterRadius: 48 },
      depthOfField: true,
      bloom: { scale: 0.6, kernel: 64 },
      sharpen: true,
      glow: true,
      msaa: 1,
      grain: false,
      chromaticAberration: false,
      beams: true,
      roadMarks: true,
      smoke: true,
      anisotropy: 8,
    },

    /**
     * Most phones and tablets, and thin laptops: the look is intact — tilt-shift,
     * bloom, headlights, shadows — at about half the pixels, with one shadow
     * pass instead of two and a tighter circle of things casting into it.
     */
    medium: {
      maxPixelRatio: 1.25,
      maxPixels: 1_500_000,
      minRenderScale: 0.55,
      shadows: { cascades: 1, mapSize: 1024, soft: false, casterRadius: 34 },
      depthOfField: true,
      bloom: { scale: 0.45, kernel: 48 },
      sharpen: false,
      glow: true,
      msaa: 1,
      grain: false,
      chromaticAberration: false,
      beams: true,
      roadMarks: true,
      smoke: true,
      anisotropy: 4,
    },

    /**
     * Old phones, software renderers, anything that has already proved it cannot
     * keep up. No shadow pass, no tilt-shift, no marks on the road, and a third
     * of the pixels of the top level — but the headlights, the signal's glow and
     * the bloom off the windows all stay, because measuring says they are nearly
     * free and without them it stops looking like this game at all.
     */
    low: {
      maxPixelRatio: 1,
      maxPixels: 800_000,
      minRenderScale: 0.5,
      shadows: { cascades: 0, mapSize: 512, soft: false, casterRadius: 0 },
      depthOfField: false,
      bloom: { scale: 0.3, kernel: 32 },
      sharpen: false,
      glow: true,
      msaa: 1,
      grain: false,
      chromaticAberration: false,
      beams: true,
      roadMarks: false,
      smoke: true,
      anisotropy: 1,
    },
  } satisfies Record<GraphicsLevel, GraphicsSettings>,
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
  pool: { size: 12, height: 0.12, brightness: 0.62 },

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
    lamps: 0.5,
    steady: { min: 3, max: 11 },
    stutter: { min: 0.2, max: 0.9 },
    rate: 9,
  },
};
