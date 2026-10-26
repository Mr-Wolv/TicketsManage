import type { APIResponse, Page, Response } from 'playwright';
import type { DashboardApiAccess } from './connection.js';
import type { Db } from './db.js';
import { log } from './logger.js';
import type {
  CollectionStatus,
  FieldState,
  TicketMetadata,
  TranscriptMessage,
  TranscriptState,
} from './types.js';

export class AuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
  }
}
export class RateLimitedError extends Error {}
export class StructureChangedError extends Error {}
export class TranscriptUnavailableError extends Error {
  constructor(
    message: string,
    public readonly restricted: boolean,
  ) {
    super(message);
  }
}

export interface ExtractionTiming {
  route: 'direct' | 'navigation';
  listMs: number;
  transcriptMs: number;
  totalMs: number;
}

export interface ExtractionOutcome {
  found: boolean;
  ticketId: string;
  status: CollectionStatus;
  metadata: TicketMetadata | null;
  messages: TranscriptMessage[];
  error: string | null;
  timing?: ExtractionTiming;
}

export interface ListingRange {
  /** Every transcript row whose ticket ID falls inside the inclusive range. */
  rows: Map<string, Record<string, unknown>>;
  /** True when pagination provably covered the whole requested range. */
  complete: boolean;
  pagesFetched: number;
  requests: number;
  durationMs: number;
}

const UNCLAIMED_VALUES = new Set([
  'none',
  'null',
  'unclaimed',
  'no one',
  'nobody',
  'n/a',
  'na',
  '-',
  '—',
]);

function hasOwn(row: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(row, key);
}

function findKey(row: Record<string, unknown>, candidates: string[]): string | null {
  const lowerMap = new Map(Object.keys(row).map((key) => [key.toLowerCase(), key]));
  for (const candidate of candidates) {
    const found = lowerMap.get(candidate.toLowerCase());
    if (found) return found;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function valueFromObject(value: unknown, candidates: string[]): { name: string | null; id: string | null } {
  if (value === null || value === undefined) return { name: null, id: null };
  const object = asRecord(value);
  if (!object) {
    const text = String(value).trim();
    if (!text || UNCLAIMED_VALUES.has(text.toLowerCase())) return { name: null, id: null };
    if (/^\d{5,25}$/.test(text)) return { name: null, id: text };
    return { name: text, id: null };
  }
  const nameKey = findKey(object, ['username', 'name', 'global_name', 'display_name', 'tag']);
  const idKey = findKey(object, ['id', 'user_id', 'discord_id']);
  const name = nameKey && object[nameKey] != null ? String(object[nameKey]).trim() : null;
  const id = idKey && object[idKey] != null ? String(object[idKey]).trim() : null;
  return { name: name || null, id: id || null };
}

interface IdentityField {
  state: 'present' | 'unclaimed' | 'unavailable';
  name: string | null;
  id: string | null;
}

/**
 * Dashboard field semantics are deliberately explicit. A field that is absent
 * is unavailable, not "unclaimed". An explicitly null/empty claimant is
 * unclaimed. These are different and must never be conflated.
 */
function extractIdentity(
  row: Record<string, unknown>,
  objectKeys: string[],
  nameKeys: string[],
  idKeys: string[],
): IdentityField {
  const objectKey = findKey(row, objectKeys);
  const nameKey = findKey(row, nameKeys);
  const idKey = findKey(row, idKeys);
  if (!objectKey && !nameKey && !idKey) {
    return { state: 'unavailable', name: null, id: null };
  }

  const rawObject = objectKey ? row[objectKey] : undefined;
  const rawName = nameKey ? row[nameKey] : undefined;
  const rawId = idKey ? row[idKey] : undefined;

  const fromObject = valueFromObject(rawObject, []);
  let name = fromObject.name ?? (rawName != null ? String(rawName).trim() : null);
  let id = fromObject.id ?? (rawId != null ? String(rawId).trim() : null);
  if (name && UNCLAIMED_VALUES.has(name.toLowerCase())) name = null;
  if (id) id = String(id);

  const explicitEmpty =
    (objectKey !== null &&
      (rawObject === null ||
        rawObject === undefined ||
        (typeof rawObject === 'string' && UNCLAIMED_VALUES.has(rawObject.trim().toLowerCase())))) ||
    (objectKey === null &&
      nameKey !== null &&
      (rawName === null || rawName === undefined || UNCLAIMED_VALUES.has(String(rawName).trim().toLowerCase()))) ||
    (objectKey === null && nameKey === null && idKey !== null && (rawId === null || rawId === undefined || String(rawId).trim() === ''));

  if (name || id) {
    return { state: 'present', name, id };
  }
  if (explicitEmpty) {
    return { state: 'unclaimed', name: null, id: null };
  }
  return { state: 'unavailable', name: null, id: null };
}

function extractLabels(row: Record<string, unknown>): string[] {
  const key = findKey(row, ['labels', 'ticket_labels', 'label_names']);
  if (!key) return [];
  const value = row[key];
  if (!Array.isArray(value)) return [];
  return value
    .map((label) => {
      if (typeof label === 'string') return label.trim();
      const object = asRecord(label);
      if (!object) return '';
      const nameKey = findKey(object, ['name', 'label', 'title']);
      return nameKey ? String(object[nameKey] ?? '').trim() : '';
    })
    .filter(Boolean);
}

function extractRating(row: Record<string, unknown>): { value: number | null; state: 'present' | 'unavailable' } {
  const key = findKey(row, ['rating', 'player_rating', 'feedback_rating']);
  if (!key || row[key] === null || row[key] === undefined || row[key] === '') {
    return { value: null, state: 'unavailable' };
  }
  const value = Number(row[key]);
  if (!Number.isFinite(value) || value <= 0) return { value: null, state: 'unavailable' };
  return { value, state: 'present' };
}

/**
 * The dashboard sends Discord IDs as JSON numbers. JavaScript's JSON.parse
 * rounds anything above Number.MAX_SAFE_INTEGER, which silently changed a
 * closer ID such as 752978053101256744 into 752978053101256700 and broke
 * claimant/closer matching. Quote unsafe integer literals before parsing so
 * every ID remains exact; all ID fields are consumed as strings anyway.
 */
export function parseDashboardJson(text: string): unknown {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === '-' || (character >= '0' && character <= '9')) {
      const previous = index === 0 ? '' : text.charAt(index - 1);
      const startsToken = previous === '' || /[\s[{,:]/.test(previous);
      if (startsToken) {
        let end = index;
        if (text.charAt(end) === '-') end += 1;
        while (end < text.length && text.charAt(end) >= '0' && text.charAt(end) <= '9') end += 1;
        const token = text.slice(index, end);
        const next = text.charAt(end);
        if (token.replace('-', '').length >= 16 && next !== '.' && next !== 'e' && next !== 'E') {
          output += `"${token}"`;
          index = end - 1;
          continue;
        }
        output += token;
        index = end - 1;
        continue;
      }
    }
    output += character;
  }
  return JSON.parse(output) as unknown;
}

function normalizeTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    const ms = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function mapListRow(
  ticketId: string,
  row: Record<string, unknown>,
  guildId: string,
  origin: string,
): TicketMetadata {
  const openerNameKey = findKey(row, [
    'username',
    'opener_username',
    'opened_by_username',
    'opened_by_name',
    'user_name',
    'opener',
  ]);
  const openerIdKey = findKey(row, [
    'user_id',
    'opener_user_id',
    'opened_by_id',
    'opener_id',
  ]);
  const openerObject = openerNameKey ? asRecord(row[openerNameKey]) : null;
  let openerUsername = openerNameKey && row[openerNameKey] != null
    ? String(openerObject ? openerObject.username ?? openerObject.name ?? '' : row[openerNameKey]).trim() || null
    : null;
  let openerUserId = openerIdKey && row[openerIdKey] != null ? String(row[openerIdKey]).trim() || null : null;
  if (openerObject) {
    openerUserId =
      openerObject.id != null ? String(openerObject.id) : openerUserId;
    openerUsername =
      (openerObject.username != null ? String(openerObject.username) : openerUsername) ?? null;
  }

  const claimed = extractIdentity(
    row,
    ['claimed_by', 'claimant', 'claimed_by_user', 'claimed_by_member'],
    ['claimed_by_name', 'claimed_by_username', 'claimant_name', 'claimant_username'],
    ['claimed_by_id', 'claimant_id', 'claimed_by_user_id'],
  );
  const closed = extractIdentity(
    row,
    ['closed_by', 'closer', 'closed_by_user', 'closed_by_member'],
    ['closed_by_name', 'closed_by_username', 'closer_name', 'closer_username'],
    ['closed_by_id', 'closer_id', 'closed_by_user_id'],
  );

  const reasonKey = findKey(row, ['close_reason', 'closereason', 'reason']);
  let closeReason: string | null = null;
  let closeReasonState: 'present' | 'empty' | 'unavailable' = 'unavailable';
  if (reasonKey) {
    const rawReason = row[reasonKey];
    if (rawReason === null || rawReason === undefined || String(rawReason).trim() === '') {
      closeReason = rawReason === null ? null : String(rawReason);
      closeReasonState = 'empty';
    } else {
      // Preserve the exact original text, including its original whitespace.
      closeReason = String(rawReason);
      closeReasonState = 'present';
    }
  }

  const openedKey = findKey(row, ['opened_at', 'created_at', 'open_time', 'opened_at_time']);
  const closedKey = findKey(row, ['closed_at', 'close_time', 'closed_at_time']);
  const rating = extractRating(row);

  return {
    ticketId,
    openerUsername,
    openerUserId,
    openedAt: openedKey ? normalizeTimestamp(row[openedKey]) : null,
    openedAtSource: openedKey && row[openedKey] ? 'dashboard' : null,
    claimedByName: claimed.name,
    claimedById: claimed.id,
    claimedState: claimed.state,
    closedByName: closed.name,
    closedById: closed.id,
    closedState: closed.state,
    closedAt: closedKey ? normalizeTimestamp(row[closedKey]) : null,
    closedAtSource: closedKey && row[closedKey] ? 'dashboard' : null,
    closeReason,
    closeReasonState,
    rating: rating.value,
    ratingState: rating.state,
    ticketUrl: `${origin}/manage/${guildId}/transcripts/view/${encodeURIComponent(ticketId)}`,
    transcriptState: 'not_retrieved',
    labels: extractLabels(row),
    rawListRow: row,
  };
}

function mapMessages(payload: unknown): {
  messages: TranscriptMessage[];
  restricted: boolean;
  firstTimestamp: string | null;
  usernames: Map<string, string>;
} {
  const body = asRecord(payload);
  if (!body) throw new StructureChangedError('Transcript response was not an object.');
  if (body.content_restricted === true) {
    return { messages: [], restricted: true, firstTimestamp: null, usernames: new Map() };
  }
  const rawMessages = body.messages;
  if (!Array.isArray(rawMessages)) {
    throw new StructureChangedError('Transcript response did not contain a messages array.');
  }
  const entities = asRecord(body.entities);
  const users = entities ? asRecord(entities.users) : null;
  const usernames = new Map<string, string>();
  if (users) {
    for (const [id, rawUser] of Object.entries(users)) {
      const user = asRecord(rawUser);
      if (user && user.username != null && String(user.username).trim()) {
        usernames.set(id, String(user.username).trim());
      }
    }
  }
  const messages: TranscriptMessage[] = [];
  let firstTimestamp: string | null = null;
  rawMessages.forEach((raw, index) => {
    const message = asRecord(raw);
    if (!message) return;
    const author = message.author;
    let authorName: string | null = null;
    let authorId: string | null = null;
    if (typeof author === 'string') {
      authorId = author;
      const user = users ? asRecord(users[author]) : null;
      authorName = user && user.username != null ? String(user.username) : null;
    } else if (author) {
      const authorObject = asRecord(author);
      if (authorObject) {
        authorId = authorObject.id != null ? String(authorObject.id) : null;
        authorName = authorObject.username != null ? String(authorObject.username) : null;
        if (!authorName && authorId && users) {
          const user = asRecord(users[authorId]);
          authorName = user && user.username != null ? String(user.username) : null;
        }
      }
    }
    const timestamp = normalizeTimestamp(message.time ?? message.timestamp);
    if (!firstTimestamp && timestamp) firstTimestamp = timestamp;
    messages.push({
      seq: index,
      messageId: message.id != null ? String(message.id) : null,
      authorName,
      authorId,
      timestamp,
      content: message.content == null ? '' : String(message.content),
      embeds: Array.isArray(message.embeds) ? message.embeds : [],
      attachments: Array.isArray(message.attachments) ? message.attachments : [],
      components: Array.isArray(message.components) ? message.components : [],
    });
  });
  return { messages, restricted: false, firstTimestamp, usernames };
}

interface ClaimInference {
  state: FieldState;
  id: string | null;
  name: string | null;
  evidence: string | null;
}

function findMentionId(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.match(/<@!?(\d{15,25})>/);
  return match && match[1] ? match[1] : null;
}

/**
 * The transcript list response has no claimant column, but tickets.bot writes
 * a "Claimed Ticket" control message containing the actual staff mention. Use
 * that durable evidence instead of guessing from who replied. A "Claim" button
 * on an otherwise unclaimed transcript is explicit evidence of no claimant.
 */
export function inferClaim(
  messages: TranscriptMessage[],
  usernames: Map<string, string>,
): ClaimInference {
  let inference: ClaimInference = {
    state: 'unavailable',
    id: null,
    name: null,
    evidence: null,
  };
  for (const message of messages) {
    const embeds = message.embeds
      .map((embed) => asRecord(embed))
      .filter((embed): embed is Record<string, unknown> => embed !== null);
    for (const embed of embeds) {
      const title = embed.title != null ? String(embed.title) : '';
      if (/^unclaimed\s+ticket\b/i.test(title)) {
        inference = { state: 'unclaimed', id: null, name: null, evidence: `Ticket control message: "${title}"` };
        continue;
      }
      if (/^claimed\s+ticket\b/i.test(title)) {
        const description = embed.description != null ? String(embed.description) : '';
        const id = findMentionId(description) ?? findMentionId(message.content);
        inference = {
          state: id ? 'present' : 'unavailable',
          id,
          name: id ? (usernames.get(id) ?? null) : null,
          evidence: `Ticket control message: "${title}"`,
        };
      }
    }
  }
  if (inference.state !== 'unavailable') return inference;

  // No claim history at all. Only the current "Claim" button is reliable: it
  // means this ticket has never been claimed. An "Unclaim" button without a
  // claim event would mean claimed but the claimant identity is unknown, which
  // must remain unresolved rather than invented.
  for (const message of messages) {
    for (const rawComponent of message.components) {
      const component = asRecord(rawComponent);
      if (!component) continue;
      const nested = Array.isArray(component.components)
        ? component.components.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => entry !== null)
        : [];
      for (const button of [component, ...nested]) {
        if (String(button.custom_id ?? '') === 'claim') {
          return {
            state: 'unclaimed',
            id: null,
            name: null,
            evidence: 'Ticket control button offers Claim, so no staff member has claimed it.',
          };
        }
      }
    }
  }
  return inference;
}

function listRequestMatches(response: Response, ticketId: string): boolean {
  if (response.request().method() !== 'POST') return false;
  let url: URL;
  try {
    url = new URL(response.url());
  } catch {
    return false;
  }
  if (!/\/api\/\d+\/transcripts\/?$/.test(url.pathname)) return false;
  try {
    const postData = response.request().postData();
    if (!postData) return true;
    const payload = JSON.parse(postData) as { id?: unknown };
    // Require the exact deep-linked ticket filter. An unfiltered first-page
    // response must never be mistaken for the requested ticket.
    return payload.id !== null && payload.id !== undefined && String(payload.id) === ticketId;
  } catch {
    return true;
  }
}

function renderRequestMatches(response: Response, ticketId: string): boolean {
  if (response.request().method() !== 'GET') return false;
  try {
    const url = new URL(response.url());
    return new RegExp(`/api/\\d+/transcripts/${ticketId}/render/?$`).test(url.pathname);
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry-After is either delta-seconds or an HTTP date. Treat an unusable or
 * implausibly long value as absent so a run pauses instead of sleeping for
 * hours behind a stuck UI.
 */
export function parseRetryAfter(
  response: { headers(): Record<string, string> },
): number | null {
  const raw = response.headers()['retry-after'];
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? seconds : null;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  const seconds = Math.ceil((date - Date.now()) / 1000);
  return seconds > 0 ? seconds : 0;
}

function rateLimitMessage(response: { headers(): Record<string, string> }): string {
  const seconds = parseRetryAfter(response);
  return `The dashboard is rate-limiting requests (HTTP 429).${
    seconds !== null ? ` Try again in about ${seconds} second(s).` : ' Wait a few minutes, then resume.'
  } The run was paused before any incomplete record was stored; completed tickets were kept.`;
}

export interface CooldownNotice {
  until: number;
  seconds: number;
  attempt: number;
}

export class DashboardExtractor {
  private directDisabled = false;
  private directFailures = 0;
  /**
   * The dashboard rate-limits bursts, so every direct request passes through
   * one serialized gate. The previous implementation read and wrote
   * nextRequestAt around an await, which let two concurrent tickets claim the
   * same slot and burst. Serializing the slot assignment keeps the true rate at
   * one request per requestDelayMs, regardless of fetchConcurrency.
   */
  private gate: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;
  private cooldownUntil = 0;

  private async throttle(): Promise<void> {
    const spacing = Math.max(500, this.settings.requestDelayMs || 0);
    const task = this.gate.then(async () => {
      const wait = Math.max(this.nextRequestAt, this.cooldownUntil) - Date.now();
      if (wait > 0) await sleep(wait);
      this.nextRequestAt = Date.now() + spacing + Math.floor(Math.random() * 150);
    });
    this.gate = task.catch(() => undefined);
    await task;
  }

  private beginCooldown(seconds: number, attempt: number): void {
    const bounded = Math.min(180, Math.max(1, Math.ceil(seconds)));
    const until = Date.now() + (bounded + 1) * 1000;
    this.cooldownUntil = Math.max(this.cooldownUntil, until);
    this.nextRequestAt = Math.max(this.nextRequestAt, this.cooldownUntil);
    log('warn', 'collector.rate_limit_cooldown', {
      seconds: bounded,
      attempt,
      until: new Date(this.cooldownUntil).toISOString(),
    });
    this.onCooldown?.({ until: this.cooldownUntil, seconds: bounded, attempt });
  }

  constructor(
    private readonly db: Db,
    private readonly page: Page,
    private readonly apiAccess: DashboardApiAccess | null = null,
    private readonly onCooldown: ((notice: CooldownNotice) => void) | null = null,
  ) {}

  private get settings() {
    return this.db.getSettings();
  }

  private get origin(): string {
    try {
      return new URL(this.settings.dashboardUrl).origin;
    } catch {
      return 'https://dashboard.tickets.bot';
    }
  }

  private listUrl(ticketId: string): string {
    return `${this.origin}/manage/${this.settings.guildId}/transcripts?ticket_id=${encodeURIComponent(ticketId)}`;
  }

  private renderUrl(ticketId: string): string {
    return `${this.origin}/manage/${this.settings.guildId}/transcripts/view/${encodeURIComponent(ticketId)}`;
  }

  private async apiFetchPage(
    pageNumber: number,
    timeoutMs: number,
  ): Promise<{ status: number; rows: Record<string, unknown>[]; totalPages: number; totalCount: number } | null> {
    const access = this.apiAccess;
    if (!access) return null;
    const request = this.page.context().request;
    let response: APIResponse;
    let rateLimitAttempt = 0;
    for (;;) {
      await this.throttle();
      response = await request.post(access.transcriptsUrl, {
        data: { page: pageNumber },
        headers: { ...access.headers, 'content-type': 'application/json', accept: 'application/json' },
        timeout: timeoutMs,
      });
      if (response.status() !== 429) break;
      const retryAfter = parseRetryAfter(response);
      // Honour the server's window once. A second consecutive 429 pauses the
      // run instead of hammering the dashboard.
      if (rateLimitAttempt >= 1 || (retryAfter !== null && retryAfter > 180)) {
        throw new RateLimitedError(rateLimitMessage(response));
      }
      rateLimitAttempt += 1;
      this.beginCooldown(retryAfter ?? 60, rateLimitAttempt);
    }
    if (response.status() === 401) {
      throw new AuthRequiredError('The dashboard session expired (HTTP 401).');
    }
    if (response.status() >= 500) {
      throw new Error(`Dashboard server error (HTTP ${response.status()}).`);
    }
    if (!response.ok()) return null;
    let payload: unknown;
    try {
      payload = parseDashboardJson(await response.text());
    } catch {
      return null;
    }
    const body = asRecord(payload);
    if (!body || !Array.isArray(body.transcripts)) return null;
    const rows = body.transcripts
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null);
    return {
      status: response.status(),
      rows,
      totalPages: Number(body.total_pages ?? 0),
      totalCount: Number(body.total_count ?? 0),
    };
  }

  private rowTicketId(row: Record<string, unknown>): string {
    return String(row.ticket_id ?? row.id ?? '');
  }

  /**
   * Walk the dashboard's ordered (descending ID) transcript listing and return
   * every row inside the inclusive range. This replaces one search request per
   * ticket with roughly one request per 15 tickets. Pagination is only trusted
   * when both range boundaries are provably covered; otherwise the caller
   * falls back to per-ID verification and no record is invented.
   */
  async fetchListingRange(startId: string, endId: string): Promise<ListingRange | null> {
    if (!this.apiAccess || this.directDisabled) return null;
    const started = Date.now();
    const settings = this.settings;
    let requests = 0;
    const cache = new Map<number, { rows: Record<string, unknown>[]; totalPages: number }>();
    const fetchPage = async (pageNumber: number) => {
      const cached = cache.get(pageNumber);
      if (cached) return cached;
      requests += 1;
      const page = await this.apiFetchPage(pageNumber, settings.navigationTimeoutMs);
      if (!page) return null;
      const entry = { rows: page.rows, totalPages: page.totalPages };
      cache.set(pageNumber, entry);
      return entry;
    };
    const minId = (rows: Record<string, unknown>[]): bigint | null => {
      let min: bigint | null = null;
      for (const row of rows) {
        const id = this.rowTicketId(row);
        if (!/^\d+$/.test(id)) continue;
        const value = BigInt(id);
        if (min === null || value < min) min = value;
      }
      return min;
    };
    const maxId = (rows: Record<string, unknown>[]): bigint | null => {
      let max: bigint | null = null;
      for (const row of rows) {
        const id = this.rowTicketId(row);
        if (!/^\d+$/.test(id)) continue;
        const value = BigInt(id);
        if (max === null || value > max) max = value;
      }
      return max;
    };

    const start = BigInt(startId);
    const end = BigInt(endId);
    const first = await fetchPage(1);
    if (!first) return null;
    const totalPages = first.totalPages;
    if (!Number.isFinite(totalPages) || totalPages < 1) return null;

    // Pages are ordered by ticket ID descending and IDs are close to dense, so
    // estimate the page directly from the ID gap instead of binary-searching
    // ten pages. A couple of correction probes handle sparse IDs safely.
    let startPage = 1;
    const firstMax = maxId(first.rows);
    const pageSize = Math.max(1, first.rows.length);
    if (firstMax !== null && end < firstMax) {
      let candidate = Math.min(
        totalPages,
        Math.max(1, Math.floor(Number(firstMax - end) / pageSize) + 1),
      );
      for (let probe = 0; probe < 8; probe += 1) {
        const page = await fetchPage(candidate);
        if (!page) return null;
        const pageMin = minId(page.rows);
        const pageMax = maxId(page.rows);
        if (pageMin !== null && pageMin > end) {
          const jump = Math.max(1, Math.floor(Number(pageMin - end) / pageSize));
          const next = Math.min(totalPages, candidate + jump);
          if (next === candidate) break;
          candidate = next;
          continue;
        }
        if (pageMax !== null && pageMax < end) {
          const jump = Math.max(1, Math.floor(Number(end - pageMax) / pageSize));
          const next = Math.max(1, candidate - jump);
          if (next === candidate) break;
          candidate = next;
          continue;
        }
        startPage = candidate;
        break;
      }
    }

    const rows = new Map<string, Record<string, unknown>>();
    let topCovered = false;
    let bottomCovered = false;
    let pagesFetched = 0;
    for (let pageNumber = startPage; pageNumber <= totalPages; pageNumber += 1) {
      const page = await fetchPage(pageNumber);
      if (!page) return null;
      pagesFetched += 1;
      const pageMax = maxId(page.rows);
      const pageMin = minId(page.rows);
      if (pageMax !== null && pageMax >= end) topCovered = true;
      if (pageMin !== null && pageMin <= start) bottomCovered = true;
      for (const row of page.rows) {
        const id = this.rowTicketId(row);
        if (!/^\d+$/.test(id)) continue;
        const value = BigInt(id);
        if (value >= start && value <= end) rows.set(id, row);
      }
      if (pageMin !== null && pageMin < start) break;
      if (pageNumber - startPage > 500) break;
    }
    // A range whose end is above the newest ticket is still fully covered when
    // page 1 starts at or below that end; the same applies at the bottom when
    // the listing ends.
    if (!topCovered && first.rows.length > 0) {
      const pageMax = maxId(first.rows);
      if (pageMax !== null && startPage === 1 && pageMax <= end) topCovered = true;
    }
    if (!bottomCovered) {
      const last = await fetchPage(totalPages);
      const pageMin = last ? minId(last.rows) : null;
      if (pageMin !== null && pageMin <= start) bottomCovered = true;
    }
    const durationMs = Date.now() - started;
    log('info', 'collector.listing', {
      startId,
      endId,
      totalPages,
      startPage,
      pagesFetched,
      requests,
      rows: rows.size,
      complete: topCovered && bottomCovered,
      durationMs,
    });
    return {
      rows,
      complete: topCovered && bottomCovered,
      pagesFetched,
      requests,
      durationMs,
    };
  }

  async fetchIdsByClosedAtRange(
    fromIso: string,
    toIso: string,
  ): Promise<{ ids: string[]; pagesFetched: number; requests: number; durationMs: number; mode: 'closed_at' | 'opened_at_proxy' } | null> {
    if (!this.apiAccess || this.directDisabled) return null;
    const started = Date.now();
    const settings = this.settings;
    const from = new Date(fromIso).getTime();
    const to = new Date(toIso).getTime();
    const ids: string[] = [];
    let pagesFetched = 0;
    let requests = 0;
    let pageNumber = 1;
    let totalPages = 9999;
    let pastRange = false;
    let mode: 'closed_at' | 'opened_at_proxy' = 'closed_at';
    let sawClosedAt = false;

    while (pageNumber <= totalPages && !pastRange) {
      await this.throttle();
      const page = await this.apiFetchPage(pageNumber, settings.navigationTimeoutMs);
      if (!page) break;
      requests += 1;
      totalPages = Math.min(totalPages, page.totalPages);
      pagesFetched += 1;

      let pageHasClosedInRange = false;
      let pageHasOpenedAfterWindow = false;
      let pageHasOpenedAtAll = false;
      let pageIdsAdded = 0;

      for (const row of page.rows) {
        const id = this.rowTicketId(row);
        if (!/^\d+$/.test(id)) continue;

        const closedKey = findKey(row, ['closed_at', 'close_time', 'closed_at_time']);
        const rawClosed = closedKey ? row[closedKey] : undefined;
        const closedIso = normalizeTimestamp(rawClosed);

        if (closedKey) sawClosedAt = true;

        if (closedIso) {
          const closedTime = new Date(closedIso).getTime();
          if (!Number.isNaN(closedTime)) {
            if (closedTime >= from && closedTime < to) {
              ids.push(id);
              pageIdsAdded += 1;
              pageHasClosedInRange = true;
            }
          }
          continue;
        }

        const openedKey = findKey(row, ['opened_at', 'created_at', 'open_time', 'opened_at_time']);
        const rawOpened = openedKey ? row[openedKey] : undefined;
        const openedIso = normalizeTimestamp(rawOpened);
        if (!openedIso) continue;
        pageHasOpenedAtAll = true;
        const openedTime = new Date(openedIso).getTime();
        if (!Number.isNaN(openedTime)) {
          if (openedTime > to) {
            pageHasOpenedAfterWindow = true;
          } else if (openedTime <= to) {
            ids.push(id);
            pageIdsAdded += 1;
          }
        }
      }

      if (mode === 'opened_at_proxy' && pageIdsAdded === 0 && pageHasOpenedAtAll) {
        pastRange = true;
        break;
      }

      if (mode === 'closed_at' && pagesFetched >= 2 && !sawClosedAt) {
        mode = 'opened_at_proxy';
      }

      if (pagesFetched >= 20) {
        log('warn', 'collector.date_listing_page_limit', {
          pagesFetched,
          found: ids.length,
        });
        break;
      }

      pageNumber += 1;
    }

    log('info', 'collector.date_listing', {
      fromIso,
      toIso,
      mode,
      pagesFetched,
      requests,
      found: ids.length,
      durationMs: Date.now() - started,
    });

    return { ids, pagesFetched, requests, durationMs: Date.now() - started, mode };
  }

  private outcomeFromTranscript(
    ticketId: string,
    metadata: TicketMetadata,
    transcript: {
      messages: TranscriptMessage[];
      restricted: boolean;
      firstTimestamp: string | null;
      usernames: Map<string, string>;
    },
  ): ExtractionOutcome {
    const messages = transcript.messages;
    const claim = inferClaim(messages, transcript.usernames);
    const claimed: { state: FieldState; id: string | null; name: string | null } =
      metadata.claimedState === 'unavailable' && claim.state !== 'unavailable'
        ? { state: claim.state, id: claim.id, name: claim.name }
        : {
            state: metadata.claimedState,
            id: metadata.claimedById,
            name: metadata.claimedByName,
          };
    const claimedName =
      claimed.name ?? (claimed.id ? (transcript.usernames.get(claimed.id) ?? null) : null);
    const closedName =
      metadata.closedByName ??
      (metadata.closedById ? (transcript.usernames.get(metadata.closedById) ?? null) : null);
    const openedAt =
      metadata.openedAt ??
      transcript.firstTimestamp ??
      messages.find((message) => message.timestamp)?.timestamp ??
      null;
    const closeEmbed = extractCloseEmbed(messages);
    const closedAt =
      metadata.closedAt ??
      closeEmbed.closedAt ??
      null;
    const closedByName = metadata.closedByName ?? closeEmbed.closedByName;
    const closedById = metadata.closedById ?? closeEmbed.closedById;
    const closeReason = metadata.closeReason ?? closeEmbed.closeReason;
    return {
      found: true,
      ticketId,
      status: transcript.restricted ? 'partial' : 'collected',
      metadata: {
        ...metadata,
        claimedById: claimed.id,
        claimedByName: claimedName,
        claimedState: claimed.state,
        closedByName,
        closedById,
        closedAt,
        closedAtSource: metadata.closedAtSource
          ?? (closeEmbed.closedAt ? 'bot_embed' : null)
          ?? (openedAt ? 'transcript_first_message' : null),
        closeReason,
        closeReasonState:
          metadata.closeReasonState ??
          (closeReason != null ? (closeReason === '' ? 'empty' : 'present') : 'unavailable'),
        openedAt,
        openedAtSource: metadata.openedAtSource ?? (openedAt ? 'transcript_first_message' : null),
        transcriptState: transcript.restricted ? 'restricted' : 'available',
      },
      messages,
      error: transcript.restricted
        ? 'The transcript exists but its content is restricted by the dashboard.'
        : null,
    };
  }

  private noteDirectFailure(reason: string): void {
    this.directFailures += 1;
    log('warn', 'collector.direct_failed', {
      reason,
      failures: this.directFailures,
      disabled: this.directDisabled || this.directFailures >= 3,
    });
    if (this.directFailures >= 3) this.directDisabled = true;
  }

  private withTiming(
    outcome: ExtractionOutcome,
    route: 'direct' | 'navigation',
    started: number,
    listMs: number,
    transcriptMs: number,
  ): ExtractionOutcome {
    return {
      ...outcome,
      timing: { route, listMs, transcriptMs, totalMs: Date.now() - started },
    };
  }

  /**
   * Fast path: call the dashboard's own authenticated JSON API. The SPA uses a
   * bearer token and x-tickets header that are not cookies, so they are captured
   * from the dashboard's request by ConnectionManager. When a listing row is
   * already known, only the transcript request is needed. Any unexpected shape
   * returns null and the caller falls back to the verified navigation path.
   */
  private async tryDirectExtraction(
    ticketId: string,
    listingRow?: Record<string, unknown>,
  ): Promise<ExtractionOutcome | null> {
    const access = this.apiAccess;
    if (!access || this.directDisabled) return null;
    const request = this.page.context().request;
    const started = Date.now();
    let row: Record<string, unknown> | null = listingRow ?? null;
    let listMs = 0;

    if (!row) {
      const listStarted = Date.now();
      let listResponse: APIResponse;
      let rateLimitAttempt = 0;
      for (;;) {
        try {
          await this.throttle();
          listResponse = await request.post(access.transcriptsUrl, {
            data: { page: 1, id: ticketId },
            headers: { ...access.headers, 'content-type': 'application/json', accept: 'application/json' },
            timeout: this.settings.navigationTimeoutMs,
          });
        } catch {
          return null;
        }
        if (listResponse.status() !== 429) break;
        const retryAfter = parseRetryAfter(listResponse);
        if (rateLimitAttempt >= 1 || (retryAfter !== null && retryAfter > 180)) {
          throw new RateLimitedError(rateLimitMessage(listResponse));
        }
        rateLimitAttempt += 1;
        this.beginCooldown(retryAfter ?? 60, rateLimitAttempt);
      }
      listMs = Date.now() - listStarted;
      if (listResponse.status() === 401) {
        throw new AuthRequiredError('The dashboard session expired (HTTP 401).');
      }
      if (listResponse.status() >= 500) {
        throw new Error(`Dashboard server error (HTTP ${listResponse.status()}).`);
      }
      if (!listResponse.ok()) {
        this.noteDirectFailure(`HTTP ${listResponse.status()}`);
        return null;
      }

      let payload: unknown;
      try {
        payload = parseDashboardJson(await listResponse.text());
      } catch {
        this.noteDirectFailure('invalid JSON');
        return null;
      }
      const body = asRecord(payload);
      const rows = body?.transcripts;
      if (!Array.isArray(rows)) {
        this.noteDirectFailure('missing transcripts array');
        return null;
      }
      row = rows
        .map((item) => asRecord(item))
        .find((item) => item && this.rowTicketId(item) === ticketId) ?? null;
      if (!row) {
        // An empty exact filter is a genuine miss. A non-empty unfiltered page
        // means the direct request did not apply the filter; verify by navigation.
        if (rows.length > 0) {
          this.noteDirectFailure('list filter was ignored');
          return null;
        }
        return this.withTiming(
          {
            found: false,
            ticketId,
            status: 'not_found',
            metadata: null,
            messages: [],
            error: null,
          },
          'direct',
          started,
          listMs,
          0,
        );
      }
    }

    const metadata = mapListRow(ticketId, row, this.settings.guildId, this.origin);
    const hasTranscriptKey = findKey(row, ['has_transcript']);
    const hasTranscript = hasTranscriptKey ? row[hasTranscriptKey] !== false : null;
    if (hasTranscript === false) {
      return this.withTiming(
        {
          found: true,
          ticketId,
          status: 'no_transcript',
          metadata: { ...metadata, transcriptState: 'unavailable' },
          messages: [],
          error: null,
        },
        'direct',
        started,
        listMs,
        0,
      );
    }

    const transcriptStarted = Date.now();
    try {
      const transcript = await this.fetchTranscriptDirect(ticketId);
      const transcriptMs = Date.now() - transcriptStarted;
      this.directFailures = 0;
      return this.withTiming(
        this.outcomeFromTranscript(ticketId, metadata, transcript),
        'direct',
        started,
        listMs,
        transcriptMs,
      );
    } catch (error) {
      if (error instanceof TranscriptUnavailableError) {
        return this.withTiming(
          {
            found: true,
            ticketId,
            status: 'partial',
            metadata: {
              ...metadata,
              transcriptState: error.restricted ? 'restricted' : 'unavailable',
            },
            messages: [],
            error: error.message,
          },
          'direct',
          started,
          listMs,
          Date.now() - transcriptStarted,
        );
      }
      throw error;
    }
  }

  metadataFromListingRow(ticketId: string, row: Record<string, unknown>): TicketMetadata {
    return mapListRow(ticketId, row, this.settings.guildId, this.origin);
  }

  async extractTicket(
    ticketId: string,
    listingRow?: Record<string, unknown>,
  ): Promise<ExtractionOutcome> {
    const direct = await this.tryDirectExtraction(ticketId, listingRow);
    if (direct) return direct;
    const navigationStarted = Date.now();
    // Navigation is the fallback path, but it still counts against the same
    // dashboard budget. Space it through the shared gate too.
    await this.throttle();
    let listResponse: Response | null = null;
    const listPromise = this.page
      .waitForResponse((response) => listRequestMatches(response, ticketId), {
        timeout: this.settings.navigationTimeoutMs,
      })
      .catch(() => null);
    try {
      await this.page.goto(this.listUrl(ticketId), {
        waitUntil: 'domcontentloaded',
        timeout: this.settings.navigationTimeoutMs,
      });
      listResponse = await listPromise;
    } catch (error) {
      if (this.page.isClosed()) {
        throw new AuthRequiredError('The dedicated browser window was closed during collection.');
      }
      throw error;
    }

    if (!listResponse) {
      if (this.page.url().match(/\/login|\/oauth2|discord\.com/i)) {
        throw new AuthRequiredError(
          'The dashboard session expired and redirected to sign-in. Reconnect, then resume the run.',
        );
      }
      throw new StructureChangedError(
        'The dashboard did not return its transcript list response for this ticket ID.',
      );
    }
    if (listResponse.status() === 401) {
      throw new AuthRequiredError('The dashboard session expired (HTTP 401).');
    }
    if (listResponse.status() === 403) {
      throw new AuthRequiredError('The dashboard denied access to transcripts (HTTP 403).');
    }
    if (listResponse.status() === 429) {
      throw new RateLimitedError(rateLimitMessage(listResponse));
    }
    if (listResponse.status() >= 500) {
      throw new Error(`Dashboard server error (HTTP ${listResponse.status()}).`);
    }
    if (!listResponse.ok()) {
      throw new StructureChangedError(
        `The transcript list request returned HTTP ${listResponse.status()}.`,
      );
    }

    let payload: unknown;
    try {
      payload = parseDashboardJson(await listResponse.text());
    } catch {
      throw new StructureChangedError('The dashboard transcript list was not valid JSON.');
    }
    const body = asRecord(payload);
    const rows = body?.transcripts;
    if (!Array.isArray(rows)) {
      throw new StructureChangedError(
        'The dashboard transcript list response did not contain a transcripts array.',
      );
    }
    const row = rows
      .map((item) => asRecord(item))
      .find((item) => item && String(item.ticket_id ?? item.id ?? '') === ticketId);
    if (!row) {
      return this.withTiming(
        {
          found: false,
          ticketId,
          status: 'not_found',
          metadata: null,
          messages: [],
          error: null,
        },
        'navigation',
        navigationStarted,
        Date.now() - navigationStarted,
        0,
      );
    }
    const metadata = mapListRow(ticketId, row, this.settings.guildId, this.origin);
    const hasTranscriptKey = findKey(row, ['has_transcript']);
    const hasTranscript = hasTranscriptKey ? row[hasTranscriptKey] !== false : null;

    if (hasTranscript === false) {
      return this.withTiming(
        {
          found: true,
          ticketId,
          status: 'no_transcript',
          metadata: { ...metadata, transcriptState: 'unavailable' },
          messages: [],
          error: null,
        },
        'navigation',
        navigationStarted,
        Date.now() - navigationStarted,
        0,
      );
    }

    const transcriptStarted = Date.now();
    try {
      const transcript = await this.fetchTranscript(ticketId);
      return this.withTiming(
        this.outcomeFromTranscript(ticketId, metadata, transcript),
        'navigation',
        navigationStarted,
        Date.now() - navigationStarted,
        Date.now() - transcriptStarted,
      );
    } catch (error) {
      if (error instanceof TranscriptUnavailableError) {
        return this.withTiming(
          {
            found: true,
            ticketId,
            status: 'partial',
            metadata: {
              ...metadata,
              transcriptState: error.restricted ? 'restricted' : 'unavailable',
            },
            messages: [],
            error: error.message,
          },
          'navigation',
          navigationStarted,
          Date.now() - navigationStarted,
          Date.now() - transcriptStarted,
        );
      }
      throw error;
    }
  }

  private async fetchTranscriptDirect(ticketId: string): Promise<{
    messages: TranscriptMessage[];
    restricted: boolean;
    firstTimestamp: string | null;
    usernames: Map<string, string>;
  }> {
    const access = this.apiAccess;
    if (!access) {
      throw new TranscriptUnavailableError('Direct dashboard access is not available.', false);
    }
    let response: APIResponse;
    let rateLimitAttempt = 0;
    for (;;) {
      await this.throttle();
      response = await this.page.context().request.get(
        `${access.transcriptsUrl}/${encodeURIComponent(ticketId)}/render`,
        {
          headers: { ...access.headers, accept: 'application/json' },
          timeout: this.settings.navigationTimeoutMs,
        },
      );
      if (response.status() !== 429) break;
      const retryAfter = parseRetryAfter(response);
      if (rateLimitAttempt >= 1 || (retryAfter !== null && retryAfter > 180)) {
        throw new RateLimitedError(rateLimitMessage(response));
      }
      rateLimitAttempt += 1;
      this.beginCooldown(retryAfter ?? 60, rateLimitAttempt);
    }
    if (response.status() === 401) {
      throw new AuthRequiredError('The dashboard session expired while loading a transcript (HTTP 401).');
    }
    if (response.status() === 403) {
      throw new TranscriptUnavailableError(
        'The transcript is restricted or this account lacks permission to view it.',
        true,
      );
    }
    if (!response.ok()) {
      throw new TranscriptUnavailableError(
        `The transcript request returned HTTP ${response.status()}.`,
        false,
      );
    }
    let payload: unknown;
    try {
      payload = parseDashboardJson(await response.text());
    } catch {
      throw new TranscriptUnavailableError('The transcript response was not valid JSON.', false);
    }
    return mapMessages(payload);
  }

  private async fetchTranscript(ticketId: string): Promise<{
    messages: TranscriptMessage[];
    restricted: boolean;
    firstTimestamp: string | null;
    usernames: Map<string, string>;
  }> {
    const responsePromise = this.page
      .waitForResponse((response) => renderRequestMatches(response, ticketId), {
        timeout: this.settings.navigationTimeoutMs,
      })
      .catch(() => null);
    await this.page.goto(this.renderUrl(ticketId), {
      waitUntil: 'domcontentloaded',
      timeout: this.settings.navigationTimeoutMs,
    });
    const response = await responsePromise;
    if (!response) {
      throw new TranscriptUnavailableError(
        'The transcript page did not return a transcript response.',
        false,
      );
    }
    if (response.status() === 401) {
      throw new AuthRequiredError('The dashboard session expired while loading a transcript (HTTP 401).');
    }
    if (response.status() === 403) {
      throw new TranscriptUnavailableError(
        'The transcript is restricted or this account lacks permission to view it.',
        true,
      );
    }
    if (!response.ok()) {
      throw new TranscriptUnavailableError(
        `The transcript request returned HTTP ${response.status()}.`,
        false,
      );
    }
    let payload: unknown;
    try {
      payload = parseDashboardJson(await response.text());
    } catch {
      throw new TranscriptUnavailableError('The transcript response was not valid JSON.', false);
    }
    return mapMessages(payload);
  }
}

/** Map a failed extraction to a user-facing collection error without raw stack traces. */
export function describeExtractionError(error: unknown): string {
  if (error instanceof AuthRequiredError) return error.message;
  if (error instanceof RateLimitedError) return error.message;
  if (error instanceof StructureChangedError) return error.message;
  if (error instanceof TranscriptUnavailableError) return error.message;
  if (error instanceof Error) {
    if (/Timeout|timeout/i.test(error.message)) {
      return 'The dashboard did not respond before the timeout.';
    }
    if (/net::|ERR_|ECONN|fetch failed/i.test(error.message)) {
      return 'A network error occurred while contacting the dashboard.';
    }
    return 'The ticket could not be retrieved from the dashboard.';
  }
  return 'The ticket could not be retrieved from the dashboard.';
}

export function extractionDiagnostics(outcome: ExtractionOutcome): Record<string, unknown> {
  const metadata = outcome.metadata;
  return {
    found: outcome.found,
    status: outcome.status,
    transcript: metadata?.transcriptState ?? null,
    hasCloseReason: metadata?.closeReasonState ?? null,
    claimant: metadata?.claimedState ?? null,
    closer: metadata?.closedState ?? null,
    messages: outcome.messages.length,
    error: outcome.error,
    route: outcome.timing?.route ?? null,
    listMs: outcome.timing?.listMs ?? null,
    transcriptMs: outcome.timing?.transcriptMs ?? null,
    totalMs: outcome.timing?.totalMs ?? null,
  };
}

export function logExtraction(outcome: ExtractionOutcome): void {
  log('info', 'collector.ticket', extractionDiagnostics(outcome));
}

// Bot embeds include a close timestamp in ISO8601 format at embeds[0].timestamp.
// This uses that authoritative field when present, avoiding brittle text parsing.
export function parseEmbedCloseTimestamp(embed: Record<string, unknown>): Date | null {
  const rawTimestamp = embed.timestamp != null ? String(embed.timestamp) : '';
  if (!rawTimestamp) return null;
  const parsed = new Date(rawTimestamp);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export interface CloseEmbed {
  closedAt: string | null;
  closedByName: string | null;
  closedById: string | null;
  closeReason: string | null;
}

export function extractCloseEmbed(messages: TranscriptMessage[]): CloseEmbed {
  const botMessage = messages.find((message) => message.embeds.length > 0) ?? null;
  if (!botMessage) return { closedAt: null, closedByName: null, closedById: null, closeReason: null };

  const rawEmbed = botMessage.embeds.map(asRecord).find((embed): embed is Record<string, unknown> => embed !== null);
  const embed = rawEmbed ? (rawEmbed.title === 'Ticket Closed' ? rawEmbed : rawEmbed) : null;
  if (!embed) return { closedAt: null, closedByName: null, closedById: null, closeReason: null };

  const timestamp = parseEmbedCloseTimestamp(embed);
  const closedAt = timestamp ? timestamp.toISOString() : null;

  const fields = Array.isArray(embed.fields) ? embed.fields : [];
  const byName = fields.find((field: Record<string, unknown>) => /Closed By/i.test(String(field.name ?? '')));
  const reasonField = fields.find((field: Record<string, unknown>) => /Reason/i.test(String(field.name ?? '')));
  const closedByName = byName?.value ? String(byName.value).trim() : null;
  const closedById = findMentionId(closedByName);
  const closeReason = reasonField?.value ? String(reasonField.value).trim() : null;

  return { closedAt, closedByName, closedById, closeReason };
}

export type { TicketMetadata };
