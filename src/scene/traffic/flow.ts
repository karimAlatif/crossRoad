import { CRASH, ROAD_ONE, TRAFFIC } from "../config";
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
 * **The two rows are strangers — mostly.** They used to break together, which
 * meant the road was either full or empty: a metronome, and the moment you learn
 * its beat there is no game left. Each row now runs its own rhythm, so what the
 * player has to judge is the *overlap* of two unrelated streams.
 *
 * But two truly unrelated streams almost never leave a gap in the same place —
 * measured, about once every two and a half minutes — so on their own they
 * leave nothing to cross *between*, and the game collapses into waiting for the
 * road to clear. So when a row leaves a fair gap, there is a chance the other
 * row leaves one at the same moment: the gap *lines up* across the road, the
 * way traffic does downstream of a light. That is the crossing this game is
 * built around — a one-car opening between cars, there for a moment, that has
 * to be spotted and taken — and how often it happens is the main difficulty
 * dial.
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
 * **And the road keeps a promise.** If the dice go badly and the junction
 * stays shut longer than `patience`, both rows stand aside and an opening is
 * made — at least `clear.counts` long whatever else is configured, because a
 * promise that delivers half a second is not one. It can also happen on a
 * random interval (`clear.every`), which is the generous, flush-the-queue
 * version; turn that down and the only openings left are the ones between cars.
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
  /**
   * A fair gap this row has just started leaving, in seconds, until the road has
   * had a chance to line the other row up with it. Zero otherwise.
   */
  offer: number;
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
  const flow: Flow = { left: 0, headway: 0, openAt: 0, offer: 0 };
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

  // A car on this road holds the speed it enters at for the whole road — there
  // is no braking and no speeding up — so it must never be let on at a crawl.
  // One that did would sit in the entry for the rest of the session and, sitting
  // there, stop anything else getting on: a whole lane frozen behind one car.
  // Measured, before this check: a car entered at 0.14 m/s and stayed for nine
  // and a half minutes. If the only safe speed is a crawl, wait a moment instead.
  const speed = cruise(lane, car, s);
  if (speed < pace().min * SLOWEST_ENTRY) return null;

  flow.left--;
  if (flow.left > 0) {
    flow.openAt = now + flow.headway;
  } else {
    // The run is over: leave a gap, and if it is a fair one, offer it to the
    // road so the other row can line up with it.
    const { tease, fair, fairChance } = ROAD_ONE.gap;
    const real = Math.random() < dial(fairChance);
    const seconds = between(real ? fair : tease);
    flow.openAt = now + seconds;
    flow.offer = real ? seconds : 0;
    startRun(flow);
  }
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
  // A fair gap on one row is only an opening if the other row agrees. Sometimes
  // it does: the whole road lines up behind it, for exactly that gap's length.
  for (const row of stream.rows) {
    const flow = row.flow;
    if (!flow || flow.offer <= 0) continue;
    const seconds = flow.offer;
    flow.offer = 0;
    if (Math.random() < dial(ROAD_ONE.gap.pairChance)) standAside(stream, now, seconds);
  }

  if (windowSeconds(stream, now) >= ROAD_ONE.clear.counts) stream.lastOpen = now;
  const starved = now - stream.lastOpen > dial(ROAD_ONE.clear.patience);
  if (!starved && now < stream.clearAt) return;

  // The promise has to deliver an opening worth the name, whatever `seconds`
  // says. A clearing configured down to a fraction of a second is a fine way to
  // say "no generous clearings", but the promise uses the same machinery, and a
  // promise that opens the road for 0.1 seconds keeps nobody's word — measured,
  // it left a careful player waiting nearly two minutes.
  let window = between(span(ROAD_ONE.clear.seconds));
  if (starved) window = Math.max(window, ROAD_ONE.clear.counts + PROMISE_MARGIN);

  standAside(stream, now, window);
  stream.clearAt = now + window + between(span(ROAD_ONE.clear.every));
}

/**
 * Both rows hold so that the junction is clear for `window` seconds, starting
 * the moment the traffic already on the road has gone through.
 *
 * The window is measured at the junction, not at the entry gate, and those are
 * different places. Both rows hold until everything *already on the road* has
 * finished crossing — the whole road's worth, not each row's own, which is the
 * subtle part. A row that happens to be empty right now would otherwise reopen
 * while the other one is still going past, and the shared window — the only
 * kind the player can use — would be the overlap of the two rather than the
 * length promised. Measured, that turned a 4 second promise into 2.2 seconds of
 * actual road.
 *
 * Then each row subtracts the time a fresh car spends driving down to the
 * junction, which it may spend inside the window.
 */
function standAside(stream: Stream, now: number, window: number): void {
  let busy = 0;
  for (const row of stream.rows) busy = Math.max(busy, busySeconds(row));

  for (const row of stream.rows) {
    if (!row.flow) continue;
    startRun(row.flow);
    row.flow.offer = 0;
    const hold = busy + window - travelSeconds(row);
    row.flow.openAt = Math.max(row.flow.openAt, now + Math.max(0, hold));
  }
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
  const spacing = Math.max(1, pace().min * headway);
  return Math.ceil(length / spacing) + 2;
}

/** The cruise speeds the cross traffic draws from, at the current difficulty. */
export function pace(): Range {
  return span(ROAD_ONE.speed);
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
    // A wreck does not drive clear — it is standing still, so distance over speed
    // says "never", and the road used to hold a lane shut for twelve minutes
    // waiting for it. It is gone when it has finished poofing.
    const clears = car.crash
      ? CRASH.holdSeconds + CRASH.poofSeconds - car.crash.t
      : (at + HALF_JUNCTION - back) / Math.max(car.v, 0.1);
    last = Math.max(last, clears);
  }
  return last;
}

/** How long a car entering now would take to reach the junction, at its quickest. */
function travelSeconds(lane: Lane): number {
  const at = lane.crossS ?? lane.length;
  return Math.max(0, at - HALF_JUNCTION) / pace().max;
}

/**
 * The speed a joining car takes.
 *
 * Free of the car in front, it is whatever the dice and the vehicle's own bulk
 * say. Behind one, it is clamped to whatever still leaves the gap open until the
 * leader is off the road: a car may close on the one ahead — that is the drama —
 * but it may never reach it.
 *
 * "The car in front" means the nearest one that is still *driving*. A wreck is
 * standing still and will be gone within a second; clamping to its speed of zero
 * is what used to let cars onto the road at a crawl. And a wreck is never close
 * enough to the entry to matter: it happens at the junction, a couple of seconds
 * away even for the slowest car, and it has poofed long before anything arrives.
 */
function cruise(lane: Lane, car: Car, entry: number): number {
  const speed = pace();
  let want = between(speed);

  // Bulk pulls towards the slow end, so the thing that lumbers looks like it.
  const heavy = clamp01((car.rig.length - NIMBLE) / (LUMBERING - NIMBLE));
  want -= (want - speed.min) * heavy * ROAD_ONE.lumber;

  const leader = nearestDriving(lane);
  if (!leader || want <= leader.v) return want;

  // How long the leader is still in the way, and therefore how much faster than
  // it we can afford to be. The margin is what keeps the two from touching at
  // the exact moment the leader leaves.
  const gap = leader.s - leader.rig.length / 2 - (entry + car.rig.length / 2);
  const leaves = (lane.length + leader.rig.length - leader.s) / Math.max(leader.v, 0.1);
  return Math.min(want, leader.v + (Math.max(0, gap) * CLOSING_MARGIN) / Math.max(leaves, 0.1));
}

/** The rearmost car on the lane that is still under way, if there is one. */
function nearestDriving(lane: Lane): Car | null {
  for (let i = lane.cars.length - 1; i >= 0; i--) {
    if (!lane.cars[i].crash) return lane.cars[i];
  }
  return null;
}

/** Draws the next run's size and its internal spacing. */
function startRun(flow: Flow): void {
  flow.left = Math.max(1, Math.round(between(span(ROAD_ONE.run))));
  flow.headway = between(span(ROAD_ONE.headway));
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

/** How much longer than `clear.counts` a promised opening is, at the least. */
const PROMISE_MARGIN = 0.4;

/** Bumper room the entry demands before it will put a car down at all. */
const ENTRY_CLEARANCE = 1.2;

/**
 * How much of the closing speed that would *just* touch the leader a car is
 * allowed. Below one, so the arithmetic has somewhere to be wrong.
 */
const CLOSING_MARGIN = 0.8;

/**
 * The slowest a car may join the road at, as a share of the slowest speed this
 * difficulty allows. Anything slower waits at the entry until it can go properly.
 */
const SLOWEST_ENTRY = 0.7;

/** Car lengths, in metres, that count as small and as large. */
const NIMBLE = 4.4;
const LUMBERING = 7;
