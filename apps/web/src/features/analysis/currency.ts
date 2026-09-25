/** Parrot src/model_pricing.py: one USD is 10,000,000,000 cost ticks. */
export const TICKS_PER_USD = 10_000_000_000;

export function formatCostUsd(ticks: number | null | undefined): string {
  if (typeof ticks !== 'number' || !Number.isFinite(ticks)) return '未提供';
  const dollars = ticks / TICKS_PER_USD;
  if (dollars === 0) return '$0.00';
  // Keep small, nonzero charges visible without rounding them to zero.
  const digits = Math.abs(dollars) < 0.00000001 ? 10 : Math.abs(dollars) < 0.01 ? 8 : Math.abs(dollars) < 1 ? 4 : 2;
  return `$${dollars.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
