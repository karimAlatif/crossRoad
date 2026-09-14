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
| `carAnimations.ts` | The three keyframed clips — idle, brake, move — built once and shared. |
| `traffic.ts` | Lanes, car-following, the light gate, waves, collisions and crashes. |
| `trafficLight.ts` | The billboarded cartoon signal. |
| `crashEffects.ts` | Generated spark, flash and smoke bursts. |
| `postProcess.ts` | Bloom, tilt-shift DoF, ACES tone mapping and colour grading. |
| `createCityScene.ts` | Wires it together, owns the fixed update and the click handler. |

## How the traffic works

Each road is configured on its own, because they do genuinely different jobs.

**`ROAD_ONE` — the cross traffic.** It never stops: not for the signal, not for
the car in front. It has no following model at all, so there is nothing for it to
rear-end itself with.

Its cars arrive in **waves**. `carsPerWave` sets how many travel together —
counted across *both* rows, so a wave of six is six cars over the road, not six
in each. `spawnGap` is the bumper gap inside a wave, and `breakTime` is the
seconds of empty road added before the next one, which is the window the player
crosses in.

Cars join at a **fixed gate**: `spawnGap` behind the road's start marker, never
further back. The break is extra clearance the gate waits for *on top of*
`spawnGap`, armed on every row at once so the gap opens right across the road.
Both details matter and both were once wrong — laying waves out backwards from
the last car pushed the tail of a busy road a hundred metres off the back of it,
and expressing the break as a plain time hold made it vanish entirely whenever
`spawnGap` happened to be the larger of the two.

`speed` is drawn **once per wave**, not per car. That is not cosmetic: with no
following model, two cars in one wave at different speeds would simply close on
each other and collide. Varying it between waves is what keeps the stream from
looking metronomic.

One interaction to keep in mind: a car takes up about `spawnGap + 5` metres and
roodOne is 77 m long, so `spawnGap` decides how many cars a row can hold — six at
8, two at 40. Set it high enough and a wave is spread over more road than exists,
and the traffic reads as evenly spaced cars rather than clumps with gaps between
them. The pool sizing accounts for `carsPerWave` either way, so the waves are
still exactly the size asked for; they just stop looking like waves.

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

Three authored clips, each played by its own AnimationGroup on its own node:

| clip | when | shape |
| --- | --- | --- |
| `idle` | stopped | shudders left and right, looping |
| `brake` | pulling up | one-shot: the nose dives and rebounds past level |
| `move` | pulling away | one-shot: the mirror of the dive — the nose lifts, then settles |

`move` fires on the transition out of standstill, which is what "when the car
starts moving" means and keeps the clip off every small mid-cruise adjustment. It
is deliberately slower and softer than `brake`: stopping is an event, setting off
is a roll. The two are opposites on the same axis, so firing either one cancels
and resets the other — otherwise a half-finished dive would freeze into the car
as it pulled away.

**A car cruising along animates nothing.** Only its wheels turn. That is the
cheapest possible state, and it is the state most cars are in most of the time —
measured with 36 cars, 108 groups existed and 14 were running.

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
idle:  { speed, swing }        // shakes per second, radians to each side
brake: { speed, dip, trigger } // playback rate, radians the nose drops
move:  { speed, lift }         // playback rate, radians the nose rises
```

Clip lengths are fixed and `speed` is applied as the group's playback rate, so
`idle.speed` means cycles per second directly rather than being tangled up in
keyframe spacing. `brake.trigger` is the deceleration, in units per second
squared, that sets the dive off; `move` needs no trigger, because "stopped, and
now moving" is not a threshold to tune.

## Performance

The frame was rebuilt around where the draw calls were actually being multiplied:

| | before | after |
| --- | --- | --- |
| draw calls | 2692 | 977 |
| shadow casters | 1737 | 407 |
| post-process passes | 64 | 33 |
| animation groups running | — | only the stopped cars, of 108 |

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
