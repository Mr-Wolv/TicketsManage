import crypto from 'node:crypto';
import type { Db } from './db.js';
import { CLASSIFIER_VERSION, LARGE_RANGE_THRESHOLD, MAX_RANGE_SIZE } from './config.js';
import type { ConnectionManager } from './connection.js';
import { ConnectionError } from './connection.js';
import type { AssessmentService } from './assessment-service.js';
import {
  AuthRequiredError,
  DashboardExtractor,
  RateLimitedError,
  StructureChangedError,
  describeExtractionError,
  logExtraction,
} from './collector.js';
import { log } from './logger.js';
import type {
  CollectionRunDiagnostics,
  CollectionRunRecord,
  CollectionStatus,
  TicketMetadata,
  TicketRecord,
} from './types.js';
import type { ExtractionOutcome, ListingRange } from './collector.js';

type CollectedItem =
  | { kind: 'not_found'; id: string }
  | { kind: 'failure'; id: string; message: string; structure: boolean }
  | {
      kind: 'reuse';
      id: string;
      metadata: TicketMetadata | null;
      metadataChanged: boolean;
      noTranscript: boolean;
    }
  | { kind: 'outcome'; id: string; outcome: ExtractionOutcome };

function rowHasTranscript(row: Record<string, unknown>): boolean {
  const key = Object.keys(row).find((name) => name.toLowerCase() === 'has_transcript');
  return key ? row[key] !== false : true;
}

export interface RangeValidation {
  ok: boolean;
  error?: string;
  startId?: string;
  endId?: string;
  count?: number;
  estimatedRequests?: number;
  large?: boolean;
  requiresConfirmation?: boolean;
  warnings?: string[];
  plan?: string;
}

export function validateRange(startInput: string, endInput: string): RangeValidation {
  const startId = String(startInput ?? '').trim();
  const endId = String(endInput ?? '').trim();
  if (!/^\d+$/.test(startId) || !/^\d+$/.test(endId)) {
    return { ok: false, error: 'Ticket IDs must contain digits only. They are kept as strings.' };
  }
  if (startId.length > 1 && startId.startsWith('0')) {
    return { ok: false, error: 'The starting ticket ID has leading zeros, which would make it ambiguous.' };
  }
  if (endId.length > 1 && endId.startsWith('0')) {
    return { ok: false, error: 'The ending ticket ID has leading zeros, which would make it ambiguous.' };
  }
  let start: bigint;
  let end: bigint;
  try {
    start = BigInt(startId);
    end = BigInt(endId);
  } catch {
    return { ok: false, error: 'The ticket ID range is not a valid integer range.' };
  }
  if (start > end) {
    return { ok: false, error: 'The starting ticket ID must be less than or equal to the ending ID.' };
  }
  const countBig = end - start + 1n;
  if (countBig > BigInt(MAX_RANGE_SIZE)) {
    return {
      ok: false,
      error: `The requested range contains more than ${MAX_RANGE_SIZE.toLocaleString()} IDs. Split it into smaller runs.`,
    };
  }
  const count = Number(countBig);
  const large = count > LARGE_RANGE_THRESHOLD;
  return {
    ok: true,
    startId,
    endId,
    count,
    estimatedRequests: count * 2,
    large,
    requiresConfirmation: large,
    warnings: [
      ...(large
        ? [
            `This inclusive range contains ${count.toLocaleString()} ticket IDs. The collector verifies each ID against the dashboard and may make up to ${(count * 2).toLocaleString()} requests.`,
          ]
        : []),
      'Ticket IDs that do not exist are recorded as not found and are never invented.',
      'Collection is read-only and can be paused; progress is checkpointed.',
    ],
    plan: `Search the Transcripts page for each ID from ${startId} to ${endId}, capture each ticket row, then open its transcript view when one exists.`,
  };
}

type CollectionMode = 'incremental' | 'full';

interface ActiveRun {
  record: CollectionRunRecord;
  mode: CollectionMode;
  pauseRequested: boolean;
  cancelRequested: boolean;
  loopRunning: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class CollectionService {
  private active: ActiveRun | null = null;

  constructor(
    private readonly db: Db,
    private readonly connection: ConnectionManager,
    private readonly assessments: AssessmentService,
  ) {}

  getStatus(): {
    run: CollectionRunRecord | null;
    active: boolean;
    connection: ReturnType<ConnectionManager['status']>;
  } {
    const run = this.active?.record ?? this.db.latestRun();
    return {
      run,
      active: Boolean(this.active),
      connection: this.connection.status(),
    };
  }

  async start(input: {
    start: string;
    end: string;
    classify: boolean;
    confirmLarge: boolean;
    mode?: CollectionMode;
  }): Promise<CollectionRunRecord> {
    const hasIdRange = Boolean(input.start && input.end);
    const requestedMode = input.mode === 'incremental' ? 'incremental' : 'full';

    if (!hasIdRange) {
      throw Object.assign(new Error('Provide a ticket ID range.'), { code: 'INVALID_RANGE' });
    }

    const validation = validateRange(input.start, input.end);
    if (!validation.ok || !validation.startId || !validation.endId || validation.count === undefined) {
      throw Object.assign(new Error(validation.error ?? 'Invalid range'), { code: 'INVALID_RANGE' });
    }
    if (validation.requiresConfirmation && !input.confirmLarge) {
      throw Object.assign(
        new Error(
          `This range contains ${validation.count.toLocaleString()} ticket IDs. Confirm the large-range warning before starting.`,
        ),
        { code: 'LARGE_RANGE_REQUIRES_CONFIRMATION', validation },
      );
    }

    const latest = this.db.latestRun();
    const current = this.active?.record ?? (latest?.status === 'paused' ? latest : null);
    if (current && (current.status === 'running' || current.status === 'paused')) {
      throw Object.assign(
        new Error(
          'Another collection run is active or paused. Resume or cancel it before starting a new range.',
        ),
        { code: 'RUN_ALREADY_ACTIVE', run: current },
      );
    }

    const runId = crypto.randomUUID();
    const mode = requestedMode;
    const record = this.db.createRun({
      id: runId,
      startId: validation.startId,
      endId: validation.endId,
      mode,
      requestedCount: validation.count,
      classificationEnabled: input.classify,
    });
    const active: ActiveRun = {
      record,
      mode,
      pauseRequested: false,
      cancelRequested: false,
      loopRunning: false,
    };
    this.active = active;
    void this.startLoop(active);
    return record;
  }
  async startManualIds(input: { ids: string[]; classify: boolean; mode?: CollectionMode }): Promise<CollectionRunRecord> {
    const requestedMode = input.mode === 'incremental' ? 'incremental' : 'full';
    const ids = Array.from(
      new Set(input.ids.map((value) => String(value).trim()).filter((value) => /^\d+$/.test(value))),
    ).sort((a, b) => Number(BigInt(a) - BigInt(b)));

    if (ids.length === 0) {
      throw Object.assign(new Error('Provide at least one numeric ticket ID.'), { code: 'INVALID_RANGE' });
    }

    const latest = this.db.latestRun();
    const current = this.active?.record ?? (latest?.status === 'paused' ? latest : null);
    if (current && (current.status === 'running' || current.status === 'paused')) {
      throw Object.assign(
        new Error(
          'Another collection run is active or paused. Resume or cancel it before starting a new run.',
        ),
        { code: 'RUN_ALREADY_ACTIVE', run: current },
      );
    }

    const runId = crypto.randomUUID();
    const mode = requestedMode;
    const record = this.db.createRun({
      id: runId,
      startId: ids[0]!,
      endId: ids[ids.length - 1]!,
      mode,
      requestedCount: ids.length,
      classificationEnabled: input.classify,
    });
    const active: ActiveRun = {
      record,
      mode,
      pauseRequested: false,
      cancelRequested: false,
      loopRunning: false,
    };
    this.active = active;
    void this.startManualLoop(active, ids);
    return record;
  }

  private async startManualLoop(active: ActiveRun, ids: string[]): Promise<void> {
    if (active.loopRunning) return;
    active.loopRunning = true;
    try {
      const diagnostics = this.diagnosticsFor(active);
      diagnostics.notes.push(`Manual ID collection: ${ids.length} ticket ID(s).`);
      const loopStarted = Date.now();
      this.update(active, { status: 'running', stage: 'connecting', errorCode: null, errorMessage: null });
      let page;
      try {
        page = await this.connection.ensureAuthenticated();
      } catch (error) {
        const message = error instanceof ConnectionError ? error.message : 'The Tickets dashboard connection is not ready.';
        this.update(active, {
          status: 'paused',
          stage: 'waiting_for_connection',
          errorCode: 'CONNECTION_REQUIRED',
          errorMessage: message,
        });
        return;
      }
      const settings = this.db.getSettings();
      const extractor = new DashboardExtractor(this.db, page, this.connection.getApiAccess(), (notice) => {
        this.update(active, {
          stage: 'rate_limit_cooldown',
          errorCode: 'RATE_LIMIT_COOLDOWN',
          errorMessage: `The dashboard asked for a pause. Waiting ${notice.seconds}s before retrying; completed tickets are kept.`,
        });
      });
      const concurrency = Math.min(6, Math.max(1, settings.fetchConcurrency || 1));
      for (let index = 0; index < ids.length; index += concurrency) {
        if (active.cancelRequested) {
          diagnostics.timings.totalMs = Date.now() - loopStarted;
          this.saveDiagnostics(active, diagnostics);
          this.finish(active, 'cancelled', 'cancelled');
          return;
        }
        if (active.pauseRequested) {
          diagnostics.timings.totalMs = Date.now() - loopStarted;
          this.saveDiagnostics(active, diagnostics);
          this.update(active, { status: 'paused', stage: 'paused', currentTicketId: null });
          return;
        }
        const batch = ids.slice(index, index + concurrency);
        this.update(active, {
          status: 'running',
          stage: 'extracting',
          currentTicketId: batch[0] ?? null,
          errorCode: null,
          errorMessage: null,
        });
        const items = await Promise.all(
          batch.map((ticketId) => this.collectOne(active, extractor, null, ticketId, diagnostics)),
        );
        for (const item of items) {
          if (active.cancelRequested) {
            diagnostics.timings.totalMs = Date.now() - loopStarted;
            this.saveDiagnostics(active, diagnostics);
            this.finish(active, 'cancelled', 'cancelled');
            return;
          }
          if (active.pauseRequested) {
            diagnostics.timings.totalMs = Date.now() - loopStarted;
            this.saveDiagnostics(active, diagnostics);
            this.update(active, { status: 'paused', stage: 'paused', currentTicketId: null });
            return;
          }
          const result = await this.applyItem(active, item, diagnostics);
          if (!result.ok && result.structure) {
            this.connection.reportDataProblem(
              'unexpected_page',
              'The dashboard did not return the expected transcript data during manual ID collection.',
            );
          }
        }
      }
      diagnostics.timings.totalMs = Date.now() - loopStarted;
      this.saveDiagnostics(active, diagnostics);
      const stats = this.refreshStats(active);
      this.finish(active, stats.failed > 0 ? 'completed_with_errors' : 'completed', 'finished');
      void this.runCloudReviewAfterCollection();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.updateRun(active.record.id, {
        status: 'paused',
        stage: 'paused',
        errorCode: 'FATAL_RUN_ERROR',
        errorMessage: message,
      });
      active.record.status = 'paused';
      active.record.stage = 'paused';
      active.record.errorCode = 'FATAL_RUN_ERROR';
      active.record.errorMessage = message;
      log('error', 'collection.manual_fatal', { runId: active.record.id, message });
    } finally {
      active.loopRunning = false;
    }
  }

  pause(): CollectionRunRecord {
    if (!this.active || !['running', 'paused'].includes(this.active.record.status)) {
      throw Object.assign(new Error('There is no active collection run to pause.'), {
        code: 'NO_ACTIVE_RUN',
      });
    }
    if (this.active.record.status === 'running') {
      this.active.pauseRequested = true;
      this.db.updateRun(this.active.record.id, {
        stage: 'pausing',
        currentTicketId: this.active.record.currentTicketId,
      });
      this.active.record.stage = 'pausing';
    }
    return this.active.record;
  }

  async cancel(): Promise<CollectionRunRecord> {
    if (!this.active) {
      const latest = this.db.latestRun();
      if (!latest || latest.status !== 'paused') {
        throw Object.assign(new Error('There is no run to cancel.'), { code: 'NO_ACTIVE_RUN' });
      }
      this.db.updateRun(latest.id, {
        status: 'cancelled',
        stage: 'cancelled',
        finishedAt: new Date().toISOString(),
      });
      return this.db.getRun(latest.id)!;
    }
    const record = this.active.record;
    this.active.cancelRequested = true;
    if (!this.active.loopRunning) {
      this.finish(this.active, 'cancelled', 'cancelled');
    }
    return record;
  }

  async resume(): Promise<CollectionRunRecord> {
    let active = this.active;
    if (!active) {
      const latest = this.db.latestRun();
      if (!latest || latest.status !== 'paused') {
        throw Object.assign(new Error('There is no paused run to resume.'), {
          code: 'NO_PAUSED_RUN',
        });
      }
      active = {
        record: latest,
        // Resume the mode the run was created with. Before this was persisted,
        // a paused incremental sync silently restarted as a full refresh.
        mode: latest.mode,
        pauseRequested: false,
        cancelRequested: false,
        loopRunning: false,
      };
      this.active = active;
    }
    if (active.loopRunning) {
      active.pauseRequested = false;
      active.cancelRequested = false;
      this.db.updateRun(active.record.id, { status: 'running', stage: 'resuming', errorCode: null, errorMessage: null });
      active.record.status = 'running';
      active.record.stage = 'resuming';
      // If the loop was just exiting after a pause, restart it once it unwinds.
      setTimeout(() => {
        if (this.active === active && !active.loopRunning && active.record.status === 'running') {
          void this.startLoop(active);
        }
      }, 100);
      return active.record;
    }
    if (active.record.status === 'running' && active.pauseRequested) {
      active.pauseRequested = false;
      return active.record;
    }
    active.pauseRequested = false;
    active.cancelRequested = false;
    this.db.updateRun(active.record.id, {
      status: 'running',
      stage: 'resuming',
      errorCode: null,
      errorMessage: null,
      finishedAt: null,
    });
    active.record.status = 'running';
    active.record.stage = 'resuming';
    active.record.errorCode = null;
    active.record.errorMessage = null;
    active.record.finishedAt = null;
    void this.startLoop(active);
    return active.record;
  }

  recoverAfterRestart(): void {
    const latest = this.db.latestRun();
    if (latest && latest.status === 'running') {
      this.db.updateRun(latest.id, {
        status: 'paused',
        stage: 'paused',
        errorCode: 'APP_RESTARTED',
        errorMessage:
          'The application restarted during this run. Progress was checkpointed; select Resume to continue.',
      });
      log('info', 'collection.recovered', { runId: latest.id });
    }
  }

  private async startLoop(active: ActiveRun): Promise<void> {
    if (active.loopRunning) return;
    active.loopRunning = true;
    try {
      await this.loop(active);
    } catch (error) {
      const message = describeExtractionError(error);
      this.db.updateRun(active.record.id, {
        status: 'paused',
        stage: 'paused',
        errorCode: 'FATAL_RUN_ERROR',
        errorMessage: message,
      });
      active.record.status = 'paused';
      active.record.stage = 'paused';
      active.record.errorCode = 'FATAL_RUN_ERROR';
      active.record.errorMessage = message;
      log('error', 'collection.fatal', {
        runId: active.record.id,
        message,
        name: error instanceof Error ? error.name : typeof error,
        detail: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        code:
          error && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code).slice(0, 80)
            : null,
        stack: error instanceof Error ? error.stack?.slice(0, 2000) ?? null : null,
      });
    } finally {
      active.loopRunning = false;
    }
  }

  private diagnosticsFor(active: ActiveRun): CollectionRunDiagnostics {
    return {
      mode: active.mode,
      timings: {},
      counts: {
        reused: 0,
        fetchedTranscripts: 0,
        directRequests: 0,
        navigationRequests: 0,
        listingPages: 0,
        modelCalls: 0,
        retries: 0,
        failures: 0,
        notFound: 0,
      },
      perTicket: { count: 0, averageMs: 0, medianMs: 0, p95Ms: 0, maxMs: 0 },
      notes: [],
      updatedAt: new Date().toISOString(),
    };
  }

  private saveDiagnostics(active: ActiveRun, diagnostics: CollectionRunDiagnostics): void {
    const samples = [...(diagnostics.perTicketSamples ?? [])].sort((a, b) => a - b);
    if (samples.length > 0) {
      const sum = samples.reduce((total, value) => total + value, 0);
      const at = (fraction: number): number =>
        samples[Math.min(samples.length - 1, Math.max(0, Math.floor((samples.length - 1) * fraction)))] ?? 0;
      diagnostics.perTicket = {
        count: samples.length,
        averageMs: Math.round(sum / samples.length),
        medianMs: Math.round(at(0.5)),
        p95Ms: Math.round(at(0.95)),
        maxMs: Math.round(samples[samples.length - 1] ?? 0),
      };
    }
    delete (diagnostics as { perTicketSamples?: number[] }).perTicketSamples;
    diagnostics.updatedAt = new Date().toISOString();
    this.db.saveRunDiagnostics(active.record.id, diagnostics);
  }

  private async pauseFromError(
    active: ActiveRun,
    error: unknown,
    diagnostics: CollectionRunDiagnostics,
  ): Promise<void> {
    if (error instanceof AuthRequiredError) {
      this.connection.reportAuthFailure(error.message);
      this.update(active, {
        status: 'paused',
        stage: 'waiting_for_connection',
        errorCode: 'AUTH_REQUIRED',
        errorMessage: error.message,
      });
    } else if (error instanceof RateLimitedError) {
      this.connection.reportDataProblem(
        'data_unavailable',
        'The dashboard is rate-limiting requests. Wait a few minutes, then resume.',
      );
      this.update(active, {
        status: 'paused',
        stage: 'rate_limited',
        errorCode: 'RATE_LIMITED',
        errorMessage: error.message,
      });
    } else {
      this.update(active, {
        status: 'paused',
        stage: 'paused',
        errorCode: 'FATAL_RUN_ERROR',
        errorMessage: describeExtractionError(error),
      });
    }
    this.saveDiagnostics(active, diagnostics);
  }

  private metadataChanged(
    existing: TicketRecord | null,
    next: TicketMetadata,
  ): boolean {
    if (!existing) return true;
    if (next.closeReasonState !== 'unavailable') {
      if ((next.closeReason ?? null) !== (existing.closeReason ?? null)) return true;
    }
    if (next.closedState !== 'unavailable') {
      if ((next.closedById ?? null) !== (existing.closedById ?? null)) return true;
      if ((next.closedByName ?? null) !== (existing.closedByName ?? null)) return true;
    }
    if (next.ratingState !== 'unavailable' && (next.rating ?? null) !== (existing.rating ?? null)) {
      return true;
    }
    if (next.openerUsername && next.openerUsername !== existing.openerUsername) return true;
    if (next.openedAt && !existing.openedAt) return true;
    return false;
  }

  private async collectOne(
    active: ActiveRun,
    extractor: DashboardExtractor,
    listing: ListingRange | null,
    ticketId: string,
    diagnostics: CollectionRunDiagnostics,
  ): Promise<CollectedItem> {
    const settings = this.db.getSettings();
    const row = listing?.rows.get(ticketId) ?? null;
    // The ordered listing is complete: an ID inside the proven range that is
    // absent from it does not exist. Never invent a record for it.
    if (listing?.complete && !row) return { kind: 'not_found', id: ticketId };

    const existing = this.db.getTicket(ticketId, false);
    const next = row ? extractor.metadataFromListingRow(ticketId, row) : null;
    const hasTranscript = row ? rowHasTranscript(row) : true;
    const changed = next ? this.metadataChanged(existing, next) : false;

    if (
      active.mode === 'incremental' &&
      existing &&
      existing.collectionStatus === 'collected' &&
      existing.transcriptState === 'available'
    ) {
      // Reuse is safe only while every listing field the dashboard exposes is
      // unchanged. A changed close reason, closer, rating or opener forces a
      // fresh transcript because the final message drives the activity date
      // and credit attribution. The dashboard exposes no transcript revision
      // or modification timestamp, so a transcript-only edit with identical
      // listing metadata cannot be detected; Full refresh is the deliberate
      // audit path for that case.
      if (hasTranscript && !changed) {
        return {
          kind: 'reuse',
          id: ticketId,
          metadata: next,
          metadataChanged: false,
          noTranscript: false,
        };
      }
      if (!hasTranscript) {
        return {
          kind: 'reuse',
          id: ticketId,
          metadata: next,
          metadataChanged: changed,
          noTranscript: true,
        };
      }
    }

    if (row && !hasTranscript) {
      return {
        kind: 'reuse',
        id: ticketId,
        metadata: next,
        metadataChanged: changed,
        noTranscript: true,
      };
    }

    let lastError: unknown = null;
    const attempts = Math.max(1, settings.maxRetries + 1);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const outcome = await extractor.extractTicket(ticketId, row ?? undefined);
        if (attempt > 0) diagnostics.counts.retries += attempt;
        return { kind: 'outcome', id: ticketId, outcome };
      } catch (error) {
        if (error instanceof AuthRequiredError || error instanceof RateLimitedError) throw error;
        lastError = error;
        if (error instanceof StructureChangedError) break;
        if (attempt < attempts - 1) {
          diagnostics.counts.retries += 1;
          await sleep(900 * (attempt + 1));
        }
      }
    }
    return {
      kind: 'failure',
      id: ticketId,
      message: describeExtractionError(lastError),
      structure: lastError instanceof StructureChangedError,
    };
  }

  private async applyItem(
    active: ActiveRun,
    item: CollectedItem,
    diagnostics: CollectionRunDiagnostics,
  ): Promise<{ ok: boolean; structure?: boolean }> {
    const { record } = active;
    if (item.kind === 'not_found') {
      this.db.setItem(record.id, item.id, 'not_found');
      diagnostics.counts.notFound += 1;
      this.refreshStats(active);
      return { ok: true };
    }
    if (item.kind === 'failure') {
      this.db.setItem(record.id, item.id, 'failed', item.message);
      diagnostics.counts.failures += 1;
      log('warn', 'collection.item_failed', { ticketId: item.id, message: item.message });
      this.refreshStats(active);
      return { ok: false, structure: item.structure };
    }

    if (item.kind === 'reuse') {
      const existing = this.db.getTicket(item.id, false);
      if (item.metadata) {
        const dbStarted = Date.now();
        this.db.transaction(() => {
          this.db.upsertTicket(
            {
              ...item.metadata!,
              transcriptState: item.noTranscript
                ? 'unavailable'
                : (existing?.transcriptState ?? 'available'),
              collectionStatus: item.noTranscript ? 'no_transcript' : 'collected',
              collectionError: null,
            },
            false,
          );
        });
        diagnostics.timings.dbMs = (diagnostics.timings.dbMs ?? 0) + (Date.now() - dbStarted);
      }
      this.db.setItem(record.id, item.id, item.noTranscript ? 'no_transcript' : 'collected');
      diagnostics.counts.reused += 1;
      this.refreshStats(active);

      const assessment = existing?.assessment ?? null;
      const outdated =
        !assessment ||
        assessment.classifierVersion !== CLASSIFIER_VERSION ||
        assessment.originalReason !== (item.metadata?.closeReason ?? existing?.closeReason ?? null);
      if (record.classificationEnabled && (item.metadataChanged || outdated)) {
        const classifyStarted = Date.now();
        try {
          await this.assessments.assessTicket(item.id);
        } catch (error) {
          log('warn', 'collection.classification_failed', {
            ticketId: item.id,
            message: error instanceof Error ? error.message : 'unknown',
          });
        }
        diagnostics.timings.classifyMs =
          (diagnostics.timings.classifyMs ?? 0) + (Date.now() - classifyStarted);
        this.refreshStats(active);
      }
      return { ok: true };
    }

    const outcome = item.outcome;
    logExtraction(outcome);
    if (outcome.timing) {
      (diagnostics.perTicketSamples ??= []).push(outcome.timing.totalMs);
      if (outcome.timing.route === 'direct') diagnostics.counts.directRequests += 1;
      else diagnostics.counts.navigationRequests += 1;
    }
    if (outcome.status === 'not_found') {
      this.db.setItem(record.id, item.id, 'not_found');
      diagnostics.counts.notFound += 1;
      this.refreshStats(active);
      return { ok: true };
    }
    if (!outcome.metadata) {
      this.db.setItem(record.id, item.id, 'failed', outcome.error ?? 'No metadata was returned.');
      diagnostics.counts.failures += 1;
      this.refreshStats(active);
      return { ok: false };
    }

    const dbStarted = Date.now();
    this.db.transaction(() => {
      this.db.upsertTicket(
        {
          ...outcome.metadata!,
          collectionStatus: outcome.status,
          collectionError: outcome.error,
        },
        false,
      );
      if (outcome.metadata!.transcriptState === 'available') {
        this.db.replaceMessages(item.id, outcome.messages);
      }
    });
    diagnostics.timings.dbMs = (diagnostics.timings.dbMs ?? 0) + (Date.now() - dbStarted);
    this.db.setItem(record.id, item.id, outcome.status, outcome.error);
    if (outcome.metadata.transcriptState === 'available') diagnostics.counts.fetchedTranscripts += 1;
    this.refreshStats(active);

    if (record.classificationEnabled) {
      const classifyStarted = Date.now();
      this.update(active, { stage: 'classifying', currentTicketId: item.id });
      try {
        await this.assessments.assessTicket(item.id);
      } catch (error) {
        log('warn', 'collection.classification_failed', {
          ticketId: item.id,
          message: error instanceof Error ? error.message : 'unknown',
        });
      }
      diagnostics.timings.classifyMs =
        (diagnostics.timings.classifyMs ?? 0) + (Date.now() - classifyStarted);
      this.refreshStats(active);
    }
    return { ok: true };
  }

  private async loop(active: ActiveRun): Promise<void> {
    const { record } = active;
    const diagnostics = this.diagnosticsFor(active);
    diagnostics.perTicketSamples = [];
    const loopStarted = Date.now();
    this.update(active, { status: 'running', stage: 'connecting', errorCode: null, errorMessage: null });
    let page;
    try {
      page = await this.connection.ensureAuthenticated();
    } catch (error) {
      const message =
        error instanceof ConnectionError
          ? error.message
          : 'The Tickets dashboard connection is not ready.';
      this.update(active, {
        status: 'paused',
        stage: 'waiting_for_connection',
        errorCode: 'CONNECTION_REQUIRED',
        errorMessage: message,
      });
      return;
    }
    const settings = this.db.getSettings();
    const extractor = new DashboardExtractor(this.db, page, this.connection.getApiAccess(), (notice) => {
      this.update(active, {
        stage: 'rate_limit_cooldown',
        errorCode: 'RATE_LIMIT_COOLDOWN',
        errorMessage: `The dashboard asked for a pause. Waiting ${notice.seconds}s before retrying; completed tickets are kept.`,
      });
    });
    const start = BigInt(record.startId);
    const end = BigInt(record.endId);

    const ids: string[] = [];
    for (let current = start; current <= end; current += 1n) ids.push(current.toString());

    const pending = ids.filter((ticketId) => {
      const existing = this.db.getItem(record.id, ticketId);
      return !(existing && ['collected', 'no_transcript', 'not_found'].includes(existing.state));
    });

    diagnostics.notes.push(
      active.mode === 'incremental'
        ? 'Incremental sync: verified listing metadata, reused complete transcripts, filled gaps.'
        : 'Full refresh: re-read every transcript in the range.',
    );

    let listing: ListingRange | null = null;
    if (this.connection.getApiAccess()) {
      this.update(active, { stage: 'discovering', currentTicketId: null });
      const discoveryStarted = Date.now();
      try {
        listing = await extractor.fetchListingRange(record.startId, record.endId);
      } catch (error) {
        if (error instanceof AuthRequiredError || error instanceof RateLimitedError) {
          await this.pauseFromError(active, error, diagnostics);
          return;
        }
        diagnostics.notes.push(
          'The ordered listing could not be read; each ticket was verified individually instead.',
        );
      }
      diagnostics.timings.discoveryMs = Date.now() - discoveryStarted;
      if (listing) {
        diagnostics.counts.listingPages = listing.pagesFetched;
        diagnostics.timings.listingMs = listing.durationMs;
        if (!listing.complete) {
          diagnostics.notes.push(
            'Listing pagination did not provably cover the whole range; absent IDs were verified individually.',
          );
        }
      }
    } else {
      diagnostics.notes.push(
        'Direct dashboard API access was unavailable; collection used the verified navigation path.',
      );
    }

    const concurrency = Math.min(6, Math.max(1, settings.fetchConcurrency || 1));
    diagnostics.notes.push(`Bounded concurrency: ${concurrency} transcript read(s) at a time.`);
    let consecutiveStructureErrors = 0;
    let consecutiveFailures = 0;
    let lastDiagnosticsSave = Date.now();

    for (let index = 0; index < pending.length; index += concurrency) {
      if (active.cancelRequested) {
        diagnostics.timings.totalMs = Date.now() - loopStarted;
        this.saveDiagnostics(active, diagnostics);
        this.finish(active, 'cancelled', 'cancelled');
        return;
      }
      if (active.pauseRequested) {
        diagnostics.timings.totalMs = Date.now() - loopStarted;
        this.saveDiagnostics(active, diagnostics);
        this.update(active, { status: 'paused', stage: 'paused', currentTicketId: null });
        return;
      }
      const batch = pending.slice(index, index + concurrency);
      this.update(active, {
        status: 'running',
        stage: listing ? 'extracting' : 'extracting',
        currentTicketId: batch[0] ?? null,
        // A successful retry after a cooldown must not leave the old warning
        // attached to an otherwise healthy run.
        errorCode: null,
        errorMessage: null,
      });

      let items: CollectedItem[];
      try {
        items = await Promise.all(
          batch.map((ticketId) => this.collectOne(active, extractor, listing, ticketId, diagnostics)),
        );
      } catch (error) {
        await this.pauseFromError(active, error, diagnostics);
        return;
      }

      for (const item of items) {
        if (active.cancelRequested) {
          diagnostics.timings.totalMs = Date.now() - loopStarted;
          this.saveDiagnostics(active, diagnostics);
          this.finish(active, 'cancelled', 'cancelled');
          return;
        }
        if (active.pauseRequested) {
          diagnostics.timings.totalMs = Date.now() - loopStarted;
          this.saveDiagnostics(active, diagnostics);
          this.update(active, { status: 'paused', stage: 'paused', currentTicketId: null });
          return;
        }
        const result = await this.applyItem(active, item, diagnostics);
        if (result.ok) {
          consecutiveStructureErrors = 0;
          consecutiveFailures = 0;
          continue;
        }
        consecutiveFailures += 1;
        if (result.structure) consecutiveStructureErrors += 1;
        else consecutiveStructureErrors = 0;
        if (consecutiveStructureErrors >= 3) {
          this.connection.reportDataProblem(
            'unexpected_page',
            'The dashboard did not return the expected transcript data for three consecutive tickets. Collection was paused to avoid storing incorrect records.',
          );
          this.refreshStats(active);
          diagnostics.timings.totalMs = Date.now() - loopStarted;
          this.saveDiagnostics(active, diagnostics);
          this.update(active, {
            status: 'paused',
            stage: 'paused',
            errorCode: 'WEBSITE_LAYOUT_CHANGED',
            errorMessage:
              'Three consecutive tickets returned an unexpected dashboard response. The site may have changed; sanitized diagnostics were recorded. No fabricated records were stored.',
          });
          return;
        }
        if (consecutiveFailures >= 5) {
          this.refreshStats(active);
          diagnostics.timings.totalMs = Date.now() - loopStarted;
          this.saveDiagnostics(active, diagnostics);
          this.update(active, {
            status: 'paused',
            stage: 'paused',
            errorCode: 'TOO_MANY_FAILURES',
            errorMessage:
              'Five consecutive tickets failed. Collection was paused to avoid hammering the dashboard. Check the connection and resume.',
          });
          return;
        }
      }
      if (Date.now() - lastDiagnosticsSave > 5000) {
        diagnostics.timings.totalMs = Date.now() - loopStarted;
        this.saveDiagnostics(active, diagnostics);
        lastDiagnosticsSave = Date.now();
      }
    }

    diagnostics.timings.totalMs = Date.now() - loopStarted;
    this.saveDiagnostics(active, diagnostics);
    const stats = this.refreshStats(active);
    this.finish(active, stats.failed > 0 ? 'completed_with_errors' : 'completed', 'finished');
    void this.runCloudReviewAfterCollection();
  }

  private async interruptibleDelay(active: ActiveRun, ms: number): Promise<void> {
    const step = 200;
    let remaining = ms;
    while (remaining > 0 && !active.pauseRequested && !active.cancelRequested) {
      const wait = Math.min(step, remaining);
      await sleep(wait);
      remaining -= wait;
    }
  }

  private refreshStats(active: ActiveRun): {
    processed: number;
    collected: number;
    partial: number;
    noTranscript: number;
    notFound: number;
    failed: number;
    classified: number;
    fallbacks: number;
  } {
    const counts = this.db.countRunItems(active.record.id);
    const processed = Object.values(counts).reduce((sum, value) => sum + value, 0);
    const classifiedRow = this.db.connection
      .prepare(
        `SELECT COUNT(DISTINCT a.ticket_id) AS n, SUM(CASE WHEN a.fallback = 1 THEN 1 ELSE 0 END) AS f
         FROM collection_items i
         JOIN assessments a ON a.ticket_id = i.ticket_id
         WHERE i.run_id = ?`,
      )
      .get(active.record.id) as Record<string, unknown>;
    const stats = {
      processed,
      collected: counts.collected ?? 0,
      partial: counts.partial ?? 0,
      noTranscript: counts.no_transcript ?? 0,
      notFound: counts.not_found ?? 0,
      failed: counts.failed ?? 0,
      classified: Number(classifiedRow.n ?? 0),
      fallbacks: Number(classifiedRow.f ?? 0),
    };
    this.db.updateRun(active.record.id, {
      processed: stats.processed,
      collected: stats.collected,
      partial: stats.partial,
      noTranscript: stats.noTranscript,
      notFound: stats.notFound,
      failed: stats.failed,
      classified: stats.classified,
      fallbacks: stats.fallbacks,
      stage: active.record.stage,
      currentTicketId: active.record.currentTicketId,
    });
    Object.assign(active.record, stats);
    return stats;
  }

  private update(
    active: ActiveRun,
    patch: Partial<Omit<CollectionRunRecord, 'id'>>,
  ): void {
    Object.assign(active.record, patch);
    this.db.updateRun(active.record.id, patch);
  }

  private finish(
    active: ActiveRun,
    status: 'cancelled' | 'completed' | 'completed_with_errors',
    stage: string,
  ): void {
    const now = new Date().toISOString();
    this.refreshStats(active);
    this.update(active, {
      status,
      stage,
      currentTicketId: null,
      errorCode: null,
      errorMessage: null,
      finishedAt: now,
    });
    log('info', 'collection.finished', {
      runId: active.record.id,
      status,
      processed: active.record.processed,
    });
    this.active = null;
  }

  private async runCloudReviewAfterCollection(): Promise<void> {
    try {
      const settings = this.db.getSettings();
      if (!settings.cloudProviderUrl || !settings.cloudApiKey || !settings.cloudModel) {
        return;
      }
      const result = await this.assessments.reclassifyPendingReviewsWithCloud();
      log('info', 'collection.cloud_review_complete', {
        processed: result.processed,
        updated: result.updated,
        failed: result.failed,
      });
    } catch (error) {
      log('warn', 'collection.cloud_review_failed', {
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }
}

export type { CollectionStatus };
