# blueMino — Downtown Crossroad

A Babylon.js night-time city crossroad you play by working the traffic light.
Cross traffic runs in waves and never stops; the road the signal governs queues,
pulls away and occasionally piles into the other one. The city is the POLYGON
City block in `public/models/scene.glb`.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # typecheck + production bundle into dist/
npm run preview  # serve the production build
```

**Click anywhere to change the light.** Drag to orbit and scroll to zoom — the
framing is clamped so the junction cannot leave the shot. There is no HUD by
design.

## Where things are

```
src/scene/
  config.ts            every tunable in the project, in one file
  createCityScene.ts   builds the scene and wires the parts together
  core/                clock, maths, shared materials and textures
  world/               city, camera, lighting, sky, post-processing, signal, lamps
  traffic/             the road model, the simulation, the car rig, the clips
  effects/             smoke, skid marks, light trails, headlights, crashes
  audio/               the sound engine
public/
  models/              scene.glb — served at /models/scene.glb
  sounds/              drop sound files here and list them in SOUND
```

Everything you can tune lives in [`src/scene/config.ts`](src/scene/config.ts).

## Documentation

- **[docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md)** — every flow in the project:
  what happens at startup, how the traffic and the effects work, and which
  setting controls what. Start here.
- **[docs/AI_CONTEXT.md](docs/AI_CONTEXT.md)** — working notes for an AI
  assistant: architecture, the invariants that are easy to break, and how to
  verify a change in a real browser.

## At a glance

- **3 real lights** in the whole scene. Every other glow — headlights, street
  lamps, light trails, the signal — is additive geometry, because a Babylon light
  is priced per material and thirty of them would recompile every shader in the
  city.
- **~940 draw calls** for a junction with about fifty cars, their lights, their
  smoke and their marks on the road.
- **0.11 ms of CPU per frame** for the whole simulation and all its effects.
- One per-frame callback, one config file, one shared core.
