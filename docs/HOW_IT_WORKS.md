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

1. **Engine and scene.** Render resolution is capped (`QUALITY.maxPixelRatio`) —
   a 2× display would otherwise shade four times the pixels.
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
6. **The camera** is placed on the junction and the intro fly-in starts.
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

The biggest system, split into three files.

- **`traffic/road.ts`** — what a lane *is*: its direction, its rules, where cars
  join it, and the wave arithmetic. Pure logic, no per-frame state.
- **`traffic/traffic.ts`** — the simulation that runs each frame.
- **`traffic/collisions.ts`** — whether two cars are touching.

### The two roads behave differently

**roodOne never stops.** It has no following model at all — every car simply
holds its speed. The gaps you need to cross are built in when a car *joins* the
road, not created by braking. Cars arrive in **waves**:

- `ROAD_ONE.carsPerWave` — how many cars travel together, counted **across both
  rows**, not per row.
- `ROAD_ONE.speed` — drawn once per wave, so every car in a wave travels at the
  same speed. This is not cosmetic: with no following model, two speeds in one
  wave would end in a collision.
- `ROAD_ONE.breakTime` — the seconds of empty road between waves. **This is the
  main difficulty dial**: it is the window you get to cross in.
- `ROAD_ONE.spawnGap` — bumper gap inside a wave, also drawn per wave.

**roodTwo obeys the signal.** These cars queue behind the stop line and behind
each other, so they need the full model: `minGap`, `accel`, `brake`, and
`comfort` — the fraction of maximum braking a driver plans with. Approach speed
is `√(2 · brake · comfort · distance)`, which stops in time at any speed. A
simple "slow down proportionally to distance" cannot, and used to roll the queue
through a red light.

### The entry gate

A car joins at a **fixed point** just behind the road's start marker — never
further back. Two things hold the gate shut: a clock carrying the break between
waves, and the car already on the road being clear by `spawnGap`.

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

## 6. A car

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

## 7. Effects

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

## 8. Night

There are only **three real lights in the whole scene**: the sun, the sky fill,
and one spill light on the signal. Everything else that glows is flat geometry
that adds itself to the picture.

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

---

## 9. Sound

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

## 10. Where to change what

| I want to change… | Look at |
|---|---|
| how hard it is to cross | `ROAD_ONE.breakTime`, `ROAD_ONE.carsPerWave` |
| how fast traffic moves | `ROAD_ONE.speed`, `ROAD_TWO.speed` |
| how cars queue and pull away | `ROAD_TWO.minGap`, `accel`, `brake`, `comfort` |
| the shudder, dive and lift | `ANIM` |
| smoke size and amount | `CAR_FX.idle / move / brake` |
| skid marks | `SKID_MARK` |
| light trails | `LIGHT_TRAIL` |
| headlights and tail lights | `HEADLIGHT` |
| street lamps and their flicker | `STREET_LAMP` |
| the signal's look and timing | `LIGHT` |
| night colour, fog, sky | `FOG`, `SKY`, `SUN`, `FILL`, `CLEAR_COLOR` |
| bloom, contrast, depth of field | `POST` |
| what to switch off for speed | `QUALITY` |
| crashes | `CRASH` |
| sound | `SOUND` |
| the camera framing | `CAMERA` |

---

## 11. Things that will surprise you

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
