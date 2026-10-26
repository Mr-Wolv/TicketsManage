import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from './config.js';
import { log } from './logger.js';
import type {
  AppSettings,
  CategoryAssessment,
  CategoryId,
  CollectionRunRecord,
  CollectionStatus,
  CreditRule,
  CreditStatus,
  FieldState,
  ReviewRecord,
  ReviewStatus,
  StoredAssessment,
  TicketMetadata,
  TicketRecord,
  TranscriptMessage,
} from './types.js';
import { TAXONOMY } from './classifier/taxonomy.js';

type Row = Record<string, unknown>;

const DEFAULT_SETTINGS: AppSettings = {
  dashboardUrl:
    'https://dashboard.tickets.bot/manage/1276839639285760081/transcripts',
  guildId: '1276839639285760081',
  ollamaUrl: 'http://127.0.0.1:11434',
  model: 'qwen2.5:3b',
  modelTimeoutMs: 15000,
  semanticEnabled: true,
  aiMode: 'deterministic',
  fuzzyThreshold: 0.82,
  requestDelayMs: 450,
  classificationEnabled: true,
  autoReuseSession: true,
  maxRetries: 2,
  navigationTimeoutMs: 25000,
  fetchConcurrency: 3,
  cloudProviderUrl: '',
  cloudApiKey: '',
  cloudModel: '',
  cloudTimeoutMs: 15000,
};

const json = (value: unknown): string => JSON.stringify(value ?? null);
const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};
const str = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);
const num = (value: unknown): number | null =>
  value === null || value === undefined || value === '' ? null : Number(value);
const bool = (value: unknown): boolean => Number(value) === 1;

export interface TicketListFilters {
  page?: number;
  pageSize?: number;
  search?: string;
  staff?: string;
  category?: string;
  fallback?: boolean;
  reviewStatus?: string;
  collectionStatus?: string;
  from?: string;
  to?: string;
  /** opened = ticket creation time; activity = last transcript message (close proxy). */
  dateBasis?: 'opened' | 'activity';
  includeDemo?: boolean;
  demoOnly?: boolean;
  sort?: 'id' | 'collected' | 'base' | 'awarded' | 'reason';
  dir?: 'asc' | 'desc';
}

export interface OverviewCounts {
  totalTickets: number;
  demoTickets: number;
  waitingForClassification: number;
  classified: number;
  reviewPending: number;
  fallbackCount: number;
  unresolvedCredit: number;
  awardedPoints: number;
  lastCollectionAt: string | null;
  latestRun: CollectionRunRecord | null;
}

export interface StaffAggregateRow {
  staffKey: string;
  staffId: string | null;
  staffName: string | null;
  ticketsCredited: number;
  awardedPoints: number;
  sameClaimClose: number;
  unclaimedHalf: number;
  differentZero: number;
  fallbackTickets: number;
  ratingSum: number;
  ratingCount: number;
  avgRating: number | null;
  categories: Record<string, { points: number; tickets: number }>;
}

export class Db {
  private conn: DatabaseSync | null = null;
  constructor(public readonly filePath: string) {}

  open(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.conn = new DatabaseSync(this.filePath);
    this.conn.exec('PRAGMA journal_mode = WAL;');
    this.conn.exec('PRAGMA foreign_keys = ON;');
    this.conn.exec('PRAGMA busy_timeout = 5000;');
    this.migrate();
    this.migrateUnifiedTaxonomy();
  }

  close(): void {
    if (this.conn) {
      try {
        this.conn.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      } catch {
        /* best effort */
      }
      this.conn.close();
      this.conn = null;
    }
  }

  get connection(): DatabaseSync {
    if (!this.conn) throw new Error('Database is not open');
    return this.conn;
  }

  private transactionDepth = 0;
  private savepointSerial = 0;

  /**
   * Re-entrant transaction. SQLite rejects a second BEGIN inside a
   * transaction, so nested calls use savepoints. This matters because
   * collection stores a ticket and its transcript inside one outer
   * transaction while replaceMessages() also wants atomicity.
   */
  transaction<T>(fn: () => T): T {
    if (this.transactionDepth > 0) {
      const savepoint = `tm_sp_${++this.savepointSerial}`;
      this.transactionDepth += 1;
      this.connection.exec(`SAVEPOINT ${savepoint}`);
      try {
        const value = fn();
        this.connection.exec(`RELEASE ${savepoint}`);
        return value;
      } catch (error) {
        try {
          this.connection.exec(`ROLLBACK TO ${savepoint}`);
          this.connection.exec(`RELEASE ${savepoint}`);
        } catch {
          /* ignore savepoint rollback failure */
        }
        throw error;
      } finally {
        this.transactionDepth -= 1;
      }
    }

    this.connection.exec('BEGIN IMMEDIATE');
    this.transactionDepth = 1;
    try {
      const value = fn();
      this.connection.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.connection.exec('ROLLBACK');
      } catch {
        /* ignore rollback failure */
      }
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }

  private migrate(): void {
    const db = this.connection;
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tickets (
        ticket_id TEXT PRIMARY KEY,
        opener_username TEXT,
        opener_user_id TEXT,
        opened_at TEXT,
        opened_at_source TEXT,
        claimed_by_name TEXT,
        claimed_by_id TEXT,
        claimed_state TEXT NOT NULL DEFAULT 'unavailable',
        closed_by_name TEXT,
        closed_by_id TEXT,
        closed_state TEXT NOT NULL DEFAULT 'unavailable',
        closed_at TEXT,
        closed_at_source TEXT,
        close_reason TEXT,
        close_reason_state TEXT NOT NULL DEFAULT 'unavailable',
        rating REAL,
        rating_state TEXT NOT NULL DEFAULT 'unavailable',
        ticket_url TEXT,
        transcript_state TEXT NOT NULL DEFAULT 'not_retrieved',
        collection_status TEXT NOT NULL DEFAULT 'failed',
        collection_error TEXT,
        labels_json TEXT NOT NULL DEFAULT '[]',
        raw_list_row_json TEXT,
        is_demo INTEGER NOT NULL DEFAULT 0,
        collected_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transcript_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id TEXT NOT NULL REFERENCES tickets(ticket_id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        message_id TEXT,
        author_name TEXT,
        author_id TEXT,
        timestamp TEXT,
        content TEXT NOT NULL DEFAULT '',
        embeds_json TEXT NOT NULL DEFAULT '[]',
        attachments_json TEXT NOT NULL DEFAULT '[]',
        components_json TEXT NOT NULL DEFAULT '[]',
        UNIQUE(ticket_id, seq)
      );
      CREATE TABLE IF NOT EXISTS assessments (
        ticket_id TEXT PRIMARY KEY REFERENCES tickets(ticket_id) ON DELETE CASCADE,
        original_reason TEXT,
        categories_json TEXT NOT NULL,
        category_ids_json TEXT NOT NULL,
        primary_category TEXT,
        base_points REAL NOT NULL DEFAULT 0,
        fallback INTEGER NOT NULL DEFAULT 0,
        method TEXT NOT NULL,
        confidence REAL,
        explanation TEXT NOT NULL DEFAULT '',
        alternatives_json TEXT NOT NULL DEFAULT '[]',
        review_required INTEGER NOT NULL DEFAULT 0,
        review_reasons_json TEXT NOT NULL DEFAULT '[]',
        unresolved_portion TEXT,
        credit_rule TEXT NOT NULL DEFAULT 'E',
        credit_status TEXT NOT NULL DEFAULT 'unresolved',
        credit_staff_id TEXT,
        credit_staff_name TEXT,
        awarded_points REAL,
        credit_explanation TEXT NOT NULL DEFAULT '',
        model TEXT,
        taxonomy_version TEXT NOT NULL,
        classifier_version TEXT NOT NULL,
        human_corrected INTEGER NOT NULL DEFAULT 0,
        assessment_hash TEXT NOT NULL DEFAULT '',
        assessed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reviews (
        ticket_id TEXT PRIMARY KEY REFERENCES tickets(ticket_id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        reasons_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT,
        resolution_note TEXT
      );
      CREATE TABLE IF NOT EXISTS review_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id TEXT NOT NULL,
        action TEXT NOT NULL,
        previous_categories_json TEXT,
        new_categories_json TEXT,
        note TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approved_aliases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        normalized_text TEXT NOT NULL,
        original_text TEXT NOT NULL,
        categories_json TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        source_ticket TEXT,
        created_at TEXT NOT NULL,
        deactivated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS taxonomy_overrides (
        category_id TEXT PRIMARY KEY,
        points REAL NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        changed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS custom_categories (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        label TEXT NOT NULL,
        label_ar TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        points REAL NOT NULL DEFAULT 0,
        distinction TEXT NOT NULL DEFAULT '',
        examples TEXT NOT NULL DEFAULT '[]',
        negative_examples TEXT NOT NULL DEFAULT '[]',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approved_reasons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        category_id TEXT NOT NULL,
        source_type TEXT NOT NULL DEFAULT 'review',
        source_ticket_id TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS taxonomy_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        note TEXT NOT NULL DEFAULT '',
        changed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS taxonomy_categories (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        label TEXT NOT NULL,
        label_ar TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        points REAL NOT NULL DEFAULT 0,
        distinction TEXT NOT NULL DEFAULT '',
        examples TEXT NOT NULL DEFAULT '[]',
        negative_examples TEXT NOT NULL DEFAULT '[]',
        active INTEGER NOT NULL DEFAULT 1,
        is_fixed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collection_runs (
        id TEXT PRIMARY KEY,
        start_id TEXT NOT NULL,
        end_id TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'full',
        status TEXT NOT NULL,
        requested_count INTEGER NOT NULL,
        processed INTEGER NOT NULL DEFAULT 0,
        collected INTEGER NOT NULL DEFAULT 0,
        partial INTEGER NOT NULL DEFAULT 0,
        no_transcript INTEGER NOT NULL DEFAULT 0,
        not_found INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        classified INTEGER NOT NULL DEFAULT 0,
        fallbacks INTEGER NOT NULL DEFAULT 0,
        classification_enabled INTEGER NOT NULL DEFAULT 1,
        stage TEXT NOT NULL DEFAULT 'starting',
        current_ticket_id TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        last_updated_at TEXT NOT NULL,
        date_from TEXT,
        date_to TEXT,
        date_timezone TEXT,
        date_basis TEXT
      );
      CREATE TABLE IF NOT EXISTS collection_items (
        run_id TEXT NOT NULL REFERENCES collection_runs(id) ON DELETE CASCADE,
        ticket_id TEXT NOT NULL,
        state TEXT NOT NULL,
        error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, ticket_id)
      );
      CREATE TABLE IF NOT EXISTS collection_run_diagnostics (
        run_id TEXT PRIMARY KEY REFERENCES collection_runs(id) ON DELETE CASCADE,
        data_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(collection_status);
      CREATE INDEX IF NOT EXISTS idx_tickets_collected ON tickets(collected_at);
      CREATE INDEX IF NOT EXISTS idx_tickets_demo ON tickets(is_demo);
      CREATE INDEX IF NOT EXISTS idx_messages_ticket ON transcript_messages(ticket_id, seq);
      CREATE INDEX IF NOT EXISTS idx_messages_ticket_time ON transcript_messages(ticket_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_assessments_review ON assessments(review_required);
      CREATE INDEX IF NOT EXISTS idx_assessments_fallback ON assessments(fallback);
      CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status);
      CREATE INDEX IF NOT EXISTS idx_run_items_run ON collection_items(run_id, state);
    `);
    // Additive migrations for databases created before the column existed.
    const runColumns = db.prepare('PRAGMA table_info(collection_runs)').all() as Row[];
    if (!runColumns.some((column) => String(column.name) === 'mode')) {
      db.exec("ALTER TABLE collection_runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'full'");
    }

    const dateColumns = ['date_from', 'date_to', 'date_timezone', 'date_basis'];
    for (const column of dateColumns) {
      if (!runColumns.some((c) => String(c.name) === column)) {
        db.exec(`ALTER TABLE collection_runs ADD COLUMN ${column} TEXT`);
      }
    }
    const current = Number(
      (db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as Row | undefined)
        ?.value ?? 0,
    );
    if (current < SCHEMA_VERSION) {
      db.prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run('schema_version', String(SCHEMA_VERSION));
    }
  }

  // ---- settings -----------------------------------------------------------

  getSettings(): AppSettings {
    const rows = this.connection.prepare('SELECT key, value FROM settings').all() as Row[];
    const stored: Record<string, string> = {};
    for (const row of rows) stored[String(row.key)] = String(row.value);
    const aiMode = stored.aiMode === 'shadow' || stored.aiMode === 'production' ? stored.aiMode : 'deterministic';
    return {
      dashboardUrl: stored.dashboardUrl ?? DEFAULT_SETTINGS.dashboardUrl,
      guildId: stored.guildId ?? DEFAULT_SETTINGS.guildId,
      ollamaUrl: stored.ollamaUrl ?? DEFAULT_SETTINGS.ollamaUrl,
      model: stored.model ?? DEFAULT_SETTINGS.model,
      modelTimeoutMs:
        stored.modelTimeoutMs === undefined
          ? DEFAULT_SETTINGS.modelTimeoutMs
          : Number(stored.modelTimeoutMs),
      semanticEnabled:
        stored.semanticEnabled === undefined
          ? DEFAULT_SETTINGS.semanticEnabled
          : stored.semanticEnabled === 'true',
      aiMode,
      fuzzyThreshold:
        stored.fuzzyThreshold === undefined
          ? DEFAULT_SETTINGS.fuzzyThreshold
          : Number(stored.fuzzyThreshold),
      requestDelayMs:
        stored.requestDelayMs === undefined
          ? DEFAULT_SETTINGS.requestDelayMs
          : Number(stored.requestDelayMs),
      classificationEnabled:
        stored.classificationEnabled === undefined
          ? DEFAULT_SETTINGS.classificationEnabled
          : stored.classificationEnabled === 'true',
      autoReuseSession:
        stored.autoReuseSession === undefined
          ? DEFAULT_SETTINGS.autoReuseSession
          : stored.autoReuseSession === 'true',
      maxRetries:
        stored.maxRetries === undefined
          ? DEFAULT_SETTINGS.maxRetries
          : Number(stored.maxRetries),
      navigationTimeoutMs:
        stored.navigationTimeoutMs === undefined
          ? DEFAULT_SETTINGS.navigationTimeoutMs
          : Number(stored.navigationTimeoutMs),
      fetchConcurrency:
        stored.fetchConcurrency === undefined
          ? DEFAULT_SETTINGS.fetchConcurrency
          : Number(stored.fetchConcurrency),
      cloudProviderUrl: stored.cloudProviderUrl ?? DEFAULT_SETTINGS.cloudProviderUrl,
      cloudApiKey: stored.cloudApiKey ?? DEFAULT_SETTINGS.cloudApiKey,
      cloudModel: stored.cloudModel ?? DEFAULT_SETTINGS.cloudModel,
      cloudTimeoutMs:
        stored.cloudTimeoutMs === undefined
          ? DEFAULT_SETTINGS.cloudTimeoutMs
          : Number(stored.cloudTimeoutMs),
    };
  }

  saveSettings(patch: Partial<AppSettings>): AppSettings {
    const current = this.getSettings();
    const next: AppSettings = { ...current, ...patch };
    if (!/^https?:\/\//.test(next.dashboardUrl)) {
      throw new Error('Dashboard URL must start with http:// or https://');
    }
    if (!/^\d+$/.test(next.guildId)) {
      throw new Error('Guild ID must contain digits only');
    }
    if (!/^https?:\/\//.test(next.ollamaUrl)) {
      throw new Error('Ollama URL must start with http:// or https://');
    }
    if (next.cloudProviderUrl && !/^https?:\/\//.test(next.cloudProviderUrl)) {
      throw new Error('Cloud provider URL must start with http:// or https://');
    }
    next.fuzzyThreshold = Math.min(0.98, Math.max(0.5, Number(next.fuzzyThreshold) || 0.82));
    next.requestDelayMs = Math.min(10000, Math.max(0, Number(next.requestDelayMs) || 0));
    next.maxRetries = Math.min(5, Math.max(0, Number(next.maxRetries) || 0));
    next.modelTimeoutMs = Math.min(
      120000,
      Math.max(1000, Number(next.modelTimeoutMs) || DEFAULT_SETTINGS.modelTimeoutMs),
    );
    next.navigationTimeoutMs = Math.min(
      120000,
      Math.max(5000, Number(next.navigationTimeoutMs) || 25000),
    );
    next.fetchConcurrency = Math.min(
      6,
      Math.max(1, Math.round(Number(next.fetchConcurrency) || DEFAULT_SETTINGS.fetchConcurrency)),
    );
    next.cloudTimeoutMs = Math.min(
      120000,
      Math.max(5000, Number(next.cloudTimeoutMs) || DEFAULT_SETTINGS.cloudTimeoutMs),
    );
    const stmt = this.connection.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    for (const [key, value] of Object.entries(next)) stmt.run(key, String(value));
    return next;
  }

  // ---- tickets ------------------------------------------------------------

  private mapTicketRow(row: Row): TicketMetadata & {
    collectionStatus: CollectionStatus;
    collectionError: string | null;
    collectedAt: string;
    updatedAt: string;
    isDemo: boolean;
    messageCount: number;
    lastActivityAt: string | null;
  } {
    return {
      ticketId: String(row.ticket_id),
      openerUsername: str(row.opener_username),
      openerUserId: str(row.opener_user_id),
      openedAt: str(row.opened_at),
      openedAtSource: str(row.opened_at_source),
      claimedByName: str(row.claimed_by_name),
      claimedById: str(row.claimed_by_id),
      claimedState: (str(row.claimed_state) ?? 'unavailable') as FieldState,
      closedByName: str(row.closed_by_name),
      closedById: str(row.closed_by_id),
      closedState: (str(row.closed_state) ?? 'unavailable') as FieldState,
      closedAt: str(row.closed_at),
      closedAtSource: str(row.closed_at_source),
      closeReason: str(row.close_reason),
      closeReasonState: (str(row.close_reason_state) ?? 'unavailable') as
        | 'present'
        | 'empty'
        | 'unavailable',
      rating: num(row.rating),
      ratingState: (str(row.rating_state) ?? 'unavailable') as 'present' | 'unavailable',
      ticketUrl: str(row.ticket_url),
      transcriptState: (str(row.transcript_state) ?? 'not_retrieved') as
        | 'available'
        | 'unavailable'
        | 'restricted'
        | 'not_retrieved',
      labels: parseJson<string[]>(row.labels_json, []),
      rawListRow: parseJson<unknown>(row.raw_list_row_json, null),
      collectionStatus: (str(row.collection_status) ?? 'failed') as CollectionStatus,
      collectionError: str(row.collection_error),
      collectedAt: String(row.collected_at),
      updatedAt: String(row.updated_at),
      isDemo: bool(row.is_demo),
      messageCount: Number(row.message_count ?? 0),
      lastActivityAt: str(row.last_activity_at),
    };
  }

  getTicketRow(ticketId: string): Row | undefined {
    return this.connection
      .prepare(
        `SELECT t.*, (SELECT COUNT(*) FROM transcript_messages m WHERE m.ticket_id = t.ticket_id) AS message_count,
                (SELECT MAX(m.timestamp) FROM transcript_messages m WHERE m.ticket_id = t.ticket_id) AS last_activity_at
         FROM tickets t WHERE t.ticket_id = ?`,
      )
      .get(ticketId) as Row | undefined;
  }

  upsertTicket(
    incoming: TicketMetadata & {
      collectionStatus: CollectionStatus;
      collectionError: string | null;
    },
    isDemo = false,
  ): void {
    const existing = this.getTicketRow(incoming.ticketId);
    const now = new Date().toISOString();
    if (!existing) {
      this.connection
        .prepare(
          `INSERT INTO tickets (
            ticket_id, opener_username, opener_user_id, opened_at, opened_at_source,
            claimed_by_name, claimed_by_id, claimed_state,
            closed_by_name, closed_by_id, closed_state,
            closed_at, closed_at_source, close_reason, close_reason_state,
            rating, rating_state, ticket_url, transcript_state,
            collection_status, collection_error, labels_json, raw_list_row_json,
            is_demo, collected_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          incoming.ticketId,
          incoming.openerUsername,
          incoming.openerUserId,
          incoming.openedAt,
          incoming.openedAtSource,
          incoming.claimedByName,
          incoming.claimedById,
          incoming.claimedState,
          incoming.closedByName,
          incoming.closedById,
          incoming.closedState,
          incoming.closedAt,
          incoming.closedAtSource,
          incoming.closeReason,
          incoming.closeReasonState,
          incoming.rating,
          incoming.ratingState,
          incoming.ticketUrl,
          incoming.transcriptState,
          incoming.collectionStatus,
          incoming.collectionError,
          json(incoming.labels),
          incoming.rawListRow === null ? null : json(incoming.rawListRow),
          isDemo ? 1 : 0,
          now,
          now,
        );
      return;
    }

    const previous = this.mapTicketRow(existing);
    const keep = <T>(nextValue: T | null, previousValue: T | null): T | null =>
      nextValue === null || nextValue === undefined ? previousValue : nextValue;
    const reason =
      incoming.closeReasonState === 'unavailable'
        ? previous.closeReason
        : incoming.closeReason;
    const reasonState =
      incoming.closeReasonState === 'unavailable' && previous.closeReasonState !== 'unavailable'
        ? previous.closeReasonState
        : incoming.closeReasonState;
    const claimed =
      incoming.claimedState === 'unavailable'
        ? {
            name: previous.claimedByName,
            id: previous.claimedById,
            state: previous.claimedState,
          }
        : {
            name: incoming.claimedByName,
            id: incoming.claimedById,
            state: incoming.claimedState,
          };
    const closed =
      incoming.closedState === 'unavailable'
        ? { name: previous.closedByName, id: previous.closedById, state: previous.closedState }
        : { name: incoming.closedByName, id: incoming.closedById, state: incoming.closedState };
    const transcriptState =
      incoming.transcriptState === 'available' || incoming.transcriptState === 'restricted'
        ? incoming.transcriptState
        : previous.transcriptState;
    const status =
      previous.collectionStatus === 'collected' && incoming.collectionStatus !== 'collected'
        ? 'collected'
        : incoming.collectionStatus;
    this.connection
      .prepare(
        `UPDATE tickets SET
          opener_username = ?, opener_user_id = ?, opened_at = ?, opened_at_source = ?,
          claimed_by_name = ?, claimed_by_id = ?, claimed_state = ?,
          closed_by_name = ?, closed_by_id = ?, closed_state = ?,
          closed_at = ?, closed_at_source = ?, close_reason = ?, close_reason_state = ?,
          rating = ?, rating_state = ?, ticket_url = ?, transcript_state = ?,
          collection_status = ?, collection_error = ?, labels_json = ?, raw_list_row_json = ?,
          collected_at = ?, updated_at = ?
        WHERE ticket_id = ?`,
      )
      .run(
        keep(incoming.openerUsername, previous.openerUsername),
        keep(incoming.openerUserId, previous.openerUserId),
        keep(incoming.openedAt, previous.openedAt),
        keep(incoming.openedAtSource, previous.openedAtSource),
        claimed.name,
        claimed.id,
        claimed.state,
        closed.name,
        closed.id,
        closed.state,
        keep(incoming.closedAt, previous.closedAt),
        keep(incoming.closedAtSource, previous.closedAtSource),
        reason,
        reasonState,
        incoming.ratingState === 'unavailable' ? previous.rating : incoming.rating,
        incoming.ratingState === 'unavailable' ? previous.ratingState : incoming.ratingState,
        keep(incoming.ticketUrl, previous.ticketUrl),
        transcriptState,
        status,
        incoming.collectionError ?? (status === 'failed' ? previous.collectionError : null),
        incoming.labels.length > 0 ? json(incoming.labels) : json(previous.labels),
        incoming.rawListRow === null ? json(previous.rawListRow) : json(incoming.rawListRow),
        now,
        now,
        incoming.ticketId,
      );
  }

  replaceMessages(ticketId: string, messages: TranscriptMessage[]): void {
    this.transaction(() => {
      this.connection
        .prepare('DELETE FROM transcript_messages WHERE ticket_id = ?')
        .run(ticketId);
      const stmt = this.connection.prepare(
        `INSERT INTO transcript_messages
         (ticket_id, seq, message_id, author_name, author_id, timestamp, content, embeds_json, attachments_json, components_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      messages.forEach((message, index) => {
        stmt.run(
          ticketId,
          index,
          message.messageId,
          message.authorName,
          message.authorId,
          message.timestamp,
          message.content,
          json(message.embeds),
          json(message.attachments),
          json(message.components),
        );
      });
    });
  }

  getMessages(ticketId: string): TranscriptMessage[] {
    const rows = this.connection
      .prepare('SELECT * FROM transcript_messages WHERE ticket_id = ? ORDER BY seq ASC')
      .all(ticketId) as Row[];
    return rows.map((row) => ({
      seq: Number(row.seq),
      messageId: str(row.message_id),
      authorName: str(row.author_name),
      authorId: str(row.author_id),
      timestamp: str(row.timestamp),
      content: String(row.content ?? ''),
      embeds: parseJson<unknown[]>(row.embeds_json, []),
      attachments: parseJson<unknown[]>(row.attachments_json, []),
      components: parseJson<unknown[]>(row.components_json, []),
    }));
  }

  getAssessment(ticketId: string): StoredAssessment | null {
    const row = this.connection
      .prepare('SELECT * FROM assessments WHERE ticket_id = ?')
      .get(ticketId) as Row | undefined;
    return row ? this.mapAssessmentRow(row) : null;
  }

  private mapAssessmentRow(row: Row): StoredAssessment {
    const categories = parseJson<CategoryAssessment[]>(row.categories_json, []);
    return {
      ticketId: String(row.ticket_id),
      originalReason: str(row.original_reason),
      categories,
      basePoints: Number(row.base_points ?? 0),
      fallback: bool(row.fallback),
      method: String(row.method) as StoredAssessment['method'],
      confidence: num(row.confidence),
      explanation: String(row.explanation ?? ''),
      alternatives: parseJson(row.alternatives_json, []),
      reviewReasons: parseJson<string[]>(row.review_reasons_json, []),
      unresolvedPortion: str(row.unresolved_portion),
      creditRule: (str(row.credit_rule) ?? 'E') as CreditRule,
      creditStatus: (str(row.credit_status) ?? 'unresolved') as CreditStatus,
      creditStaffId: str(row.credit_staff_id),
      creditStaffName: str(row.credit_staff_name),
      awardedPoints: num(row.awarded_points),
      creditExplanation: String(row.credit_explanation ?? ''),
      model: str(row.model),
      taxonomyVersion: String(row.taxonomy_version),
      classifierVersion: String(row.classifier_version),
      humanCorrected: bool(row.human_corrected),
      assessedAt: String(row.assessed_at),
    };
  }

  getReview(ticketId: string): ReviewRecord | null {
    const row = this.connection
      .prepare('SELECT * FROM reviews WHERE ticket_id = ?')
      .get(ticketId) as Row | undefined;
    return row ? this.mapReviewRow(row) : null;
  }

  private mapReviewRow(row: Row): ReviewRecord {
    return {
      ticketId: String(row.ticket_id),
      status: String(row.status) as ReviewStatus,
      reasons: parseJson<string[]>(row.reasons_json, []),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      resolvedAt: str(row.resolved_at),
      resolvedBy: str(row.resolved_by),
      resolutionNote: str(row.resolution_note),
    };
  }

  getTicket(ticketId: string, includeMessages = true): TicketRecord | null {
    const row = this.getTicketRow(ticketId);
    if (!row) return null;
    const base = this.mapTicketRow(row);
    const messages = includeMessages ? this.getMessages(ticketId) : [];
    return {
      ...base,
      messages,
      assessment: this.getAssessment(ticketId),
      review: this.getReview(ticketId),
    };
  }

  listTickets(filters: TicketListFilters = {}): { items: TicketRecord[]; total: number; page: number; pageSize: number } {
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(200, Math.max(5, filters.pageSize ?? 25));
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.demoOnly) where.push('t.is_demo = 1');
    else if (!filters.includeDemo) where.push('t.is_demo = 0');
    if (filters.search) {
      where.push(
        `(t.ticket_id LIKE ? OR IFNULL(t.opener_username,'') LIKE ? OR IFNULL(t.claimed_by_name,'') LIKE ? OR IFNULL(t.closed_by_name,'') LIKE ? OR IFNULL(t.close_reason,'') LIKE ?)`,
      );
      const term = `%${filters.search}%`;
      params.push(term, term, term, term, term);
    }
    if (filters.staff) {
      where.push(
        `(t.claimed_by_id = ? OR t.closed_by_id = ? OR a.credit_staff_id = ? OR t.claimed_by_name LIKE ? OR t.closed_by_name LIKE ? OR a.credit_staff_name LIKE ?)`,
      );
      params.push(filters.staff, filters.staff, filters.staff, `%${filters.staff}%`, `%${filters.staff}%`, `%${filters.staff}%`);
    }
    if (filters.category) {
      where.push(`a.category_ids_json LIKE ?`);
      params.push(`%"${filters.category}"%`);
    }
    if (filters.fallback === true) where.push('a.fallback = 1');
    if (filters.fallback === false) where.push('a.fallback = 0');
    if (filters.reviewStatus) {
      where.push('r.status = ?');
      params.push(filters.reviewStatus);
    }
    if (filters.collectionStatus) {
      where.push('t.collection_status = ?');
      params.push(filters.collectionStatus);
    }
    const dateExpression =
      filters.dateBasis === 'activity'
        ? `COALESCE(t.closed_at, (SELECT MAX(m.timestamp) FROM transcript_messages m WHERE m.ticket_id = t.ticket_id), t.opened_at, t.collected_at)`
        : `COALESCE(t.closed_at, t.opened_at, t.collected_at)`;
    if (filters.from) {
      where.push(`${dateExpression} >= ?`);
      params.push(filters.from);
    }
    if (filters.to) {
      where.push(`${dateExpression} <= ?`);
      params.push(filters.to);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sortMap: Record<string, string> = {
      id: 'CAST(t.ticket_id AS INTEGER)',
      collected: 't.collected_at',
      base: 'IFNULL(a.base_points, -1)',
      awarded: 'IFNULL(a.awarded_points, -1)',
      reason: 'IFNULL(t.close_reason, \'\')',
    };
    const sort = sortMap[filters.sort ?? 'id'] ?? sortMap.id;
    const dir = filters.dir === 'asc' ? 'ASC' : 'DESC';
    const totalRow = this.connection
      .prepare(
        `SELECT COUNT(*) AS n FROM tickets t
         LEFT JOIN assessments a ON a.ticket_id = t.ticket_id
         LEFT JOIN reviews r ON r.ticket_id = t.ticket_id
         ${whereSql}`,
      )
      .get(...(params as never[])) as Row;
    const rows = this.connection
      .prepare(
        `SELECT t.*, (SELECT COUNT(*) FROM transcript_messages m WHERE m.ticket_id = t.ticket_id) AS message_count,
                (SELECT MAX(m.timestamp) FROM transcript_messages m WHERE m.ticket_id = t.ticket_id) AS last_activity_at
         FROM tickets t
         LEFT JOIN assessments a ON a.ticket_id = t.ticket_id
         LEFT JOIN reviews r ON r.ticket_id = t.ticket_id
         ${whereSql}
         ORDER BY ${sort} ${dir}, t.ticket_id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...(params as never[]), pageSize, (page - 1) * pageSize) as Row[];
    const items = rows.map((row) => {
      const base = this.mapTicketRow(row);
      const ticketId = base.ticketId;
      return {
        ...base,
        messages: [],
        assessment: this.getAssessment(ticketId),
        review: this.getReview(ticketId),
      };
    });
    return { items, total: Number(totalRow.n), page, pageSize };
  }

  saveAssessment(assessment: StoredAssessment): void {
    const categories = assessment.categories;
    this.connection
      .prepare(
        `INSERT INTO assessments (
          ticket_id, original_reason, categories_json, category_ids_json, primary_category,
          base_points, fallback, method, confidence, explanation, alternatives_json,
          review_required, review_reasons_json, unresolved_portion,
          credit_rule, credit_status, credit_staff_id, credit_staff_name,
          awarded_points, credit_explanation, model, taxonomy_version, classifier_version,
          human_corrected, assessment_hash, assessed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ticket_id) DO UPDATE SET
          original_reason = excluded.original_reason,
          categories_json = excluded.categories_json,
          category_ids_json = excluded.category_ids_json,
          primary_category = excluded.primary_category,
          base_points = excluded.base_points,
          fallback = excluded.fallback,
          method = excluded.method,
          confidence = excluded.confidence,
          explanation = excluded.explanation,
          alternatives_json = excluded.alternatives_json,
          review_required = excluded.review_required,
          review_reasons_json = excluded.review_reasons_json,
          unresolved_portion = excluded.unresolved_portion,
          credit_rule = excluded.credit_rule,
          credit_status = excluded.credit_status,
          credit_staff_id = excluded.credit_staff_id,
          credit_staff_name = excluded.credit_staff_name,
          awarded_points = excluded.awarded_points,
          credit_explanation = excluded.credit_explanation,
          model = excluded.model,
          taxonomy_version = excluded.taxonomy_version,
          classifier_version = excluded.classifier_version,
          human_corrected = excluded.human_corrected,
          assessment_hash = excluded.assessment_hash,
          assessed_at = excluded.assessed_at`,
      )
      .run(
        assessment.ticketId,
        assessment.originalReason,
        json(categories),
        json(categories.map((c) => c.categoryId)),
        categories.length === 1 ? categories[0]!.categoryId : categories.length > 1 ? 'MULTIPLE' : null,
        assessment.basePoints,
        assessment.fallback ? 1 : 0,
        assessment.method,
        assessment.confidence,
        assessment.explanation,
        json(assessment.alternatives),
        assessment.reviewReasons.length > 0 ? 1 : 0,
        json(assessment.reviewReasons),
        assessment.unresolvedPortion,
        assessment.creditRule,
        assessment.creditStatus,
        assessment.creditStaffId,
        assessment.creditStaffName,
        assessment.awardedPoints,
        assessment.creditExplanation,
        assessment.model,
        assessment.taxonomyVersion,
        assessment.classifierVersion,
        assessment.humanCorrected ? 1 : 0,
        hashAssessment(assessment),
        assessment.assessedAt,
      );
  }

  ensureReview(ticketId: string, reasons: string[]): ReviewRecord {
    const now = new Date().toISOString();
    const existing = this.getReview(ticketId);
    if (existing) {
      if (existing.status === 'pending') {
        this.connection
          .prepare('UPDATE reviews SET reasons_json = ?, updated_at = ? WHERE ticket_id = ?')
          .run(json(reasons), now, ticketId);
        return { ...existing, reasons, updatedAt: now };
      }
      return existing;
    }
    this.connection
      .prepare(
        `INSERT INTO reviews (ticket_id, status, reasons_json, created_at, updated_at)
         VALUES (?, 'pending', ?, ?, ?)`,
      )
      .run(ticketId, json(reasons), now, now);
    this.addReviewHistory(ticketId, 'created', null, null, reasons.join('; '));
    return {
      ticketId,
      status: 'pending',
      reasons,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      resolvedBy: null,
      resolutionNote: null,
    };
  }

  setReviewReasons(ticketId: string, reasons: string[]): void {
    this.connection
      .prepare('UPDATE reviews SET reasons_json = ?, updated_at = ? WHERE ticket_id = ?')
      .run(json(reasons), new Date().toISOString(), ticketId);
  }

  resolveReview(
    ticketId: string,
    status: Exclude<ReviewStatus, 'pending'>,
    note: string | null,
    resolvedBy = 'local manager',
  ): void {
    const now = new Date().toISOString();
    this.connection
      .prepare(
        `UPDATE reviews SET status = ?, resolved_at = ?, updated_at = ?, resolved_by = ?, resolution_note = ?
         WHERE ticket_id = ?`,
      )
      .run(status, now, now, resolvedBy, note, ticketId);
  }

  addReviewHistory(
    ticketId: string,
    action: string,
    previousCategories: string[] | null,
    newCategories: string[] | null,
    note: string | null,
  ): void {
    this.connection
      .prepare(
        `INSERT INTO review_history (ticket_id, action, previous_categories_json, new_categories_json, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ticketId,
        action,
        previousCategories ? json(previousCategories) : null,
        newCategories ? json(newCategories) : null,
        note,
        new Date().toISOString(),
      );
  }

  listReviewHistory(ticketId: string): Array<{
    id: number;
    action: string;
    previousCategories: string[] | null;
    newCategories: string[] | null;
    note: string | null;
    createdAt: string;
  }> {
    const rows = this.connection
      .prepare('SELECT * FROM review_history WHERE ticket_id = ? ORDER BY id DESC')
      .all(ticketId) as Row[];
    return rows.map((row) => ({
      id: Number(row.id),
      action: String(row.action),
      previousCategories: parseJson<string[] | null>(row.previous_categories_json, null),
      newCategories: parseJson<string[] | null>(row.new_categories_json, null),
      note: str(row.note),
      createdAt: String(row.created_at),
    }));
  }

  listReviews(status?: string): Array<{
    ticketId: string;
    status: ReviewStatus;
    reasons: string[];
    createdAt: string;
    updatedAt: string;
    originalReason: string | null;
    reasonState: string;
    categories: CategoryAssessment[];
    basePoints: number;
    fallback: boolean;
    method: string;
    explanation: string;
    alternatives: unknown;
    creditStatus: string;
    creditRule: string;
    claimedByName: string | null;
    closedByName: string | null;
    openerUsername: string | null;
    assessment: StoredAssessment | null;
    ticket: TicketRecord;
  }> {
    const where = status && status !== 'all' ? 'WHERE r.status = ?' : '';
    const params = status && status !== 'all' ? [status] : [];
    const rows = this.connection
      .prepare(
        `SELECT r.* FROM reviews r ${where} ORDER BY r.updated_at DESC`,
      )
      .all(...(params as never[])) as Row[];
    const results = [];
    for (const row of rows) {
      const review = this.mapReviewRow(row);
      const ticket = this.getTicket(review.ticketId, false);
      if (!ticket) continue;
      results.push({
        ticketId: review.ticketId,
        status: review.status,
        reasons: review.reasons,
        createdAt: review.createdAt,
        updatedAt: review.updatedAt,
        originalReason: ticket.assessment?.originalReason ?? ticket.closeReason,
        reasonState: ticket.closeReasonState,
        categories: ticket.assessment?.categories ?? [],
        basePoints: ticket.assessment?.basePoints ?? 0,
        fallback: ticket.assessment?.fallback ?? false,
        method: ticket.assessment?.method ?? 'none',
        explanation: ticket.assessment?.explanation ?? '',
        alternatives: ticket.assessment?.alternatives ?? [],
        creditStatus: ticket.assessment?.creditStatus ?? 'unresolved',
        creditRule: ticket.assessment?.creditRule ?? 'E',
        claimedByName: ticket.claimedByName,
        closedByName: ticket.closedByName,
        openerUsername: ticket.openerUsername,
        assessment: ticket.assessment,
        ticket,
      });
    }
    return results;
  }

  findApprovedAlias(normalizedText: string): { categories: CategoryAssessment[]; original: string } | null {
    const row = this.connection
      .prepare(
        'SELECT * FROM approved_aliases WHERE normalized_text = ? AND active = 1 ORDER BY id DESC LIMIT 1',
      )
      .get(normalizedText) as Row | undefined;
    if (!row) return null;
    const categories = parseJson<Array<{ categoryId: string; points: number; evidence?: string[] }>>(
      row.categories_json,
      [],
    );
    return {
      original: String(row.original_text),
      categories: categories.map((category) => ({
        categoryId: category.categoryId as CategoryAssessment['categoryId'],
        points: Number(category.points),
        evidence: [`Approved correction from ticket ${String(row.source_ticket ?? 'unknown')}`],
        method: 'approved_alias' as const,
        confidence: 0.99,
      })),
    };
  }

  addApprovedAlias(input: {
    normalizedText: string;
    originalText: string;
    categoryIds: string[];
    sourceTicket: string;
  }): { conflict: boolean; previousCategoryIds: string[] | null } {
    const existing = this.connection
      .prepare(
        'SELECT * FROM approved_aliases WHERE normalized_text = ? AND active = 1 ORDER BY id DESC LIMIT 1',
      )
      .get(input.normalizedText) as Row | undefined;
    let conflict = false;
    let previousCategoryIds: string[] | null = null;
    if (existing) {
      const existingCategories = parseJson<CategoryAssessment[]>(existing.categories_json, []);
      previousCategoryIds = existingCategories.map((category) => category.categoryId);
      const same =
        [...previousCategoryIds].sort().join(',') === [...input.categoryIds].sort().join(',');
      if (same) return { conflict: false, previousCategoryIds };
      conflict = true;
      this.connection
        .prepare('UPDATE approved_aliases SET active = 0, deactivated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), String(existing.id));
    }
    const categories = input.categoryIds.map((categoryId) => ({
      categoryId,
      points: 0,
      evidence: [`Approved from ticket ${input.sourceTicket}`],
    }));
    this.connection
      .prepare(
        `INSERT INTO approved_aliases (normalized_text, original_text, categories_json, active, source_ticket, created_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
      )
      .run(
        input.normalizedText,
        input.originalText,
        json(categories),
        input.sourceTicket,
        new Date().toISOString(),
      );
    return { conflict, previousCategoryIds };
  }

  // ---- taxonomy (fluid / overridable) --------------------------------------

  getCategoryPoints(categoryId: CategoryId): number | null {
    const row = this.connection
      .prepare('SELECT points FROM taxonomy_overrides WHERE category_id = ?')
      .get(categoryId) as Row | undefined;
    return row ? Number(row.points) : null;
  }

  setCategoryPoints(categoryId: CategoryId, points: number, note = ''): { previous: number | null } {
    const previous = this.getCategoryPoints(categoryId);
    this.connection
      .prepare(
        `INSERT INTO taxonomy_overrides (category_id, points, note, changed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(category_id) DO UPDATE SET points = excluded.points, note = excluded.note, changed_at = excluded.changed_at`,
      )
      .run(categoryId, Number(points), note, new Date().toISOString());
    this.logTaxonomyChange('update_points', 'category', categoryId, previous !== null ? String(previous) : null, String(points), note);
    return { previous };
  }

  listTaxonomyOverrides(): Array<{ categoryId: CategoryId; points: number; note: string; changedAt: string }> {
    return this.connection
      .prepare('SELECT category_id, points, note, changed_at FROM taxonomy_overrides ORDER BY category_id')
      .all()
      .map((row) => ({
        categoryId: row.category_id as CategoryId,
        points: Number(row.points),
        note: String(row.note ?? ''),
        changedAt: String(row.changed_at),
      }));
  }

  addCustomCategory(input: {
    id: string;
    code: string;
    label: string;
    labelAr: string;
    description: string;
    points: number;
    distinction?: string;
    examples: string[];
    negativeExamples?: string[];
  }): void {
    const now = new Date().toISOString();
    this.connection
      .prepare(
        `INSERT OR REPLACE INTO custom_categories (id, code, label, label_ar, description, points, distinction, examples, negative_examples, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        input.id,
        input.code,
        input.label,
        input.labelAr,
        input.description,
        Number(input.points),
        input.distinction ?? '',
        json(input.examples),
        json(input.negativeExamples ?? []),
        now,
      );
    this.logTaxonomyChange('add_category', 'custom_category', input.id, null, input.code, `Added custom category ${input.code}`);
  }

  listCustomCategories(): Array<{
    id: string;
    code: string;
    label: string;
    labelAr: string;
    description: string;
    points: number;
    distinction: string;
    examples: string[];
    negativeExamples: string[];
    active: number;
    createdAt: string;
  }> {
    return this.connection
      .prepare('SELECT * FROM custom_categories WHERE active = 1 ORDER BY created_at')
      .all()
      .map((row) => ({
        id: String(row.id),
        code: String(row.code),
        label: String(row.label),
        labelAr: String(row.label_ar),
        description: String(row.description),
        points: Number(row.points),
        distinction: String(row.distinction ?? ''),
        examples: parseJson<string[]>(row.examples, []),
        negativeExamples: parseJson<string[]>(row.negative_examples, []),
        active: Number(row.active),
        createdAt: String(row.created_at),
      }));
  }

  addApprovedReason(input: { text: string; categoryId: CategoryId; sourceType?: string; sourceTicketId?: string }): void {
    const normalized = input.text.toLowerCase().replace(/\s+/g, ' ').trim();
    const now = new Date().toISOString();
    this.connection
      .prepare(
        `INSERT INTO approved_reasons (text, normalized_text, category_id, source_type, source_ticket_id, active, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(input.text, normalized, input.categoryId, input.sourceType ?? 'review', input.sourceTicketId ?? null, now);
    this.logTaxonomyChange('add_reason', 'approved_reason', normalized, null, input.categoryId, `Approved reason for ${input.categoryId}`);
  }

  listApprovedReasons(filters?: { categoryId?: CategoryId; search?: string }): Array<{
    id: number;
    text: string;
    normalizedText: string;
    categoryId: CategoryId;
    sourceType: string;
    sourceTicketId: string | null;
    createdAt: string;
  }> {
    let sql = 'SELECT * FROM approved_reasons WHERE active = 1';
    const params: unknown[] = [];
    if (filters?.categoryId) {
      sql += ' AND category_id = ?';
      params.push(filters.categoryId);
    }
    if (filters?.search) {
      sql += ' AND normalized_text LIKE ?';
      params.push(`%${filters.search.toLowerCase().replace(/\s+/g, ' ').trim()}%`);
    }
    sql += ' ORDER BY created_at DESC';
    return this.connection
      .prepare(sql)
      .all(...(params as unknown as any[]))
      .map((row) => ({
        id: Number(row.id),
        text: String(row.text),
        normalizedText: String(row.normalized_text),
        categoryId: row.category_id as CategoryId,
        sourceType: String(row.source_type),
        sourceTicketId: str(row.source_ticket_id),
        createdAt: String(row.created_at),
      }));
  }

  listTaxonomyAudit(limit = 100): Array<{ id: number; action: string; entityType: string; entityId: string; oldValue: string | null; newValue: string | null; note: string; changedAt: string }> {
    return this.connection
      .prepare('SELECT * FROM taxonomy_audit_log ORDER BY id DESC LIMIT ?')
      .all(limit)
      .map((row) => ({
        id: Number(row.id),
        action: String(row.action),
        entityType: String(row.entity_type),
        entityId: String(row.entity_id),
        oldValue: str(row.old_value),
        newValue: str(row.new_value),
        note: String(row.note ?? ''),
        changedAt: String(row.changed_at),
      }));
  }

  private logTaxonomyChange(action: string, entityType: string, entityId: string, oldValue: string | null, newValue: string | null, note = ''): void {
    this.connection
      .prepare(
        `INSERT INTO taxonomy_audit_log (action, entity_type, entity_id, old_value, new_value, note, changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(action, entityType, entityId, oldValue, newValue, note, new Date().toISOString());
  }

  migrateUnifiedTaxonomy(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS taxonomy_categories (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        label TEXT NOT NULL,
        label_ar TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        points REAL NOT NULL DEFAULT 0,
        distinction TEXT NOT NULL DEFAULT '',
        examples TEXT NOT NULL DEFAULT '[]',
        negative_examples TEXT NOT NULL DEFAULT '[]',
        active INTEGER NOT NULL DEFAULT 1,
        is_fixed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    const now = new Date().toISOString();
    const stmt = this.connection.prepare(
      `INSERT INTO taxonomy_categories (id, code, label, label_ar, description, points, distinction, examples, negative_examples, active, is_fixed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET code = excluded.code, label = excluded.label, label_ar = excluded.label_ar, description = excluded.description, points = excluded.points, distinction = excluded.distinction, examples = excluded.examples, negative_examples = excluded.negative_examples, active = excluded.active, updated_at = excluded.updated_at`,
    );
    for (const category of TAXONOMY) {
      stmt.run(
        category.id,
        category.code,
        category.label,
        category.labelAr,
        category.description,
        Number(category.points),
        category.distinction ?? '',
        JSON.stringify(category.examples ?? []),
        JSON.stringify(category.negativeExamples ?? []),
        1,
        1,
        now,
        now,
      );
    }
    const customCategories = this.listCustomCategories();
    for (const category of customCategories) {
      stmt.run(
        category.id,
        category.code,
        category.label,
        category.labelAr,
        category.description,
        Number(category.points),
        category.distinction ?? '',
        JSON.stringify(category.examples ?? []),
        JSON.stringify(category.negativeExamples ?? []),
        category.active,
        0,
        category.createdAt,
        now,
      );
    }
  }

  loadUnifiedTaxonomy(): Array<{
    id: string;
    code: string;
    label: string;
    labelAr: string;
    description: string;
    points: number;
    distinction: string;
    examples: string[];
    negativeExamples: string[];
    active: number;
    isFixed: boolean;
    updatedAt: string;
  }> {
    const rows = this.connection.prepare('SELECT * FROM taxonomy_categories ORDER BY is_fixed DESC, created_at').all();
    return rows.map((row) => ({
      id: String(row.id),
      code: String(row.code),
      label: String(row.label),
      labelAr: String(row.label_ar),
      description: String(row.description),
      points: Number(row.points),
      distinction: String(row.distinction ?? ''),
      examples: parseJson<string[]>(row.examples, []),
      negativeExamples: parseJson<string[]>(row.negative_examples, []),
      active: Number(row.active),
      isFixed: Boolean(row.is_fixed),
      updatedAt: String(row.updated_at),
    }));
  }

  saveUnifiedCategory(input: {
    id: string;
    code: string;
    label: string;
    labelAr: string;
    description: string;
    points: number;
    distinction?: string;
    examples: string[];
    negativeExamples?: string[];
    active?: number;
    isFixed?: boolean;
  }): void {
    const now = new Date().toISOString();
    const existing = this.connection.prepare('SELECT * FROM taxonomy_categories WHERE id = ?').get(input.id) as Row | undefined;
    const previous = existing ? JSON.stringify(existing) : null;
    this.connection
      .prepare(
        `INSERT INTO taxonomy_categories (id, code, label, label_ar, description, points, distinction, examples, negative_examples, active, is_fixed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET code = excluded.code, label = excluded.label, label_ar = excluded.label_ar, description = excluded.description, points = excluded.points, distinction = excluded.distinction, examples = excluded.examples, negative_examples = excluded.negative_examples, active = excluded.active, is_fixed = excluded.is_fixed, updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        input.code,
        input.label,
        input.labelAr,
        input.description,
        Number(input.points),
        input.distinction ?? '',
        JSON.stringify(input.examples ?? []),
        JSON.stringify(input.negativeExamples ?? []),
        input.active ?? 1,
        input.isFixed ? 1 : 0,
        existing ? String(existing.created_at) : now,
        now,
      );
    this.logTaxonomyChange('update_category', 'taxonomy_category', input.id, previous, JSON.stringify(input), 'Updated unified taxonomy category');
  }

  // ---- collection runs ---------------------------------------------------

  createRun(input: {
    id: string;
    startId: string;
    endId: string;
    mode: 'incremental' | 'full';
    requestedCount: number;
    classificationEnabled: boolean;
    dateFrom?: string | null;
    dateTo?: string | null;
    dateTimezone?: string | null;
    dateBasis?: string | null;
  }): CollectionRunRecord {
    const now = new Date().toISOString();
    this.connection
      .prepare(
        `INSERT INTO collection_runs
         (id, start_id, end_id, mode, status, requested_count, classification_enabled, date_from, date_to, date_timezone, date_basis, created_at, started_at, last_updated_at)
         VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.startId,
        input.endId,
        input.mode,
        input.requestedCount,
        input.classificationEnabled ? 1 : 0,
        input.dateFrom ?? null,
        input.dateTo ?? null,
        input.dateTimezone ?? null,
        input.dateBasis ?? null,
        now,
        now,
        now,
      );
    return this.getRun(input.id)!;
  }

  updateRun(
    id: string,
    patch: Partial<Omit<CollectionRunRecord, 'id' | 'createdAt' | 'startedAt'>>,
  ): void {
    const fields: string[] = [];
    const params: unknown[] = [];
    const mapping: Record<string, string> = {
      status: 'status',
      processed: 'processed',
      collected: 'collected',
      partial: 'partial',
      noTranscript: 'no_transcript',
      notFound: 'not_found',
      failed: 'failed',
      classified: 'classified',
      fallbacks: 'fallbacks',
      stage: 'stage',
      currentTicketId: 'current_ticket_id',
      errorCode: 'error_code',
      errorMessage: 'error_message',
      finishedAt: 'finished_at',
    };
    for (const [key, column] of Object.entries(mapping)) {
      if (key in patch) {
        fields.push(`${column} = ?`);
        params.push((patch as Record<string, unknown>)[key]);
      }
    }
    fields.push('last_updated_at = ?');
    params.push(new Date().toISOString(), id);
    this.connection
      .prepare(`UPDATE collection_runs SET ${fields.join(', ')} WHERE id = ?`)
      .run(...(params as never[]));
  }

  getRun(id: string): CollectionRunRecord | null {
    const row = this.connection
      .prepare('SELECT * FROM collection_runs WHERE id = ?')
      .get(id) as Row | undefined;
    return row ? this.mapRunRow(row) : null;
  }

  private mapRunRow(row: Row): CollectionRunRecord {
    return {
      id: String(row.id),
      startId: String(row.start_id),
      endId: String(row.end_id),
      mode: (row.mode === 'incremental' ? 'incremental' : 'full') as CollectionRunRecord['mode'],
      status: String(row.status) as CollectionRunRecord['status'],
      requestedCount: Number(row.requested_count),
      processed: Number(row.processed),
      collected: Number(row.collected),
      partial: Number(row.partial),
      noTranscript: Number(row.no_transcript),
      notFound: Number(row.not_found),
      failed: Number(row.failed),
      classified: Number(row.classified),
      fallbacks: Number(row.fallbacks),
      classificationEnabled: bool(row.classification_enabled),
      stage: String(row.stage),
      currentTicketId: str(row.current_ticket_id),
      errorCode: str(row.error_code),
      errorMessage: str(row.error_message),
      createdAt: String(row.created_at),
      startedAt: String(row.started_at),
      finishedAt: str(row.finished_at),
      lastUpdatedAt: String(row.last_updated_at),
      dateFrom: str(row.date_from),
      dateTo: str(row.date_to),
      dateTimezone: str(row.date_timezone),
      dateBasis: str(row.date_basis),
    };
  }

  saveRunDiagnostics(runId: string, data: unknown): void {
    this.connection
      .prepare(
        `INSERT INTO collection_run_diagnostics (run_id, data_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`,
      )
      .run(runId, JSON.stringify(data ?? {}), new Date().toISOString());
  }

  getRunDiagnostics(runId: string): Record<string, unknown> | null {
    const row = this.connection
      .prepare('SELECT data_json FROM collection_run_diagnostics WHERE run_id = ?')
      .get(runId) as Row | undefined;
    return row ? parseJson<Record<string, unknown>>(row.data_json, {}) : null;
  }

  latestRun(): CollectionRunRecord | null {
    const row = this.connection
      .prepare('SELECT * FROM collection_runs ORDER BY started_at DESC LIMIT 1')
      .get() as Row | undefined;
    return row ? this.mapRunRow(row) : null;
  }

  listRuns(limit = 10): CollectionRunRecord[] {
    const rows = this.connection
      .prepare('SELECT * FROM collection_runs ORDER BY started_at DESC LIMIT ?')
      .all(limit) as Row[];
    return rows.map((row) => this.mapRunRow(row));
  }

  setItem(runId: string, ticketId: string, state: CollectionStatus, error: string | null = null): void {
    this.connection
      .prepare(
        `INSERT INTO collection_items (run_id, ticket_id, state, error, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id, ticket_id) DO UPDATE SET state = excluded.state, error = excluded.error, updated_at = excluded.updated_at`,
      )
      .run(runId, ticketId, state, error, new Date().toISOString());
  }

  getItem(runId: string, ticketId: string): { state: CollectionStatus; error: string | null } | null {
    const row = this.connection
      .prepare('SELECT state, error FROM collection_items WHERE run_id = ? AND ticket_id = ?')
      .get(runId, ticketId) as Row | undefined;
    return row ? { state: String(row.state) as CollectionStatus, error: str(row.error) } : null;
  }

  countRunItems(runId: string): Record<string, number> {
    const rows = this.connection
      .prepare('SELECT state, COUNT(*) AS n FROM collection_items WHERE run_id = ? GROUP BY state')
      .all(runId) as Row[];
    const counts: Record<string, number> = {};
    for (const row of rows) counts[String(row.state)] = Number(row.n);
    return counts;
  }

  overview(includeDemo = false, demoOnly = false): OverviewCounts {
    const scope = demoOnly ? 't.is_demo = 1' : includeDemo ? '1=1' : 't.is_demo = 0';
    const counts = this.connection
      .prepare(
        `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN t.is_demo = 1 THEN 1 ELSE 0 END) AS demo,
          SUM(CASE WHEN a.ticket_id IS NULL THEN 1 ELSE 0 END) AS waiting,
          SUM(CASE WHEN a.ticket_id IS NOT NULL THEN 1 ELSE 0 END) AS classified,
          SUM(CASE WHEN r.status = 'pending' THEN 1 ELSE 0 END) AS review_pending,
          SUM(CASE WHEN a.fallback = 1 THEN 1 ELSE 0 END) AS fallbacks,
          SUM(CASE WHEN a.credit_status = 'unresolved' THEN 1 ELSE 0 END) AS unresolved_credit,
          SUM(CASE WHEN a.awarded_points IS NOT NULL THEN a.awarded_points ELSE 0 END) AS awarded
         FROM tickets t
         LEFT JOIN assessments a ON a.ticket_id = t.ticket_id
         LEFT JOIN reviews r ON r.ticket_id = t.ticket_id
         WHERE ${scope}`,
      )
      .get() as Row;
    const last = this.connection
      .prepare(
        `SELECT MAX(COALESCE(finished_at, last_updated_at)) AS last FROM collection_runs WHERE status IN ('completed')`,
      )
      .get() as Row;
    return {
      totalTickets: Number(counts.total ?? 0),
      demoTickets: Number(counts.demo ?? 0),
      waitingForClassification: Number(counts.waiting ?? 0),
      classified: Number(counts.classified ?? 0),
      reviewPending: Number(counts.review_pending ?? 0),
      fallbackCount: Number(counts.fallbacks ?? 0),
      unresolvedCredit: Number(counts.unresolved_credit ?? 0),
      awardedPoints: Number(counts.awarded ?? 0),
      lastCollectionAt: str(last.last),
      latestRun: this.latestRun(),
    };
  }

  clearDemoData(): number {
    const ids = (
      this.connection.prepare('SELECT ticket_id FROM tickets WHERE is_demo = 1').all() as Row[]
    ).map((row) => String(row.ticket_id));
    this.transaction(() => {
      for (const id of ids) {
        this.connection.prepare('DELETE FROM reviews WHERE ticket_id = ?').run(id);
        this.connection.prepare('DELETE FROM assessments WHERE ticket_id = ?').run(id);
        this.connection.prepare('DELETE FROM transcript_messages WHERE ticket_id = ?').run(id);
        this.connection.prepare('DELETE FROM tickets WHERE ticket_id = ?').run(id);
      }
    });
    return ids.length;
  }

  getResetPreview(): {
    tickets: number;
    transcriptMessages: number;
    assessments: number;
    reviews: number;
    reviewHistory: number;
    collectionRuns: number;
    collectionItems: number;
    collectionRunDiagnostics: number;
    taxonomyOverrides: number;
    customCategories: number;
    approvedReasons: number;
    taxonomyAuditLog: number;
  } {
    const count = (table: string) => {
      try {
        const row = this.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row;
        return Number(row?.n ?? 0);
      } catch {
        return 0;
      }
    };
    return {
      tickets: count('tickets'),
      transcriptMessages: count('transcript_messages'),
      assessments: count('assessments'),
      reviews: count('reviews'),
      reviewHistory: count('review_history'),
      collectionRuns: count('collection_runs'),
      collectionItems: count('collection_items'),
      collectionRunDiagnostics: count('collection_run_diagnostics'),
      taxonomyOverrides: count('taxonomy_overrides'),
      customCategories: count('custom_categories'),
      approvedReasons: count('approved_reasons'),
      taxonomyAuditLog: count('taxonomy_audit_log'),
    };
  }

  resetRoster(): void {
    this.transaction(() => {
      // Clear operational ticket data while preserving reusable knowledge:
      // approved aliases, taxonomy overrides, custom categories, approved reasons,
      // and audit log survive roster reset.
      for (const table of [
        'reviews',
        'review_history',
        'assessments',
        'transcript_messages',
        'collection_items',
        'collection_runs',
        'collection_run_diagnostics',
        'tickets',
      ]) {
        try {
          this.connection.exec(`DELETE FROM ${table}`);
        } catch {
          // ignore missing tables
        }
      }
    });
  }

  deleteAllData(): void {
    this.transaction(() => {
      for (const table of [
        'reviews',
        'review_history',
        'assessments',
        'transcript_messages',
        'collection_items',
        'collection_runs',
        'collection_run_diagnostics',
        'approved_aliases',
        'tickets',
      ]) {
        try {
          this.connection.exec(`DELETE FROM ${table}`);
        } catch {
          // ignore missing tables
        }
      }
    });
  }

  backupTo(targetPath: string): void {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    this.connection.exec('PRAGMA wal_checkpoint(FULL);');
    this.connection.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
    log('info', 'db.backup.created', { target: path.basename(targetPath) });
  }

  /** Validate that a candidate restore file is a readable TicketsManage DB. */
  static validateBackup(filePath: string): void {
    const db = new DatabaseSync(filePath);
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Row[];
      const names = new Set(tables.map((row) => String(row.name)));
      for (const required of ['tickets', 'assessments', 'reviews', 'collection_runs']) {
        if (!names.has(required)) throw new Error(`Backup is missing table: ${required}`);
      }
    } finally {
      db.close();
    }
  }

  restoreFrom(backupPath: string): void {
    Db.validateBackup(backupPath);
    const safety = `${this.filePath}.pre-restore-${Date.now()}`;
    this.close();
    fs.copyFileSync(this.filePath, safety);
    for (const suffix of ['-wal', '-shm']) {
      try {
        fs.rmSync(this.filePath + suffix, { force: true });
      } catch {
        /* ignore */
      }
    }
    fs.copyFileSync(backupPath, this.filePath);
    this.open();
  }
}

function hashAssessment(assessment: StoredAssessment): string {
  const source = JSON.stringify({
    categories: assessment.categories.map((category) => category.categoryId).sort(),
    base: assessment.basePoints,
    credit: assessment.creditStatus,
    awarded: assessment.awardedPoints,
    method: assessment.method,
    review: assessment.reviewReasons,
    human: assessment.humanCorrected,
  });
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) | 0;
  }
  return `${assessment.classifierVersion}-${(hash >>> 0).toString(16)}`;
}

export { DEFAULT_SETTINGS };
