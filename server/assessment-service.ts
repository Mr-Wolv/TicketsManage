import { CLASSIFIER_VERSION, TAXONOMY_VERSION, resolveApprovedCloudBaseUrl } from './config.js';
import type { Db } from './db.js';
import { log } from './logger.js';
import { normalizeReason } from './classifier/normalize.js';
import { classifyReason } from './classifier/pipeline.js';
import { isCategoryId, loadUnifiedTaxonomy, pointsFor } from './classifier/taxonomy.js';
import { applyStaffCredit, basePointsFor } from './scoring.js';
import { OpenAiCompatibleProvider, buildTaxonomyContext, classifyWithRetry, sanitizeCloudResult } from './classifier/cloud.js';
import { LRUCache } from './classifier/lru.js';
import type {
  CategoryAssessment,
  CategoryId,
  ReviewRecord,
  StaffCreditResult,
  StoredAssessment,
  TicketRecord,
} from './types.js';

export interface AssessOutcome {
  assessment: StoredAssessment;
  review: ReviewRecord | null;
  ticket: TicketRecord;
  warning?: string;
}

export class AssessmentService {
  constructor(private readonly db: Db) {}

  private creditReviewReason(credit: StaffCreditResult): string {
    return `Staff attribution unresolved: ${credit.explanation}`;
  }

  private buildStoredAssessment(input: {
    ticket: TicketRecord;
    categories: CategoryAssessment[];
    fallback: boolean;
    method: StoredAssessment['method'];
    confidence: number | null;
    explanation: string;
    alternatives: StoredAssessment['alternatives'];
    classificationReviewReasons: string[];
    unresolvedPortion: string | null;
    model: string | null;
    humanCorrected: boolean;
  }): StoredAssessment {
    const basePoints = basePointsFor(input.categories, this.db);
    const credit = applyStaffCredit(
      {
        claimedState: input.ticket.claimedState,
        claimedById: input.ticket.claimedById,
        claimedByName: input.ticket.claimedByName,
        closedState: input.ticket.closedState,
        closedById: input.ticket.closedById,
        closedByName: input.ticket.closedByName,
        reasonState: input.ticket.closeReasonState,
      },
      basePoints,
    );
    const reviewReasons = [...input.classificationReviewReasons];
    if (credit.status === 'unresolved') reviewReasons.push(this.creditReviewReason(credit));
    return {
      ticketId: input.ticket.ticketId,
      originalReason: input.ticket.closeReason,
      categories: input.categories,
      basePoints,
      fallback: input.fallback,
      method: input.method,
      confidence: input.confidence,
      explanation: input.explanation,
      alternatives: input.alternatives,
      reviewReasons: [...new Set(reviewReasons)],
      unresolvedPortion: input.unresolvedPortion,
      creditRule: credit.rule,
      creditStatus: credit.status,
      creditStaffId: credit.staffId,
      creditStaffName: credit.staffName,
      awardedPoints: credit.awardedPoints,
      creditExplanation: credit.explanation,
      model: input.model,
      taxonomyVersion: TAXONOMY_VERSION,
      classifierVersion: CLASSIFIER_VERSION,
      humanCorrected: input.humanCorrected,
      assessedAt: new Date().toISOString(),
    };
  }

  async assessTicket(
    ticketId: string,
    options: { force?: boolean } = {},
  ): Promise<AssessOutcome> {
    const ticket = this.db.getTicket(ticketId);
    if (!ticket) throw new Error('TICKET_NOT_FOUND');
    const existing = ticket.assessment;
    if (existing?.humanCorrected && !options.force) {
      return { assessment: existing, review: ticket.review, ticket };
    }

    const settings = this.db.getSettings();
    const classification = await classifyReason(
      ticket.closeReason ?? '',
      ticket.closeReasonState,
      {
        fuzzyThreshold: settings.fuzzyThreshold,
        semanticEnabled: false,
        semanticMode: 'off',
        model: null,
        aliasLookup: (normalized) => this.db.findApprovedAlias(normalized),
        suppressSemanticDisabledReview: true,
        db: this.db,
      },
    );

    const assessment = this.buildStoredAssessment({
      ticket,
      categories: classification.categories,
      fallback: classification.fallback,
      method: classification.method,
      confidence: classification.confidence,
      explanation: classification.explanation,
      alternatives: classification.alternatives,
      classificationReviewReasons: classification.reviewReasons,
      unresolvedPortion: classification.unresolvedPortion,
      model: classification.model,
      humanCorrected: false,
    });

    const review = this.persist(assessment, ticket);
    return {
      assessment,
      review,
      ticket,
      warning: classification.reviewReasons.find((reason) =>
        reason.startsWith('Semantic classification was unavailable'),
      ),
    };
  }

  private persist(assessment: StoredAssessment, ticket: TicketRecord): ReviewRecord | null {
    let review = ticket.review;
    this.db.transaction(() => {
      this.db.saveAssessment(assessment);
      const previousCategories =
        ticket.assessment?.categories.map((category) => category.categoryId) ?? null;
      if (assessment.reviewReasons.length > 0) {
        review = this.db.ensureReview(assessment.ticketId, assessment.reviewReasons);
        if (
          previousCategories &&
          JSON.stringify(previousCategories) !==
            JSON.stringify(assessment.categories.map((category) => category.categoryId))
        ) {
          this.db.addReviewHistory(
            assessment.ticketId,
            'reassessed',
            previousCategories,
            assessment.categories.map((category) => category.categoryId),
            'Classifier assessment changed.',
          );
        }
      }
      if (review && review.status === 'pending' && assessment.reviewReasons.length === 0) {
        // A reassessment (for example after claimant extraction or a classifier
        // fix) can clear every actionable reason. Leaving the item pending would
        // ask the manager to resolve a problem that no longer exists.
        this.db.setReviewReasons(assessment.ticketId, []);
        this.db.resolveReview(
          assessment.ticketId,
          'accepted',
          'Automatically resolved after reassessment: no actionable review reasons remain.',
        );
        this.db.addReviewHistory(
          assessment.ticketId,
          'resolved',
          null,
          null,
          'Reassessment cleared all review reasons.',
        );
        review = this.db.getReview(assessment.ticketId);
      }
    });
    return review;
  }

  async correctAssessment(input: {
    ticketId: string;
    categoryIds: string[];
    note: string | null;
    approveAlias: boolean;
  }): Promise<AssessOutcome & { aliasConflict: boolean; reviewResolved: boolean }> {
    const ticket = this.db.getTicket(input.ticketId);
    if (!ticket) throw new Error('TICKET_NOT_FOUND');
    const uniqueIds = [...new Set(input.categoryIds)];
    if (uniqueIds.some((id) => !isCategoryId(id))) {
      throw new Error('UNKNOWN_CATEGORY');
    }
    if (ticket.closeReasonState !== 'empty' && uniqueIds.length === 0) {
      throw new Error('CATEGORY_REQUIRED');
    }
    if (ticket.closeReasonState === 'empty' && uniqueIds.length > 0) {
      throw new Error('EMPTY_REASON_CANNOT_HAVE_CATEGORY');
    }

    const categories: CategoryAssessment[] = uniqueIds.map((id) => ({
      categoryId: id as CategoryId,
      points: pointsFor(id as CategoryId, this.db),
      evidence: ['Manager correction saved in the review workflow'],
      method: 'human' as const,
      confidence: 1,
    }));
    const previous = ticket.assessment;
    const basePoints = basePointsFor(categories, this.db);
    const credit = applyStaffCredit(
      {
        claimedState: ticket.claimedState,
        claimedById: ticket.claimedById,
        claimedByName: ticket.claimedByName,
        closedState: ticket.closedState,
        closedById: ticket.closedById,
        closedByName: ticket.closedByName,
        reasonState: ticket.closeReasonState,
      },
      basePoints,
    );
    const reviewReasons: string[] = [];
    if (credit.status === 'unresolved') reviewReasons.push(this.creditReviewReason(credit));
    if (ticket.closeReasonState === 'unavailable') {
      reviewReasons.push('Closing reason was unavailable; the manager supplied a manual classification.');
    }
    const assessment: StoredAssessment = {
      ticketId: ticket.ticketId,
      originalReason: ticket.closeReason,
      categories,
      basePoints,
      fallback: false,
      method: 'human',
      confidence: 1,
      explanation: `Manager correction: ${
        categories.length
          ? categories.map((category) => category.categoryId).join(', ')
          : 'no categories (empty reason)'
      }. Base points and staff credit were recalculated deterministically.`,
      alternatives: previous?.alternatives ?? [],
      reviewReasons,
      unresolvedPortion: null,
      creditRule: credit.rule,
      creditStatus: credit.status,
      creditStaffId: credit.staffId,
      creditStaffName: credit.staffName,
      awardedPoints: credit.awardedPoints,
      creditExplanation: credit.explanation,
      model: null,
      taxonomyVersion: TAXONOMY_VERSION,
      classifierVersion: CLASSIFIER_VERSION,
      humanCorrected: true,
      assessedAt: new Date().toISOString(),
    };

    let aliasConflict = false;
    this.db.transaction(() => {
      this.db.saveAssessment(assessment);
      this.db.addReviewHistory(
        ticket.ticketId,
        'corrected',
        previous?.categories.map((category) => category.categoryId) ?? null,
        categories.map((category) => category.categoryId),
        input.note,
      );
      if (reviewReasons.length > 0) {
        this.db.ensureReview(ticket.ticketId, reviewReasons);
      } else if (ticket.review) {
        this.db.resolveReview(ticket.ticketId, 'corrected', input.note);
      }
      if (input.approveAlias && ticket.closeReasonState === 'present' && ticket.closeReason) {
        const result = this.db.addApprovedAlias({
          normalizedText: normalizeReason(ticket.closeReason),
          originalText: ticket.closeReason,
          categoryIds: uniqueIds,
          sourceTicket: ticket.ticketId,
        });
        aliasConflict = result.conflict;
      }
      if (ticket.closeReasonState === 'present' && ticket.closeReason) {
        for (const categoryId of uniqueIds) {
          this.db.addApprovedReason({
            text: ticket.closeReason,
            categoryId: categoryId as any,
            sourceType: 'review',
            sourceTicketId: ticket.ticketId,
          });
        }
      }
    });

    const review = this.db.getReview(ticket.ticketId);
    log('info', 'assessment.corrected', {
      ticketId: ticket.ticketId,
      categories: uniqueIds,
      aliasConflict,
    });
    return {
      assessment,
      review,
      ticket: this.db.getTicket(ticket.ticketId)!,
      aliasConflict,
      reviewResolved: review?.status !== 'pending',
    };
  }

  acceptReview(ticketId: string, note: string | null): AssessOutcome {
    const ticket = this.db.getTicket(ticketId);
    if (!ticket || !ticket.assessment) throw new Error('TICKET_NOT_FOUND');
    let remaining: ReviewRecord | null = null;
    this.db.transaction(() => {
      this.db.addReviewHistory(
        ticketId,
        'accepted',
        ticket.assessment!.categories.map((category) => category.categoryId),
        ticket.assessment!.categories.map((category) => category.categoryId),
        note,
      );
      if (ticket.assessment!.creditStatus === 'unresolved') {
        // Acceptance resolves the classification judgement, but not the missing
        // attribution evidence. The item stays visible until dismissed.
        this.db.ensureReview(ticketId, [this.creditReviewReason({
          rule: ticket.assessment!.creditRule,
          status: ticket.assessment!.creditStatus,
          awardedPoints: ticket.assessment!.awardedPoints,
          staffId: ticket.assessment!.creditStaffId,
          staffName: ticket.assessment!.creditStaffName,
          explanation: ticket.assessment!.creditExplanation,
        })]);
      } else {
        this.db.resolveReview(ticketId, 'accepted', note);
      }
      if (
        ticket.closeReasonState === 'present' &&
        ticket.closeReason &&
        !ticket.assessment!.humanCorrected
      ) {
        for (const category of ticket.assessment!.categories) {
          this.db.addApprovedReason({
            text: ticket.closeReason!,
            categoryId: category.categoryId,
            sourceType: 'review',
            sourceTicketId: ticket.ticketId,
          });
        }
      }
      remaining = this.db.getReview(ticketId);
    });
    return {
      assessment: this.db.getAssessment(ticketId)!,
      review: remaining,
      ticket: this.db.getTicket(ticketId)!,
    };
  }

  dismissReview(ticketId: string, note: string | null): AssessOutcome {
    const ticket = this.db.getTicket(ticketId);
    if (!ticket || !ticket.assessment) throw new Error('TICKET_NOT_FOUND');
    this.db.transaction(() => {
      this.db.addReviewHistory(
        ticketId,
        'dismissed',
        ticket.assessment!.categories.map((category) => category.categoryId),
        null,
        note,
      );
      this.db.resolveReview(ticketId, 'dismissed', note);
    });
    return {
      assessment: ticket.assessment!,
      review: this.db.getReview(ticketId),
      ticket: this.db.getTicket(ticketId)!,
    };
  }

  async reassess(ticketId: string): Promise<AssessOutcome> {
    const ticket = this.db.getTicket(ticketId);
    if (!ticket) throw new Error('TICKET_NOT_FOUND');
    if (ticket.assessment?.humanCorrected) {
      return { assessment: ticket.assessment, review: ticket.review, ticket };
    }
    return this.assessTicket(ticketId, { force: true });
  }

  /**
   * Recalculate staff credit and points from stored category assignments only.
   * No browser, transcript or classifier work is involved, so changing a
   * scoring rule never requires recollecting or reclassifying tickets.
   */
  rescoreAll(): { rescored: number; changed: number; unresolved: number } {
    const rows = this.db.connection
      .prepare(
        `SELECT a.ticket_id FROM assessments a
         JOIN tickets t ON t.ticket_id = a.ticket_id
         WHERE t.is_demo = 0 ORDER BY CAST(a.ticket_id AS INTEGER) ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    let rescored = 0;
    let changed = 0;
    let unresolved = 0;
    for (const row of rows) {
      const ticketId = String(row.ticket_id);
      const ticket = this.db.getTicket(ticketId);
      if (!ticket?.assessment) continue;
      const previous = ticket.assessment;
      if (previous.categories.length === 0) continue;
      const next = this.buildStoredAssessment({
        ticket,
        categories: previous.categories,
        fallback: previous.fallback,
        method: previous.method,
        confidence: previous.confidence,
        explanation: previous.explanation,
        alternatives: previous.alternatives,
        classificationReviewReasons: previous.reviewReasons.filter(
          (reason) => !reason.startsWith('Staff attribution unresolved:'),
        ),
        unresolvedPortion: previous.unresolvedPortion,
        model: previous.model,
        humanCorrected: previous.humanCorrected,
      });
      this.persist(next, ticket);
      rescored += 1;
      if (next.awardedPoints !== previous.awardedPoints) changed += 1;
      if (next.creditStatus === 'unresolved') unresolved += 1;
    }
    return { rescored, changed, unresolved };
  }

  /**
   * Reclassify only tickets whose assessment is missing or was produced by an
   * older classifier/taxonomy. Human corrections are never overwritten.
   */
  async reclassifyStale(): Promise<{ reclassified: number; failed: number }> {
    const rows = this.db.connection
      .prepare(
        `SELECT t.ticket_id FROM tickets t
         LEFT JOIN assessments a ON a.ticket_id = t.ticket_id
         WHERE t.is_demo = 0
           AND (a.ticket_id IS NULL OR a.classifier_version <> ? OR a.taxonomy_version <> ?)
           AND (a.human_corrected IS NULL OR a.human_corrected = 0)
         ORDER BY CAST(t.ticket_id AS INTEGER) ASC`,
      )
      .all(CLASSIFIER_VERSION, TAXONOMY_VERSION) as Array<Record<string, unknown>>;
    let reclassified = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        await this.assessTicket(String(row.ticket_id));
        reclassified += 1;
      } catch {
        failed += 1;
      }
    }
    return { reclassified, failed };
  }

  async reclassifyPendingReviewsWithCloud(): Promise<{ processed: number; updated: number; failed: number; quotaExhausted?: boolean; quotaReason?: string }> {
    const settings = this.db.getSettings();
    if (!settings.cloudProviderUrl || !settings.cloudApiKey || !settings.cloudModel) {
      throw new Error('Cloud provider is not configured.');
    }
    // Fail before dispatching anything if the configured endpoint is not the
    // approved destination: the stored API key must never leave for another host.
    const approvedBaseUrl = resolveApprovedCloudBaseUrl(settings.cloudProviderUrl);
    if (!approvedBaseUrl) {
      throw new Error('CLOUD_ENDPOINT_NOT_APPROVED');
    }

    const pending = this.db.listReviews('pending');
    const eligible = pending.filter((entry) => {
      const ticket = entry.ticket;
      const assessment = entry.assessment;
      if (!ticket || !assessment || assessment.humanCorrected) return false;
      const reason = ticket.closeReason?.trim();
      if (!reason) return false;
      const reviewReasons = assessment.reviewReasons ?? [];
      const isUnresolvedCredit = reviewReasons.some((r) => r.startsWith('Staff attribution unresolved'));
      const isLowConfidence = (assessment.confidence ?? 1) < 0.85;
      const isFallback = assessment.fallback === true;
      return isUnresolvedCredit || isLowConfidence || isFallback;
    });

    const processed = eligible.length;
    if (processed === 0) {
      return { processed: 0, updated: 0, failed: 0 };
    }

    // Cache taxonomy context per settings hash
    const taxonomyKey = `${settings.cloudProviderUrl}|${settings.cloudModel}|${settings.cloudTimeoutMs}`;
    const taxonomyCache = new Map<string, string>();
    const resultCache = new Map<
      string,
      { categories: any[]; alternatives: any[]; reviewRequired: boolean }
    >();
    // The unified taxonomy is the authority for what a category ID may be: an
    // ID that is not in here has no points value and can never be scored.
    const unifiedTaxonomy = loadUnifiedTaxonomy(this.db);
    const validCategoryIds = new Set(Object.keys(unifiedTaxonomy));

    const getTaxonomyContext = (): string => {
      let ctx = taxonomyCache.get(taxonomyKey);
      if (!ctx) {
        ctx = buildTaxonomyContext(
          Object.values(unifiedTaxonomy).map((category) => ({
            id: category.id,
            code: category.code,
            label: category.label,
            examples: category.examples,
          })),
        );
        taxonomyCache.set(taxonomyKey, ctx);
      }
      return ctx;
    };

    const provider = new OpenAiCompatibleProvider(approvedBaseUrl, settings.cloudApiKey, settings.cloudModel);
    const workers = Math.min(Math.max(settings.cloudMaxWorkers, 1), 50);
    const timeoutMs = Math.min(settings.cloudTimeoutMs, 10000);
    const updates: Array<{ assessment: any; ticketId: string; oldCategories: string[]; newCategories: string[] }> = [];

    let quotaExhausted = false;
    let quotaReason = '';

    const processOne = async (entry: typeof eligible[number]): Promise<boolean> => {
      if (quotaExhausted) return false;

      const ticket = entry.ticket;
      const assessment = entry.assessment;
      if (!ticket || !assessment) return false;

      const reason = ticket.closeReason ?? '';
      // The whole reason is part of the cache key: two different reasons that
      // happen to share a 200-character prefix must never share a result.
      const reasonHash = `${reason}|${taxonomyKey}`;

      let categories: any[];
      let alternatives: any[];
      let reviewRequired = false;

      const cached = resultCache.get(reasonHash);
      if (cached) {
        categories = cached.categories;
        alternatives = cached.alternatives;
        reviewRequired = cached.reviewRequired;
      } else {
        try {
          const result = await classifyWithRetry(provider, reason, getTaxonomyContext(), timeoutMs);
          const sanitized = sanitizeCloudResult(result, (id) => validCategoryIds.has(id));
          if (sanitized.rejectedCategoryIds.length > 0) {
            log('warn', 'cloud.categories_rejected', {
              ticketId: ticket.ticketId,
              rejected: sanitized.rejectedCategoryIds.slice(0, 10),
            });
          }
          categories = sanitized.categories.map((category) => ({
            categoryId: category.categoryId as CategoryId,
            points: pointsFor(category.categoryId as CategoryId, this.db),
            evidence: category.evidence,
            method: 'cloud' as const,
            confidence: category.confidence,
          }));
          alternatives = sanitized.alternatives;
          reviewRequired = sanitized.reviewRequired;

          if (categories.length > 0) {
            resultCache.set(reasonHash, { categories, alternatives, reviewRequired });
          }
        } catch (error) {
          const typed = error as Error & { quotaExhausted?: boolean; cause?: string };
          if (typed.quotaExhausted) {
            quotaExhausted = true;
            quotaReason = typed.cause ?? 'Daily free-model quota exhausted.';
          }
          return false;
        }
      }

      if (categories.length === 0) return false;

      const basePoints = basePointsFor(categories, this.db);
      const credit = applyStaffCredit(
        {
          claimedState: ticket.claimedState,
          claimedById: ticket.claimedById,
          claimedByName: ticket.claimedByName,
          closedState: ticket.closedState,
          closedById: ticket.closedById,
          closedByName: ticket.closedByName,
          reasonState: ticket.closeReasonState,
        },
        basePoints,
      );

      // A valid cloud classification answers the classification question itself,
      // so the deterministic fallback and low-confidence reasons no longer
      // apply. Attribution problems are recomputed from the ticket, which keeps
      // Rule E items visible instead of dismissing them as if they were solved.
      const classificationReviewReasons = reviewRequired
        ? ['Cloud AI requested human review before accepting this classification.']
        : [];
      const newAssessment = this.buildStoredAssessment({
        ticket,
        categories,
        fallback: false,
        method: 'cloud',
        confidence: categories[0]?.confidence ?? null,
        explanation: reviewRequired
          ? 'Cloud semantic reclassification (the provider requested human review).'
          : 'Cloud semantic reclassification.',
        alternatives,
        classificationReviewReasons,
        unresolvedPortion: null,
        model: settings.cloudModel,
        humanCorrected: false,
      });

      updates.push({
        assessment: newAssessment,
        ticketId: assessment.ticketId,
        oldCategories: assessment.categories.map((c: any) => c.categoryId),
        newCategories: categories.map((c: any) => c.categoryId),
      });
      return true;
    };

    // Parallel execution with worker pool
    const pool: Promise<boolean>[] = [];
    for (const entry of eligible) {
      const task = processOne(entry);
      pool.push(task);
      if (pool.length >= workers) {
        await Promise.allSettled(pool);
        pool.length = 0;
      }
    }
    if (pool.length > 0) {
      await Promise.allSettled(pool);
    }

    // Batch DB writes in single transaction
    const updated = updates.length;
    if (updated > 0) {
      this.db.transaction(() => {
        for (const update of updates) {
          this.db.saveAssessment(update.assessment);
          if (update.assessment.reviewReasons.length === 0) {
            this.db.setReviewReasons(update.ticketId, []);
            this.db.resolveReview(update.ticketId, 'dismissed', 'Cloud AI reclassification succeeded.');
          } else {
            // Unresolved staff attribution (Rule E) stays visible: the item keeps
            // its reasons and remains in the review queue until a manager
            // dismisses it. It must never be resolved by a successful model call.
            this.db.ensureReview(update.ticketId, update.assessment.reviewReasons);
          }
          this.db.addReviewHistory(
            update.ticketId,
            'reassessed',
            update.oldCategories,
            update.newCategories,
            'Cloud AI reclassification.',
          );
        }
      });
    }

    return { processed, updated, failed: processed - updated, quotaExhausted, quotaReason };
  }

  listPendingAssessmentIds(limit = 100, includeDemo = false): string[] {
    const rows = this.db.connection
      .prepare(
        `SELECT t.ticket_id FROM tickets t
         LEFT JOIN assessments a ON a.ticket_id = t.ticket_id
         WHERE a.ticket_id IS NULL ${includeDemo ? '' : 'AND t.is_demo = 0'}
         ORDER BY CAST(t.ticket_id AS INTEGER) ASC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => String(row.ticket_id));
  }
}