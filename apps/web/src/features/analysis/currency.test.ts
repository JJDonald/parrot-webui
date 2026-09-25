import { describe, expect, it } from 'vitest';
import { formatCostUsd } from './currency';

describe('Parrot cost ticks in USD', () => {
  it('uses ten billion ticks per dollar and keeps small charges visible', () => {
    expect(formatCostUsd(10_000_000_000)).toBe('$1.00');
    expect(formatCostUsd(100_000_000)).toBe('$0.0100');
    expect(formatCostUsd(1)).toBe('$0.0000000001');
    expect(formatCostUsd(0)).toBe('$0.00');
    expect(formatCostUsd(null)).toBe('未提供');
  });
});
