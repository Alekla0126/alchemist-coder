/**
 * Public API list prices in USD per million tokens (input, output).
 * Used only to *estimate* cost; subscription users are not billed per token.
 * Longest prefix wins, so dated model ids resolve to their family.
 */
const PRICES: ReadonlyArray<readonly [prefix: string, input: number, output: number]> = [
  ['claude-fable-5', 10, 50],
  ['claude-mythos-5', 10, 50],
  ['claude-opus-5', 5, 25],
  ['claude-opus-4-8', 5, 25],
  ['claude-opus-4-7', 5, 25],
  ['claude-opus-4-6', 5, 25],
  ['claude-opus-4-5', 5, 25],
  ['claude-opus-4-1', 15, 75],
  ['claude-opus-4', 15, 75],
  ['claude-sonnet-5', 2, 10],
  ['claude-sonnet-4', 3, 15],
  ['claude-3-7-sonnet', 3, 15],
  ['claude-haiku-4-5', 1, 5],
  ['claude-3-5-haiku', 0.8, 4],
  ['kimi-k3', 3, 15],
];

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export const emptyUsage = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });

export function priceFor(model: string | null | undefined): { input: number; output: number } | null {
  if (!model) return null;
  let best: (typeof PRICES)[number] | null = null;
  for (const entry of PRICES) {
    if (model.startsWith(entry[0]) && (!best || entry[0].length > best[0].length)) best = entry;
  }
  return best ? { input: best[1], output: best[2] } : null;
}

/** Cache reads bill at 0.1x input, 5-minute cache writes at 1.25x and 1-hour writes at 2x. */
export function estimateCost(model: string | null | undefined, u: TokenUsage): number | null {
  const p = priceFor(model);
  if (!p) return null;
  const inputSide = u.input + u.cacheRead * 0.1 + u.cacheWrite5m * 1.25 + u.cacheWrite1h * 2;
  return (inputSide * p.input + u.output * p.output) / 1_000_000;
}
