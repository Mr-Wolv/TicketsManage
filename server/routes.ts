import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  type Router,
} from 'express';
import { chromium } from 'playwright';
import {
  APP_VERSION,
  BACKUP_DIR,
  CLASSIFIER_VERSION,
  DATA_DIR,
  DB_PATH,
  EXPORT_DIR,
  PROFILE_DIR,
  TAXONOMY_VERSION,
} from './config.js';
import { Db } from './db.js';
import type { ConnectionManager } from './connection.js';
import type { CollectionService } from './collection-service.js';
import type { AssessmentService } from './assessment-service.js';
import { validateRange, validateDateRange, type RangeValidation, type DateRangeValidation } from './collection-service.js';
import { OllamaClient, type ModelStatus } from './classifier/ollama.js';
import { TAXONOMY, TAXONOMY_BY_ID, isCategoryId } from './classifier/taxonomy.js';
import { buildStaffReport } from './reports.js';
import {
  buildReviewExport,
  buildStaffExport,
  buildTicketExport,
  reviewExportCsv,
  staffExportCsv,
  ticketExportCsv,
} from './exports.js';
import { seedDemoData } from './demo.js';
import { recentLogs, log } from './logger.js';
import type { AppSettings, ReviewRecord, TicketRecord } from './types.js';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

const asyncRoute =
  (handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };

let modelCache: { at: number; status: ModelStatus } | null = null;

async function getModelStatus(db: Db, force = false): Promise<ModelStatus> {
  const settings = db.getSettings();
  if (!force && modelCache && Date.now() - modelCache.at < 10_000 && modelCache.status.selectedModel === settings.model) {
    return modelCache.status;
  }
  const client = new OllamaClient(settings.ollamaUrl, settings.model);
  const status = await client.status();
  modelCache = { at: Date.now(), status };
  return status;
}

function browserInstalled(): boolean {
  try {
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

function boolQuery(value: unknown): boolean {
  return value === '1' || value === 'true' || value === true;
}

function normalizeDateFilter(value: unknown, endOfDay: boolean): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    // Interpret a plain date in the machine's local timezone. Egyptian staff
    // days are local days; treating them as UTC shifted late-night tickets into
    // the wrong calendar column.
    const local = new Date(`${trimmed}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`);
    return Number.isNaN(local.getTime()) ? trimmed : local.toISOString();
  }
  return trimmed;
}

function sanitizeTicket(ticket: TicketRecord, includeMessages = false): Record<string, unknown> {
  const { rawListRow, messages, ...rest } = ticket;
  return {
    ...rest,
    messages: includeMessages ? messages : [],
    rawFieldNames:
      rawListRow && typeof rawListRow === 'object' && !Array.isArray(rawListRow)
        ? Object.keys(rawListRow as Record<string, unknown>)
        : [],
  };
}

interface ReviewSummary {
  ticketId: string;
  status: string;
  reasons: string[];
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  originalCloseReason: string | null;
  closeReasonState: string;
  categories: unknown;
  basePoints: number;
  fallback: boolean;
  method: string;
  explanation: string;
  alternatives: unknown;
  assessment: unknown;
  credit: unknown;
  claimedBy: unknown;
  closedBy: unknown;
  opener: string | null;
  rating: number | null;
  transcriptState: string;
  sourceUrl: string | null;
  isDemo: boolean;
  review: ReviewRecord;
}

function serializeReview(review: Awaited<ReturnType<Db['listReviews']>>[number]): ReviewSummary {
  return {
    ticketId: review.ticketId,
    status: review.status,
    reasons: review.reasons,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
    resolvedAt: review.ticket.review?.resolvedAt ?? null,
    resolutionNote: review.ticket.review?.resolutionNote ?? null,
    originalCloseReason: review.originalReason,
    closeReasonState: review.reasonState,
    categories: review.categories,
    basePoints: review.basePoints,
    fallback: review.fallback,
    method: review.method,
    explanation: review.explanation,
    alternatives: review.alternatives,
    assessment: review.assessment,
    credit: review.assessment
      ? {
          rule: review.assessment.creditRule,
          status: review.assessment.creditStatus,
          staffId: review.assessment.creditStaffId,
          staffName: review.assessment.creditStaffName,
          awardedPoints: review.assessment.awardedPoints,
          explanation: review.assessment.creditExplanation,
        }
      : null,
    claimedBy: {
      name: review.claimedByName,
      id: review.ticket.claimedById,
      state: review.ticket.claimedState,
    },
    closedBy: {
      name: review.closedByName,
      id: review.ticket.closedById,
      state: review.ticket.closedState,
    },
    opener: review.openerUsername,
    rating: review.ticket.rating,
    transcriptState: review.ticket.transcriptState,
    sourceUrl: review.ticket.ticketUrl,
    isDemo: review.ticket.isDemo,
    review: {
      ticketId: review.ticketId,
      status: review.status,
      reasons: review.reasons,
      createdAt: review.createdAt,
      updatedAt: review.updatedAt,
      resolvedAt: review.ticket.review?.resolvedAt ?? null,
      resolvedBy: review.ticket.review?.resolvedBy ?? null,
      resolutionNote: review.ticket.review?.resolutionNote ?? null,
    },
  };
}

function reviewStatusCounts(
  db: Db,
  mode: 'real' | 'all' | 'demo' = 'real',
): Record<string, number> {
  const scope = mode === 'demo' ? 't.is_demo = 1' : mode === 'all' ? '1=1' : 't.is_demo = 0';
  const rows = db.connection
    .prepare(
      `SELECT r.status, COUNT(*) AS n FROM reviews r
       JOIN tickets t ON t.ticket_id = r.ticket_id
       WHERE ${scope} GROUP BY r.status`,
    )
    .all() as Array<Record<string, unknown>>;
  const counts: Record<string, number> = { pending: 0, accepted: 0, corrected: 0, dismissed: 0, all: 0 };
  for (const row of rows) {
    const status = String(row.status);
    counts[status] = Number(row.n);
    counts.all = (counts.all ?? 0) + Number(row.n);
  }
  return counts;
}

function recentRunItems(db: Db, runId: string): Array<Record<string, unknown>> {
  const rows = db.connection
    .prepare(
      `SELECT i.ticket_id, i.state, i.error, i.updated_at,
              t.opener_username, t.collection_status, t.close_reason, t.close_reason_state,
              a.categories_json, a.fallback, a.base_points, a.awarded_points, a.credit_status,
              r.status AS review_status
       FROM collection_items i
       LEFT JOIN tickets t ON t.ticket_id = i.ticket_id
       LEFT JOIN assessments a ON a.ticket_id = i.ticket_id
       LEFT JOIN reviews r ON r.ticket_id = i.ticket_id
       WHERE i.run_id = ?
       ORDER BY i.updated_at DESC LIMIT 12`,
    )
    .all(runId) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    let categoryIds: string[] = [];
    try {
      const parsed = JSON.parse(String(row.categories_json ?? '[]')) as Array<{ categoryId?: string }>;
      categoryIds = parsed.map((category) => String(category.categoryId ?? '')).filter(Boolean);
    } catch {
      categoryIds = [];
    }
    return {
      ticketId: String(row.ticket_id),
      state: String(row.state),
      error: row.error ?? null,
      updatedAt: String(row.updated_at),
      opener: row.opener_username ?? null,
      reason: row.close_reason ?? null,
      reasonState: row.close_reason_state ?? 'unavailable',
      categories: categoryIds,
      fallback: Number(row.fallback) === 1,
      basePoints: row.base_points === null || row.base_points === undefined ? null : Number(row.base_points),
      awardedPoints:
        row.awarded_points === null || row.awarded_points === undefined ? null : Number(row.awarded_points),
      creditStatus: row.credit_status ?? null,
      reviewStatus: row.review_status ?? null,
    };
  });
}

function collectionCounts(db: Db): Record<string, number> {
  const rows = db.connection
    .prepare(
      `SELECT collection_status, COUNT(*) AS n FROM tickets WHERE is_demo = 0 GROUP BY collection_status`,
    )
    .all() as Array<Record<string, unknown>>;
  const result: Record<string, number> = {};
  for (const row of rows) result[String(row.collection_status)] = Number(row.n);
  return result;
}

function backupList(): Array<{ file: string; size: number; createdAt: string }> {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((file) => file.endsWith('.db'))
    .map((file) => {
      const stat = fs.statSync(path.join(BACKUP_DIR, file));
      return { file, size: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function setDownload(res: Response, filename: string, type: string, body: string): void {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(body);
}

function timestampForFile(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

export function createApiRouter(deps: {
  db: Db;
  connection: ConnectionManager;
  assessments: AssessmentService;
  collection: CollectionService;
}): Router {
  const { db, connection, assessments, collection } = deps;
  const router = express.Router();

  router.get('/health', (_req, res) => {
    res.json({ ok: true, version: APP_VERSION });
  });

  router.get('/taxonomy', (_req, res) => {
    const overrides = db.listTaxonomyOverrides();
    const unifiedRows = db.loadUnifiedTaxonomy();
    const categories = Object.values(unifiedRows).map((row) => ({
      id: row.id,
      code: row.code,
      label: row.label,
      labelAr: row.labelAr,
      description: row.description,
      points: overrides.find((o) => o.categoryId === row.id)?.points ?? row.points,
      distinction: row.distinction || undefined,
      examples: row.examples,
      negativeExamples: row.negativeExamples.length > 0 ? row.negativeExamples : undefined,
      isCustom: !row.isFixed,
    }));
    res.json({ version: TAXONOMY_VERSION, categories, overrides });
  });

  router.get('/taxonomy/categories', (_req, res) => {
    const rows = db.loadUnifiedTaxonomy();
    res.json({ categories: Object.values(rows) });
  });

  router.get('/taxonomy/overrides', (_req, res) => {
    res.json(db.listTaxonomyOverrides());
  });

  router.put(
    '/taxonomy/overrides/:categoryId',
    asyncRoute(async (req, res) => {
      const categoryId = String(req.params.categoryId);
      if (!isCategoryId(categoryId)) {
        throw new HttpError(400, 'INVALID_CATEGORY', 'Unknown fixed category ID.');
      }
      const points = Number(req.body?.points);
      if (!Number.isFinite(points) || points < 0) {
        throw new HttpError(400, 'INVALID_POINTS', 'Points must be a non-negative number.');
      }
      const note = typeof req.body?.note === 'string' ? req.body.note : '';
      db.setCategoryPoints(categoryId, points, note);
      res.json(db.listTaxonomyOverrides());
    }),
  );

  router.post(
    '/taxonomy/custom-categories',
    asyncRoute(async (req, res) => {
      const id = String(req.body?.id ?? '').trim();
      const code = String(req.body?.code ?? '').trim();
      const label = String(req.body?.label ?? '').trim();
      const labelAr = String(req.body?.labelAr ?? '').trim();
      const description = String(req.body?.description ?? '').trim();
      const points = Number(req.body?.points);
      if (!id || !code || !label || !labelAr || !description || !Number.isFinite(points) || points < 0) {
        throw new HttpError(400, 'INVALID_INPUT', 'All fields are required and points must be non-negative.');
      }
      db.addCustomCategory({
        id,
        code,
        label,
        labelAr,
        description,
        points,
        distinction: typeof req.body?.distinction === 'string' ? req.body.distinction : '',
        examples: Array.isArray(req.body?.examples) ? req.body.examples : [],
        negativeExamples: Array.isArray(req.body?.negativeExamples) ? req.body.negativeExamples : [],
      });
      res.json(db.listCustomCategories());
    }),
  );

  router.get('/taxonomy/custom-categories', (_req, res) => {
    res.json(db.listCustomCategories());
  });

  router.post(
    '/taxonomy/approved-reasons',
    asyncRoute(async (req, res) => {
      const text = String(req.body?.text ?? '').trim();
      const categoryId = String(req.body?.categoryId ?? '').trim();
      const customCategories = db.listCustomCategories();
      const validCustomIds = new Set(customCategories.map((cat) => cat.id));
      if (!text || !categoryId || (!isCategoryId(categoryId) && !validCustomIds.has(categoryId))) {
        throw new HttpError(400, 'INVALID_INPUT', 'Text and a valid categoryId are required.');
      }
      db.addApprovedReason({
        text,
        categoryId: categoryId as any,
        sourceType: typeof req.body?.sourceType === 'string' ? req.body.sourceType : 'manual',
        sourceTicketId: typeof req.body?.sourceTicketId === 'string' ? req.body.sourceTicketId : null,
      });
      res.json(db.listApprovedReasons());
    }),
  );

  router.get('/taxonomy/approved-reasons', (req, res) => {
    res.json(
      db.listApprovedReasons({
        categoryId: typeof req.query.categoryId === 'string' ? (req.query.categoryId as any) : undefined,
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
      }),
    );
  });

  router.get('/taxonomy/audit', (req, res) => {
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 20;
    res.json(db.listTaxonomyAudit(Number.isFinite(limit) ? Math.min(limit, 100) : 20));
  });

  router.delete('/taxonomy/custom-categories/:id', (req, res) => {
    const id = String(req.params.id);
    db.connection.prepare('UPDATE custom_categories SET active = 0 WHERE id = ?').run(id);
    res.json(db.listCustomCategories());
  });

  router.delete('/taxonomy/approved-reasons/:id', (req, res) => {
    const id = Number(req.params.id);
    db.connection.prepare('UPDATE approved_reasons SET active = 0 WHERE id = ?').run(id);
    res.json(db.listApprovedReasons());
  });

  router.get(
    '/status',
    asyncRoute(async (_req, res) => {
      const realOverview = db.overview(false, false);
      const demoOverview = db.overview(false, true);
      const settings = db.getSettings();
      const model = await getModelStatus(db);
      const connectionStatus = connection.status();
      const setup = [
        {
          id: 'database',
          label: 'Local database initialized',
          ready: fs.existsSync(DB_PATH),
          detail: DB_PATH,
        },
        {
          id: 'browser',
          label: 'Dedicated browser installed',
          ready: browserInstalled(),
          detail: browserInstalled()
            ? 'Playwright Chromium is available.'
            : 'Run "npx playwright install chromium" once.',
        },
        {
          id: 'connection',
          label: 'Tickets dashboard connected',
          ready: connectionStatus.state === 'authenticated',
          detail: connectionStatus.message,
        },
        {
          id: 'data',
          label: 'Tickets collected',
          ready: realOverview.totalTickets > 0,
          detail: `${realOverview.totalTickets.toLocaleString()} real ticket record(s) stored.`,
        },
      ];
      res.json({
        appVersion: APP_VERSION,
        taxonomyVersion: TAXONOMY_VERSION,
        classifierVersion: CLASSIFIER_VERSION,
        overview: realOverview,
        demoOverview,
        connection: connectionStatus,
        model,
        collectionCounts: collectionCounts(db),
        reviewCounts: reviewStatusCounts(db),
        setup,
        settings: {
          model: settings.model,
          semanticEnabled: settings.semanticEnabled,
          classificationEnabled: settings.classificationEnabled,
          dashboardUrl: settings.dashboardUrl,
          guildId: settings.guildId,
          autoReuseSession: settings.autoReuseSession,
        },
        latestRun: db.latestRun(),
        runs: db.listRuns(5),
      });
    }),
  );

  // ---- connection -------------------------------------------------------

  router.get('/connection', (_req, res) => {
    res.json(connection.status());
  });

  router.post(
    '/connection/connect',
    asyncRoute(async (_req, res) => {
      const status = await connection.connectForSignIn();
      res.json({ status });
    }),
  );

  router.post(
    '/connection/verify',
    asyncRoute(async (_req, res) => {
      const status = await connection.verify();
      res.json({ status });
    }),
  );

  router.post(
    '/connection/disconnect',
    asyncRoute(async (_req, res) => {
      res.json({ status: await connection.disconnect() });
    }),
  );

  router.post(
    '/connection/reset',
    asyncRoute(async (req, res) => {
      if (req.body?.confirm !== 'RESET') {
        throw new HttpError(
          400,
          'CONFIRMATION_REQUIRED',
          'Type RESET to confirm deleting the dedicated browser profile.',
        );
      }
      res.json({ status: await connection.resetProfile() });
    }),
  );

  // ---- collection -------------------------------------------------------

  router.post('/collection/preview', (req, res, next) => {
    try {
      const start = String(req.body?.start ?? '');
      const end = String(req.body?.end ?? '');
      const dateFrom = String(req.body?.dateFrom ?? '');
      const dateTo = String(req.body?.dateTo ?? '');
      const dateTimezone = String(req.body?.dateTimezone ?? '');
      const dateBasis = String(req.body?.dateBasis ?? '');
      let validation: RangeValidation;
      let dateValidation: DateRangeValidation | null = null;
      const hasDateRange = Boolean(dateFrom && dateTo);
      const hasIdRange = Boolean(start && end);

      if (hasDateRange && !hasIdRange) {
        dateValidation = validateDateRange(dateFrom, dateTo, dateTimezone, dateBasis);
        validation = dateValidation.ok
          ? {
              ok: true,
              plan: `Collect tickets whose confirmed closure timestamps fall within ${dateValidation.dateFromDisplay} to ${dateValidation.dateToDisplay} (${dateValidation.dateTimezone}, ${dateValidation.dateBasis}).`,
              warnings: dateValidation.warnings,
              count: 0,
            }
          : { ok: false, error: dateValidation.error ?? 'Invalid date range.' };
      } else if (hasIdRange) {
        validation = validateRange(start, end);
        if (hasDateRange) {
          dateValidation = validateDateRange(dateFrom, dateTo, dateTimezone, dateBasis);
          if (!dateValidation.ok) {
            validation = { ok: false, error: dateValidation.error ?? 'Invalid date range.' };
          } else if (validation.ok) {
            validation = {
              ...validation,
              plan: `Collect ticket IDs ${start}–${end} and filter the report to ${dateValidation.dateFromDisplay}–${dateValidation.dateToDisplay} (${dateValidation.dateTimezone}, ${dateValidation.dateBasis}).`,
            };
          }
        }
      } else {
        validation = { ok: false, error: 'Provide a ticket ID range or a date range.' };
      }
      res.json({
        ...validation,
        connection: connection.status(),
        currentRun: collection.getStatus().run,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    '/collection/start',
    asyncRoute(async (req, res) => {
      try {
        const run = await collection.start({
          start: String(req.body?.start ?? ''),
          end: String(req.body?.end ?? ''),
          classify: req.body?.classify === undefined ? db.getSettings().classificationEnabled : Boolean(req.body.classify),
          confirmLarge: Boolean(req.body?.confirmLarge),
          mode: req.body?.mode === 'incremental' ? 'incremental' : 'full',
          dateFrom: String(req.body?.dateFrom ?? '') || null,
          dateTo: String(req.body?.dateTo ?? '') || null,
          dateTimezone: String(req.body?.dateTimezone ?? '') || null,
          dateBasis: String(req.body?.dateBasis ?? '') || null,
        });
        res.status(202).json({ run });
      } catch (error) {
        const typed = error as Error & { code?: string; validation?: unknown; run?: unknown };
        if (typed.code === 'INVALID_RANGE') throw new HttpError(400, typed.code, typed.message, typed.validation);
        if (typed.code === 'LARGE_RANGE_REQUIRES_CONFIRMATION') {
          throw new HttpError(409, typed.code, typed.message, typed.validation);
        }
        if (typed.code === 'RUN_ALREADY_ACTIVE') {
          throw new HttpError(409, typed.code, typed.message, typed.run);
        }
        throw error;
      }
    }),
  );

  router.post('/collection/pause', (req, res, next) => {
    try {
      res.json({ run: collection.pause() });
    } catch (error) {
      const typed = error as Error & { code?: string };
      next(new HttpError(409, typed.code ?? 'PAUSE_FAILED', typed.message));
    }
  });

  router.post(
    '/collection/cancel',
    asyncRoute(async (_req, res) => {
      try {
        res.json({ run: await collection.cancel() });
      } catch (error) {
        const typed = error as Error & { code?: string };
        throw new HttpError(409, typed.code ?? 'CANCEL_FAILED', typed.message);
      }
    }),
  );

  router.post(
    '/collection/resume',
    asyncRoute(async (_req, res) => {
      try {
        res.json({ run: await collection.resume() });
      } catch (error) {
        const typed = error as Error & { code?: string };
        throw new HttpError(409, typed.code ?? 'RESUME_FAILED', typed.message);
      }
    }),
  );

  router.get('/collection/status', (_req, res) => {
    const status = collection.getStatus();
    res.json({
      ...status,
      recentItems: status.run ? recentRunItems(db, status.run.id) : [],
      counts: collectionCounts(db),
      latestRun: db.latestRun(),
      diagnostics: status.run ? db.getRunDiagnostics(status.run.id) : null,
    });
  });

  // ---- tickets ----------------------------------------------------------

  router.get('/tickets', (req, res) => {
    const demo = String(req.query.demo ?? '');
    const fallback =
      req.query.fallback === 'true' ? true : req.query.fallback === 'false' ? false : undefined;
    const result = db.listTickets({
      page: Number(req.query.page ?? 1),
      pageSize: Number(req.query.pageSize ?? 25),
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      staff: typeof req.query.staff === 'string' ? req.query.staff : undefined,
      category: typeof req.query.category === 'string' ? req.query.category : undefined,
      fallback,
      reviewStatus: typeof req.query.reviewStatus === 'string' ? req.query.reviewStatus : undefined,
      collectionStatus:
        typeof req.query.status === 'string' ? req.query.status : undefined,
      from: normalizeDateFilter(req.query.from, false),
      to: normalizeDateFilter(req.query.to, true),
      dateBasis: req.query.dateBasis === 'activity' ? 'activity' : 'opened',
      includeDemo: demo === '1' || demo === 'include',
      demoOnly: demo === 'only',
      sort: (req.query.sort as 'id' | 'collected' | 'base' | 'awarded' | 'reason') ?? 'id',
      dir: req.query.dir === 'asc' ? 'asc' : 'desc',
    });
    res.json({
      ...result,
      items: result.items.map((ticket) => sanitizeTicket(ticket, false)),
    });
  });

  router.get('/tickets/:ticketId', (req, res, next) => {
    const ticket = db.getTicket(String(req.params.ticketId));
    if (!ticket) {
      next(new HttpError(404, 'TICKET_NOT_FOUND', 'Ticket not found in the local database.'));
      return;
    }
    res.json({
      ticket: sanitizeTicket(ticket, true),
      history: db.listReviewHistory(ticket.ticketId),
      taxonomy: TAXONOMY,
    });
  });

  router.post(
    '/tickets/:ticketId/reassess',
    asyncRoute(async (req, res) => {
      try {
        await assessments.reassess(String(req.params.ticketId));
      } catch (error) {
        if ((error as Error).message === 'TICKET_NOT_FOUND') {
          throw new HttpError(404, 'TICKET_NOT_FOUND', 'Ticket not found in the local database.');
        }
        throw error;
      }
      const ticket = db.getTicket(String(req.params.ticketId))!;
      res.json({
        ticket: sanitizeTicket(ticket, true),
        history: db.listReviewHistory(ticket.ticketId),
      });
    }),
  );

  // ---- staff report -----------------------------------------------------

  router.get('/staff', (req, res) => {
    const report = buildStaffReport(db, {
      from: normalizeDateFilter(req.query.from, false),
      to: normalizeDateFilter(req.query.to, true),
      dateBasis: req.query.dateBasis === 'activity' ? 'activity' : 'opened',
      staff: typeof req.query.staff === 'string' ? req.query.staff : undefined,
      includeDemo: boolQuery(req.query.demo),
      demoOnly: req.query.demo === 'only',
    });
    res.json(report);
  });

  // ---- local assessment maintenance --------------------------------------

  router.post(
    '/assessments/rescore',
    asyncRoute(async (_req, res) => {
      const result = assessments.rescoreAll();
      res.json({
        ...result,
        message:
          `Rescored ${result.rescored.toLocaleString()} stored assessment(s) from their existing categories ` +
          `without contacting the dashboard or the classifier. ${result.changed} award(s) changed.`,
      });
    }),
  );

  router.post(
    '/assessments/reclassify',
    asyncRoute(async (_req, res) => {
      const result = await assessments.reclassifyStale();
      res.json({
        ...result,
        message:
          `Reclassified ${result.reclassified.toLocaleString()} ticket(s) whose assessment was missing or outdated. ` +
          `${result.failed} failed. Human corrections were preserved.`,
      });
    }),
  );

  // ---- reviews ----------------------------------------------------------

  router.get('/reviews', (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
    const includeDemo = boolQuery(req.query.demo);
    const demoOnly = req.query.demo === 'only';
    const search = typeof req.query.search === 'string' ? req.query.search.toLowerCase() : '';
    const category = typeof req.query.category === 'string' ? req.query.category : '';
    const fallbackOnly = req.query.fallback === 'true';
    let items = db.listReviews(status === 'all' ? undefined : status);
    if (demoOnly) items = items.filter((item) => item.ticket.isDemo);
    else if (!includeDemo) items = items.filter((item) => !item.ticket.isDemo);
    if (search) {
      items = items.filter((item) =>
        [
          item.ticketId,
          item.originalReason ?? '',
          item.claimedByName ?? '',
          item.closedByName ?? '',
          item.reasons.join(' '),
        ]
          .join(' ')
          .toLowerCase()
          .includes(search),
      );
    }
    if (category) {
      items = items.filter((item) =>
        item.categories.some((entry) => entry.categoryId === category),
      );
    }
    if (fallbackOnly) items = items.filter((item) => item.fallback);
    const summaries = items.map(serializeReview);
    res.json({
      items: summaries,
      total: summaries.length,      counts: reviewStatusCounts(db, demoOnly ? 'demo' : includeDemo ? 'all' : 'real'),
      filter: { status, search, category, fallback: fallbackOnly, includeDemo, demoOnly },
    });
  });

  router.get('/reviews/:ticketId', (req, res, next) => {
    const ticketId = String(req.params.ticketId);
    const review = db.getReview(ticketId);
    const ticket = db.getTicket(ticketId);
    if (!review || !ticket) {
      next(new HttpError(404, 'REVIEW_NOT_FOUND', 'Review item not found.'));
      return;
    }
    const summaries = db.listReviews('all').filter((item) => item.ticketId === ticketId);
    const summary = summaries[0];
    res.json({
      item: summary ? serializeReview(summary) : null,
      ticket: sanitizeTicket(ticket, true),
      history: db.listReviewHistory(ticketId),
    });
  });

  router.post(
    '/reviews/:ticketId/accept',
    asyncRoute(async (req, res) => {
      const ticketId = String(req.params.ticketId);
      try {
        const outcome = assessments.acceptReview(ticketId, req.body?.note ? String(req.body.note) : null);
        res.json({
          assessment: outcome.assessment,
          review: outcome.review,
          ticket: sanitizeTicket(db.getTicket(ticketId)!, true),
          history: db.listReviewHistory(ticketId),
          stillPending: outcome.review?.status === 'pending',
          message:
            outcome.review?.status === 'pending'
              ? 'Prediction accepted, but the item remains open because staff attribution is unresolved. Dismiss it with a note to acknowledge that outcome.'
              : 'Prediction accepted and the review item was resolved.',
        });
      } catch (error) {
        if ((error as Error).message === 'TICKET_NOT_FOUND') {
          throw new HttpError(404, 'REVIEW_NOT_FOUND', 'Review item not found.');
        }
        throw error;
      }
    }),
  );

  router.post(
    '/reviews/:ticketId/correct',
    asyncRoute(async (req, res) => {
      const categoryIds = Array.isArray(req.body?.categoryIds)
        ? req.body.categoryIds.map((value: unknown) => String(value))
        : [];
      try {
        const outcome = await assessments.correctAssessment({
          ticketId: String(req.params.ticketId),
          categoryIds,
          note: req.body?.note ? String(req.body.note) : null,
          approveAlias: Boolean(req.body?.approveAlias),
        });
        res.json({
          assessment: outcome.assessment,
          review: outcome.review,
          ticket: sanitizeTicket(outcome.ticket, true),
          history: db.listReviewHistory(outcome.ticket.ticketId),
          aliasConflict: outcome.aliasConflict,
          reviewResolved: outcome.reviewResolved,
          message: outcome.reviewResolved
            ? 'Correction saved and the review item was resolved.'
            : 'Correction saved, but the item remains open because staff attribution is unresolved.',
        });
      } catch (error) {
        const message = (error as Error).message;
        if (message === 'TICKET_NOT_FOUND') throw new HttpError(404, 'TICKET_NOT_FOUND', 'Review item not found.');
        if (message === 'UNKNOWN_CATEGORY') throw new HttpError(400, message, 'One of the selected categories is not in the fixed taxonomy.');
        if (message === 'CATEGORY_REQUIRED') throw new HttpError(400, message, 'Select at least one category for a nonempty closing reason.');
        if (message === 'EMPTY_REASON_CANNOT_HAVE_CATEGORY') {
          throw new HttpError(400, message, 'An empty closing reason cannot be assigned scored categories.');
        }
        throw error;
      }
    }),
  );

  router.post(
    '/reviews/:ticketId/dismiss',
    asyncRoute(async (req, res) => {
      try {
        const outcome = assessments.dismissReview(
          String(req.params.ticketId),
          req.body?.note ? String(req.body.note) : null,
        );
        res.json({
          review: outcome.review,
          ticket: sanitizeTicket(outcome.ticket, true),
          history: db.listReviewHistory(outcome.ticket.ticketId),
          message: 'Review item dismissed and archived in the correction history.',
        });
      } catch (error) {
        if ((error as Error).message === 'TICKET_NOT_FOUND') {
          throw new HttpError(404, 'REVIEW_NOT_FOUND', 'Review item not found.');
        }
        throw error;
      }
    }),
  );

  router.post(
    '/reviews/:ticketId/reassess',
    asyncRoute(async (req, res) => {
      const ticketId = String(req.params.ticketId);
      try {
        await assessments.reassess(ticketId);
      } catch (error) {
        if ((error as Error).message === 'TICKET_NOT_FOUND') {
          throw new HttpError(404, 'TICKET_NOT_FOUND', 'Review item not found.');
        }
        throw error;
      }
      const ticket = db.getTicket(ticketId)!;
      res.json({
        ticket: sanitizeTicket(ticket, true),
        history: db.listReviewHistory(ticketId),
        message: 'Ticket reassessed.',
      });
    }),
  );

  // ---- exports ----------------------------------------------------------

  router.get('/export/tickets', (req, res) => {
    const options = {
      includeDemo: boolQuery(req.query.demo),
      demoOnly: req.query.demo === 'only',
      from: normalizeDateFilter(req.query.from, false),
      to: normalizeDateFilter(req.query.to, true),
      dateBasis: req.query.dateBasis === 'activity' ? 'activity' : 'opened',
      staff: typeof req.query.staff === 'string' ? req.query.staff : undefined,
    } as const;
    const format = req.query.format === 'csv' ? 'csv' : 'json';
    if (format === 'csv') {
      setDownload(
        res,
        `tickets-${timestampForFile()}.csv`,
        'text/csv; charset=utf-8',
        ticketExportCsv(db, options),
      );
      return;
    }
    setDownload(
      res,
      `tickets-${timestampForFile()}.json`,
      'application/json; charset=utf-8',
      JSON.stringify(buildTicketExport(db, options), null, 2),
    );
  });

  router.get('/export/staff', (req, res) => {
    const filters = {
      includeDemo: boolQuery(req.query.demo),
      demoOnly: req.query.demo === 'only',
      from: normalizeDateFilter(req.query.from, false),
      to: normalizeDateFilter(req.query.to, true),
      dateBasis: req.query.dateBasis === 'activity' ? 'activity' : 'opened',
      staff: typeof req.query.staff === 'string' ? req.query.staff : undefined,
    } as const;
    const format = req.query.format === 'csv' ? 'csv' : 'json';
    if (format === 'csv') {
      setDownload(
        res,
        `staff-report-${timestampForFile()}.csv`,
        'text/csv; charset=utf-8',
        staffExportCsv(db, filters),
      );
      return;
    }
    setDownload(
      res,
      `staff-report-${timestampForFile()}.json`,
      'application/json; charset=utf-8',
      JSON.stringify(buildStaffExport(db, filters), null, 2),
    );
  });

  router.get('/export/reviews', (req, res) => {
    const options = {
      status: typeof req.query.status === 'string' ? req.query.status : 'pending',
      includeDemo: boolQuery(req.query.demo),
      demoOnly: req.query.demo === 'only',
    };
    const format = req.query.format === 'csv' ? 'csv' : 'json';
    if (format === 'csv') {
      setDownload(
        res,
        `review-queue-${timestampForFile()}.csv`,
        'text/csv; charset=utf-8',
        reviewExportCsv(db, options),
      );
      return;
    }
    setDownload(
      res,
      `review-queue-${timestampForFile()}.json`,
      'application/json; charset=utf-8',
      JSON.stringify(buildReviewExport(db, options), null, 2),
    );
  });

  // ---- settings and model ----------------------------------------------

  router.get('/settings', (_req, res) => {
    res.json({
      settings: db.getSettings(),
      meta: {
        appVersion: APP_VERSION,
        taxonomyVersion: TAXONOMY_VERSION,
        classifierVersion: CLASSIFIER_VERSION,
        dataDir: DATA_DIR,
        dbPath: DB_PATH,
        profileDir: PROFILE_DIR,
        backupDir: BACKUP_DIR,
        exportDir: EXPORT_DIR,
        browserInstalled: browserInstalled(),
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        taxonomy: TAXONOMY,
      },
    });
  });

  router.put(
    '/settings',
    asyncRoute(async (req, res) => {
      const input = req.body ?? {};
      const allowed: Array<keyof AppSettings> = [
        'dashboardUrl',
        'guildId',
        'ollamaUrl',
        'model',
        'modelTimeoutMs',
        'semanticEnabled',
        'fuzzyThreshold',
        'requestDelayMs',
        'classificationEnabled',
        'autoReuseSession',
        'maxRetries',
        'navigationTimeoutMs',
        'fetchConcurrency',
        'cloudProviderUrl',
        'cloudApiKey',
        'cloudModel',
        'cloudTimeoutMs',
      ];
      const patch: Partial<AppSettings> = {};
      for (const key of allowed) {
        if (key in input) (patch as Record<string, unknown>)[key] = input[key];
      }
      if (Object.keys(patch).length === 0) {
        throw new HttpError(400, 'NO_SETTINGS', 'No recognized settings were provided.');
      }
      if (patch.model !== undefined && !String(patch.model).trim()) {
        throw new HttpError(400, 'INVALID_MODEL', 'Select a model name or enter one explicitly.');
      }
      let settings: AppSettings;
      try {
        settings = db.saveSettings(patch);
      } catch (error) {
        throw new HttpError(400, 'INVALID_SETTINGS', (error as Error).message);
      }
      modelCache = null;
      log('info', 'settings.updated', { keys: Object.keys(patch) });
      res.json({ settings, message: 'Settings saved.' });
    }),
  );

  router.get(
    '/model',
    asyncRoute(async (req, res) => {
      res.json(await getModelStatus(db, boolQuery(req.query.force)));
    }),
  );

  router.post(
    '/model/detect',
    asyncRoute(async (_req, res) => {
      res.json(await getModelStatus(db, true));
    }),
  );

  router.post(
    '/model/test',
    asyncRoute(async (_req, res) => {
      const settings = db.getSettings();
      const client = new OllamaClient(settings.ollamaUrl, settings.model);
      const result = await client.selfTest();
      res.json({
        ...result,
        status: await getModelStatus(db, true),
      });
    }),
  );

  // ---- backups ----------------------------------------------------------

  router.get('/backups', (_req, res) => {
    res.json({ backups: backupList(), backupDir: BACKUP_DIR });
  });

  router.post(
    '/backups',
    asyncRoute(async (_req, res) => {
      const filename = `ticketsmanage-${timestampForFile()}.db`;
      const target = path.join(BACKUP_DIR, filename);
      db.backupTo(target);
      res.json({ backup: { file: filename, size: fs.statSync(target).size, createdAt: new Date().toISOString() } });
    }),
  );

  router.post(
    '/backups/restore',
    asyncRoute(async (req, res) => {
      if (req.body?.confirm !== 'RESTORE') {
        throw new HttpError(400, 'CONFIRMATION_REQUIRED', 'Type RESTORE to confirm replacing local data.');
      }
      if (collection.getStatus().active) {
        throw new HttpError(409, 'COLLECTION_ACTIVE', 'Cancel or finish the active collection before restoring a backup.');
      }
      const requested = path.basename(String(req.body?.file ?? ''));
      const target = path.join(BACKUP_DIR, requested);
      if (!requested.endsWith('.db') || !fileInside(BACKUP_DIR, target) || !fs.existsSync(target)) {
        throw new HttpError(400, 'BACKUP_NOT_FOUND', 'That backup file was not found in the backup directory.');
      }
      try {
        db.restoreFrom(target);
      } catch (error) {
        throw new HttpError(400, 'RESTORE_FAILED', `The backup could not be restored: ${(error as Error).message}`);
      }
      modelCache = null;
      res.json({
        message:
          'Backup restored. The local database was reopened. Verify the dashboard connection and review settings; the browser profile was not changed.',
      });
    }),
  );

  // ---- diagnostics ------------------------------------------------------

  router.get(
    '/diagnostics',
    asyncRoute(async (req, res) => {
      const model = await getModelStatus(db);
      const diagnostics = {
        generatedAt: new Date().toISOString(),
        app: {
          version: APP_VERSION,
          taxonomyVersion: TAXONOMY_VERSION,
          classifierVersion: CLASSIFIER_VERSION,
        },
        runtime: {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          cpus: os.cpus().length,
          totalMemoryGb: Math.round((os.totalmem() / 1e9) * 10) / 10,
          freeMemoryGb: Math.round((os.freemem() / 1e9) * 10) / 10,
        },
        paths: {
          dataDir: DATA_DIR,
          dbPath: DB_PATH,
          profileDir: PROFILE_DIR,
          backupDir: BACKUP_DIR,
          exportDir: EXPORT_DIR,
        },
        database: {
          counts: db.overview(true, false),
          collectionCounts: collectionCounts(db),
          reviewCounts: reviewStatusCounts(db),
          latestRun: db.latestRun(),
          backups: backupList().length,
        },
        connection: connection.status(),
        model: {
          running: model.running,
          version: model.version,
          baseUrl: model.baseUrl,
          selectedModel: model.selectedModel,
          selectedInstalled: model.selectedInstalled,
          localModels: model.localModels,
          error: model.error,
        },
        browserInstalled: browserInstalled(),
        logs: recentLogs(150),
        note: 'Diagnostics contain no ticket transcripts, closing reasons, cookies, passwords, browser tokens, or authorization headers.',
      };
      if (boolQuery(req.query.download)) {
        setDownload(
          res,
          `ticketsmanage-diagnostics-${timestampForFile()}.json`,
          'application/json; charset=utf-8',
          JSON.stringify(diagnostics, null, 2),
        );
        return;
      }
      res.json(diagnostics);
    }),
  );

  // ---- demo -------------------------------------------------------------

  router.post(
    '/demo/seed',
    asyncRoute(async (_req, res) => {
      if (collection.getStatus().active) {
        throw new HttpError(409, 'COLLECTION_ACTIVE', 'Finish or cancel the active collection before seeding demo data.');
      }
      const result = await seedDemoData(db);
      res.json({
        ...result,
        message:
          'Synthetic demo records were created with IDs starting at 9000001 and are excluded from real metrics unless demo data is shown.',
      });
    }),
  );

  router.post('/demo/clear', (_req, res) => {
    const removed = db.clearDemoData();
    res.json({ removed, message: `Removed ${removed} synthetic demo record(s).` });
  });

  // ---- reset roster -----------------------------------------------------

  router.get('/reset/preview', (_req, res) => {
    const counts = db.getResetPreview();
    res.json({
      counts,
      preserved: {
        settings: true,
        taxonomy: true,
        approvedAliases: true,
        taxonomyOverrides: true,
        customCategories: true,
        approvedReasons: true,
        taxonomyAuditLog: true,
        browserProfile: true,
        dashboardAuth: true,
      },
      message: 'Reset clears collected tickets, transcripts, assessments, reviews, runs and cached outputs. Settings, taxonomy, approved aliases, approved reasons, custom categories, and audit history are preserved.',
    });
  });

  router.post('/reset/roster', asyncRoute(async (req, res) => {
    if (collection.getStatus().active) {
      throw new HttpError(409, 'COLLECTION_ACTIVE', 'Finish or cancel the active collection before resetting the roster.');
    }
    const body = (req.body as Record<string, unknown>) ?? {};
    const confirm = String(body.confirm ?? '');
    if (confirm !== 'RESET ROSTER') {
      throw new HttpError(400, 'CONFIRMATION_REQUIRED', 'Type RESET ROSTER to confirm the operation.');
    }
    const timestamp = timestampForFile();
    const backupPath = path.join(BACKUP_DIR, `roster-reset-backup-${timestamp}.db`);
    try {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      db.backupTo(backupPath);
      Db.validateBackup(backupPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Backup failed';
      throw new HttpError(500, 'BACKUP_FAILED', `Could not create a verified backup before reset: ${message}`);
    }
    try {
      db.resetRoster();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Reset failed';
      throw new HttpError(500, 'RESET_FAILED', `Reset failed: ${message}`);
    }
    res.json({
      ok: true,
      backupPath,
      backupFile: path.basename(backupPath),
      message: 'Roster reset complete. Tickets, transcripts, assessments, reviews and runs cleared. Settings, taxonomy, approved aliases, approved reasons, custom categories, and audit history are preserved.',
      audit: { action: 'roster_reset', at: new Date().toISOString() },
    });
  }));

  // ---- AI ---------------------------------------------------------------

  router.get('/ai/status', asyncRoute(async (_req, res) => {
    const settings = db.getSettings();
    const client = new OllamaClient(settings.ollamaUrl, settings.model);
    const status = await client.status();
    res.json({
      aiMode: settings.aiMode ?? 'deterministic',
      semanticEnabled: settings.semanticEnabled,
      model: settings.model,
      ollamaUrl: settings.ollamaUrl,
      runtime: status,
      classificationEnabled: settings.classificationEnabled,
    });
  }));

  router.post('/ai/test', asyncRoute(async (_req, res) => {
    const settings = db.getSettings();
    const client = new OllamaClient(settings.ollamaUrl, settings.model);
    const result = await client.selfTest();
    res.json(result);
  }));

  router.post('/ai/sample', asyncRoute(async (req, res) => {
    const settings = db.getSettings();
    const body = (req.body as Record<string, unknown>) ?? {};
    const reason = String(body.reason ?? 'Player needs help with account recovery');
    const client = new OllamaClient(settings.ollamaUrl, settings.model);
    const result = await client.classifyReason(reason, settings.modelTimeoutMs);
    res.json({ reason, result });
  }));

  router.post('/cloud/free-models', asyncRoute(async (_req, res) => {
    const rows = db.connection.prepare("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
    const stored = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    const apiKey = stored.cloudApiKey?.trim();
    const baseUrl = stored.cloudProviderUrl?.trim() || 'https://openrouter.ai/api/v1';
    if (!apiKey) {
      throw new HttpError(400, 'MISSING_API_KEY', 'Set the cloud provider API key in Settings first.');
    }
    const url = new URL('/v1/models', baseUrl);
    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      throw new HttpError(502, 'UPSTREAM_ERROR', `OpenRouter responded ${response.status}`);
    }
    const payload = (await response.json()) as Record<string, unknown>;
    const models = Array.isArray((payload.data as Array<Record<string, unknown>>) ?? [])
      ? (payload.data as Array<Record<string, unknown>>)
      : [];
    const free = models
      .filter((model) => {
        const pricing = model.pricing as Record<string, string> | undefined;
        return (
          pricing?.prompt === '0' &&
          pricing?.completion === '0' &&
          typeof model.id === 'string'
        );
      })
      .map((model) => String(model.id));
    res.json({ models: free });
  }));

  router.post('/ai/mode', asyncRoute(async (req, res) => {
    const body = (req.body as Record<string, unknown>) ?? {};
    const aiMode = body.aiMode;
    if (aiMode !== 'deterministic' && aiMode !== 'shadow' && aiMode !== 'production') {
      throw new HttpError(400, 'INVALID_AI_MODE', 'aiMode must be deterministic, shadow, or production');
    }
    const settings = db.saveSettings({ aiMode } as Partial<AppSettings>);
    res.json({ ok: true, aiMode: settings.aiMode });
  }));

  router.use((req: Request, _res: Response, next: NextFunction) => {
    next(new HttpError(404, 'API_NOT_FOUND', `No API route for ${req.method} ${req.path}`));
  });

  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) {
      res.status(error.status).json({
        error: { code: error.code, message: error.message, details: error.details ?? null },
      });
      return;
    }
    const message = error instanceof Error ? error.message : 'Unexpected server error';
    log('error', 'api.unhandled', { message: message.slice(0, 400) });
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The local application could not complete that request. Check diagnostics for details.',
      },
    });
  });

  return router;
}

function fileInside(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function localOriginGuard(req: Request, res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    next();
    return;
  }
  const origin = req.get('origin');
  if (origin && origin !== 'null') {
    try {
      const parsed = new URL(origin);
      const local =
        (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
        (parsed.protocol === 'http:' || parsed.protocol === 'https:');
      if (!local) {
        res.status(403).json({
          error: {
            code: 'CROSS_ORIGIN_BLOCKED',
            message: 'Mutating requests are only accepted from the local TicketsManage UI.',
          },
        });
        return;
      }
    } catch {
      res.status(403).json({ error: { code: 'CROSS_ORIGIN_BLOCKED', message: 'Invalid origin.' } });
      return;
    }
  }
  next();
}
