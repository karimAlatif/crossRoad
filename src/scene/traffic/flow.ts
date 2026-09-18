import { ROAD_ONE, TRAFFIC } from "../config";
import { between, clamp01 } from "../core/maths";
import type { Range } from "../core/types";
import { entryPoint, type Car, type Lane } from "./road";

/**
 * How the cross traffic behaves — the game, really.
 *
 * `ROAD_TWO` is the road the player governs; this is the one they have to read.
 * Everything the crossing feels like comes from the order cars arrive in, so
 * that order is the thing designed here, and it is built from four ideas.
 *
 * **Runs.** Cars arrive in runs of a few, nose to tail, at a headway drawn once
 * per run — so one run comes through tight and the next strung out. Between runs
 * the row leaves a gap, and the gap is drawn from one of two kinds: a *tease*,
 * which looks like an opening and closes before a car could use it, or a *fair*
 * one, which a single brave car can make. Difficulty decides how often each
 * turns up. The tease is not cruelty: a road where every gap is crossable is a
 * road you never have to look at.
 *
 * **The two rows are strangers.** They used to break together, which meant the
 * road was either full or empty — a metronome, and the moment you learn its
 * beat there is no game left. Each row now runs its own rhythm, so what the
 * player actually has to judge is the *overlap* of two unrelated streams, which
 * is irregular in a way neither row is on its own.
 *
 * **Every car has its own speed**, which is what makes a gap something to judge
 * rather than count. A big opening with a quick car bearing down on it is not the
 * same problem as the same opening behind a van, and it should not look like it.
 * Long vehicles lean towards the slow end, so the thing that lumbers *looks* like
 * it lumbers. No car may ever catch the one in front: `cruise` works out how fast
 * the car ahead is leaving and clamps to it, so this road cannot rear-end itself
 * and never has to brake — which is also what keeps it readable, because nothing
 * a car is about to do is hidden from the player.
 *
 * **And the road keeps a promise.** Every so often it clears completely: both
 * rows stand aside, and a real window opens at the junction. It happens on a
 * random interval, so it cannot be counted on — but if the dice go badly and the
 * junction stays shut longer than `patience`, the next one is pulled forward.
 * Unpredictable, never unfair. That is the whole design in one sentence.
 */

/** One row's state: the run being laid down, and when the next car may enter. */
export type Flow = {
  /** Cars still owed to this run. */
  left: number;
  /** Seconds between this run's cars. Drawn per run, so runs have character. */
  headway: number;
  /** The earliest the next car may enter. */
  openAt: number;
};

/** One road's state: its rows, and the rhythm they share. */
export type Stream = {
  rows: Lane[];
  /** When the whole road next stands aside. */
  clearAt: number;
  /** The last moment the junction was offering a real opening. */
  lastOpen: number;
};

export function createFlow(): Flow {
  const flow: Flow = { left: 0, headway: 0, openAt: 0 };
  startRun(flow);
  return flow;
}

export function createStream(rows: Lane[]): Stream {
  return { rows, clearAt: between(span(ROAD_ONE.clear.every)), lastOpen: 0 };
}

/**
 * Whether a car may join this row now, and how fast it goes if it does.
 *
 * Returns null while the row is holding the gate — for the headway inside a run,
 * for the gap after one, or because the road is standing aside.
 */
export function enter(lane: Lane, car: Car, tail: Car | null, now: number): number | null {
  const flow = lane.flow;
  if (!flow || now < flow.openAt) return null;

  // Room, whatever the clock thinks. The clock alone is enough while everything
  // is moving freely, but a wreck can leave a car stopped across the entry, and
  // dropping the next one on top of it would be a crash the player never saw.
  const s = entryPoint(lane, car.rig);
  const gap = tail ? tail.s - tail.rig.length / 2 - (s + car.rig.length / 2) : Infinity;
  if (gap < ENTRY_CLEARANCE) return null;

  const speed = cruise(lane, car, tail, gap);

  flow.left--;
  flow.openAt = now + (flow.left > 0 ? flow.headway : gapSeconds());
  if (flow.left <= 0) startRun(flow);
  return speed;
}

/**
 * Keeps the road's side of the bargain, once per frame.
 *
 * Two things happen here. The road clears itself every so often — both rows
 * stand aside and a real window opens at the junction — and, separately, the
 * junction is watched: if it has not offered an opening worth the name for
 * `patience` seconds, the next clearing is pulled forward to now.
 */
export function keepFair(stream: Stream, now: number): void {
  if (windowSeconds(stream, now) >= ROAD_ONE.clear.counts) stream.lastOpen = now;
  if (now - stream.lastOpen > dial(ROAD_ONE.clear.patience)) {
    stream.clearAt = Math.min(stream.clearAt, now);
  }
  if (now < stream.clearAt) return;

  // The window is measured at the junction, not at the entry gate, and those are
  // different places.
  //
  // Both rows hold until everything *already on the road* has finished crossing —
  // the whole road's worth, not each row's own, which is the subtle part. A row
  // that happens to be empty right now would otherwise reopen while the other one
  // is still going past, and the shared window — the only kind the player can use
  // — would be the overlap of the two rather than the length promised. Measured,
  // that turned a 4 second promise into 2.2 seconds of actual road.
  //
  // Then each row subtracts the time a fresh car spends driving down to the
  // junction, which it may spend inside the window.
  const window = between(span(ROAD_ONE.clear.seconds));
  let busy = 0;
  for (const row of stream.rows) busy = Math.max(busy, busySeconds(row));

  for (const row of stream.rows) {
    if (!row.flow) continue;
    startRun(row.flow);
    const hold = busy + window - travelSeconds(row);
    row.flow.openAt = Math.max(row.flow.openAt, now + Math.max(0, hold));
  }

  stream.clearAt = now + window + between(span(ROAD_ONE.clear.every));
  stream.lastOpen = now;
}

/**
 * Seconds until the junction is occupied, whichever row gets there first.
 *
 * This is the number the game is actually played in: how long the player has if
 * they open the light right now.
 */
export function windowSeconds(stream: Stream, now: number): number {
  let soonest = Infinity;
  for (const row of stream.rows) soonest = Math.min(soonest, clearSeconds(row, now));
  return soonest;
}

/** How many cars one row needs in its pool to run at its busiest. */
export function rowPool(length: number): number {
  const headway = span(ROAD_ONE.headway).min;
  const spacing = Math.max(1, ROAD_ONE.speed.min * headway);
  return Math.ceil(length / spacing) + 2;
}

/* ------------------------------------------------------------------ within -- */

/** Seconds until this row next has something in the junction. */
function clearSeconds(lane: Lane, now: number): number {
  const at = lane.crossS;
  if (at === null || !lane.flow) return Infinity;

  let soonest = Infinity;
  for (const car of lane.cars) {
    const nose = car.s + car.rig.length / 2;
    // Already through: it is behind the junction and on its way off the road.
    if (car.s - car.rig.length / 2 > at + HALF_JUNCTION) continue;
    // In it — including a wreck sitting in it, which blocks it until it poofs.
    if (nose > at - HALF_JUNCTION) return 0;
    soonest = Math.min(soonest, (at - HALF_JUNCTION - nose) / Math.max(car.v, 0.1));
  }

  // And whatever is about to be let on, assuming it arrives as fast as this road
  // allows: the promise has to hold for the worst case, not the average one.
  const waiting = Math.max(0, lane.flow.openAt - now) + travelSeconds(lane);
  return Math.min(soonest, waiting);
}

/**
 * Seconds until everything already on this row has finished crossing.
 *
 * `clearSeconds` asks when the junction goes *busy*; this asks when it comes
 * free, which is the other end of the same traffic and the one a hold needs.
 */
function busySeconds(lane: Lane): number {
  const at = lane.crossS;
  if (at === null) return 0;

  let last = 0;
  for (const car of lane.cars) {
    const back = car.s - car.rig.length / 2;
    if (back > at + HALF_JUNCTION) continue;
    last = Math.max(last, (at + HALF_JUNCTION - back) / Math.max(car.v, 0.1));
  }
  return last;
}

/** How long a car entering now would take to reach the junction, at its quickest. */
function travelSeconds(lane: Lane): number {
  const at = lane.crossS ?? lane.length;
  return Math.max(0, at - HALF_JUNCTION) / ROAD_ONE.speed.max;
}

/**
 * The speed a joining car takes.
 *
 * Free of the car in front, it is whatever the dice and the vehicle's own bulk
 * say. Behind one, it is clamped to whatever still leaves the gap open until the
 * leader is off the road: a car may close on the one ahead — that is the drama —
 * but it may never reach it.
 */
function cruise(lane: Lane, car: Car, tail: Car | null, gap: number): number {
  const { speed, lumber } = ROAD_ONE;
  let want = between(speed);

  // Bulk pulls towards the slow end, so the thing that lumbers looks like it.
  const heavy = clamp01((car.rig.length - NIMBLE) / (LUMBERING - NIMBLE));
  want -= (want - speed.min) * heavy * lumber;

  if (!tail || want <= tail.v) return want;

  // How long the leader is still in the way, and therefore how much faster than
  // it we can afford to be. The margin is what keeps the two from touching at
  // the exact moment the leader leaves.
  const leaves = (lane.length + tail.rig.length - tail.s) / Math.max(tail.v, 0.1);
  return Math.min(want, tail.v + (gap * CLOSING_MARGIN) / Math.max(leaves, 0.1));
}

/** Draws the next run's size and its internal spacing. */
function startRun(flow: Flow): void {
  flow.left = Math.max(1, Math.round(between(span(ROAD_ONE.run))));
  flow.headway = between(span(ROAD_ONE.headway));
}

/** The gap after a run: a tease, or one a single car can take. */
function gapSeconds(): number {
  const { tease, fair, fairChance } = ROAD_ONE.gap;
  return Math.random() < dial(fairChance) ? between(fair) : between(tease);
}

/* ------------------------------------------------------------- difficulty -- */

/** Where `ROAD_ONE.difficulty` sits between a pair's easy value and its hard one. */
function dial(pair: { easy: number; hard: number }): number {
  const at = clamp01(ROAD_ONE.difficulty);
  return pair.easy + (pair.hard - pair.easy) * at;
}

function span(pair: { easy: Range; hard: Range }): Range {
  const at = clamp01(ROAD_ONE.difficulty);
  return {
    min: pair.easy.min + (pair.hard.min - pair.easy.min) * at,
    max: pair.easy.max + (pair.hard.max - pair.easy.max) * at,
  };
}

/* ---------------------------------------------------------------- constants -- */

/**
 * Half the width of the junction along this road, which is what "in the way"
 * means: the other road's two rows plus the width of a car either side of them.
 */
const HALF_JUNCTION = TRAFFIC.laneOffset + 2.4;

/** Bumper room the entry demands before it will put a car down at all. */
const ENTRY_CLEARANCE = 1.2;

/**
 * How much of the closing speed that would *just* touch the leader a car is
 * allowed. Below one, so the arithmetic has somewhere to be wrong.
 */
const CLOSING_MARGIN = 0.8;

/** Car lengths, in metres, that count as small and as large. */
const NIMBLE = 4.4;
const LUMBERING = 7;
