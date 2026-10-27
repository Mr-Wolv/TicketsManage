import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Db } from '../server/db.js';
import { buildStaffReport } from '../server/reports.js';
import type { TicketMetadata } from '../server/types.js';

let directory: string;
let db: Db;

function ticket(overrides: Partial<TicketMetadata> = {}): TicketMetadata {
  return {
    ticketId: '8001',
    openerUsername: 'player#1',
    openerUserId: 'user-1',
    openedAt: '2026-10-17T10:00:00.000Z',
    openedAtSource: 'dashboard',
    claimedByName: 'SamePerson',
    claimedById: '1',
    claimedState: 'present',
    closedByName: 'SamePerson',
    closedById: '1',
    closedState: 'present',
    closedAt: null,
    closedAtSource: null,
    closeReason: 'problem solved',
    closeReasonState: 'present',
    rating: null,
    ratingState: 'unavailable',
    ticketUrl: null,
    transcriptState: 'available',
    labels: [],
    rawListRow: null,
    ...overrides,
  };
}

function openDb(): Db {
  const instance = new Db(path.join(directory, 'test.db'));
  instance.open();
  return instance;
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ticketsmanage-test-'));
  db = openDb();
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('Staff totals computation', () => {
  it('computes staff points from stored assessments', () => {
    db.upsertTicket({ ...ticket({ ticketId: '8001' }), collectionStatus: 'collected', collectionError: null });
    db.saveAssessment({
      ticketId: '8001',
      originalReason: 'problem solved',
      categories: [
        { categoryId: 'TEXT_PROBLEM_SOLVED', points: 5, evidence: [], method: 'exact', confidence: 1 },
      ],
      basePoints: 5,
      fallback: false,
      method: 'exact',
      confidence: 1,
      explanation: '',
      alternatives: [],
      reviewReasons: [],
      unresolvedPortion: null,
      creditRule: 'B',
      creditStatus: 'awarded',
      creditStaffId: '1',
      creditStaffName: 'SamePerson',
      awardedPoints: 5,
      creditExplanation: 'same claim and close',
      model: null,
      taxonomyVersion: '1.1.0',
      classifierVersion: '2.1.0',
      humanCorrected: false,
      assessedAt: '2026-10-17T10:05:00.000Z',
    });
    const report = buildStaffReport(db, { idStart: '8001', idEnd: '8001' });
    expect(report.totals?.awardedPoints ?? 0).toBe(5);
    expect(report.rows ?? []).toHaveLength(1);
    expect((report.rows ?? [])[0]?.staffName).toBe('SamePerson');
    expect((report.rows ?? [])[0]?.awardedPoints).toBe(5);
  });
});
