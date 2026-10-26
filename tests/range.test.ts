import { describe, expect, it } from 'vitest';
import { validateRange, validateDateRange } from '../server/collection-service.js';

describe('ticket range validation', () => {
  it('accepts an inclusive single-ticket range', () => {
    const result = validateRange('100', '100');
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.startId).toBe('100');
    expect(result.endId).toBe('100');
    expect(result.large).toBe(false);
  });

  it('counts an inclusive range and estimates requests', () => {
    const result = validateRange('100', '150');
    expect(result.ok).toBe(true);
    expect(result.count).toBe(51);
    expect(result.estimatedRequests).toBe(102);
  });

  it('trims surrounding whitespace', () => {
    const result = validateRange(' 42 ', '42 ');
    expect(result.ok).toBe(true);
    expect(result.startId).toBe('42');
  });

  it('keeps very large ids as strings without losing precision', () => {
    const result = validateRange('9007199254740993', '9007199254740994');
    expect(result.ok).toBe(true);
    expect(result.startId).toBe('9007199254740993');
    expect(result.count).toBe(2);
  });

  it('rejects non-numeric, negative, decimal and empty ids', () => {
    for (const bad of ['', 'abc', '-1', '1.5', '12a', '  ']) {
      expect(validateRange(bad, '10').ok, bad).toBe(false);
      expect(validateRange('1', bad).ok, bad).toBe(false);
    }
  });

  it('rejects leading zeros as ambiguous', () => {
    expect(validateRange('007', '10').ok).toBe(false);
    expect(validateRange('1', '010').ok).toBe(false);
    expect(validateRange('0', '10').ok).toBe(true);
  });

  it('rejects a reversed range', () => {
    const result = validateRange('200', '100');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/less than or equal/i);
  });

  it('requires confirmation for large ranges', () => {
    const result = validateRange('1', '500');
    expect(result.ok).toBe(true);
    expect(result.large).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.warnings?.join(' ')).toMatch(/inclusive range contains 500/i);
  });

  it('refuses an absurdly large range', () => {
    const result = validateRange('1', '99999999');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/split it into smaller runs/i);
  });
});

describe('date range validation', () => {
  it('accepts a closed-at Africa/Cairo range', () => {
    const result = validateDateRange('17/10/26', '23/10/26', 'Africa/Cairo', 'closed');
    expect(result.ok).toBe(true);
    expect(result.dateFromDisplay).toBe('17/10/26');
    expect(result.dateToDisplay).toBe('23/10/26');
    expect(result.dateTimezone).toBe('Africa/Cairo');
    expect(result.dateBasis).toBe('closed');
    expect(result.dateTo).toBe('2026-10-23T21:00:00.000Z');
  });

  it('rejects DD/MM/YYYY format', () => {
    expect(validateDateRange('17/10/2026', '23/10/2026', 'UTC', 'closed').ok).toBe(false);
  });

  it('rejects reversed dates', () => {
    expect(validateDateRange('24/10/26', '23/10/26', 'UTC', 'closed').ok).toBe(false);
  });

  it('rejects invalid separators', () => {
    expect(validateDateRange('17-10-26', '23-10-26', 'UTC', 'closed').ok).toBe(false);
  });

  it('defaults timezone and basis', () => {
    const result = validateDateRange('01/01/27', '02/01/27', '', '');
    expect(result.ok).toBe(true);
    expect(result.dateTimezone).toBe('Africa/Cairo');
    expect(result.dateBasis).toBe('closed');
  });
});
