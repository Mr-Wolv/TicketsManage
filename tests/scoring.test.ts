import { describe, expect, it } from 'vitest';
import { applyStaffCredit, basePointsFor, type StaffIdentityInput } from '../server/scoring.js';
import type { CategoryAssessment } from '../server/types.js';

function input(overrides: Partial<StaffIdentityInput> = {}): StaffIdentityInput {
  return {
    claimedState: 'present',
    claimedById: 'staff-1',
    claimedByName: 'Alice',
    closedState: 'present',
    closedById: 'staff-1',
    closedByName: 'Alice',
    reasonState: 'present',
    ...overrides,
  };
}

function assessment(categoryId: CategoryAssessment['categoryId'], points: number): CategoryAssessment {
  return {
    categoryId,
    points,
    evidence: ['test'],
    method: 'exact',
    confidence: 0.95,
  };
}

describe('base points', () => {
  it('sums distinct categories using authoritative taxonomy values', () => {
    expect(
      basePointsFor([
        assessment('REPORT', 3),
        assessment('GENERAL_QUESTION', 2),
        assessment('NO_RESPONSE', 1),
      ]),
    ).toBe(6);
  });

  it('never awards the same category twice', () => {
    expect(basePointsFor([assessment('RECHARGE', 2), assessment('RECHARGE', 2)])).toBe(2);
  });

  it('ignores a points value supplied by a model and uses the taxonomy', () => {
    expect(basePointsFor([assessment('RECHARGE', 99)])).toBe(2);
    expect(basePointsFor([assessment('ANYDESK', 1)])).toBe(10);
  });

  it('returns zero for no categories', () => {
    expect(basePointsFor([])).toBe(0);
  });
});

describe('staff-credit precedence', () => {
  it('Rule A: a different confirmed claimant and closer gives zero to both', () => {
    const result = applyStaffCredit(
      input({ claimedById: 'staff-1', claimedByName: 'Alice', closedById: 'staff-2', closedByName: 'Bob' }),
      5,
    );
    expect(result.rule).toBe('A');
    expect(result.status).toBe('zero_different');
    expect(result.awardedPoints).toBe(0);
    expect(result.staffId).toBeNull();
    expect(result.staffName).toBeNull();
  });

  it('Rule A compares stable ids before names', () => {
    const result = applyStaffCredit(
      input({ claimedById: 'staff-1', claimedByName: 'Alice', closedById: 'staff-2', closedByName: 'Alice' }),
      3,
    );
    expect(result.rule).toBe('A');
    expect(result.awardedPoints).toBe(0);
  });

  it('Rule B: the same confirmed staff member receives the full base', () => {
    const result = applyStaffCredit(input(), 5);
    expect(result.rule).toBe('B');
    expect(result.status).toBe('awarded');
    expect(result.awardedPoints).toBe(5);
    expect(result.staffId).toBe('staff-1');
    expect(result.staffName).toBe('Alice');
  });

  it('matches the same person by normalised name when ids are absent', () => {
    const result = applyStaffCredit(
      input({
        claimedById: null,
        closedById: null,
        claimedByName: '  Alice  ',
        closedByName: 'alice',
      }),
      2,
    );
    expect(result.rule).toBe('B');
    expect(result.awardedPoints).toBe(2);
  });

  it('Rule C: confirmed unclaimed with a reason gives half the base to the closer', () => {
    const result = applyStaffCredit(
      input({ claimedState: 'unclaimed', claimedById: null, claimedByName: null }),
      5,
    );
    expect(result.rule).toBe('C');
    expect(result.awardedPoints).toBe(2.5);
    expect(result.staffName).toBe('Alice');
  });

  it('Rule C keeps half-points for odd bases', () => {
    const result = applyStaffCredit(
      input({ claimedState: 'unclaimed', claimedById: null, claimedByName: null }),
      3,
    );
    expect(result.rule).toBe('C');
    expect(result.awardedPoints).toBe(1.5);
  });

  it('Rule D: confirmed unclaimed with an empty reason gives zero', () => {
    const result = applyStaffCredit(
      input({
        claimedState: 'unclaimed',
        claimedById: null,
        claimedByName: null,
        reasonState: 'empty',
      }),
      3,
    );
    expect(result.rule).toBe('D');
    expect(result.awardedPoints).toBe(0);
    expect(result.status).toBe('none');
  });

  it('Rule E: an unavailable claimant is unresolved, never assumed unclaimed', () => {
    const result = applyStaffCredit(
      input({ claimedState: 'unavailable', claimedById: null, claimedByName: null }),
      5,
    );
    expect(result.rule).toBe('E');
    expect(result.status).toBe('unresolved');
    expect(result.awardedPoints).toBeNull();
  });

  it('Rule E: an unavailable closer is unresolved', () => {
    const result = applyStaffCredit(
      input({ closedState: 'unavailable', closedById: null, closedByName: null }),
      5,
    );
    expect(result.rule).toBe('E');
    expect(result.awardedPoints).toBeNull();
  });

  it('Rule E: unclaimed with an unavailable closing reason is unresolved', () => {
    const result = applyStaffCredit(
      input({
        claimedState: 'unclaimed',
        claimedById: null,
        claimedByName: null,
        reasonState: 'unavailable',
      }),
      2,
    );
    expect(result.rule).toBe('E');
    expect(result.awardedPoints).toBeNull();
  });

  it('never invents points when no category was found', () => {
    const result = applyStaffCredit(input(), 0);
    expect(result.awardedPoints).toBe(0);
    expect(result.status).toBe('none');
  });
});
