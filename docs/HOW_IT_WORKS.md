# How blueMino works

A walk through every flow in the project: what happens, in what order, and which
file and setting controls it. Read it top to bottom once and you should be able
to find anything afterwards.

`AI_CONTEXT.md` next door covers the same project for an AI assistant — it is
terser and is mostly a list of traps.

---

## 1. The shape of the project

```
index.html → src/main.tsx → src/App.tsx → createCityScene()
```

React does almost nothing here. It mounts a `<canvas>`, shows the loading
overlay, and hands the canvas to `createCityScene`. Everything after that is
Babylon.js.

```
src/scene/
  config.ts           every number you can tune, in one file
  createCityScene.ts  builds the scene and wires the parts together
  core/               small shared pieces every system uses
  world/              the things that do not move: city, camera, lights, signal
  traffic/            the cars: the road model, the simulation, the rig
  effects/            smoke, skid marks, light trails, headlights, crashes
  audio/              the sound engine
public/
  models/scene.glb    the city
  sounds/             your sound files go here
```

**One rule worth knowing:** `config.ts` is the only place with numbers in it. If
you want to change how something looks or behaves, you should be able to do it
there without opening anything else.

---

## 2. Starting up

`createCityScene` runs once, in this order. The labels are what you see on the
loading screen.

1. **Engine and scene.** The device is sized up first (`quality.ts`) and a
   graphics level chosen, because some of what follows cannot be changed later:
   a shadow map cannot be resized, and a headlight cone never built costs
   nothing forever. See "One game, every device" below.
2. **The clock starts.** One heartbeat that every moving part hangs off. More on
   this below.
3. **Sound begins downloading** in the background, so it is ready but silent.
4. **Sky and lights** are created before the city, so the city is lit the moment
   it appears.
5. **The city loads** (`world/city.ts`). Three things happen to it:
   - Unity's exporter writes the emissive strength as zero, which turns off every
     lit window and neon sign. It is put back (`EMISSIVE_REVIVE`) — this is what
     the bloom then picks up.
   - The `Cars` group is hidden. It is not decoration; it is the library the
     traffic clones from.
   - Every static mesh is frozen, so Babylon stops recalculating where it is.
6. **The camera** is placed and the opening shot begins — see section 6.
7. **Shadows**: only meshes near the junction, and only ones big enough to cast a
   shadow you could see, are registered.
8. **Street lamps** are placed on the `spot` marker inside each lamp post.
9. **The markers are read** (`world/props.ts`) — see the next section.
10. **The signal** is built where the `traffic light` marker is.
11. **The traffic starts** — including 25 seconds of simulation run instantly, so
    the junction is already busy on the first frame rather than filling up while
    you watch.
12. **Post-processing** is attached: bloom, tone mapping, tilt-shift depth of
    field, and a glow layer restricted to the signal lamps.
13. **Shaders are compiled** before the first visible frame, so the reveal is
    smooth instead of a stutter of materials warming up.

---

## 3. The markers in the model

The whole layout is authored in the `.glb`, not in code. Under a top-level
`props` group:

```
props
  ├── traffic light      where the signal stands
  ├── roodOne            start, end
  └── roodTwo            start, end, cross      ← "cross" is the stop line

cameraPath               the opening shot
  ├── start
  └── end
```

Each car model may also carry lamp markers:

```
SM_Veh_Car_Taxi_03
  ├── forntLamp → left, right     (yes, spelled that way in the model)
  └── backLamp  → left, right
```

8 of the 20 car models have these. The rest fall back to positions measured from
their own bounding box. Both paths put the **left** side first.

Lamp posts carry a `spot` child at the end of the arm, which is where the light
actually hangs.

**To move a road or the signal, move the marker in the model.** Nothing in the
code needs to change.

---

## 4. One heartbeat

`core/frame.ts` holds the only per-frame callback in the project. Everything that
moves subscribes to it with `clock.each(...)` and is given the length of the
frame.

Two reasons this matters to you:

- **One definition of a frame.** A long pause — you alt-tab, the browser garbage
  collects — is capped at 1/20 s, so the traffic never teleports and no animation
  fast-forwards. Every system agrees on this.
- **Order is subscription order.** The traffic subscribes last, after the
  effects, so everything is consistent within a frame.

---

## 5. The traffic

The biggest system, split into four files.

- **`traffic/road.ts`** — what a lane *is*: its direction, its rules, where cars
  join it. Pure logic, no per-frame state.
- **`traffic/flow.ts`** — how the cross traffic arrives, which is the game.
- **`traffic/traffic.ts`** — the simulation that runs each frame.
- **`traffic/collisions.ts`** — whether two cars are touching.

### roodOne: the road you have to read

It never stops — not for the signal, not for the car in front — so it has no
following model at all and every car holds the speed it arrived with. That is a
design decision, not a saving: a road that brakes is a road whose future is
hidden, and this one has to be legible three seconds ahead or you are being
asked to guess rather than judge.

Everything the crossing *feels* like therefore comes from the order cars arrive
in, and that order is built from four ideas.

**Runs and gaps.** Cars come in runs of a few, nose to tail, at a spacing drawn
once per run — so one run arrives tight and the next strung out. After each run
the row leaves a gap, and the gap is one of two kinds: a **tease**, which looks
like an opening and closes before a car could use it, or a **fair** one, which a
single brave car can make. A road where every gap is crossable is a road you
never have to watch.

**The two rows are strangers — mostly.** They used to break together, which
meant the road was either completely full or completely empty — a metronome, and
once you learn its beat there is no game left. Each row now keeps its own rhythm,
so what you are judging is the *overlap* of two unrelated streams.

But two truly unrelated streams almost never leave a gap in the same place —
measured, about once every two and a half minutes — which left nothing to cross
*between*, and the game became waiting for the road to clear. So a fair gap in
one row has a chance to **line up** with the other (`gap.pairChance`): both rows
leave the gap at once, the way traffic does downstream of a light. That is the
crossing this game is built around — a car's width of road between cars, there
for a moment, that has to be spotted and taken.

**Every car has its own speed.** The same gap is a different problem with a
quick car behind it, and it should not look like it. Long vehicles lean towards
the slow end, so the thing that lumbers looks like it lumbers. No car can ever
catch the one in front: a joining car works out how fast the leader is leaving
and clamps itself to that — measured over five minutes at every difficulty, the
tightest gap between two cars in a row was 1.15 m and the road never once ran
into itself.

**And the road keeps a promise.** If the junction stays shut longer than
`patience`, an opening is made — always at least `clear.counts` long, whatever
else is configured. The road can also clear itself on a random interval
(`clear.every`), which is the generous, flush-the-queue version; at the hard end
that is rare and short, so the openings you get are overwhelmingly the gaps
between cars. That one sentence is the whole design: unpredictable, never
unfair.

### One dial for all of it

`ROAD_ONE.difficulty` runs from 0 to 1, and every pair written `{ easy, hard }`
in the block is read through it. Measured over four simulated minutes at each
setting:

| difficulty | cars/min | junction busy | openings/min | longest wait | careful player | sharp player |
|---|---|---|---|---|---|---|
| 0 | 27 | 26% | 7.0 | 11 s | 69 cars/min | 70 cars/min |
| 0.5 | 60 | 47% | 5.6 | 24 s | 48 cars/min | 48 cars/min |
| 0.75 | 80 | 58% | 4.0 | 30 s | 36 cars/min | 35 cars/min |
| **0.95** (current) | 102 | 69% | 2.4 | 34 s | 16 cars/min | 24 cars/min |
| 1 | 108 | 70% | 2.4 | 35 s | 10 cars/min | 30 cars/min |

Eight to twelve simulated minutes per row. At the easy end the two players do
equally well; at the hard end they come apart, because the openings are tight
and brief enough that taking a 2.6-second gap rather than waiting for a
3-second one is the difference between getting a car across and not. That is
the difficulty curve doing its job: the hard end is not just less generous, it
rewards being sharp.

An "opening" is 2.5 seconds of clear junction — about what one car needs to pull
away and get across. The "longest wait" tracks `patience` by design: that is the
promise. The "careful player" is a stand-in that opens the light on a
three-second window and closes it as the window runs out; the "sharp player"
takes 2.6-second ones. Neither **crashed once at any setting** — the difficulty
changes how much you can get through, not whether good play is punished.

**What actually makes it harder**, measured rather than guessed:

- **Pace and density** — `speed`, `run`, `headway`. At the top end a car covers
  the whole road in under two and a half seconds, so a gap has to be seen and
  taken rather than considered. This made crossing much harder without changing
  *what kind* of opening the player gets.
- **How often gaps line up** — `gap.pairChance` — and how long the promise waits
  — `clear.patience`. These set how many openings there are at all.
- **Not** shorter gaps. Counter-intuitively, tightening `gap.fair` made the game
  *easier*: shorter gaps mean each row cycles faster, which gives gaps more
  chances to line up.
- **Not** fewer fair gaps. Cutting `fairChance` leaves too few gaps to line up,
  and the openings the player gets start arriving on the promise's timer — which
  is predictable, and predictable is the opposite of what this road is for.

For comparison, the setting that preceded this one — difficulty 0.95 with the
road's clearings cut to a tenth of a second — measured **0.4 openings a minute,
waits of nearly two minutes, and not one car across** for the careful player.
Cutting the clearings to zero had quietly switched off the promise too, which is
why the promise now has a floor of its own.

**roodTwo obeys the signal.** These cars queue behind the stop line and behind
each other, so they need the full model: `minGap`, `accel`, `brake`, and
`comfort` — the fraction of maximum braking a driver plans with. Approach speed
is `√(2 · brake · comfort · distance)`, which stops in time at any speed. A
simple "slow down proportionally to distance" cannot, and used to roll the queue
through a red light.

### The entry gate

A car joins at a **fixed point** just behind the road's start marker — never
further back. What holds the gate shut differs by road: the cross traffic works
in *time*, from its own rhythm, and the queueing road works in *distance*, from
the car already there. Both also check there is physical room, because a wreck
can leave a car stopped across the entry and dropping the next one on top of it
would be a crash nobody saw coming.

Both are needed. The distance check alone cannot work on an empty road: once the
last car has gone there is nothing to measure against, and the break between
waves disappears entirely.

### Collisions

Cars are rectangles on the ground, tested with a separating-axis test, shrunk
slightly (`TRAFFIC.hitboxScale`) so bumper-to-bumper queueing is not a crash. On
impact both cars spin, hop, squash and then poof away (`CRASH`), and an
`onCrash` event fires — which is where game logic would hook in.

### Recycling

Cars are pooled. A car reaching the end of a road is hidden and reused at the
start. As far as the effects are concerned, that is a **new car setting off**: it
draws fresh random values and starts new skid marks.

---

## 6. The camera

There is exactly one view, and the player never moves it.

`CAMERA.view` holds it: a world `target` the camera looks at, an `alpha` that
swings it round that point, a `beta` that tilts it down from overhead, and a
`radius`. **The two angles are in degrees**, the way they read off a scene
inspector.

The opening move is authored in the model, as the `cameraPath` node above —
`start` and `end` for the drive, and `view` for the point the camera turns onto
along the way.

**Forward along the path.** The camera drives in a straight line from `start` to
`end`, looking *down the road* — at a point `lookAhead` metres past the end of
the path — not at the junction. That is what makes the opening a drive up the
street rather than a slow approach to a crossroad you can already see. It eases
away and arrives gently rather than running at one speed and stopping dead.

**The turn, four fifths of the way along.** At `turnAt` of the drive the camera
starts swinging its gaze onto the `view` marker, and lands on it exactly as it
reaches `end`. So the crossroad comes into frame while the camera is still
moving, and the arrival is already looking at it. The drive itself is untouched
by this — the camera does not slow down, change line or change speed; only the
direction it faces.

**Then up into the game view.** From the end of the path the camera rises and
swings out to the game's distance, the look-at easing the rest of the way from
the `view` marker onto `CAMERA.view.target`. It climbs from 10 m on the road to
about 30 m above the crossroad and comes to rest exactly on `CAMERA.view`.

All of that is two tracks of keyframes — one for where the camera *stands*, one
for what it *looks at*:

| time | stands | looks at |
|---|---|---|
| 0 | `start` | down the path |
| `turnAt · flySeconds` | — | down the path (held) |
| `flySeconds` | `end` | the `view` marker |
| `+ settleSeconds` | the game view | `view.target` |

and the intro eases along both at once. Keeping them apart is exactly what buys
the mid-drive turn: the look-at has a key at 80% that the standing track knows
nothing about, so the drive is still one unbroken move from `start` to `end`.

Describing the camera by position and look-at, rather than by `alpha`, `beta` and
`radius`, is what keeps the rest simple. An ArcRotateCamera's position is a
*consequence* of those three numbers swung around its target, so animating them
directly would make every leg an arc, and every change of target would silently
rewrite them. Here the camera is put where it should be and pointed where it
should look, and Babylon works the angles out backwards.

It is one callback on the shared clock, and it unsubscribes itself the moment it
arrives, so once the intro is over nothing of it is running at all.

**The shot is yours to author.** Move `start`, `end` and `view` in the model to
change the drive and what it turns onto. `CAMERA.intro.lookAhead` sets how far
down the road the camera watches on the way in, `turnAt` when the turn begins
(0.8 = the last fifth of the drive), and `flySeconds` and `settleSeconds` time
the two halves. If the model has no `cameraPath`, a wide establishing shot is
worked out from the view instead, so the intro still happens.

**Then it is pinned.** The camera's inputs are removed and both limits of each
angle are closed onto the value it holds, so nothing can move it — not a drag,
not a scroll, not something calling `attachControl` later, not even code setting
`camera.alpha` directly. Set `CAMERA.locked` to `false` if you ever want it to
let go.

### Every screen gets the same shot

A phone held upright and a 21:9 monitor cannot show the same picture through the
same lens. With a fixed lens the *vertical* angle is what stays constant, so the
narrower the screen the less of the world fits across it — and a view framed on a
desktop quietly loses the sides of the junction on a phone.

So the framing is a promise, not a lens setting. `CAMERA.frame` is an area — in
metres, on the plane through the view's target — that is visible on every screen,
and the camera does whatever it has to in order to keep it:

1. **It opens the lens.** Free, and it moves nothing: same spot, same angle, same
   distance, same fog. The same shot with a wider edge.
2. **Then, only if that is not enough, it steps back.** Straight out along the
   same line, so the angle and the composition hold and the junction just sits a
   little further away. The tilt-shift follows the camera's distance on its own,
   so it stays focused on the junction.

The lens stops opening at `frame.maxFov` — in **degrees**, like the view's own
angles — because this camera looks down at 37°: past about 74° the top of the
frame climbs over the horizon into empty sky, and well before that a wide lens
starts to look like a fisheye. That is the point where distance takes over.

**One width cannot serve both shapes of screen.** Enough city to fill a wide
monitor, guaranteed across a phone held upright, means showing the world three or
four times taller than it is wide — and everything shrinks. So `frame.width` is
what a *wide* screen shows across, and `frame.portraitWidth` is what a *tall* one
must fit: the junction, and not much more. Screens in between blend smoothly, so
turning a tablet on its side never makes the framing jump. The extra height a
tall screen shows is a gift rather than a waste: it is more of the cross traffic
coming, which is exactly what the player is reading.

**Tall screens have a view of their own: `CAMERA.portraitView`.** It has the same
four fields as `view` — target, alpha, beta, radius — and phones follow it
exactly the way wide screens follow `view`. A composition does not survive a
change of shape: `view.target` sits off to one side of the junction, a fine use
of a monitor's spare width and a poor use of a phone's, where width is the one
thing there is none of. So the portrait view is authored separately. Its default
target is the junction's own centre, measured from the crossing poles, so a tall
screen can frame the junction tightly without losing either edge.

Screens between the two shapes blend the two views — target, angles and distance
together, the swing the short way round — from fully `portraitView` at 3:4 and
taller to fully `view` at 16:10 and wider, so turning a tablet never makes the
camera jump. The lens and distance then adapt *on top of* whichever view is in
force, to that exact screen: a 9:16 phone and a 9:19.5 one both come out as close
to the portrait view as their shape allows. The authored `radius` is the
closest the camera will be; a narrower phone can still step back further if
`portraitWidth` will not otherwise fit across it.

Measured by moving `portraitView` to target `(-20, 0, 2)`, alpha 240, beta 50,
radius 44 and reading where the camera ended up: every portrait screen aimed at
exactly `(-20, 0, 2)` at 240° and 50°, the iPad at exactly 44 m and the phones a
little further back for their shape — and the desktop did not move at all.

Measured at `width` 82 and `portraitWidth` 35 — how much of the screen the
junction itself fills is what tells you whether the view reads as "the same":

| screen | lens | distance | junction fills |
|---|---|---|---|
| 1080p, 4K, laptop | 49.5° | 50 m | 39% wide, 52% tall |
| iPad landscape (4:3) | 56° | 50 m | 45% wide, 45% tall |
| iPad portrait (3:4) | 50° | 50 m | 88% wide, 53% tall |
| phone portrait (9:16) | 64° | 50 m | 88% wide, 40% tall |
| phone portrait (tall, 9:19.5) | 70° | 54 m | 86% wide, 32% tall |

Before `portraitWidth` existed — one width of 82 for every screen, and a lens
cap that had been written in degrees but was read as radians, so it was no cap at
all — a phone held upright opened the lens to **121°** and the junction filled
**13%** of the screen's height. That was the "too far away on phones".

Lower `portraitWidth` is closer. At 35 the signal and the first waiting cars are
still in view on the left; at 33 the queue starts to leave the frame, and that is
the player's own traffic, so 35 is about as close as it should go.

Rotating mid-game is handled the same way, including mid-intro: the lens follows
immediately, and the opening lands on — and pins to — whatever the screen has
become.

### And the right number of pixels

`core/viewport.ts` is the one place that answers the canvas. On every size change
it settles three things in one pass: how many pixels to render, the engine's idea
of its own size, and the framing above.

It watches with a `ResizeObserver` on the canvas rather than `window.resize`,
because the canvas changes size for reasons the window knows nothing about — a
rotated phone, an address bar sliding away, a devtools pane. The work is
coalesced into the next animation frame, because a drag-resize fires in bursts
and every `engine.resize()` reallocates the post stack's render targets.

The resolution is the smallest of three limits: the display's own pixel ratio,
the level's `maxPixelRatio`, and its `maxPixels` — a flat budget on the total.
That last one is what protects a 4K monitor, which would otherwise ask for four
times the shading of a 1080p one for a scene that is already fill-rate bound. A
maximised 4K window renders at about 2300 x 1300 and is then scaled up.

### One game, every device

A 2019 Android phone and a desktop with a graphics card are asked to draw the
same city. `GRAPHICS` in the config holds three versions of the answer, and
`quality.ts` decides which one this machine gets.

**It guesses first, then measures — once.** The guess reads what the browser
will admit to — the GPU's name, the core count, the memory, whether the pointer
is a finger — and errs low on purpose. Then the opening shot doubles as a
benchmark: while the camera flies in, the scene listens to its own frames, and if
the typical one is too slow it picks the level that fits, in one step, before the
camera settles. After that the picture **never changes again**.

That last part is the lesson of an earlier version, which kept watching all
session and dropped a level whenever the frame rate dipped. Each drop rebuilt the
bloom and switched off the tilt-shift and shadows in a single frame, so the whole
scene visibly lurched in the middle of play — and because it listened from the
very first frame, when every game hitches, it could talk a perfectly good machine
down a level before anything had happened. Now it skips the first moments,
judges the median frame rather than the worst ones, and only ever acts while the
camera is moving.

**What each level gives up** was decided by measuring, not taste. Switching each
feature off in turn, on a software renderer where fill rate is the scarce thing:

| | share of a frame |
|---|---|
| halving the resolution | **38%** |
| bloom | 8% |
| the shadow pass | 8% |
| the glow layer | 4.6% |
| skid marks and light trails | 2.2% |
| depth of field | 1.5% |
| FXAA, sharpen | ~1% |
| **all sixty headlight cones** | **0.3%** |

Which is why the levels look the way they do. Resolution carries most of the
load. The headlight beams — which look like the expensive thing, sixty additive
quads — cost nothing worth having, so they survive even at the bottom: a night
street with no headlights is not this game.

| | high | medium | low |
|---|---|---|---|
| pixel budget | 2.5 M | 1.5 M | 0.8 M |
| shadows | 1536, two passes | 1024, one pass | none |
| depth of field | yes | yes | no |
| bloom | 0.6 / 64 | 0.45 / 48 | 0.3 / 32 |
| sharpen | yes | no | no |
| headlights, glow, smoke | yes | yes | yes |
| skid marks, light trails | yes | yes | no |
| texture filtering | 8x | 4x | 1x |

Measured on the same machine, low draws a frame about **three times faster** than
high.

`GRAPHICS.force` pins a level if you want to see what a phone gets — set it to
`"low"` and reload; a pinned level is never second-guessed. `GRAPHICS.adapt`
tunes the benchmark, or switches it off.

**The console says what happened.** Every start prints one line — the level and
the GPU it is running on — and, if the benchmark had to lower it, a second line
saying from what, to what, and how slow the frames were:

```
Graphics: high on NVIDIA GeForce RTX 4060 Laptop GPU.
```
```
Graphics: high on Intel(R) UHD Graphics.
Graphics: lowered from high to medium — frames took 43 ms during the opening, …
Graphics: that is a built-in graphics chip. If this machine also has a dedicated
graphics card, set the browser to use it — …
```

**Laptops with two GPUs run browsers on the weak one.** A gaming laptop has a
built-in graphics chip for battery life and a dedicated card for games, and
Windows gives web browsers the built-in one by default. A page cannot overrule
that: the engine asks for `powerPreference: "high-performance"`, and Chrome on
Windows ignores it. Measured on an RTX 4060 laptop, the same scene at 1080p ran
at **92 fps on the card and about 16 fps on the Intel chip Chrome had picked** —
so the game correctly lowered itself, on hardware that could have run it at the
top level with room to spare. The fix is on the machine, not in the game:
*Settings › System › Display › Graphics*, pick the browser, choose *High
performance*, and restart the browser. The console's third line says exactly
that when it applies.

---

## 7. A car

Each car is a stack of transform nodes, each with exactly one writer:

```
root    lane position and heading      ← the simulation owns this
 idle   the left-right shudder          ← AnimationGroup, only while stopped
  brake the one-shot nose dive          ← AnimationGroup
   move the one-shot pull-away lift     ← AnimationGroup
    crash the spin and tumble           ← written per frame, only while wrecked
     body the model
```

Giving every animation its own node is what lets a shudder and a dive overlap
instead of fighting over one transform.

Three clips, all in `traffic/carAnimations.ts`, tuned in `ANIM`:

- **idle** — a left-right shudder, looping, only while stopped.
- **brake** — the nose dives, rebounds past level and settles. Fires once when a
  car starts braking hard, where "hard" is `ANIM.brake.trigger` as a fraction of
  that road's own braking rate.
- **move** — the mirror: the nose lifts as the car pulls away. Fires once when a
  stopped car starts moving.

A car already rolling along plays none of them.

`clipTiming()` works out, from the keyframes and the playback speed, *when* each
clip reaches its extreme. The effects use it, so retuning a clip carries its
smoke with it.

---

## 8. Effects

All in `effects/`, all tuned in `CAR_FX`, `SKID_MARK` and `LIGHT_TRAIL`.

| effect | when | where it comes from |
|---|---|---|
| exhaust breath | while idling | one soft puff, low behind the car |
| getaway cloud | on `move` | from under the car, spilling both sides |
| brake cloud | on `brake` | ahead of the front lamps |
| skid marks | while moving, for a window after setting off | the ground under the `backLamp` markers |
| light trail | any moving car | the `backLamp` markers, at their own height |
| crash | on impact | flash, sparks and smoke |

### How they stay cheap

- **One particle system per effect for the whole fleet.** These are all bursts,
  and a burst records where it happened at the instant it fires, so one system
  can throw smoke under a different car every frame. Forty cars cost the same as
  one.
- **Skid marks and light trails are geometry, not particles**: a fixed pool of
  flat strips instanced off one mesh — one draw call each, however many are down.
  The pool is a ring, so the road never accumulates without bound.
- **The trails are attached.** The newest segment is stretched every frame from
  where it started to where the lamp is *now*, so the ribbon always reaches the
  car. It is only let go once it is long enough, and the next one starts from the
  same spot, so the joins line up.
- **Fading is done by narrowing**, not by going transparent — which would need a
  per-instance colour buffer and a material set up to read it. A mark that wears
  from the edges in reads correctly anyway.

### Randomness per car

Each car draws its own values from the ranges in `SKID_MARK` and `LIGHT_TRAIL`
every time it sets off, so no two cars lay quite the same marks.

---

## 9. Night

### What the city is lit by

Four things, and only one of them is a light you would recognise as one.

**The environment** (`AMBIENT`, built in `world/ambient.ts`) does most of the
work. Every surface in the city is PBR, and a PBR surface takes most of its light
from its surroundings rather than from lights: the sky overhead, the warm band
along the horizon where a city throws its own light back off the haze, and the
dark bounce off the asphalt. A road's normal points at the sky, so this is what
makes the streets legible — `AMBIENT.intensity` is the single knob for "brighter".

This used to be baked by pointing a camera at the sky dome, and it was silently
broken. Babylon works out the diffuse half of an environment — the spherical
harmonics that every lit surface actually samples — by reading the cube's pixels
back off the GPU, and that read is exactly the kind of thing that works on one
driver and returns zeros on the next. Where it returned zeros the ambient term
was *nothing*: the same build, bright on one machine and black on another, with
only the self-lit things surviving — glowing windows above a black street. The
environment is now built on the CPU from three colours, with its harmonics worked
out in JavaScript, so there is no device on which it can come out empty.

**The sun** (`SUN`) is the moon, really: a dim, cold key from above with the
shadows. **The fill** (`FILL`) is a hemispheric light — sky colour from above,
ground bounce from below — which is the other half of what lights a road.

And **three real lights in the whole scene** is the limit: the sun, the fill, and
one spill on the signal. Everything else that glows is flat geometry that adds
itself to the picture.

This is not a shortcut, it is the reason it runs: a Babylon light costs per
*material*, so thirty headlights would recompile every shader in the city and
then be paid for on every pixel of every surface.

- **Headlights** (`HEADLIGHT`): a cone on the road and a lamp at each marker.
  The lamps hang off the car's animation stack so they rock and dive with it. The
  cones cannot — a flat cone tilted by a nose-dive ends up under the road — so
  they follow as a *slide* instead: a dive pulls the pool of light in towards the
  bumper, which is what a dipping headlight really does.
- **Street lamps** (`STREET_LAMP`): a bulb glow and a pool below, on each post's
  `spot`.
- **Faulty lights** (`flicker` inside both): a fraction of cars and lamps have a
  bad connection. They are steady, stutter for a fraction of a second, then
  settle. A lamp and the light it casts always go dark together.
- **The signal** (`LIGHT`): the lit lamp breathes and flares on each switch; the
  dark one has no halo at all.
- **Fog** (`FOG`) dissolves the far city, which both frames the junction and
  hides how little is lit out there.

### The city's own materials are corrected on the way in

The `.glb` is a Unity export, and it arrives with two settings that make a night
scene far darker than it needs to be (`CITY_MATERIALS`):

- **`metallic: 1` on the main atlas.** A fully metallic surface has *no diffuse
  response at all* — it is only ever a reflection of its surroundings — so the
  pavements, the props and the building faces took nothing from the moon or the
  fill. It is clamped to nearly zero, which is what gives the city back its own
  colour. Glass is exempt: it is meant to be a mirror.
- **A road atlas that is almost black**, which is right for daylight and much too
  dark at night. `roadTint` lifts its albedo — the knob for "the streets
  specifically are too dark", with no effect on the buildings or the mood.

Together with the environment above, these took the road from 81 to 114 on a
0–255 luminance scale, and the whole frame from 46 to 67, with the picture
identical on the highest and lowest graphics levels.

---

## 10. Sound

`audio/sound.ts`, tuned in `SOUND`. Four sounds: a looping **theme** at 60%, and
one-shots for **move**, **brake** and **accident**.

**To add one**, drop the file in `public/sounds/` and list it:

```ts
brake: { files: ["/sounds/brake.mp3"], volume: 0.55, ... }
```

List several files and each play picks one at random. An empty list is silent and
costs nothing. A wrong file name gives one clear warning in the console.

Nothing plays until your first click — browsers do not allow it. The files are
downloaded during loading and decoded on that click.

**Overlapping sounds** are the interesting part:

- Hits of the same sound closer together than `merge` seconds become **one
  sound, slightly louder**. A whole queue pulling away on one green is one
  getaway sound, not twelve stacked copies, which would clip and buzz.
- Each sound has a `maxVoices` cap, and there is an overall cap. Past it, the
  oldest voice fades out over 35 ms and the new one takes its place, so a new
  event is always heard and nothing clicks.
- Every play uses a random pitch from its range, so repeats do not sound
  mechanical.
- Sounds pan towards the side of the screen they happened on and quieten with
  distance from the junction.
- An accident briefly ducks the theme.

---

## 11. Where to change what

| I want to change… | Look at |
|---|---|
| **how hard it is to cross** | `ROAD_ONE.difficulty`, one number, 0 to 1 |
| the shape of the cross traffic | `ROAD_ONE.run`, `headway`, `gap` |
| how often a gap between cars lines up | `ROAD_ONE.gap.pairChance` |
| how often the road clears itself | `ROAD_ONE.clear` |
| how fast traffic moves | `ROAD_ONE.speed`, `ROAD_TWO.speed` |
| how cars queue and pull away | `ROAD_TWO.minGap`, `accel`, `brake`, `comfort` |
| the shudder, dive and lift | `ANIM` |
| smoke size and amount | `CAR_FX.idle / move / brake` |
| skid marks | `SKID_MARK` |
| light trails | `LIGHT_TRAIL` |
| headlights and tail lights | `HEADLIGHT` |
| street lamps and their flicker | `STREET_LAMP` |
| the signal's look and timing | `LIGHT` |
| **how bright the scene is** | `AMBIENT.intensity`, then `FILL.intensity` |
| the streets specifically | `CITY_MATERIALS.roadTint` |
| night colour, fog, sky | `FOG`, `SKY`, `SUN`, `FILL`, `CLEAR_COLOR` |
| bloom, contrast, depth of field | `POST` |
| what each class of device gets | `GRAPHICS.levels` |
| when it may lower the level | `GRAPHICS.adapt` (once, during the intro) |
| crashes | `CRASH` |
| sound | `SOUND` |
| the view, and the opening shot | `CAMERA.view`, `CAMERA.intro` |
| what stays in frame on a phone | `CAMERA.frame` |
| render resolution on big screens | `GRAPHICS.levels.*.maxPixels` |

---

## 12. Things that will surprise you

- **`capacity` is not `count`.** `count` is how many particles a puff makes;
  `capacity` is the ceiling for that effect across every car at once. Set
  capacity too low and puffs silently come out short — this happened, and it
  broke the left-then-right order of the idle breaths until the cap was raised.
- **`LIGHT_TRAIL.seconds` is how long the light lingers**, so at 20 m/s a 0.1 s
  trail is two metres of light. It is a duration, not a length.
- **The front lamp marker is spelled `forntLamp`** in the model. If you fix the
  spelling in the `.glb`, change `HEADLIGHT.mounts.front` to match or those cars
  will quietly fall back to estimated positions.
- **Changing a size range affects only new particles.** Nothing already in the
  air changes.
- **A car reused at the start of the road counts as a new car**, so it lays fresh
  skid marks.
- The game exposes `onCrash`, `isGreen` and `toggleLight` from `createCityScene`.
  Nothing uses them yet — they are there for game logic.
