/**
 * The handful of shapes that turn up all over the scene.
 *
 * Everything else is declared next to the code that owns it. These are here
 * because several unrelated modules speak them to each other, and three copies
 * of `{ min: number; max: number }` is three chances to mean slightly different
 * things by it.
 */

/**
 * An inclusive range, as written throughout `config.ts`.
 *
 * Read one with `between` for a random value or `mid` for its centre — see
 * `core/maths.ts`.
 */
export type Range = { min: number; max: number };

/** Anything holding on to GPU or browser resources until it is told to let go. */
export type Disposable = { dispose: () => void };
