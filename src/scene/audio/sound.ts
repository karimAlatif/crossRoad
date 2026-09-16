import { Vector3, type Scene } from "@babylonjs/core";
import { SOUND } from "../config";
import type { Disposable, Range } from "../core/types";

/** The one-shot effects. The theme is separate: it loops on its own. */
export type SoundName = "move" | "brake" | "accident";

export type Sound = Disposable & {
  /**
   * Plays an effect. `at` is where it happened, in world space; leave it out for
   * a sound that has no place, and it plays centred at full volume.
   *
   * Safe to call as often as the game likes. Nothing is heard before the player
   * has interacted with the page — browsers forbid it — and calls made before
   * then are dropped rather than saved up, so the first click is not greeted by
   * every brake that happened during loading.
   */
  play: (name: SoundName, at?: Vector3) => void;
  /** Counters for tuning: voices playing, bursts merged, voices cut short. */
  stats: () => SoundStats;
};

export type SoundStats = {
  state: AudioContextState | "locked" | "off";
  /** Whether the theme is looping, and the volume it is at right now. */
  theme: { playing: boolean; volume: number };
  playing: Record<SoundName, number>;
  merged: Record<SoundName, number>;
  stolen: Record<SoundName, number>;
};

/** Settings shared by every one-shot in SOUND. */
type Effect = {
  files: readonly string[];
  volume: number;
  maxVoices: number;
  merge: number;
  pitch: Range;
  duck?: { amount: number; seconds: number };
};

/** One sound currently playing. */
type Voice = {
  name: SoundName;
  source: AudioBufferSourceNode;
  gain: GainNode;
  /** The gain it was started at, before any merged hits lifted it. */
  base: number;
  started: number;
  ends: number;
};

const NAMES: SoundName[] = ["move", "brake", "accident"];

/** How long a cut-short voice takes to fade out. Long enough not to click. */
const STEAL_FADE = 0.035;

/**
 * The game's audio.
 *
 * Plain Web Audio, not Babylon's audio engine: the whole job here is controlling
 * how sounds overlap, and that is easiest with direct hold of the nodes.
 *
 * What keeps it cheap when a whole queue brakes or pulls away at once:
 *
 * - **Decoded once.** Each file is fetched as soon as the page loads, decoded
 *   once when audio unlocks, and every play after that is a new source node
 *   reading the same shared buffer.
 * - **Bursts merge.** A second hit of the same sound within `merge` seconds of the
 *   first does not start another voice. It lifts the one already playing, a
 *   little and up to a limit. Twelve cars pulling away on one green is one
 *   getaway sound, a touch louder — not twelve copies of it stacked on top of
 *   one another, which would clip and phase into a buzz.
 * - **Voices are capped**, per sound and across everything. When a sound is at
 *   its limit, its oldest voice is faded out over a few milliseconds and the new
 *   one takes its place, so a new event is always heard and nothing clicks.
 * - **Variation.** Each play takes a random file from the list and a random
 *   pitch from its range, so repeats do not sound mechanical.
 * - **Silence costs nothing.** While the tab is hidden the audio context is
 *   suspended, and a sound with no files is skipped before any work is done.
 *
 * Position is used lightly: a sound pans towards the side of the screen it
 * happened on, and quietens with distance from the junction the camera is
 * looking at.
 */
export function createSound(scene: Scene): Sound {
  const playing = counters();
  const merged = counters();
  const stolen = counters();
  const effects: Record<SoundName, Effect> = {
    move: SOUND.move,
    brake: SOUND.brake,
    accident: SOUND.accident,
  };

  if (!SOUND.enabled) {
    return {
      play: () => {},
      stats: () => ({ state: "off", theme: { playing: false, volume: 0 }, playing, merged, stolen }),
      dispose: () => {},
    };
  }

  // --- Fetch now, decode later ---------------------------------------------
  //
  // The bytes are fetched straight away, alongside the city, so there is nothing
  // to wait for when the player first clicks. Decoding needs an AudioContext, and
  // making one before a user gesture earns a console warning in Chrome, so that
  // part waits.
  const bytes = new Map<string, Promise<ArrayBuffer | null>>();
  const fetchOnce = (url: string) => {
    if (!bytes.has(url)) {
      bytes.set(
        url,
        fetch(url)
          .then((response) => {
            // A dev server answers a path that does not exist with the app's own
            // page rather than a 404, so a wrong file name shows up as HTML.
            const type = response.headers.get("content-type") ?? "";
            if (!response.ok || type.includes("text/html")) {
              throw new Error("not found — check the file name and that it is in public/sounds/");
            }
            return response.arrayBuffer();
          })
          .catch((error: unknown) => {
            console.warn(`Sound "${url}" could not be loaded (${String(error)}); it will be silent.`);
            return null;
          }),
      );
    }
    return bytes.get(url)!;
  };
  for (const file of SOUND.theme.files) fetchOnce(file);
  for (const name of NAMES) for (const file of effects[name].files) fetchOnce(file);

  // --- Everything below exists only once audio is unlocked ------------------
  let context: AudioContext | null = null;
  let master: GainNode | null = null;
  let music: GainNode | null = null;
  let sfx: GainNode | null = null;
  let theme: AudioBufferSourceNode | null = null;
  const buffers = new Map<SoundName, AudioBuffer[]>();
  const voices: Voice[] = [];
  /** Voices still sounding, across every effect. Kept current by `sweep`. */
  let live = 0;
  let disposed = false;

  const decodeAll = async (ctx: AudioContext, files: readonly string[]) => {
    const decoded = await Promise.all(
      files.map(async (file) => {
        const data = await fetchOnce(file);
        if (!data) return null;
        try {
          // decodeAudioData detaches the buffer it is given, so it gets a copy:
          // the same file may be listed under more than one sound.
          return await ctx.decodeAudioData(data.slice(0));
        } catch (error) {
          console.warn(`Sound "${file}" could not be decoded (${String(error)}); it will be silent.`);
          return null;
        }
      }),
    );
    return decoded.filter((buffer): buffer is AudioBuffer => buffer !== null);
  };

  const unlock = async () => {
    removeGestures();
    if (disposed || context) return;

    const ctx = new AudioContext();
    context = ctx;
    master = ctx.createGain();
    master.gain.value = SOUND.master;
    master.connect(ctx.destination);
    music = ctx.createGain();
    music.gain.value = 0;
    music.connect(master);
    sfx = ctx.createGain();
    sfx.connect(master);
    if (ctx.state === "suspended") await ctx.resume();

    for (const name of NAMES) {
      decodeAll(ctx, effects[name].files).then((list) => buffers.set(name, list));
    }

    const themes = await decodeAll(ctx, SOUND.theme.files);
    if (disposed || themes.length === 0 || !music) return;
    const source = ctx.createBufferSource();
    source.buffer = themes[Math.floor(Math.random() * themes.length)];
    source.loop = true;
    source.connect(music);
    source.start();
    theme = source;
    // Faded in, so the music arrives rather than starting with a jolt.
    music.gain.setValueAtTime(0, ctx.currentTime);
    music.gain.linearRampToValueAtTime(SOUND.theme.volume, ctx.currentTime + SOUND.theme.fadeIn);
  };

  // Browsers only let audio start from inside a user gesture. The first one —
  // the click that works the traffic light, most likely — unlocks it.
  const gestures = ["pointerdown", "keydown", "touchstart"] as const;
  const onGesture = () => void unlock();
  for (const type of gestures) window.addEventListener(type, onGesture, { passive: true });
  function removeGestures() {
    for (const type of gestures) window.removeEventListener(type, onGesture);
  }

  // A hidden tab plays nothing and draws nothing, so its audio should cost
  // nothing either.
  const onVisibility = () => {
    if (!context) return;
    if (document.hidden) void context.suspend();
    else void context.resume();
  };
  document.addEventListener("visibilitychange", onVisibility);

  // --- Placing a sound ------------------------------------------------------
  const right = new Vector3();
  const offset = new Vector3();

  /** Pan from -1 to 1, and a volume factor from `quietest` to 1. */
  const place = (at: Vector3 | undefined): { pan: number; level: number } => {
    const camera = scene.activeCamera;
    if (!at || !camera) return { pan: 0, level: 1 };

    camera.getDirectionToRef(Vector3.RightReadOnly, right);
    at.subtractToRef(camera.position, offset);
    const across = Vector3.Dot(offset, right);
    const along = Math.hypot(offset.x, offset.z) || 1;
    const pan = Math.max(-1, Math.min(1, (across / along) * SOUND.space.pan));

    // Distance from what the camera is looking at, not from the camera: the
    // camera sits well back from the junction, and everything the player cares
    // about is roughly the same distance from the lens.
    const target = (camera as { target?: Vector3 }).target ?? camera.position;
    const distance = Math.hypot(at.x - target.x, at.z - target.z);
    const { near, far, quietest } = SOUND.space;
    const t = Math.max(0, Math.min(1, (distance - near) / Math.max(1e-3, far - near)));
    return { pan, level: 1 - t * (1 - quietest) };
  };

  /** Fades a voice out quickly and stops it: used when its slot is needed. */
  const cut = (voice: Voice, now: number) => {
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.linearRampToValueAtTime(0, now + STEAL_FADE);
    try {
      voice.source.stop(now + STEAL_FADE + 0.01);
    } catch {
      // Already stopped: nothing to do.
    }
    voice.ends = now;
    stolen[voice.name]++;
    playing[voice.name]--;
    live--;
  };

  /** Forgets voices that have finished, and counts the ones still going. */
  const sweep = (now: number) => {
    for (const name of NAMES) playing[name] = 0;
    live = 0;
    for (let i = voices.length - 1; i >= 0; i--) {
      if (voices[i].ends <= now) {
        voices.splice(i, 1);
      } else {
        playing[voices[i].name]++;
        live++;
      }
    }
  };

  /** The oldest voice still sounding, of one effect or of any. */
  const oldest = (now: number, name?: SoundName): Voice | null => {
    for (const voice of voices) {
      if (voice.ends > now && (!name || voice.name === name)) return voice;
    }
    return null;
  };

  /** The newest voice of one effect still sounding. */
  const newest = (now: number, name: SoundName): Voice | null => {
    for (let i = voices.length - 1; i >= 0; i--) {
      const voice = voices[i];
      if (voice.ends > now && voice.name === name) return voice;
    }
    return null;
  };

  const duck = (amount: number, seconds: number, now: number) => {
    if (!music || !theme) return;
    const full = SOUND.theme.volume;
    const gain = music.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(full * amount, now + 0.06);
    gain.setValueAtTime(full * amount, now + seconds);
    gain.linearRampToValueAtTime(full, now + seconds + 0.6);
  };

  return {
    play: (name, at) => {
      const ctx = context;
      if (!ctx || !sfx || ctx.state !== "running") return;
      const effect = effects[name];
      const list = buffers.get(name);
      if (!list || list.length === 0) return;

      const now = ctx.currentTime;
      sweep(now);
      const { pan, level } = place(at);
      const volume = effect.volume * level;

      // A burst: lift the voice already playing instead of stacking another.
      const latest = newest(now, name);
      if (latest && now - latest.started < effect.merge) {
        const lifted = Math.min(latest.base * 1.6, latest.gain.gain.value + volume * 0.25);
        latest.gain.gain.setTargetAtTime(lifted, now, 0.02);
        merged[name]++;
        return;
      }

      // Make room: first within this sound, then across the whole mix. Voices are
      // kept in the order they started, so the first one found is the oldest.
      if (playing[name] >= effect.maxVoices) {
        const victim = oldest(now, name);
        if (victim) cut(victim, now);
      }
      if (live >= SOUND.maxVoices) {
        const victim = oldest(now);
        if (victim) cut(victim, now);
      }

      const buffer = list[Math.floor(Math.random() * list.length)];
      const rate = effect.pitch.min + Math.random() * (effect.pitch.max - effect.pitch.min);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = rate;
      const gain = ctx.createGain();
      gain.gain.value = volume;
      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      source.connect(gain).connect(panner).connect(sfx);
      source.onended = () => {
        source.disconnect();
        gain.disconnect();
        panner.disconnect();
      };
      source.start(now);

      voices.push({
        name,
        source,
        gain,
        base: volume,
        started: now,
        ends: now + buffer.duration / rate,
      });
      playing[name]++;
      live++;

      if (effect.duck) duck(effect.duck.amount, effect.duck.seconds, now);
    },

    stats: () => {
      if (context) sweep(context.currentTime);
      return {
        state: context ? context.state : "locked",
        theme: { playing: theme !== null, volume: music ? +music.gain.value.toFixed(3) : 0 },
        playing,
        merged,
        stolen,
      };
    },

    dispose: () => {
      disposed = true;
      removeGestures();
      document.removeEventListener("visibilitychange", onVisibility);
      try {
        theme?.stop();
      } catch {
        // Never started.
      }
      voices.length = 0;
      void context?.close();
      context = null;
    },
  };
}

function counters(): Record<SoundName, number> {
  return { move: 0, brake: 0, accident: 0 };
}
