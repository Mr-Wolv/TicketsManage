import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { Db } from '../server/db.js';
import { ConnectionManager } from '../server/connection.js';
import { AssessmentService } from '../server/assessment-service.js';
import { CollectionService } from '../server/collection-service.js';
import { MAX_RANGE_SIZE, MISSING_IDS_MAX_WINDOW } from '../server/config.js';
import type { TicketMetadata } from '../server/types.js';

/**
 * Ticket Explorer's "uncollected IDs in this interval" report.
 *
 * These run against the real application stack (createApp) over real HTTP, so
 * the route, its validation and the SQL are the shipped ones. "Missing" means
 * "no local ticket record": the app never claims an ID does not exist on the
 * dashboard, and computing the report must not create, score or review anything.
 */

let db: Db;
let server: http.Server;

function ticket(overrides: Partial<TicketMetadata> = {}): TicketMetadata {
  return {
    ticketId: '1000',
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
    ticketUrl: 'https://dashboard.tickets.bot/ticket/1000',
    transcriptState: 'available',
    labels: [],
    rawListRow: null,
    ...overrides,
  };
}

function seed(ticketId: string, isDemo = false): void {
  db.upsertTicket(
    {
      ...ticket({ ticketId, ticketUrl: `https://dashboard.tickets.bot/ticket/${ticketId}` }),
      collectionStatus: 'collected',
      collectionError: null,
    },
    isDemo,
  );
}

interface Result {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: <T = any>() => T;
}

async function request(method: string, path: string): Promise<Result> {
  if (!server.listening) {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  }
  const address = server.address();
  const port: number = typeof address === 'object' && address ? address.port : 1;

  return new Promise<Result>((resolve, reject) => {
    const req = http.request({ method, path, host: '127.0.0.1', port }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          text,
          json: <T,>() => JSON.parse(text) as T,
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

async function report(
  start: string,
  end: string,
  extra = '',
): Promise<{
  status: number;
  count: number;
  missingIds: string[];
  rangeSize: number;
  collectedInRange: number;
  truncated: boolean;
  scope: string;
  error: { code: string; message: string } | null;
}> {
  const result = await request(
    'GET',
    `/api/tickets/missing-ids?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}${extra}`,
  );
  const body = result.json();
  return {
    status: result.status,
    count: body.count,
    missingIds: body.missingIds ?? [],
    rangeSize: body.rangeSize,
    collectedInRange: body.collectedInRange,
    truncated: body.truncated,
    scope: body.scope,
    error: body.error ?? null,
  };
}

beforeEach(() => {
  db = new Db(':memory:');
  db.open();
  const connection = new ConnectionManager(db);
  const assessments = new AssessmentService(db);
  const collection = new CollectionService(db, connection, assessments);
  server = http.createServer(createApp({ db, connection, assessments, collection }));
});

afterEach(() => {
  server.close();
  db.close();
});

describe('uncollected IDs in an interval', () => {
  it('reports no gaps when every ID in the interval is collected', async () => {
    for (const id of ['100', '101', '102', '103', '104']) seed(id);
    const result = await report('100', '104');
    expect(result.status).toBe(200);
    expect(result.missingIds).toEqual([]);
    expect(result.count).toBe(0);
    expect(result.rangeSize).toBe(5);
    expect(result.collectedInRange).toBe(5);
    expect(result.truncated).toBe(false);
  });

  it('identifies exactly the internal gaps', async () => {
    for (const id of ['100', '101', '104', '107']) seed(id);
    const result = await report('100', '107');
    expect(result.missingIds).toEqual(['102', '103', '105', '106']);
    expect(result.count).toBe(4);
    expect(result.rangeSize).toBe(8);
    expect(result.collectedInRange).toBe(4);
  });

  it('includes both boundaries, and reports a missing boundary', async () => {
    for (const id of ['100', '101', '102']) seed(id);

    const tail = await report('100', '105');
    expect(tail.missingIds).toEqual(['103', '104', '105']);

    const head = await report('97', '102');
    expect(head.missingIds).toEqual(['97', '98', '99']);

    const both = await report('98', '104');
    expect(both.missingIds).toEqual(['98', '99', '103', '104']);

    // Both boundaries present and nothing in between.
    seed('103');
    seed('104');
    expect((await report('100', '104')).missingIds).toEqual([]);
  });

  it('treats a single-ID interval like any other interval', async () => {
    seed('100');
    const present = await report('100', '100');
    expect(present.missingIds).toEqual([]);
    expect(present.collectedInRange).toBe(1);

    const absent = await report('101', '101');
    expect(absent.missingIds).toEqual(['101']);
    expect(absent.collectedInRange).toBe(0);

    seed('0');
    const zero = await report('0', '0');
    expect(zero.missingIds).toEqual([]);
  });

  it('reports the whole interval as uncollected against an empty collection', async () => {
    const result = await report('500', '504');
    expect(result.status).toBe(200);
    expect(result.missingIds).toEqual(['500', '501', '502', '503', '504']);
    expect(result.collectedInRange).toBe(0);
    expect(result.rangeSize).toBe(5);

    // Nothing was invented to represent the gap.
    expect(db.listTickets({ includeDemo: true }).total).toBe(0);
    expect(db.getTicket('500')).toBeNull();
  });

  it('handles sparse, noncontiguous IDs without leaking markers outside the interval', async () => {
    for (const id of ['999', '1000', '5000', '90000', '123456']) seed(id);

    const result = await report('998', '1001');
    expect(result.missingIds).toEqual(['998', '1001']);
    expect(result.collectedInRange).toBe(2);

    const around = await report('4999', '5001');
    expect(around.missingIds).toEqual(['4999', '5001']);

    const wide = await report('1000', '5000');
    const numeric = wide.missingIds.map(Number);
    expect(numeric[0]).toBe(1001);
    expect(numeric[numeric.length - 1]).toBe(4999);
    expect(wide.missingIds).not.toContain('1000');
    expect(wide.missingIds).not.toContain('5000');
    expect(wide.missingIds.every((id) => Number(id) >= 1000 && Number(id) <= 5000)).toBe(true);
    expect(wide.collectedInRange).toBe(2);
  });

  it('sorts numerically, never lexicographically', async () => {
    // Lexicographic order would place "10" before "9" and "100" before "99".
    seed('10');
    const result = await report('1', '20');
    expect(result.missingIds).toEqual([
      '1', '2', '3', '4', '5', '6', '7', '8', '9',
      '11', '12', '13', '14', '15', '16', '17', '18', '19', '20',
    ]);
    expect(result.missingIds.indexOf('9')).toBeLessThan(result.missingIds.indexOf('11'));

    seed('99');
    const wide = await report('1', '100');
    expect(wide.missingIds.indexOf('98')).toBeLessThan(wide.missingIds.indexOf('100'));
    expect(wide.missingIds[wide.missingIds.length - 1]).toBe('100');
  });

  it('keeps IDs beyond the safe integer range exact', async () => {
    // 2^53 + 1 and 2^53 + 3 are not representable as doubles; rounding them (or
    // casting the stored text to SQLite INTEGER) would report a collected ID as
    // missing.
    seed('9007199254740993');
    const single = await report('9007199254740993', '9007199254740993');
    expect(single.missingIds).toEqual([]);
    expect(single.collectedInRange).toBe(1);

    seed('9007199254740995');
    const wide = await report('9007199254740992', '9007199254740995');
    expect(wide.missingIds).toEqual(['9007199254740992', '9007199254740994']);
    expect(wide.collectedInRange).toBe(2);
  });

  it('scopes the report the same way the ticket list is scoped', async () => {
    seed('1000');
    seed('1001', true); // demo record

    const real = await report('1000', '1001');
    expect(real.scope).toBe('collection');
    expect(real.collectedInRange).toBe(1);
    expect(real.missingIds).toEqual(['1001']);

    const demo = await report('1000', '1001', '&demo=only');
    expect(demo.scope).toBe('demo');
    expect(demo.collectedInRange).toBe(1);
    expect(demo.missingIds).toEqual(['1000']);

    const all = await report('1000', '1001', '&demo=include');
    expect(all.scope).toBe('all');
    expect(all.collectedInRange).toBe(2);
    expect(all.missingIds).toEqual([]);
  });
});

describe('uncollected ID intervals with malformed input', () => {
  it('requires two usable IDs instead of guessing', async () => {
    const missingBoth = await request('GET', '/api/tickets/missing-ids');
    expect(missingBoth.status).toBe(400);
    expect(missingBoth.json().error.code).toBe('INVALID_ID_RANGE');

    const missingEnd = await request('GET', '/api/tickets/missing-ids?start=100');
    expect(missingEnd.status).toBe(400);

    const repeated = await request('GET', '/api/tickets/missing-ids?start=1&start=2&end=5');
    expect(repeated.status).toBe(400);

    // Express turns a repeated/array parameter into an array; a non-string must
    // be rejected, not coerced into "1,2".
    const array = await request('GET', '/api/tickets/missing-ids?start[]=1&start[]=2&end=5');
    expect(array.status).toBe(400);
    expect(array.json().error.code).toBe('INVALID_ID_RANGE');
  });

  it('refuses malformed, fractional, negative, reversed and ambiguous IDs', async () => {
    const cases: Array<[string, string]> = [
      ['abc', '10'],
      ['1', 'abc'],
      ['1.5', '10'],
      ['1', '1.5'],
      ['-1', '10'],
      ['1', '-10'],
      ['200', '100'],
      ['007', '10'],
      ['1', '010'],
      ['1e3', '1000'],
      ['  ', '10'],
      ['0x10', '20'],
      ['10', '10.0'],
    ];
    for (const [start, end] of cases) {
      const result = await report(start, end);
      expect(result.status, `${start}..${end} should be refused`).toBe(400);
      expect(result.error?.code, `${start}..${end}`).toBe('INVALID_ID_RANGE');
      expect(result.missingIds).toEqual([]);
    }
  });

  it('refuses an oversized interval instead of quietly returning nothing', async () => {
    const beyondRangeLimit = await report('1', String(MAX_RANGE_SIZE + 1));
    expect(beyondRangeLimit.status).toBe(400);
    expect(beyondRangeLimit.error?.code).toBe('INVALID_ID_RANGE');

    const beyondWindow = await report('1', String(MISSING_IDS_MAX_WINDOW + 1));
    expect(beyondWindow.status).toBe(400);
    expect(beyondWindow.error?.code).toBe('ID_RANGE_TOO_LARGE');
    expect(beyondWindow.error?.message).toMatch(/Narrow it/i);

    // The largest allowed window still answers, in ascending order.
    const atLimit = await report('1', String(MISSING_IDS_MAX_WINDOW));
    expect(atLimit.status).toBe(200);
    expect(atLimit.missingIds).toHaveLength(MISSING_IDS_MAX_WINDOW);
    expect(atLimit.missingIds[0]).toBe('1');
    expect(atLimit.missingIds.at(-1)).toBe(String(MISSING_IDS_MAX_WINDOW));
    expect(atLimit.truncated).toBe(false);
  });

  it('answers an extremely long all-digit interval without an internal error', async () => {
    const huge = '9'.repeat(40);
    const result = await report(huge, huge);
    expect(result.status).toBe(200);
    expect(result.missingIds).toEqual([huge]);
    expect(result.rangeSize).toBe(1);

    const health = await request('GET', '/api/health');
    expect(health.status).toBe(200);
  });
});

describe('computing uncollected IDs writes nothing', () => {
  function counts(): { tickets: number; assessments: number; reviews: number; runs: number } {
    const scalar = (sql: string): number =>
      Number((db.connection.prepare(sql).get() as { n: number }).n);
    return {
      tickets: scalar('SELECT COUNT(*) AS n FROM tickets'),
      assessments: scalar('SELECT COUNT(*) AS n FROM assessments'),
      reviews: scalar('SELECT COUNT(*) AS n FROM reviews'),
      runs: scalar('SELECT COUNT(*) AS n FROM collection_runs'),
    };
  }

  it('leaves tickets, assessments, reviews and runs untouched', async () => {
    for (const id of ['1000', '1002']) seed(id);
    const assessments = new AssessmentService(db);
    await assessments.assessTicket('1000');
    await assessments.assessTicket('1002');

    const before = counts();
    const pendingBefore = db.listReviews('pending').length;
    const overviewBefore = db.overview(false, false);

    expect(before.tickets).toBe(2);
    expect(before.assessments).toBe(2);

    for (const [start, end] of [
      ['999', '1003'],
      ['1000', '1000'],
      ['1', '100'],
      ['500', '500'],
      ['1000', '9000'],
    ]) {
      const result = await report(start!, end!);
      expect(result.status).toBe(200);
    }

    expect(counts()).toEqual(before);
    expect(db.listReviews('pending').length).toBe(pendingBefore);
    expect(db.overview(false, false)).toEqual(overviewBefore);

    // The gap was never materialised as a record, and scored totals are unchanged.
    expect(db.getTicket('1001')).toBeNull();
    expect(db.getAssessment('1001')).toBeNull();
    expect(db.getReview('1001')).toBeNull();
    expect(db.listTickets({}).items.map((item) => item.ticketId).sort()).toEqual(['1000', '1002']);
    expect(Number.isFinite(db.getAssessment('1000')!.awardedPoints ?? 1)).toBe(true);
  });
});
