# blueMino — Downtown Crossroad

A React + Babylon.js front end for the POLYGON City block in `assets/scene.glb`,
framed on the intersection the game is played on. The `Cars` group ships hidden.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # typecheck + production bundle into dist/
npm run preview  # serve the production build
```

## How the scene is put together

`src/scene/` is plain TypeScript with no React in it; `src/ui/` is React with no
Babylon in it. `createCityScene.ts` is the only place the two meet.

| File | Role |
| --- | --- |
| `config.ts` | Every tunable value — framing, sun, grading, traffic, waves, idle, quality. Start here. |
| `environment.ts` | Procedural sky, baked into a cube that becomes the scene IBL. |
| `lighting.ts` | Sun, sky fill, cascaded shadows and the caster filter. |
| `camera.ts` | The locked-off game view, its limits, the intro fly-in and reset. |
| `city.ts` | Loads the `.glb`, hides `Cars`, repairs materials, freezes the static world. |
| `props.ts` | Reads the authored `props` markers and hides their placeholder cubes. |
| `carFactory.ts` | Clones the hidden `Cars` models into drivable, animatable rigs. |
| `carAnimations.ts` | The two keyframed clips — idle and brake — built once and shared. |
| `traffic.ts` | Lanes, car-following, the light gate, waves, collisions and crashes. |
| `trafficLight.ts` | The billboarded cartoon signal. |
| `crashEffects.ts` | Generated spark, flash and smoke bursts. |
| `postProcess.ts` | Bloom, tilt-shift DoF, ACES tone mapping and colour grading. |
| `createCityScene.ts` | Wires it together, owns the fixed update and the click handler. |

## How the traffic works

Each road is configured on its own, because they do genuinely different jobs.

**`ROAD_ONE` — the cross traffic.** It never stops: not for the signal, not for
the car in front. It has no following model at all, so there is nothing for it to
rear-end itself with. Its dials are `speed`, `spawnGap`, and `breakTime` — the
seconds of empty road left behind each car. That break *is* the gap mechanism:
since these cars never brake, the openings the player crosses in have to be built
in at the moment a car joins the road. `breakTime` is therefore the main
difficulty dial — longer means more room to cross.

**`ROAD_TWO` — the road the signal governs.** These cars queue behind the stop
line and behind each other, so they get the full model: `speed`, `minGap`,
`spawnGap`, `accel`, `brake` and `comfort`.

`TRAFFIC.laneOffset` is shared, since both roads are painted the same width.

**`cross` is the stop line.** A car whose nose is still short of it is governed by
the light; once its nose is past, it is committed and clears the junction rather
than stopping dead in the middle of it.

**Braking is kinematic, not a flat gain.** Approach speed is
`sqrt(2 · brake · comfort · distance)` — the fastest a car can go and still pull
up in the distance it has left. A linear "speed = distance × gain" cannot be made
safe at every speed: raise the cruise and cars start braking too late to stop,
which is how the queue used to roll a red light into the cross traffic. Lanes are
seeded from that same law, so the first frame is a state the physics could
actually have produced.

## How the car animation works

Two authored clips, each played by its own AnimationGroup on its own node:

| clip | when | shape |
| --- | --- | --- |
| `idle` | stopped | shudders left and right, looping |
| `brake` | pulling up | a one-shot nose dive that rebounds past level |

**A moving car animates nothing.** Only its wheels turn. That is the cheapest
possible state, and it is the state most cars are in most of the time — so with
20 cars there are 40 groups of which only the stopped ones ever run.

The shake is a *yaw* swing rather than a roll because the camera looks down on the
junction: from up there a car rocking on its springs barely reads, while one
wagging its tail is unmistakable.

The rig stacks the layers so each node has exactly one writer —
`root → idle → brake → crash → body`. That is what lets a shudder and a dive
overlap and *compose* rather than fight over a single transform, and it keeps
either of them from corrupting the lane maths on `root`.

Two things make this cheap. The clips are built **once** and shared: every car's
groups point at the same `Animation` objects, so twenty cars cost one copy of the
keyframes. And a layer whose weight reaches zero is **paused outright**, not just
muted. Pausing preserves the phase, so resuming does not restart the cycle.

Watch out for two things if you edit this. Babylon's weighted blend leaves a
little of the last pose behind at weight zero, and merely *starting* a group
parks a pose on its node — so each layer resets its node to identity both when it
switches off and when it is first built. And because the simulation runs in
`onBeforeRender` while Babylon animates before that, those resets win for the
frame.

### Tuning

Everything is in `ANIM`, two numbers per clip:

```ts
idle:  { speed, swing }   // shakes per second, radians to each side
brake: { speed, dip, trigger }
```

Clip lengths are fixed and `speed` is applied as the group's playback rate, so
`idle.speed` means cycles per second directly rather than being tangled up in
keyframe spacing. `brake.trigger` is the deceleration, in units per second
squared, that sets the dive off.

## Performance

The frame was rebuilt around where the draw calls were actually being multiplied:

| | before | after |
| --- | --- | --- |
| draw calls | 2692 | 977 |
| shadow casters | 1737 | 407 |
| post-process passes | 64 | 33 |
| animation groups running | — | only the stopped cars, of 40 |

The wins, in order of size: shadow casting is filtered to geometry near the
junction that is neither flat nor tiny (road tiles and trash bags cast nothing you
can see, but cost a draw per cascade); cascades cut from three to two; the glow
layer restricted to the signal lamps, which otherwise re-rendered most of the city
into its own buffer; cars stripped of parts no camera up here can see, with only
the shell casting; SSAO, MSAA, grain and chromatic aberration off; and the render
resolution capped at 1.5x so a 2x display does not shade four times the pixels.
All of it is in `QUALITY`.

Note what is deliberately *not* done: the static city is never merged. Babylon's
glTF loader already instances this asset — only 384 of its 1572 meshes carry
geometry and the rest share it — so welding by material would bake every instance
into real vertices, roughly tripling the vertex memory to remove draw calls that
hardware instancing was already collapsing.

## Things worth knowing

**The crossroad is found, not hard-coded.** The four `SM_Prop_LightPole_CrossLights`
poles stand at the corners of the junction; their average is the camera target.
Re-export the city from Unity and the framing follows it. `CROSSROAD` in
`config.ts` is only the fallback.

**`assets/` is the web root.** `vite.config.ts` sets `publicDir: "assets"`, so
`assets/scene.glb` is served at `/scene.glb` with nothing copied or duplicated.
Drop new files in `assets/` and they are served.

**The sky is baked late on purpose.** The IBL cube is captured from the sky dome,
but on the first frame that shader is still compiling — a probe fired then
captures black and leaves the entire city with no ambient light. `environment.bake()`
is therefore called after `scene.whenReadyAsync()`.

**Unity's exporter zeroes the emissives.** The `.glb` carries a perfectly good
emissive atlas alongside `emissiveFactor: [0,0,0]`, which multiplies every lit
window down to black. `city.ts` puts the factor back; that glow is what the bloom
and glow layers then work with.

**Nothing static moves.** World matrices are frozen and a selection octree handles
culling. The `Cars` subtree is deliberately left unfrozen — it is the part most
likely to be animated next.

## Hiding and showing the traffic

`Cars` is a top-level group of 30 vehicles. It is disabled on the asset container
*before* the container is added to the scene, so it never costs a frame. The HUD's
**Traffic** toggle brings it back via `setCarsVisible(true)`.

Six further vehicles sit outside that group, parked in the lot off to the
north-west. They are well outside the camera's framing and are left visible.

## Controls

Drag to orbit, scroll to zoom. Panning is disabled and beta/radius are clamped, so
the junction cannot leave the shot. The HUD toggles traffic, tilt-shift, ambient
occlusion and idle orbit, and resets the view.
