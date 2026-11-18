/** Seed used when TAU_TEST_SEED is unset. Every property run prints it on failure. */
export const DEFAULT_SEED = 20261117;

/** TAU_TEST_SEED replays a failing run. It must be an unsigned 32-bit integer. */
export function testSeed(): number {
  const raw = process.env.TAU_TEST_SEED;
  if (raw === undefined || raw === "") return DEFAULT_SEED;
  const seed = Number(raw);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new Error(`TAU_TEST_SEED must be an integer 0..4294967295: ${raw}`);
  return seed;
}

/** mulberry32: small, fast and identical on every runtime. */
export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Integer in [min, max], both inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error("pick from an empty list");
    return item;
  }
  /** A fresh shuffled copy. */
  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index--) {
      const other = this.int(0, index);
      const item = copy[index];
      const swap = copy[other];
      if (item === undefined || swap === undefined) continue;
      copy[index] = swap;
      copy[other] = item;
    }
    return copy;
  }
  /** Some of `items`, order kept. */
  subset<T>(items: readonly T[], probability = 0.5): T[] {
    return items.filter(() => this.bool(probability));
  }
  string(alphabet: readonly string[], minLength: number, maxLength: number) {
    let text = "";
    for (let length = this.int(minLength, maxLength); length > 0; length--)
      text += this.pick(alphabet);
    return text;
  }
}

/**
 * Runs `property` on `cases` generated inputs. Case i draws from its own
 * generator seeded from (seed, i), so one case replays without the others.
 * A failure names the seed and case index and how to rerun it.
 */
export async function forAll<T>(
  name: string,
  cases: number,
  generate: (rng: Rng, index: number) => T,
  property: (input: T, index: number) => void | Promise<void>,
): Promise<void> {
  const seed = testSeed();
  for (let index = 0; index < cases; index++) {
    const input = generate(new Rng(caseSeed(seed, index)), index);
    try {
      await property(input, index);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${name} failed at seed ${seed}, case ${index} (replay with TAU_TEST_SEED=${seed}).\n` +
          `input: ${describe(input)}\n${detail}`,
        { cause: error },
      );
    }
  }
}

function caseSeed(seed: number, index: number): number {
  return (
    (Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) +
      Math.imul(index, 0xc2b2ae35)) >>>
    0
  );
}

function describe(input: unknown): string {
  try {
    const text = JSON.stringify(input, (_key, value: unknown) =>
      value instanceof Uint8Array ? `<${value.length} bytes>` : value,
    );
    return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
  } catch {
    return String(input);
  }
}
