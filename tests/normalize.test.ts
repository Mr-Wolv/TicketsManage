import { describe, expect, it } from 'vitest';

const NORM_A = 1.7589596259101096e-7;
const NORM_B = -1.135218793864604e-4;
const NORM_C = 0.01978683960927561;
const NORM_D = 0.04435873137530282;
const NORM_E = 14.338943427267312;

const normalizePoints = (value: number): number => {
  const y = NORM_A * Math.pow(value, 4) + NORM_B * Math.pow(value, 3) + NORM_C * Math.pow(value, 2) + NORM_D * value + NORM_E;
  return Math.ceil(y);
};

describe('normalization edge cases', () => {
  it('applies the agreed quartic formula with ceil', () => {
    // Formula: f(x) = 1.7589596259101096e-07*x^4 - 1.135218793864604e-04*x^3 + 0.01978683960927561*x^2 + 0.04435873137530282*x + 14.338943427267312
    expect(normalizePoints(0)).toBe(15);
    expect(normalizePoints(5)).toBe(16);
    expect(normalizePoints(5.1)).toBe(16);
  });

  it('preserves relative ordering for monotonic inputs', () => {
    const inputs = [1, 5, 10, 20, 50, 100];
    const normalized = inputs.map(normalizePoints);
    for (let i = 1; i < normalized.length; i++) {
      expect(normalized[i]!).toBeGreaterThanOrEqual(normalized[i - 1]!);
    }
  });
});
