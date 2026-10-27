import { CLASSIFIER_VERSION, TAXONOMY_VERSION } from './config.js';
import type { Db } from './db.js';
import { log } from './logger.js';
import { normalizeReason } from './classifier/normalize.js';
import { classifyReason } from './classifier/pipeline.js';
import { isCategoryId, loadUnifiedTaxonomy, pointsFor } from './classifier/taxonomy.js';
import { applyStaffCredit, basePointsFor } from './scoring.js';
import { OpenAiCompatibleProvider, adaptCloudResult, buildTaxonomyContext } from './classifier/cloud.js';
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

  async reclassifyPendingReviewsWithCloud(): Promise<{ processed: number; updated: number; failed: number }> {
    const settings = this.db.getSettings();
    if (!settings.cloudProviderUrl || !settings.cloudApiKey || !settings.cloudModel) {
      throw new Error('Cloud provider is not configured.');
    }

    const provider = new OpenAiCompatibleProvider(settings.cloudProviderUrl, settings.cloudApiKey, settings.cloudModel);
    const taxonomyContext = buildTaxonomyContext(
      Object.values(loadUnifiedTaxonomy(this.db)).map((category) => ({
        id: category.id,
        code: category.code,
        label: category.label,
        examples: category.examples,
      })),
    );

    const pending = this.db.listReviews('pending');
    let processed = 0;
    let updated = 0;
    let failed = 0;

    for (const entry of pending) {
      const ticket = entry.ticket;
      const assessment = entry.assessment;
      if (!ticket || !assessment || assessment.humanCorrected) {
        continue;
      }

      processed += 1;
      try {
        const result = await provider.classify(
          ticket.closeReason ?? '',
          taxonomyContext,
          settings.cloudTimeoutMs,
        );
        const adapted = adaptCloudResult(result) as any;
        const categories = (adapted.categories ?? []).map((c: any) => ({
          categoryId: c.categoryId,
          points: pointsFor(c.categoryId, this.db),
          evidence: c.evidence ?? [],
          method: 'cloud' as const,
          confidence: c.confidence ?? 0,
        }));

        if (categories.length === 0) {
          throw new Error('Cloud model returned no categories.');
        }

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

        const reviewReasons = [...new Set(assessment.reviewReasons ?? [])];
        const newAssessment = this.buildStoredAssessment({
          ticket,
          categories,
          fallback: assessment.fallback,
          method: 'cloud',
          confidence: categories[0]?.confidence ?? 0,
          explanation: (adapted.explanation as string) ?? 'Cloud semantic reclassification.',
          alternatives: (adapted.alternatives as any[]) ?? [],
          classificationReviewReasons: reviewReasons,
          unresolvedPortion: (adapted.unresolvedPortion as string | null) ?? null,
          model: result.model,
          humanCorrected: false,
        });

        this.db.transaction(() => {
          this.db.saveAssessment(newAssessment);
          if (reviewReasons.length === 0) {
            this.db.setReviewReasons(assessment.ticketId, []);
          }
          this.db.addReviewHistory(
            assessment.ticketId,
            'reassessed',
            assessment.categories.map((c: { categoryId: string }) => c.categoryId),
            categories.map((c: { categoryId: string }) => c.categoryId),
            'Cloud AI reclassification.',
          );
        });

        updated += 1;
      } catch (error) {
        failed += 1;
        log('warn', 'assessment.cloud_review_failed', {
          ticketId: ticket.ticketId,
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
    }

    return { processed, updated, failed };
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