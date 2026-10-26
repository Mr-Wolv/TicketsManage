import { APP_VERSION, CLASSIFIER_VERSION, TAXONOMY_VERSION } from './config.js';
import type { Db, TicketListFilters } from './db.js';
import type { TicketRecord } from './types.js';
import { TAXONOMY_BY_ID } from './classifier/taxonomy.js';
import { buildStaffReport, type StaffReportFilters } from './reports.js';
import { toCsv, type CsvValue } from './csv.js';

export interface ExportOptions {
  includeDemo?: boolean;
  demoOnly?: boolean;
  from?: string;
  to?: string;
  dateBasis?: 'opened' | 'activity';
  staff?: string;
}

function loadAllTickets(db: Db, options: ExportOptions): TicketRecord[] {
  const tickets: TicketRecord[] = [];
  let page = 1;
  for (;;) {
    const result = db.listTickets({
      page,
      pageSize: 200,
      includeDemo: options.includeDemo,
      demoOnly: options.demoOnly,
      from: options.from,
      to: options.to,
      dateBasis: options.dateBasis,
      staff: options.staff,
      sort: 'id',
      dir: 'asc',
    } satisfies TicketListFilters);
    tickets.push(...result.items);
    if (tickets.length >= result.total || result.items.length === 0) break;
    page += 1;
    if (page > 1000) break;
  }
  return tickets;
}

function ticketExportRecord(ticket: TicketRecord): Record<string, unknown> {
  const assessment = ticket.assessment;
  return {
    ticketId: ticket.ticketId,
    opener: { name: ticket.openerUsername, id: ticket.openerUserId },
    openedAt: ticket.openedAt,
    openedAtSource: ticket.openedAtSource,
    claimedBy: {
      name: ticket.claimedByName,
      id: ticket.claimedById,
      state: ticket.claimedState,
    },
    closedBy: {
      name: ticket.closedByName,
      id: ticket.closedById,
      state: ticket.closedState,
    },
    closedAt: ticket.closedAt,
    closedAtSource: ticket.closedAtSource,
    originalCloseReason: ticket.closeReason,
    closeReasonState: ticket.closeReasonState,
    rating: ticket.rating,
    labels: ticket.labels,
    transcriptState: ticket.transcriptState,
    messageCount: ticket.messageCount,
    collectionStatus: ticket.collectionStatus,
    collectionError: ticket.collectionError,
    sourceUrl: ticket.ticketUrl,
    isDemo: ticket.isDemo,
    classification: assessment
      ? {
          categories: assessment.categories.map((category) => ({
            id: category.categoryId,
            code: TAXONOMY_BY_ID[category.categoryId]!.code,
            label: TAXONOMY_BY_ID[category.categoryId]!.label,
            points: category.points,
            method: category.method,
            confidence: category.confidence,
            evidence: category.evidence,
          })),
          basePoints: assessment.basePoints,
          fallback: assessment.fallback,
          method: assessment.method,
          confidence: assessment.confidence,
          explanation: assessment.explanation,
          alternatives: assessment.alternatives,
          humanCorrected: assessment.humanCorrected,
          assessedAt: assessment.assessedAt,
          model: assessment.model,
        }
      : null,
    staffCredit: assessment
      ? {
          rule: assessment.creditRule,
          status: assessment.creditStatus,
          staffId: assessment.creditStaffId,
          staffName: assessment.creditStaffName,
          awardedPoints: assessment.awardedPoints,
          explanation: assessment.creditExplanation,
        }
      : null,
    review: ticket.review
      ? {
          status: ticket.review.status,
          reasons: ticket.review.reasons,
          createdAt: ticket.review.createdAt,
          resolvedAt: ticket.review.resolvedAt,
          resolutionNote: ticket.review.resolutionNote,
        }
      : null,
  };
}

export function buildTicketExport(db: Db, options: ExportOptions = {}): Record<string, unknown> {
  const tickets = loadAllTickets(db, options);
  return {
    exportType: 'tickets',
    exportVersion: 1,
    appVersion: APP_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
    classifierVersion: CLASSIFIER_VERSION,
    exportedAt: new Date().toISOString(),
    includesDemoData: Boolean(options.includeDemo),
    demoOnly: Boolean(options.demoOnly),
    filters: {
      from: options.from ?? null,
      to: options.to ?? null,
      dateBasis: options.dateBasis ?? 'opened',
      staff: options.staff ?? null,
    },
    count: tickets.length,
    tickets: tickets.map(ticketExportRecord),
  };
}

export function ticketExportCsv(db: Db, options: ExportOptions = {}): string {
  const exportData = buildTicketExport(db, options) as { tickets: Array<Record<string, unknown>> };
  const headers = [
    'ticket_id',
    'opener_name',
    'opener_id',
    'opened_at',
    'claimed_by_name',
    'claimed_by_id',
    'claimed_state',
    'closed_by_name',
    'closed_by_id',
    'closed_state',
    'closed_at',
    'rating',
    'close_reason_original',
    'close_reason_state',
    'categories',
    'base_points',
    'fallback',
    'classification_method',
    'confidence',
    'credit_rule',
    'credit_status',
    'staff_id',
    'staff_name',
    'awarded_points',
    'review_status',
    'transcript_state',
    'source_url',
    'explanation',
  ];
  const rows: CsvValue[][] = exportData.tickets.map((ticket) => {
    const classification = ticket.classification as
      | {
          categories: Array<{ id: string; points: number }>;
          basePoints: number;
          fallback: boolean;
          method: string;
          confidence: number | null;
          explanation: string;
        }
      | null;
    const credit = ticket.staffCredit as
      | {
          rule: string;
          status: string;
          staffId: string | null;
          staffName: string | null;
          awardedPoints: number | null;
        }
      | null;
    const review = ticket.review as { status: string } | null;
    const claimed = ticket.claimedBy as { name: string | null; id: string | null; state: string };
    const closed = ticket.closedBy as { name: string | null; id: string | null; state: string };
    return [
      String(ticket.ticketId),
      String((ticket.opener as { name: string | null }).name ?? ''),
      String((ticket.opener as { id: string | null }).id ?? ''),
      String(ticket.openedAt ?? ''),
      String(claimed.name ?? ''),
      String(claimed.id ?? ''),
      claimed.state,
      String(closed.name ?? ''),
      String(closed.id ?? ''),
      closed.state,
      String(ticket.closedAt ?? ''),
      ticket.rating === null ? '' : Number(ticket.rating),
      String(ticket.originalCloseReason ?? ''),
      String(ticket.closeReasonState ?? ''),
      classification
        ? classification.categories.map((category) => `${category.id}:${category.points}`).join('; ')
        : '',
      classification ? classification.basePoints : '',
      classification ? (classification.fallback ? 'yes' : 'no') : '',
      classification ? classification.method : '',
      classification?.confidence ?? '',
      credit?.rule ?? '',
      credit?.status ?? '',
      credit?.staffId ?? '',
      credit?.staffName ?? '',
      credit?.awardedPoints ?? '',
      review?.status ?? '',
      String(ticket.transcriptState ?? ''),
      String(ticket.sourceUrl ?? ''),
      classification ? classification.explanation : '',
    ];
  });
  return toCsv(headers, rows);
}

export function buildStaffExport(
  db: Db,
  filters: StaffReportFilters,
): Record<string, unknown> {
  return {
    exportType: 'staff-report',
    exportVersion: 1,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    ...buildStaffReport(db, filters),
  };
}

export function staffExportCsv(db: Db, filters: StaffReportFilters): string {
  const report = buildStaffReport(db, filters);
  const headers = [
    'staff_name',
    'staff_id',
    'tickets_credited',
    'awarded_points',
    'same_claimant_and_closer',
    'unclaimed_half_points',
    'zero_because_different_staff',
    'fallback_tickets',
    'average_rating',
    'rating_count',
    'category_breakdown',
  ];
  const rows: CsvValue[][] = report.rows.map((row) => [
    row.staffName ?? '',
    row.staffId ?? '',
    row.ticketsCredited,
    row.awardedPoints,
    row.sameClaimClose,
    row.unclaimedHalf,
    row.differentZero,
    row.fallbackTickets,
    row.avgRating ?? '',
    row.ratingCount,
    row.categories.map((category) => `${category.code}:${category.points}`).join('; '),
  ]);
  return toCsv(headers, rows);
}

export function buildReviewExport(
  db: Db,
  options: { status?: string; includeDemo?: boolean; demoOnly?: boolean } = {},
): Record<string, unknown> {
  const reviews = db.listReviews(options.status ?? 'pending');
  const filtered = options.demoOnly
    ? reviews.filter((review) => review.ticket.isDemo)
    : options.includeDemo
      ? reviews
      : reviews.filter((review) => !review.ticket.isDemo);
  return {
    exportType: 'review-queue',
    exportVersion: 1,
    appVersion: APP_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
    exportedAt: new Date().toISOString(),
    includesDemoData: Boolean(options.includeDemo),
    demoOnly: Boolean(options.demoOnly),
    filterStatus: options.status ?? 'pending',
    count: filtered.length,
    items: filtered.map((review) => ({
      ticketId: review.ticketId,
      reviewStatus: review.status,
      reviewReasons: review.reasons,
      createdAt: review.createdAt,
      updatedAt: review.updatedAt,
      originalCloseReason: review.originalReason,
      closeReasonState: review.reasonState,
      categories: review.categories.map((category) => ({
        id: category.categoryId,
        code: TAXONOMY_BY_ID[category.categoryId]!.code,
        points: category.points,
        method: category.method,
        evidence: category.evidence,
      })),
      basePoints: review.basePoints,
      fallback: review.fallback,
      method: review.method,
      explanation: review.explanation,
      alternatives: review.alternatives,
      staffCredit: review.assessment
        ? {
            rule: review.assessment.creditRule,
            status: review.assessment.creditStatus,
            staffId: review.assessment.creditStaffId,
            staffName: review.assessment.creditStaffName,
            awardedPoints: review.assessment.awardedPoints,
            explanation: review.assessment.creditExplanation,
          }
        : null,
      claimedBy: { name: review.claimedByName, id: review.ticket.claimedById, state: review.ticket.claimedState },
      closedBy: { name: review.closedByName, id: review.ticket.closedById, state: review.ticket.closedState },
      sourceUrl: review.ticket.ticketUrl,
      correctionHistory: db.listReviewHistory(review.ticketId),
    })),
  };
}

export function reviewExportCsv(
  db: Db,
  options: { status?: string; includeDemo?: boolean; demoOnly?: boolean } = {},
): string {
  const data = buildReviewExport(db, options) as {
    items: Array<Record<string, unknown>>;
  };
  const headers = [
    'ticket_id',
    'review_status',
    'original_close_reason',
    'reason_state',
    'categories',
    'base_points',
    'fallback',
    'method',
    'review_reasons',
    'alternatives',
    'claimed_by',
    'closed_by',
    'credit_rule',
    'credit_status',
    'awarded_points',
    'source_url',
  ];
  const rows: CsvValue[][] = data.items.map((item) => {
    const categories = item.categories as Array<{ id: string; points: number }>;
    const credit = item.staffCredit as
      | { rule: string; status: string; awardedPoints: number | null }
      | null;
    const reasons = item.reviewReasons as string[];
    const alternatives = item.alternatives as Array<{ categoryId: string; reason: string }>;
    const claimedBy = item.claimedBy as { name: string | null };
    const closedBy = item.closedBy as { name: string | null };
    return [
      String(item.ticketId),
      String(item.reviewStatus),
      String(item.originalCloseReason ?? ''),
      String(item.closeReasonState),
      categories.map((category) => `${category.id}:${category.points}`).join('; '),
      Number(item.basePoints ?? 0),
      item.fallback ? 'yes' : 'no',
      String(item.method),
      reasons.join(' | '),
      alternatives.map((alternative) => `${alternative.categoryId}: ${alternative.reason}`).join(' | '),
      claimedBy.name ?? '',
      closedBy.name ?? '',
      credit?.rule ?? '',
      credit?.status ?? '',
      credit?.awardedPoints ?? '',
      String(item.sourceUrl ?? ''),
    ];
  });
  return toCsv(headers, rows);
}
