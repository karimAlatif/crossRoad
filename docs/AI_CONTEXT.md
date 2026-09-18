# AI context — blueMino

Working notes for an AI agent picking this project up. Dense on purpose: the
invariants and the traps, not a tutorial. For how the game works, read
`HOW_IT_WORKS.md` — that one is written for the project's owner.

## What this is

A browser scene, not an app: a Babylon.js night-time city crossroad where the
player clicks anywhere to work the traffic light. React only mounts the canvas
and shows a loading overlay. There is no UI by design — the owner asked for it
to be removed early on, twice. Do not add HUD elements unless asked.

- Babylon.js 9.26, Vite 8, React 19, TypeScript 5.9 (strict, `noUnusedLocals`).
- `npm run dev` / `npm run build`. `npx tsc --noEmit` typechecks.
- The model is Synty POLYGON City, exported from Unity.

## Layout

```
src/scene/
  config.ts            every tunable in the project, one file
  quality.ts           picks a graphics level per device, and watches the fps
  createCityScene.ts   composition root: builds everything, wires it, returns the API
  core/                shared by everything
    types.ts           Range, Disposable
    maths.ts           clamp01, between, mid, moveTowards, byte
    frame.ts           createClock — THE per-frame heartbeat
    viewport.ts        resolution + resize, the only answer to the canvas
    visuals.ts         unlit materials, radialTexture, plane/planeSource instancing
  world/               things that do not move
    city.ts            loads the .glb, revives emissives, freezes statics
    props.ts           reads the authored marker hierarchy
    camera.ts          the one view, the authored fly-in, and the pin
    lighting.ts        sun, fill, cascaded shadows
    environment.ts     sky dome, fog, and the ambient below
    ambient.ts         the environment light: a CPU-built cube + its harmonics
    postProcess.ts     bloom, tone mapping, DoF, glow layer, SSAO
    trafficLight.ts    the signal: geometry, lamps, breathing glow
    streetLamps.ts     lamp-post glows, instanced
  traffic/
    road.ts            lane/rules model + entry arithmetic (pure)
    flow.ts            how the cross traffic arrives: runs, gaps, the promise
    collisions.ts      footprint + separating-axis test (pure)
    traffic.ts         the simulation: drive, place, collide, crash, warm-up
    carFactory.ts      the car rig, animation layers, effect emission points
    carAnimations.ts   the three keyframe clips + clipTiming()
  effects/
    carEffects.ts      idle/move/brake smoke; owns the two ribbon pools
    roadMarks.ts       generic stretched-ribbon pool (skid marks, light trails)
    carHeadlights.ts   beams, lamps, and lampMounts() for every car
    crashEffects.ts    flash, sparks, smoke
    particles.ts       burstSystem + grow, shared by car and crash effects
    flicker.ts         faulty-light stutter, shared by cars and street lamps
  audio/sound.ts       Web Audio: theme, move, brake, accident
public/models|sounds   the web root; `/models/scene.glb`, `/sounds/*`
```

## The frame

One `onBeforeRenderObservable` observer exists: `core/frame.ts`. Everything
per-frame subscribes through `clock.each(fn)` and is handed a **clamped** `dt`
(max 1/20 s) and `elapsed`. Subscription order is execution order. The traffic
subscribes late (in `createCityScene`) so systems that read car positions have
already run against the previous frame's placement — that is fine and
intentional; a frame of lag is invisible at these speeds.

The single exception is `carEffects`, which also holds an
`onAfterRenderObservable` callback to flush its burst queues once the frame is
drawn. That cannot move to the clock, which runs before the draw.

## Invariants and traps

These were each found the hard way. Breaking one usually looks like "the thing
is invisible" rather than an error.

1. **The glTF root mirrors the world.** Babylon's loader parents everything under
   `__root__` with scale (1, 1, −1) plus a 180° Y rotation. Consequences:
   - **Never billboard through it.** Billboarding writes the world matrix
     directly and cannot express the mirror; it put the car lamps at y = −1.5,
     under the road. Every glow plane uses a fixed rotation instead.
   - Positions read from the model must be transformed, not assumed.
2. **StandardMaterial *adds* its emissive texture to `emissiveColor`** and clamps
   the sum. A white texture therefore pins the result to white whatever colour
   the material is given. Every generated texture bakes its colour into its own
   pixels (`byte()` + `radialTexture`), and `emissiveColor` stays black. This is
   `unlit()` in `core/visuals.ts` — use it, do not hand-roll a material.
3. **A frozen material stops re-uploading uniforms.** Anything whose colour
   changes at runtime must pass `frozen: false` — only the signal's lamps do.
4. **`DynamicTexture` defaults to invertY**, so canvas row 0 lands at V = 1. The
   headlight cone is written with `t = 1 - y / (size - 1)` for exactly this
   reason; removing the flip builds the cone backwards.
5. **Particle size gradients *replace* `particle.size`.** `minSize`/`maxSize` are
   overwritten on the first update, so gradients are absolute metres.
   `addStartSizeGradient` is a different thing and needs `targetStopDuration`;
   using it on a never-stopping system throws and takes the whole scene load
   down with it.
6. **`manualEmitCount` holds one burst per frame.** A second car setting it the
   same frame overwrites the first — which silently meant only one car per frame
   got smoke. `carEffects` fixes this with a queue plus Babylon's
   `startPositionFunction`/`startDirectionFunction` hooks; Babylon creates a
   particle's position *before* its direction, so position picks the burst and
   direction reuses it. Do not "simplify" this back.
7. **Instances own almost nothing.** `receiveShadows`, `applyFog` and materials
   belong to the source mesh; setting them per instance is ignored and warns once
   per instance. `core/visuals.ts#plane` and `#receiveShadows` handle this.
8. **The traffic warms up for 25 simulated seconds synchronously** before the
   first frame, so the junction opens busy. Nothing "live" may happen during it:
   `traffic` gates clips on a `live` flag and `carEffects` gates everything on
   `running` until the first real frame. Without that gate, a warm-up's worth of
   queued bursts fires at once on frame 1, in places the cars left long ago.
9. **Cars are pooled.** A car that reaches the end of a road is disabled and
   reused at the start — often in the same frame. Anything per-trip (random
   widths, skid windows, ribbon anchors) must reset on the "starts moving" edge,
   and anything measuring a car over time must treat a large position jump as a
   new trip, not a fast one.
10. **The front lamp marker is spelled `forntLamp` in the .glb.** Not a typo in
    the code. 8 of 20 car models carry `forntLamp`/`backLamp`, each with `left`
    and `right`; the rest fall back to bounding-box estimates. Index 0 is always
    the left side, in both paths.
11. **Audio needs a user gesture.** Files are fetched at load, decoded on the
    first click. Calls before that are dropped, not queued.
12. **`ArcRotateCamera.setTarget` rebuilds alpha/beta/radius** from where the
    camera currently is, silently undoing a shot that was just set. Pass its
    fourth argument (`cloneAlphaBetaRadius`) to keep them. It also returns early
    when the new target equals the old one, so a bug here can hide.
13. **The camera is pinned after the intro**: inputs cleared and both limits of
    each angle closed onto the held value. That is deliberate and is what makes
    it immovable even against direct writes to `camera.alpha`. `CAMERA.locked`
    turns it off.
14. **The opening shot is authored in the model** as `cameraPath` → `start`,
    `end`, `view`. `view` is the point the camera turns onto part-way through the
    drive (`CAMERA.intro.turnAt`); it is optional, and without it the camera
    keeps looking ahead and turns on the way up. The markers are placeholders and
    are hidden once read. With no `cameraPath` at all the intro falls back to a
    wide shot derived from the view.
15. **The intro animates two separate tracks, not one pose list**: where the
    camera *stands* and what it *looks at*, each a list of keyed positions eased
    segment by segment. Keeping them apart is the whole point — the look-at has a
    key at 80% of the drive that the standing track does not, so the camera can
    start turning mid-drive without that key splitting the drive into two legs
    and making it slow down in the middle. Each frame sets `setTarget` then
    `setPosition`, in that order (`setPosition` reads the target to work the
    angles out). Animating alpha/beta/radius instead makes every leg an arc and
    needs `overrideCloneAlphaBetaRadius` to survive a moving target; that
    approach was tried and removed. An ArcRotateCamera also cannot be flown by
    animating `position` directly — it rebuilds position from its angles every
    frame, and `setPosition` is what works the sum backwards.
16. **The intro is one clock tick and it unsubscribes itself on arrival** — which
    is why `core/frame.ts` tolerates a tick removing itself mid-iteration. After
    `pin` nothing of the camera runs. `positionOf()` in `camera.ts` is the
    forward form of the same sum, used to turn the game view into the last pose.
17. **Framing is a promise, not a lens setting.** `CAMERA.frame` is an area in
    metres, on the plane through the view target, that must be visible on any
    screen. `fitToScreen` keeps it by opening the lens first (free, moves
    nothing) and only then stepping the camera back (`frame.maxFov` is where it
    switches, set just under the angle at which the frame would climb over the
    horizon and fill with sky). It runs on every canvas resize, so the *effective*
    view is module state — `framed` in `camera.ts` — not `CAMERA.view`: the intro
    ends there, `pin` closes onto it, and a resize after the intro re-pins. Any
    new code that wants "the view" wants `framed` and `aim`, not the config.
    What has to fit across blends from `frame.portraitWidth` (aspect ≤ 0.75) to
    `frame.width` (aspect ≥ 1.6): a single width cannot make both a desktop and
    an upright phone look right. The aim blends the same way, from the junction's
    centre (`frameJunction`, called once the city has loaded and before the
    intro) to `view.target` — the authored target is off-centre, and on a tall
    screen that wasted the width the tight framing needs. `CAMERA.fov` and `frame.maxFov` are in
    **degrees**; `maxFov` used to be radians, the owner wrote 120 meaning
    degrees, and phones got a 121° fisheye.
18. **Only `core/viewport.ts` answers the canvas.** One `ResizeObserver` on the
    canvas (not `window.resize` — the canvas resizes for reasons the window never
    hears about), coalesced into one animation frame, settling resolution,
    `engine.resize()` and framing together. Resolution is the smallest of the
    device ratio and the graphics level's `maxPixelRatio` and `maxPixels`; the
    last is a flat budget that keeps a 4K window from shading 4x a 1080p one.
19. **Graphics settings are per device, and live.** `GRAPHICS.levels` in the
    config holds three of them; `quality.ts` picks one at startup (before
    anything is built — a shadow map cannot be resized and an unbuilt cone costs
    nothing) and `graphics` is the one in force. It is an `export let`, so read
    `graphics.x` at the point of use and never destructure it at module scope,
    or you capture the level the module happened to load under.
20. **Levels only take away.** A feature switched off in its own block stays off
    at every level: `graphics.smoke && CAR_FX.enabled`, never one or the other.
21. **The level may change once, during the intro, and never during play.**
    `calibrate` listens to the opening shot (skipping the first hitchy moments),
    takes the median frame, jumps straight to the level that fits from the
    measured per-level costs, and unsubscribes — all before the camera settles,
    so the change is masked by camera motion. An earlier version watched all
    session and dropped levels live; the owner saw it as the whole scene
    flickering mid-game. Do not bring back live quality changes. Only what can
    change live is re-applied (render scale, post flags, shadows on/off); content
    decided at build time stays as built. A new knob goes in `GraphicsSettings`
    with an `apply()` on its owner, called from the `calibrate` callback.
22. **Decide what to cut by measuring, not by looking.** Turning each feature off
    in turn (software renderer, fill-rate bound) gave: resolution 38%, bloom 8%,
    shadows 8%, glow 4.6%, road marks 2.2%, DoF 1.5%, and all sixty headlight
    cones 0.3%. The intuitive cut — the beams — was worthless; the resolution
    budget is worth more than everything else combined.
23. **The inspector is loaded on demand** (`inspect()` or the `i` key), not
    imported. Importing it statically put ~10 MB of editor UI in the bundle and
    doubled the request count on first load: 2.60 MB over the wire became 2.02 MB
    across half as many files. Do not add the static import back.
24. **Never depend on reading a render target back.** The scene's ambient used
    to come from a `ReflectionProbe` of the sky dome. Babylon derives the diffuse
    IBL — the spherical harmonics PBR samples — by calling `readPixels` on that
    cube, which returns zeros on some drivers. When it does, the harmonics are
    zero, the ambient term vanishes and the city goes black except for emissive
    windows and additive headlights: the same build, bright on one device and
    dark on another. `world/ambient.ts` builds the cube on the CPU and computes
    the harmonics in JS instead. Do not replace it with a probe.
25. **The .glb's materials are wrong and are corrected on load.** Unity exports
    the city atlas with `metallic: 1` — no diffuse response, so nothing but
    reflections — and a near-black road texture. `city.ts` clamps metallic and
    lifts the road albedo (`CITY_MATERIALS`). If the city ever looks flat and
    dark again after a re-export, check those first.
26. **Lighting is deliberately not tiered.** The graphics levels change what is
    *drawn*, never how bright it is: measured, high and low differ by 0.1%. A
    level that changed the exposure or the ambient would mean the game looked
    different on different phones, which is the problem this all came from.
27. **The cross traffic's design lives in `flow.ts`**, and its top comment is
    the spec. Runs with gaps after them, two rows on independent rhythms, a
    speed per car clamped so nothing can catch the car ahead, and a road that
    clears itself on a random interval — pulled forward if the junction has been
    shut longer than `patience`. `ROAD_ONE.difficulty` (0–1) interpolates every
    `{ easy, hard }` pair in the config block.
28. **Two bugs that simulation caught and reading would not have.** When the road
    stands aside, the hold must be computed from (a) *when the cars already on
    the road finish crossing*, not when the junction next goes busy — those are
    opposite ends of the same traffic — and (b) the **busiest row of the road**,
    not each row's own, or a row that happens to be empty reopens while the other
    is still going past. Each mistake silently turned a 4-second promised window
    into about 2 seconds of real one. There is no way to see either by reading
    the code; step the sim and measure the junction.
29. **Independent rows need a way to line up, and the promise needs a floor.**
    Two unrelated rows leave a shared gap about once every 2.5 minutes, so with
    the clearings turned down there was nothing to cross between.
    `gap.pairChance` lets a fair gap on one row line the whole road up
    (`standAside` for that gap's length); that is now the main source of
    openings. Separately, the promise used `clear.seconds`, so setting it near
    zero silently hollowed the promise out — a measured 115 s wait with zero cars
    across. A starved clearing now always lasts at least `counts + 0.4`. Measure
    both "openings/min" and "openings/min with clearings disabled" when tuning:
    the second is how much of the game is gaps between cars.
30. **`ROAD_ONE.speed` is on the difficulty dial** (`{ easy, hard }`), read
    through `flow.ts#pace()` — including by `road.ts` for the free lane's rules.
    When making the road harder, pace and density are the levers that keep the
    openings as gaps between cars; shortening `gap.fair` makes it *easier*
    (rows cycle faster, so gaps line up more), and cutting `fairChance` pushes
    the openings onto the promise's timer. Single five-minute simulations vary by
    ±25% on these metrics: compare candidates head to head with 8–12 minute
    samples before drawing conclusions.
31. **A wreck has speed zero, so keep it out of any "distance ÷ speed" sum.**
    Cross-traffic cars hold their entry speed for the whole road, so two bits of
    arithmetic went badly wrong around wrecks. The entry clamp ("never catch the
    car ahead") read a wreck's zero as "you may only crawl" and let a car on at
    0.14 m/s; it sat in the entry for nine minutes and nothing else in that lane
    could get on. And `busySeconds` divided the distance to clear by a wreck's
    zero speed and held a lane shut for twelve minutes. Now the clamp uses the
    nearest car that is still *driving*, a car that could only enter at a crawl
    waits at the gate instead (`SLOWEST_ENTRY`), and a wreck counts as clear when
    it finishes poofing. Test with a careless player — the light flipping on a
    timer — because a careful one never makes the wrecks that expose this.
32. **Cars are pooled, so anything counted with a flag on the car saturates at
    the pool size.** Count transitions (`was <= line && is > line`) instead. This
    produced a confident "0 cars are getting through" that was entirely the
    measurement's fault.
33. **Check which GPU the browser is actually using before believing a
    performance report.** The dev machine is a laptop with an Intel UHD and an
    RTX 4060, and Chrome runs on the Intel by default — `powerPreference:
    "high-performance"` is ignored on Windows. "The quality drops on my PC" was
    exactly that: 16 fps on the Intel, 92 on the card. To test on the real card,
    launch the test Chrome with `--force_high_performance_gpu --use-angle=d3d11`
    and without `--use-gl=swiftshader`; `engine.getGlInfo().renderer` names the
    adapter. The console line from `quality.ts#announce` names it for users.
34. **Never set `receiveShadows` on an instance** — use
    `core/visuals.ts#receiveShadows`, which sets it on the source. An instance
    owns no material state; Babylon warns once per instance, and the city plus
    the car clones printed 65 warnings at every start. Earlier verification
    scripts filtered that warning out, which is how it survived: do not filter
    console output you have not read.
35. **`camera.position` is only recomputed when the view matrix is.** Reading it
    in a headless harness that never renders gives a stale value — call
    `camera.getViewMatrix()` first. This produced a false "the camera never
    rises" reading once.

## Verifying changes

There is no test suite. The working method for this project is to **measure in a
real browser**, and it has repeatedly overturned what a screenshot seemed to
show. The recipe:

1. Temporarily expose the scene: add to `App.tsx`, after `sceneRef.current = city`:
   `(window as unknown as Record<string, unknown>).__city = city; // TEMP PROBE`
   **Always revert this** with `git checkout -- src/App.tsx` when done.
2. `npm run build`, then `npx vite preview --port 4179 --strictPort`.
3. Launch headless Chrome with `--remote-debugging-port=<port>
   --headless=new --use-gl=swiftshader --enable-unsafe-swiftshader
   --window-size=1280,720 --user-data-dir=<temp>`.
4. Drive it over CDP from a Node script (Node 22 has a built-in `WebSocket`):
   `Runtime.evaluate` to probe, `Page.captureScreenshot` for pictures,
   `Input.dispatchMouseEvent` for a real user gesture (audio unlock).

Pitfalls in that harness, all of which have produced false results here:

- **SwiftShader takes ~1 s per frame** and blocks the page's main thread, so any
  `setTimeout`-based timing in the page is meaningless while the render loop
  runs. `engine.stopRenderLoop()` first.
- **To step the simulation without drawing**, do all of:
  `scene._frameId++; scene.animate(); scene.onBeforeRenderObservable.notifyObservers(scene);
  for (const p of scene.particleSystems) p.animate(); scene.onAfterRenderObservable.notifyObservers(scene);`
  Without `_frameId++`, `ParticleSystem.animate()` returns immediately and no
  particle is ever born. Set `engine.getDeltaTime = () => 16` and
  `scene.useConstantAnimationDeltaTime = true` for a fixed 60 Hz step.
- **To freeze the scene for an A/B screenshot**, set `getDeltaTime = () => 0`
  and `scene.animationsEnabled = false`; otherwise the second capture differs by
  a frame of traffic and the diff is meaningless.
- **`Runtime.enable` replays console messages from before the navigation.** A
  stale warning looks like a live one; navigate to `about:blank` first.
- Particles are often simply **off-screen** — project them before concluding
  they are invisible.

## Performance

Measured by stepping the sim 600 frames with no rendering and timing it, and by
drawing for 20 s on a software rasteriser at 1280x720 (which is fill-rate bound,
so treat the frame times as a ratio between levels, not as real-world numbers):

| | high | medium | low |
|---|---|---|---|
| CPU per frame (sim + effects) | 0.16 ms | 0.12 ms | 0.14 ms |
| relative frame cost | 1.00x | 0.70x | **0.33x** |
| shadow map | 1536, 2 passes, 422 casters | 1024, 1 pass, 277 casters | none |
| active meshes | ~1230 | ~1310 | ~1270 |
| real lights | 3 | 3 | 3 |
| particle systems | 6 | 6 | 6 |

What keeps it there, and must not be casually undone:

- The .glb arrives **already instanced** (384 meshes, 1188 instances). Merging it
  destroys that — this was tried and reverted.
- Every glow is **additive geometry, not a light**. A Babylon light costs per
  *material*, so thirty headlights would recompile every shader in the city.
- Each effect is **one shared system or pool**: 3 particle systems for the cars,
  2 ribbon pools, one instanced source per glow kind.
- City meshes are frozen (`freezeWorldMatrix`, `doNotSyncBoundingInfo`) and their
  materials are frozen after `whenReadyAsync`.
- The pools are **rings**: `SKID_MARK.pool`, `LIGHT_TRAIL.pool` bound the road's
  memory and draw cost no matter how long the game runs.
- The render resolution is **budgeted, not inherited** (`core/viewport.ts`). A 4K
  window renders at ~2300x1300. Raising `maxPixels` is the quickest way to make
  this scene slow on a big monitor.
- The engine asks for **no canvas antialiasing and no stencil**: the scene is
  drawn into the post stack's buffer and blitted, so MSAA on the canvas would
  smooth the edges of one full-screen quad. AA is FXAA inside the pipeline.
- Babylon's **audio engine is off** (`audioEngine: false`) — the game runs its own
  Web Audio graph, and the second AudioContext was never used.
- Rendering **stops when the tab is hidden**.

## Working with the owner

- **`config.ts` is theirs.** They tune it live, mid-session. Re-read it before
  editing and preserve their values; change structure, not numbers, unless the
  change is the point.
- They have reverted edits to `carAnimations.ts` clip shapes twice. Treat the
  keyframes as theirs.
- Comments explain *why*, in British spelling, and are expected to carry the
  reasoning above. Keep them.
- When something looks wrong, they want the cause found and stated plainly, not
  patched over.
