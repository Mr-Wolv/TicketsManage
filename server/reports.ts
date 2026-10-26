import type { Db, TicketListFilters } from './db.js';
import type { CategoryId, TicketRecord } from './types.js';
import { TAXONOMY_BY_ID } from './classifier/taxonomy.js';

export interface StaffReportFilters {
  from?: string;
  to?: string;
  dateBasis?: 'opened' | 'activity';
  includeDemo?: boolean;
  demoOnly?: boolean;
  staff?: string;
}

export interface StaffCategoryBreakdown {
  categoryId: CategoryId;
  code: string;
  label: string;
  points: number;
  tickets: number;
}

export interface StaffReportRow {
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
  categories: StaffCategoryBreakdown[];
}

export interface StaffReport {
  generatedAt: string;
  period: { from: string | null; to: string | null; dateBasis: 'opened' | 'activity' };
  includesDemo: boolean;
  demoOnly: boolean;
  filters: { staff: string | null };
  rows: StaffReportRow[];
  totals: {
    staffCount: number;
    ticketsCredited: number;
    awardedPoints: number;
    unresolvedCredit: number;
    fallbackTickets: number;
    ratedTickets: number;
    dateSource: DateSourceBreakdown;
  };
  methodology: string;
}

function loadTickets(db: Db, filters: StaffReportFilters): TicketRecord[] {
  const items: TicketRecord[] = [];
  let page = 1;
  for (;;) {
    const result = db.listTickets({
      page,
      pageSize: 200,
      includeDemo: filters.includeDemo,
      demoOnly: filters.demoOnly,
      from: filters.from,
      to: filters.to,
      dateBasis: filters.dateBasis,
      staff: filters.staff,
      sort: 'id',
      dir: 'asc',
    } satisfies TicketListFilters);
    items.push(...result.items);
    if (items.length >= result.total || result.items.length === 0) break;
    page += 1;
    if (page > 500) break;
  }
  return items;
}

function keyFor(id: string | null, name: string | null): string | null {
  if (id && id.trim()) return `id:${id.trim()}`;
  if (name && name.trim()) return `name:${name.trim().toLowerCase()}`;
  return null;
}

function newRow(key: string, id: string | null, name: string | null): StaffReportRow {
  return {
    staffKey: key,
    staffId: id,
    staffName: name,
    ticketsCredited: 0,
    awardedPoints: 0,
    sameClaimClose: 0,
    unclaimedHalf: 0,
    differentZero: 0,
    fallbackTickets: 0,
    ratingSum: 0,
    ratingCount: 0,
    avgRating: null,
    categories: [],
  };
}

export interface DateSourceBreakdown {
  closedAt: number;
  lastActivity: number;
  openedAt: number;
  collectedAt: number;
}

export function buildStaffReport(db: Db, filters: StaffReportFilters): StaffReport {
  const tickets = loadTickets(db, filters);
  const rows = new Map<string, StaffReportRow>();
  let unresolvedCredit = 0;
  let fallbackTickets = 0;
  let ratedTickets = 0;
  const dateSource: DateSourceBreakdown = { closedAt: 0, lastActivity: 0, openedAt: 0, collectedAt: 0 };

  const ensure = (id: string | null, name: string | null): StaffReportRow | null => {
    const key = keyFor(id, name);
    if (!key) return null;
    let row = rows.get(key);
    if (!row) {
      row = newRow(key, id, name);
      rows.set(key, row);
    }
    if (!row.staffName && name) row.staffName = name;
    if (!row.staffId && id) row.staffId = id;
    return row;
  };

  for (const ticket of tickets) {
    const assessment = ticket.assessment;
    if (!assessment) continue;
    if (assessment.fallback) fallbackTickets += 1;
    if (assessment.creditStatus === 'unresolved') unresolvedCredit += 1;

    if (ticket.closedAt) dateSource.closedAt += 1;
    else if (ticket.lastActivityAt) dateSource.lastActivity += 1;
    else if (ticket.openedAt) dateSource.openedAt += 1;
    else dateSource.collectedAt += 1;

    const involved: Array<StaffReportRow | null> = [];
    if (assessment.creditStatus === 'zero_different') {
      involved.push(ensure(ticket.claimedById, ticket.claimedByName));
      involved.push(ensure(ticket.closedById, ticket.closedByName));
    } else if (
      assessment.creditStatus === 'awarded' ||
      (assessment.creditRule === 'B' && assessment.awardedPoints !== null) ||
      (assessment.creditRule === 'C' && assessment.awardedPoints !== null)
    ) {
      involved.push(ensure(assessment.creditStaffId, assessment.creditStaffName));
    }
    for (const row of involved) {
      if (row && assessment.fallback) row.fallbackTickets += 1;
    }

    if (assessment.creditRule === 'A' && assessment.creditStatus === 'zero_different') {
      if (involved[0]) involved[0].differentZero += 1;
      if (involved[1]) involved[1].differentZero += 1;
      continue;
    }

    if (
      (assessment.creditStatus !== 'awarded' && assessment.creditStatus !== 'none') ||
      assessment.awardedPoints === null
    ) {
      continue;
    }
    const row = ensure(assessment.creditStaffId, assessment.creditStaffName);
    if (!row) continue;
    if (assessment.creditRule === 'B') row.sameClaimClose += 1;
    if (assessment.creditRule === 'C') row.unclaimedHalf += 1;
    const awarded = assessment.awardedPoints;
    if (awarded > 0) {
      row.ticketsCredited += 1;
      row.awardedPoints += awarded;
      if (assessment.basePoints > 0) {
        for (const category of assessment.categories) {
          const share = (category.points / assessment.basePoints) * awarded;
          let breakdown = row.categories.find((item) => item.categoryId === category.categoryId);
          if (!breakdown) {
            const definition = TAXONOMY_BY_ID[category.categoryId]!;
            breakdown = {
              categoryId: category.categoryId,
              code: definition.code,
              label: definition.label,
              points: 0,
              tickets: 0,
            };
            row.categories.push(breakdown);
          }
          breakdown.points += share;
          breakdown.tickets += 1;
        }
      }
    }
    if (ticket.rating !== null) {
      row.ratingSum += ticket.rating;
      row.ratingCount += 1;
      ratedTickets += 1;
    }
  }

  const resultRows = [...rows.values()]
    .map((row) => ({
      ...row,
      awardedPoints: round2(row.awardedPoints),
      avgRating: row.ratingCount > 0 ? round2(row.ratingSum / row.ratingCount) : null,
      categories: row.categories
        .map((category) => ({ ...category, points: round2(category.points) }))
        .sort((a, b) => b.points - a.points || a.code.localeCompare(b.code)),
    }))
    .sort((a, b) => b.awardedPoints - a.awardedPoints || (a.staffName ?? '').localeCompare(b.staffName ?? ''));

  const totals = resultRows.reduce(
    (sum, row) => {
      sum.ticketsCredited += row.ticketsCredited;
      sum.awardedPoints += row.awardedPoints;
      return sum;
    },
    { ticketsCredited: 0, awardedPoints: 0 },
  );

  return {
    generatedAt: new Date().toISOString(),
    period: {
      from: filters.from ?? null,
      to: filters.to ?? null,
      dateBasis: filters.dateBasis ?? 'opened',
    },
    includesDemo: Boolean(filters.includeDemo),
    demoOnly: Boolean(filters.demoOnly),
    filters: { staff: filters.staff ?? null },
    rows: resultRows,
    totals: {
      staffCount: resultRows.length,
      ticketsCredited: totals.ticketsCredited,
      awardedPoints: round2(totals.awardedPoints),
      unresolvedCredit,
      fallbackTickets,
      ratedTickets,
      dateSource,
    },
    methodology:
      'Totals sum the final staff awards produced by the deterministic staff-credit rules, never raw ticket base scores. Different confirmed claimant/closer = zero for both; same claimant/closer = full base; confirmed unclaimed with reason = half base to closer; unclaimed without reason = zero; missing identities = unresolved. Ratings are averaged only across credited tickets with a real rating; missing ratings are excluded, not treated as zero. ' +
      (filters.dateBasis === 'activity'
        ? 'The date basis is activity: the last transcript message timestamp, which is the closest available evidence of when a ticket closed. The dashboard exposes no closure timestamp, so a ticket can have been closed shortly after its last message. Tickets with no messages fall back to their opening time.'
        : 'The date basis is opening: tickets are placed in the day they were opened. The dashboard exposes no closure timestamp.'),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
