import type {
  CategoryAssessment,
  CategoryId,
  FieldState,
  ReasonState,
  StaffCreditResult,
} from './types.js';
import type { Db } from './db.js';
import { pointsFor } from './classifier/taxonomy.js';

export interface StaffIdentityInput {
  claimedState: FieldState;
  claimedById: string | null;
  claimedByName: string | null;
  closedState: FieldState;
  closedById: string | null;
  closedByName: string | null;
  reasonState: ReasonState;
}

/** Base points come only from distinct taxonomy categories. */
export function basePointsFor(categories: Array<Pick<CategoryAssessment, 'categoryId' | 'points'>>, db?: Db): number {
  const seen = new Set<CategoryId>();
  let total = 0;
  for (const category of categories) {
    if (seen.has(category.categoryId)) continue;
    seen.add(category.categoryId);
    // Always use the authoritative taxonomy value, never a model number.
    total += pointsFor(category.categoryId, db);
  }
  return total;
}

function normalizeName(name: string | null): string | null {
  if (!name) return null;
  const normalized = name.trim().toLowerCase().replace(/\s+/g, ' ');
  return normalized.length ? normalized : null;
}

function hasIdentity(id: string | null, name: string | null): boolean {
  return Boolean(id && id.trim()) || Boolean(name && name.trim());
}

function displayName(id: string | null, name: string | null): string | null {
  return name?.trim() || null;
}

/**
 * Staff-credit precedence:
 * A different confirmed claimant/closer -> neither gets points
 * B same confirmed claimant/closer -> full base to that person
 * C confirmed unclaimed + nonempty reason -> half base to closer
 * D confirmed unclaimed + empty reason -> zero
 * E incomplete/unreliable identity -> unresolved, never guessed
 */
export function applyStaffCredit(
  input: StaffIdentityInput,
  basePoints: number,
): StaffCreditResult {
  const claimantConfirmed =
    input.claimedState === 'present' && hasIdentity(input.claimedById, input.claimedByName);
  const closerConfirmed =
    input.closedState === 'present' && hasIdentity(input.closedById, input.closedByName);
  const unclaimed = input.claimedState === 'unclaimed';

  if (input.claimedState === 'unavailable') {
    return unresolved(
      'Rule E: the dashboard did not expose a readable claimant field. The award is unresolved rather than assumed unclaimed.',
    );
  }
  if (input.closedState === 'unavailable') {
    return unresolved(
      'Rule E: the dashboard did not expose a readable closing-staff field. The award is unresolved rather than guessed.',
    );
  }

  if (claimantConfirmed && closerConfirmed) {
    const sameById =
      input.claimedById &&
      input.closedById &&
      input.claimedById.trim().length > 0 &&
      input.closedById.trim().length > 0
        ? input.claimedById.trim() === input.closedById.trim()
        : null;
    const sameByName =
      normalizeName(input.claimedByName) && normalizeName(input.closedByName)
        ? normalizeName(input.claimedByName) === normalizeName(input.closedByName)
        : null;
    const same = sameById ?? sameByName;

    if (same === null) {
      return unresolved(
        'Rule E: claimant and closer are both present, but there is no stable shared identifier or comparable name to determine whether they are the same person.',
      );
    }
    if (!same) {
      return {
        rule: 'A',
        status: 'zero_different',
        awardedPoints: 0,
        staffId: null,
        staffName: null,
        explanation: `Rule A: the confirmed claimant (${displayName(input.claimedById, input.claimedByName) ?? input.claimedById ?? 'unknown'}) and closer (${displayName(input.closedById, input.closedByName) ?? input.closedById ?? 'unknown'}) are different staff members. Neither receives staff-credit points; the ${formatPoints(basePoints)}-point base score remains for audit.`,
      };
    }
    return {
      rule: 'B',
      status: basePoints > 0 ? 'awarded' : 'none',
      awardedPoints: basePoints,
      staffId: input.closedById ?? input.claimedById,
      staffName: displayName(input.closedById, input.closedByName) ?? displayName(input.claimedById, input.claimedByName),
      explanation:
        basePoints > 0
          ? `Rule B: the same confirmed staff member claimed and closed the ticket, so the full ${formatPoints(basePoints)}-point base score is awarded.`
          : 'Rule B: the same confirmed staff member claimed and closed the ticket, but this classification has no points, so no staff award is due.',
    };
  }

  if (unclaimed) {
    if (!closerConfirmed) {
      return unresolved(
        'Rule E: the ticket is confirmed unclaimed, but the closing staff member could not be identified. The base score is preserved and staff attribution remains unresolved.',
      );
    }
    if (input.reasonState === 'unavailable') {
      return unresolved(
        'Rule E: the ticket is confirmed unclaimed and the closer is known, but the closing reason could not be extracted, so the half-point rule cannot be applied reliably.',
      );
    }
    if (input.reasonState === 'empty') {
      return {
        rule: 'D',
        status: 'none',
        awardedPoints: 0,
        staffId: null,
        staffName: null,
        explanation: 'Rule D: the ticket is confirmed unclaimed and has no closing reason, so zero staff-credit points are awarded.',
      };
    }
    return {
      rule: 'C',
      status: basePoints > 0 ? 'awarded' : 'none',
      awardedPoints: basePoints / 2,
      staffId: input.closedById,
      staffName: displayName(input.closedById, input.closedByName),
      explanation:
        basePoints > 0
          ? `Rule C: the ticket is confirmed unclaimed and has a closing reason, so the identified closer receives half of the ${formatPoints(basePoints)}-point base score (${formatPoints(basePoints / 2)} points).`
          : 'Rule C: the ticket is confirmed unclaimed, but this classification has no points, so no staff award is due.',
    };
  }

  if (input.claimedState === 'present' && !claimantConfirmed) {
    return unresolved(
      'Rule E: a claimant field was present but did not contain a usable identity. Staff attribution is unresolved.',
    );
  }

  return unresolved(
    'Rule E: the claim state and identities could not be established reliably. No staff-credit award is guessed.',
  );
}

function unresolved(explanation: string): StaffCreditResult {
  return {
    rule: 'E',
    status: 'unresolved',
    awardedPoints: null,
    staffId: null,
    staffName: null,
    explanation,
  };
}

export function formatPoints(value: number | null): string {
  if (value === null || Number.isNaN(value)) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
