import { describe, expect, it } from 'vitest';
import {
  CATEGORY_IDS,
  FALLBACK_DISPLAY_LABEL,
  TAXONOMY,
  TAXONOMY_BY_ID,
  isCategoryId,
  pointsFor,
} from '../server/classifier/taxonomy.js';
import type { CategoryId } from '../server/types.js';

const EXPECTED_POINTS: Record<CategoryId, number> = {
  REPORT: 3,
  GENERAL_ISSUE: 2,
  GENERAL_QUESTION: 2,
  NO_RESPONSE: 1,
  UNBANNED: 2,
  ANYDESK: 10,
  ANYDESK_BY: 5,
  ACCOUNT_RECOVERY: 2,
  TEXT_PROBLEM_SOLVED: 5,
  RECHARGE: 2,
};

describe('fixed taxonomy', () => {
  it('contains the ten fixed categories with unique ids and codes', () => {
    expect(TAXONOMY).toHaveLength(10);
    expect(new Set(CATEGORY_IDS).size).toBe(10);
    expect(new Set(TAXONOMY.map((category) => category.code)).size).toBe(10);
  });

  it('assigns the agreed point value to every category', () => {
    for (const [id, points] of Object.entries(EXPECTED_POINTS)) {
      expect(pointsFor(id as CategoryId), id).toBe(points);
    }
  });

  it('gives Recharge exactly 2 points', () => {
    expect(TAXONOMY_BY_ID.RECHARGE!.points).toBe(2);
    expect(pointsFor('RECHARGE')).toBe(2);
  });

  it('has a complete multilingual definition for every category', () => {
    for (const category of TAXONOMY) {
      expect(category.label.trim().length, category.id).toBeGreaterThan(0);
      expect(category.labelAr.trim().length, category.id).toBeGreaterThan(0);
      expect(category.description.trim().length, category.id).toBeGreaterThan(20);
      expect(category.examples.length, category.id).toBeGreaterThanOrEqual(3);
      expect(category.negativeExamples?.length ?? 0, category.id).toBeGreaterThanOrEqual(1);
    }
  });

  it('includes Arabic, Egyptian Arabic and Arabizi coverage for Recharge', () => {
    const examples = TAXONOMY_BY_ID.RECHARGE!.examples.join(' | ');
    expect(examples).toMatch(/شحن/);
    expect(examples.toLowerCase()).toMatch(/shahn|sha7n|sh7an/);
    expect(TAXONOMY_BY_ID.RECHARGE!.labelAr).toBe('شحن');
    expect(TAXONOMY_BY_ID.RECHARGE!.negativeExamples?.join(' ')).toMatch(/سأل|باسورد/);
  });

  it('validates category ids without accepting unknown values', () => {
    expect(isCategoryId('RECHARGE')).toBe(true);
    for (const category of TAXONOMY) expect(isCategoryId(category.id)).toBe(true);
    expect(isCategoryId('recharge')).toBe(false);
    expect(isCategoryId('REFUND')).toBe(false);
    expect(isCategoryId(null)).toBe(false);
  });

  it('separates the fallback display label from the scored category', () => {
    expect(FALLBACK_DISPLAY_LABEL).toBe('General problem (fallback)');
    expect(FALLBACK_DISPLAY_LABEL).not.toBe(TAXONOMY_BY_ID.GENERAL_ISSUE!.label);
  });
});

describe('fluid taxonomy', () => {
  it('returns overridden points when a db override exists', async () => {
    const { Db } = await import('../server/db.js');
    const { pointsFor, TAXONOMY_BY_ID } = await import('../server/classifier/taxonomy.js');
    const db = new Db(':memory:');
    db.open();
    try {
      const base = pointsFor('RECHARGE', db);
      expect(base).toBe(TAXONOMY_BY_ID.RECHARGE!.points);
      db.setCategoryPoints('RECHARGE', 99, 'test');
      expect(pointsFor('RECHARGE', db)).toBe(99);
    } finally {
      db.close();
    }
  });

  it('finds an approved reason by fuzzy match above threshold', async () => {
    const { Db } = await import('../server/db.js');
    const { findApprovedReason } = await import('../server/classifier/taxonomy.js');
    const db = new Db(':memory:');
    db.open();
    try {
      db.addApprovedReason({ text: 'Player was unbanned after review', categoryId: 'UNBANNED', sourceType: 'test' });
      const result = findApprovedReason(db, 'player was unbaned after review');
      expect(result).not.toBeNull();
      expect(result!.categoryId).toBe('UNBANNED');
    } finally {
      db.close();
    }
  });

  it('returns null when no approved reason matches above threshold', async () => {
    const { Db } = await import('../server/db.js');
    const { findApprovedReason } = await import('../server/classifier/taxonomy.js');
    const db = new Db(':memory:');
    db.open();
    try {
      db.addApprovedReason({ text: 'completely unrelated text here', categoryId: 'REPORT', sourceType: 'test' });
      const result = findApprovedReason(db, 'player needs recharge help');
      expect(result).toBeNull();
    } finally {
      db.close();
    }
  });

  it('creates approved reasons from a review correction', async () => {
    const { Db } = await import('../server/db.js');
    const { AssessmentService } = await import('../server/assessment-service.js');
    const db = new Db(':memory:');
    db.open();
    try {
      db.upsertTicket({
        ticketId: '1',
        openerUsername: 'u1',
        openerUserId: '1',
        openedAt: '2026-01-01T00:00:00Z',
        openedAtSource: null,
        claimedByName: null,
        claimedById: null,
        claimedState: 'unavailable',
        closedByName: 'staff',
        closedById: '1',
        closedState: 'present',
        closedAt: '2026-01-01T01:00:00Z',
        closedAtSource: null,
        closeReason: 'player recharge completed',
        closeReasonState: 'present',
        rating: null,
        ratingState: 'unavailable',
        ticketUrl: null,
        transcriptState: 'not_retrieved',
        labels: [],
        rawListRow: null,
        collectionStatus: 'collected',
        collectionError: null,
      });
      const service = new AssessmentService(db);
      await service.assessTicket('1');
      await service.correctAssessment({
        ticketId: '1',
        categoryIds: ['RECHARGE'],
        note: null,
        approveAlias: false,
      });
      const reasons = db.listApprovedReasons({ search: 'recharge' });
      expect(reasons.some((r) => r.categoryId === 'RECHARGE')).toBe(true);
    } finally {
      db.close();
    }
  });
});
