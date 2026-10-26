import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Db } from '../server/db.js';
import { AssessmentService } from '../server/assessment-service.js';
import { normalizeReason } from '../server/classifier/normalize.js';
import type { TicketMetadata } from '../server/types.js';

let directory: string;
let db: Db;

function ticket(overrides: Partial<TicketMetadata> = {}): TicketMetadata {
  return {
    ticketId: '5001',
    openerUsername: 'player#1',
    openerUserId: 'user-1',
    openedAt: '2026-10-01T10:00:00.000Z',
    openedAtSource: 'dashboard',
    claimedByName: 'Amina',
    claimedById: 'staff-1',
    claimedState: 'present',
    closedByName: 'Amina',
    closedById: 'staff-1',
    closedState: 'present',
    closedAt: '2026-10-01T10:30:00.000Z',
    closedAtSource: 'dashboard',
    closeReason: 'تم شحن الحساب للاعب',
    closeReasonState: 'present',
    rating: null,
    ratingState: 'unavailable',
    ticketUrl: 'https://dashboard.tickets.bot/ticket/5001',
    transcriptState: 'available',
    labels: [],
    rawListRow: null,
    ...overrides,
  };
}

function openDb(): Db {
  const instance = new Db(path.join(directory, 'test.db'));
  instance.open();
  instance.saveSettings({ semanticEnabled: false, classificationEnabled: true });
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

describe('SQLite persistence', () => {
  it('upserts a ticket idempotently and preserves one row per ticket', () => {
    db.upsertTicket({ ...ticket(), collectionStatus: 'collected', collectionError: null });
    db.upsertTicket({ ...ticket(), collectionStatus: 'collected', collectionError: null });
    expect(db.getTicket('5001')?.closeReason).toBe('تم شحن الحساب للاعب');
    const listed = db.listTickets({});
    expect(listed.total).toBe(1);
  });

  it('updates a changed record instead of duplicating it', () => {
    db.upsertTicket({ ...ticket(), collectionStatus: 'collected', collectionError: null });
    db.upsertTicket({
      ...ticket({ closeReason: 'Recharge completed for the player' }),
      collectionStatus: 'collected',
      collectionError: null,
    });
    expect(db.listTickets({}).total).toBe(1);
    expect(db.getTicket('5001')?.closeReason).toBe('Recharge completed for the player');
  });

  it('stores an ordered transcript and replaces it without duplicates', () => {
    db.upsertTicket({ ...ticket(), collectionStatus: 'collected', collectionError: null });
    db.replaceMessages('5001', [
      {
        seq: 1,
        messageId: 'm1',
        authorName: 'player#1',
        authorId: 'user-1',
        timestamp: '2026-10-01T10:01:00.000Z',
        content: 'أنا عايز أشحن',
        embeds: [],
        attachments: [],
        components: [],
      },
      {
        seq: 2,
        messageId: 'm2',
        authorName: 'Amina',
        authorId: 'staff-1',
        timestamp: '2026-10-01T10:02:00.000Z',
        content: 'تم الشحن',
        embeds: [],
        attachments: [],
        components: [],
      },
    ]);
    db.replaceMessages('5001', [
      {
        seq: 1,
        messageId: 'm1',
        authorName: 'player#1',
        authorId: 'user-1',
        timestamp: '2026-10-01T10:01:00.000Z',
        content: 'أنا عايز أشحن',
        embeds: [],
        attachments: [],
        components: [],
      },
    ]);
    const messages = db.getMessages('5001');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('أنا عايز أشحن');
  });

  it('supports the nested transaction used when saving a ticket and its transcript', () => {
    expect(() => {
      db.transaction(() => {
        db.upsertTicket({ ...ticket(), collectionStatus: 'collected', collectionError: null });
        db.replaceMessages('5001', [
          {
            seq: 1,
            messageId: 'm1',
            authorName: 'player#1',
            authorId: 'user-1',
            timestamp: '2026-10-01T10:01:00.000Z',
            content: 'I need a recharge',
            embeds: [],
            attachments: [],
            components: [],
          },
        ]);
      });
    }).not.toThrow();
    expect(db.getMessages('5001')).toHaveLength(1);
    expect(db.getTicket('5001')?.collectionStatus).toBe('collected');
  });

  it('rolls back both nested and outer writes when a transaction fails', () => {
    expect(() =>
      db.transaction(() => {
        db.upsertTicket({ ...ticket(), collectionStatus: 'collected', collectionError: null });
        db.transaction(() => {
          db.replaceMessages('5001', [
            {
              seq: 1,
              messageId: 'm1',
              authorName: 'player#1',
              authorId: 'user-1',
              timestamp: '2026-10-01T10:01:00.000Z',
              content: 'I need a recharge',
              embeds: [],
              attachments: [],
              components: [],
            },
          ]);
          throw new Error('simulated nested failure');
        });
      }),
    ).toThrow('simulated nested failure');

    expect(db.getTicket('5001')).toBeNull();
    expect(db.getMessages('5001')).toHaveLength(0);

    // The transaction depth must be reset so later writes still work.
    expect(() =>
      db.transaction(() => {
        db.upsertTicket({ ...ticket(), collectionStatus: 'collected', collectionError: null });
      }),
    ).not.toThrow();
    expect(db.getTicket('5001')?.collectionStatus).toBe('collected');
  });

  it('persists settings across a close and reopen', () => {
    db.saveSettings({ model: 'qwen2.5:3b', fuzzyThreshold: 0.8, modelTimeoutMs: 12000 });
    db.close();
    db = openDb();
    const settings = db.getSettings();
    expect(settings.model).toBe('qwen2.5:3b');
    expect(settings.fuzzyThreshold).toBe(0.8);
    expect(settings.modelTimeoutMs).toBe(12000);
    expect(settings.semanticEnabled).toBe(false);
  });

  it('stores an approved correction and reuses it for the same wording', () => {
    const reason = 'حول اللاعب مبلغ للشحن';
    db.addApprovedAlias({
      normalizedText: normalizeReason(reason),
      originalText: reason,
      categoryIds: ['RECHARGE'],
      sourceTicket: '5001',
    });
    const alias = db.findApprovedAlias(normalizeReason(reason));
    expect(alias?.categories.map((category) => category.categoryId)).toEqual(['RECHARGE']);
    expect(db.findApprovedAlias(normalizeReason('كلام مختلف'))).toBeNull();
  });

  it('creates, resolves and histories a review without duplicating it', () => {
    db.upsertTicket({ ...ticket(), collectionStatus: 'collected', collectionError: null });
    const first = db.ensureReview('5001', ['Needs review']);
    const second = db.ensureReview('5001', ['Needs review', 'Second reason']);
    expect(second.ticketId).toBe(first.ticketId);
    expect(second.reasons).toHaveLength(2);
    db.addReviewHistory('5001', 'corrected', ['GENERAL_ISSUE'], ['RECHARGE'], 'Fixed by manager');
    db.resolveReview('5001', 'corrected', 'Fixed by manager');
    const review = db.getReview('5001');
    expect(review?.status).toBe('corrected');
    expect(review?.resolvedBy).toBe('local manager');
    expect(db.listReviews('corrected').map((item) => item.ticketId)).toContain('5001');
    expect(db.listReviewHistory('5001').length).toBeGreaterThanOrEqual(2);
  });

  it('backs up, validates and restores the database', () => {
    db.upsertTicket({ ...ticket(), collectionStatus: 'collected', collectionError: null });
    const backup = path.join(directory, 'backups', 'snapshot.db');
    db.backupTo(backup);
    expect(fs.existsSync(backup)).toBe(true);
    Db.validateBackup(backup);

    db.upsertTicket({
      ...ticket({ ticketId: '5002', closeReason: 'Recharge completed' }),
      collectionStatus: 'collected',
      collectionError: null,
    });
    expect(db.listTickets({}).total).toBe(2);
    db.restoreFrom(backup);
    expect(db.listTickets({}).total).toBe(1);
  });
});

describe('assessment integration', () => {
  it('classifies a Recharge ticket end to end with 2 base and 2 awarded points', async () => {
    db.upsertTicket({ ...ticket(), collectionStatus: 'collected', collectionError: null });
    const service = new AssessmentService(db);
    const outcome = await service.assessTicket('5001');

    expect(outcome.assessment.basePoints).toBe(2);
    expect(outcome.assessment.categories.map((category) => category.categoryId)).toEqual(['RECHARGE']);
    expect(outcome.assessment.creditRule).toBe('B');
    expect(outcome.assessment.awardedPoints).toBe(2);
    expect(outcome.assessment.originalReason).toBe('تم شحن الحساب للاعب');

    const stored = db.getTicket('5001')?.assessment;
    expect(stored?.basePoints).toBe(2);
    expect(stored?.awardedPoints).toBe(2);
  });

  it('gives half points to the closer for an unclaimed Recharge ticket', async () => {
    db.upsertTicket({
      ...ticket({
        claimedState: 'unclaimed',
        claimedById: null,
        claimedByName: null,
        closedById: 'staff-2',
        closedByName: 'Omar',
      }),
      collectionStatus: 'collected',
      collectionError: null,
    });
    const outcome = await new AssessmentService(db).assessTicket('5001');
    expect(outcome.assessment.basePoints).toBe(2);
    expect(outcome.assessment.creditRule).toBe('C');
    expect(outcome.assessment.awardedPoints).toBe(1);
    expect(outcome.assessment.creditStaffName).toBe('Omar');
  });

  it('creates a persistent review for a fallback and keeps it after reopen', async () => {
    db.upsertTicket({
      ...ticket({ closeReason: 'zxqv blorp wobble', closeReasonState: 'present' }),
      collectionStatus: 'collected',
      collectionError: null,
    });
    const outcome = await new AssessmentService(db).assessTicket('5001');
    expect(outcome.assessment.fallback).toBe(true);
    expect(outcome.review?.status).toBe('pending');

    db.close();
    db = openDb();
    const reopened = db.getTicket('5001');
    expect(reopened?.assessment?.fallback).toBe(true);
    expect(reopened?.review?.status).toBe('pending');
  });

  it('auto-resolves a pending review when reassessment leaves no actionable reason', async () => {
    db.upsertTicket({
      ...ticket({
        claimedState: 'unavailable',
        claimedById: null,
        claimedByName: null,
      }),
      collectionStatus: 'collected',
      collectionError: null,
    });
    const service = new AssessmentService(db);
    const first = await service.assessTicket('5001');
    expect(first.review?.status).toBe('pending');

    db.upsertTicket({
      ...ticket({ claimedState: 'present', claimedById: 'staff-1', claimedByName: 'Amina' }),
      collectionStatus: 'collected',
      collectionError: null,
    });
    const second = await service.assessTicket('5001');
    expect(second.assessment.reviewReasons).toEqual([]);
    expect(second.review?.status).toBe('accepted');
    expect(second.review?.reasons).toEqual([]);
    expect(db.getReview('5001')?.status).toBe('accepted');
  });

  it('does not reassess a human-corrected ticket unless forced', async () => {
    db.upsertTicket({ ...ticket(), collectionStatus: 'collected', collectionError: null });
    const service = new AssessmentService(db);
    await service.assessTicket('5001');
    const current = db.getTicket('5001')!;
    db.saveAssessment({
      ...current.assessment!,
      categories: [
        {
          categoryId: 'GENERAL_QUESTION',
          points: 2,
          evidence: ['Manager correction'],
          method: 'human',
          confidence: 1,
        },
      ],
      basePoints: 2,
      humanCorrected: true,
      method: 'human',
    });
    const outcome = await service.assessTicket('5001');
    expect(outcome.assessment.humanCorrected).toBe(true);
    expect(outcome.assessment.categories[0]?.categoryId).toBe('GENERAL_QUESTION');
  });
});

describe('date basis and local maintenance', () => {
  it('filters by last transcript activity when requested', () => {
    db.upsertTicket({
      ...ticket({
        openedAt: '2026-09-01T10:00:00.000Z',
        closedAt: null,
        closedAtSource: null,
      }),
      collectionStatus: 'collected',
      collectionError: null,
    });
    db.replaceMessages('5001', [
      {
        seq: 0,
        messageId: 'm1',
        authorName: 'player#1',
        authorId: 'user-1',
        timestamp: '2026-10-18T20:00:00.000Z',
        content: 'hello',
        embeds: [],
        attachments: [],
        components: [],
      },
    ]);
    const window = {
      from: '2026-10-17T00:00:00.000Z',
      to: '2026-10-23T23:59:59.999Z',
    };
    expect(db.listTickets({ ...window, dateBasis: 'opened' }).total).toBe(0);
    expect(db.listTickets({ ...window, dateBasis: 'activity' }).total).toBe(1);
    expect(db.getTicket('5001')?.lastActivityAt).toBe('2026-10-18T20:00:00.000Z');
  });

  it('rescoring stored categories never changes a valid same-person award', async () => {
    db.upsertTicket({ ...ticket(), collectionStatus: 'collected', collectionError: null });
    const service = new AssessmentService(db);
    const before = await service.assessTicket('5001');
    expect(before.assessment.awardedPoints).toBe(2);
    const result = service.rescoreAll();
    expect(result.rescored).toBe(1);
    expect(result.changed).toBe(0);
    expect(db.getTicket('5001')?.assessment?.awardedPoints).toBe(2);
  });

  it('preserves taxonomy tables across roster reset', async () => {
    db.upsertTicket({ ...ticket(), collectionStatus: 'collected', collectionError: null });
    const service = new AssessmentService(db);
    await service.assessTicket('5001');

    db.saveAssessment({
      ...db.getTicket('5001')!.assessment!,
      categories: [{ categoryId: 'REPORT', points: 77, evidence: ['override'], method: 'rules_only', confidence: 1 }],
      basePoints: 77,
      humanCorrected: false,
      method: 'rules_only',
    });

    db.setCategoryPoints('RECHARGE', 5);
    db.addCustomCategory({ id: 'CUSTOM_VIP_REFUND', code: 'VR', label: 'VIP Refund', labelAr: '', description: '', points: 3, examples: ['refund vip'] });
    db.addApprovedReason({ text: 'approve vip', categoryId: 'REPORT' });
    db.addApprovedReason({ text: 'custom refund', categoryId: 'REPORT' });

    const beforePreview = db.getResetPreview();
    expect(beforePreview.tickets).toBe(1);
    expect(beforePreview.assessments).toBe(1);
    expect(beforePreview.customCategories).toBe(1);
    expect(beforePreview.approvedReasons).toBe(2);
    expect(beforePreview.taxonomyAuditLog).toBeGreaterThanOrEqual(2);

    db.resetRoster();

    const afterPreview = db.getResetPreview();
    expect(afterPreview.tickets).toBe(0);
    expect(afterPreview.assessments).toBe(0);
    expect(afterPreview.customCategories).toBe(1);
    expect(afterPreview.approvedReasons).toBe(2);
    expect(afterPreview.taxonomyAuditLog).toBeGreaterThanOrEqual(2);

    expect(db.listCustomCategories()).toHaveLength(1);
    expect(db.listApprovedReasons()).toHaveLength(2);
    expect(db.listTaxonomyAudit().length).toBeGreaterThanOrEqual(2);
    expect(db.getTicket('5001')).toBeNull();
  });
});
