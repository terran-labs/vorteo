/**
 * Session cost estimates for providers that report token counts but no cost, priced at the
 * provider's published API list rates. Subscription sessions are not billed per token, so the
 * estimate is what the same tokens would cost through the API.
 */

/** US dollars per million tokens. */
interface ModelPrice {
  input: number;
  cachedInput: number;
  output: number;
}

/**
 * Standard short-context list prices from https://developers.openai.com/api/docs/pricing,
 * checked 2026-11-02. Cache writes are not priced because Codex does not report them, and
 * requests above 272K input tokens, which OpenAI bills at higher long-context rates, are
 * priced at these rates too, so long sessions are underestimated.
 */
const MODEL_PRICES: Record<string, ModelPrice> = {
  "gpt-6-astra": { input: 10, cachedInput: 1, output: 50 },
  "gpt-6.1-sol": { input: 2, cachedInput: 0.1, output: 10 },
};

export interface SessionTokenTotals {
  /** All input tokens, including the cached ones. */
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** The estimated cost of a session's tokens, or undefined for a model without a known price. */
export function estimateSessionCostUsd(
  model: string | null | undefined,
  totals: SessionTokenTotals,
): number | undefined {
  const price = model ? MODEL_PRICES[model] : undefined;
  if (!price) return undefined;
  const cached = Math.min(totals.cachedInputTokens, totals.inputTokens);
  const uncached = totals.inputTokens - cached;
  return (
    (uncached * price.input + cached * price.cachedInput + totals.outputTokens * price.output) /
    1_000_000
  );
}
