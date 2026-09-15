# blueMino — Downtown Crossroad

A React + Babylon.js front end for the POLYGON City block in `public/models/scene.glb`,
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

`speed` and `spawnGap` are both drawn **once per wave**, so one wave runs fast
and tight, the next slow and loose.

Cars join at a **fixed gate**: `spawnGap.max` behind the road's start marker,
never further back, whichever gap a wave happens to draw.

The gate has two locks and needs both. A **clock** carries the break between
waves and keeps working when a row is empty. A **ruler** measures the real
distance to the last car, which is what stops a car being dropped on top of a
queue that stopped after it entered — the roodTwo case. Each has a failure the
other covers, and each has been the bug at some point: a break expressed only as
distance vanished the moment a row emptied, because there was no longer a car to
measure against; expressed only as time it was swallowed whenever `spawnGap` was
the larger of the two.

Measured headways at a fixed point on the road, with `breakTime: 1.5–2.5`:
`[0.6 0.6 0.6 3.25 0.77 0.77 2.67 0.75]`. The in-wave figures shift between waves
as `spawnGap` is redrawn, and each break is the in-wave headway plus a pause
inside the configured range.

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

The warm-up runs with clips **off**. It is not rendering, so a clip fired there
would not play — it would sit queued and then start on the first visible frame,
which is how every car that braked during the warm-up ended up diving in unison
the moment the page appeared. Collisions are off for the same window, so the
opening state can never contain a wreck.

`brake.trigger` is a **fraction of that road's own `brake` rate**, not a
deceleration. An absolute figure has to be kept in step by hand with
`ROAD_TWO.brake`, and once that was retuned to 60 a trigger of 1 meant any frame
losing 0.017 of a unit counted as braking — noise in the following model rather
than a stop.

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

## Night

The scene runs at night, and the whole look is built so that adding light costs
nothing.

**No light is a Babylon light.** A Babylon light is priced per *material*, not per
light: thirty car headlights would recompile every shader in the city for thirty
lights and then pay for all of them on every pixel of every surface. The scene
has exactly three real lights — a moon, a sky fill, and the signal's spill — and
that number does not change however much of the city is lit.

Everything else is **additive geometry, hardware-instanced**. Each car carries a
pool of light on the road ahead, a bright spot at the bumper and a red one at the
tail; each lamp post carries a bulb and a pool. Every car after the first
instances the same three source meshes, every post the same two. Measured: 126
headlight meshes off **3** sources, and adding the lot moved draw calls from 977
to 991.

The cone **starts at the bumper**, as a spot the width of the lamp, and fans out
from there — `beam.startWidth` and `beam.endWidth` are those two widths in metres.
It reaches full brightness within the first 3% of its length rather than
instantly, which is only to avoid a straight edge across the head of it; what
really stops a seam showing is starting narrow, since there is nothing wide
enough at the car to show one.

**The beam texture is written pixel by pixel**, not built from canvas gradient
stops. A radial gradient can only ever produce an ellipse — symmetric,
hard-edged, and reading as a blob dropped on the tarmac rather than light thrown
forward. The falloff wanted here differs per axis: across the width, a squared
parabola, which has no visible edge at all; along the length, a quick rise to a
peak just ahead of the bumper and then a long decay that reaches zero *before*
the plane ends, so the far end has nothing to cut off against. `HEADLIGHT.spread`
is those four numbers.

**Lamp positions come from the model.** A car may carry a `frontLamp` and a
`backLamp` node, each with a `left` and a `right` child; a headlamp and its cone
go at each front marker, and a single tail light at the midpoint of the back
pair. The models are different shapes, so a position measured off the bumper is
only ever right for some of them — a taxi's headlamps and a van's are not in the
same place, and nothing in a bounding box knows that.

Markers are read from the *template* rather than the clone, so it makes no odds
whether Babylon carries empty nodes across when a mesh is cloned. A car without
them falls back to `lamp.height` and `lamp.apart` off the measured bumper, which
means the two coexist: export a model with markers and it starts using them, with
nothing else to change.

**The lamps hang off the bottom of the car's animation stack**, so they rock with
the idle shudder, dip with the brake and tumble with a wreck. A lamp bolted to
the lane node instead stays perfectly level while the car it belongs to rolls
around, and reads as painted on.

The cones do not follow: they hang off the lane node, which carries position and
heading but no pitch or roll. A patch of lit road that tilts with the bodywork
cuts straight through the surface it is lying on.

The mount coordinates are the same either way — every node between the two is at
rest until an animation moves it — so which parent a light takes is purely a
question of what should move it.

Each car throws **two cones, one per headlamp**, not one down the middle. Both are instances of the same source
meshes, so the extra realism costs no draw calls at all.

The lamps sit at lamp height rather than road height — a glow down at the bumper
spills out around the car and reads as light pooling *underneath* it.

They all lie flat, facing up, and **none of them is billboarded**. Billboarding
writes the world matrix directly, and it cannot do that correctly through a
parent chain containing the glTF root's `(1, 1, -1)` mirror: it put the lamps at
`y = -1.5` instead of `+0.55`, under the road, where nothing they were given had
any visible effect. Lying flat needs no special case, costs nothing per frame,
and reads from every angle the camera can reach — it is always above the
junction. The street lamp bulbs had the same tag, made doubly meaningless by the
`freezeWorldMatrix` beside it, and are flat for the same reason.

Street lamps are placed from the model, not measured: every `SM_Prop_LightPole_Base`
in the .glb carries a child node named **`spot`** at the end of its arm, which is
exactly where the lamp hangs. Measuring the post's bounding box instead put the
light halfway along the arm, out over the road.

**Colour lives in the texture, not on the material** — and this one is a trap
worth knowing about. `StandardMaterial` *adds* its emissive texture to
`emissiveColor` rather than multiplying by it, then clamps the sum:

```glsl
vec3 emissiveColor = vEmissiveColor;
emissiveColor += TEXRD(emissiveSampler, ...).rgb;   // default.fragment
finalDiffuse = clamp(... + emissiveColor ..., 0.0, 1.0);
```

So a *white* glow texture pins every channel at 1 and the light comes out pure
white however warm a colour the material was handed. Saturating `emissiveColor`
had no effect at all until the colour was baked into the texture's RGB and
`emissiveColor` left black. `beamStrength` and friends now scale that baked
colour, which is why they cap at 1: past that the shader clamps and the hue
washes out again.

The other half of reading warm is that the road has to be **dark**. Additive
light lands on top of whatever is already there, so a brightly blue-lit road plus
an orange beam sums to white — the beam was measured adding a correct
`(80, 55, 7)` and still showing as `(222, 220, 216)` because of what it was
landing on. The moon, fill and IBL intensities are set low for that reason as
much as for the look.

Additive matters twice over. It never darkens what is behind it, and because
adding is commutative the instances need no per-mesh depth sort — which is what
makes them instanceable at all.

**The city lights itself.** The `.glb` carries an emissive atlas for its windows
(see the note above about Unity zeroing it), so at night `EMISSIVE_STRENGTH`
turns every window on at no per-mesh cost. Their glow comes from **bloom**, not
the glow layer: bloom is a fixed cost whatever is emitting, while the glow layer
would re-render every lit mesh in the city into its own buffer. The glow layer
stays restricted to the signal.

**The sky is night, the key light is not.** `SKY.sunElevation` puts the sky's own
sun *below* the horizon, which is what makes SkyMaterial render deep dusk instead
of flat black and leaves a faint glow for the skyline to sit against. The
directional light still comes from above as a cool, dim moon. The IBL is baked
off that night sky, so the ambient is the right colour by construction.

Dials: `FOG` (with an `enabled` flag), `HEADLIGHT`, `STREET_LAMP`,
`EMISSIVE_STRENGTH`, `SKY.sunElevation`, and `SUN`/`FILL` for the moon.

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

**`public/` is the web root.** Vite serves it as-is, so `public/models/scene.glb`
is fetched from `/models/scene.glb`. Models go in `public/models/`, sounds in
`public/sounds/` — see `SOUND` in `src/scene/config.ts` for wiring a sound up.

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
