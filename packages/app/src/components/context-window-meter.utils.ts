export function formatContextPercentage(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(value / 100);
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${Math.round(value / 1_000_000)}m`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return Math.round(value).toString();
}

function isValidMaxTokens(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isValidUsedTokens(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

export function getUsagePercentage(maxTokens: number, usedTokens: number): number | null {
  if (!isValidMaxTokens(maxTokens) || !isValidUsedTokens(usedTokens)) {
    return null;
  }
  return (usedTokens / maxTokens) * 100;
}

/** A session cost ready to show; `estimated` when the provider reported none. */
export interface SessionCost {
  amount: string;
  estimated: boolean;
}

/** The provider's reported cost, or the daemon's estimate when the provider reports none. */
export function resolveSessionCost(
  totalCostUsd: number | null | undefined,
  estimatedCostUsd: number | null | undefined,
): SessionCost | null {
  if (typeof totalCostUsd === "number") {
    const amount = formatSessionCost(totalCostUsd);
    return amount ? { amount, estimated: false } : null;
  }
  if (typeof estimatedCostUsd === "number") {
    const amount = formatSessionCost(estimatedCostUsd);
    return amount ? { amount, estimated: true } : null;
  }
  return null;
}

export function formatSessionCost(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  if (value < 0.01) {
    return `$${value.toFixed(4)}`;
  }
  return `$${value.toFixed(2)}`;
}
