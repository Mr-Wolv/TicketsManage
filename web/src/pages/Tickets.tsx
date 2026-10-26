import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, download, formatDate, formatNumber, formatPoints } from '../api';
import { useApp } from '../context';
import { TicketDetail } from '../components/TicketDetail';
import {
  Alert,
  CategoryChips,
  EmptyState,
  PageHeader,
  SectionCard,
  StatusBadge,
  ToneBadge,
  ValueOrUnavailable,
} from '../components/ui';
import type { Ticket } from '../types';

interface TicketFilters {
  search: string;
  staff: string;
  category: string;
  fallback: string;
  reviewStatus: string;
  status: string;
  from: string;
  to: string;
  sort: string;
  dir: string;
}

const INITIAL_FILTERS: TicketFilters = {
  search: '',
  staff: '',
  category: '',
  fallback: '',
  reviewStatus: '',
  status: '',
  from: '',
  to: '',
  sort: 'id',
  dir: 'desc',
};

export function TicketsPage() {
  const { taxonomy, taxonomyById, demoMode } = useApp();
  const [filters, setFilters] = useState<TicketFilters>(INITIAL_FILTERS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [data, setData] = useState<{ items: Ticket[]; total: number; page: number; pageSize: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (filters.search) params.set('search', filters.search);
      if (filters.staff) params.set('staff', filters.staff);
      if (filters.category) params.set('category', filters.category);
      if (filters.fallback) params.set('fallback', filters.fallback);
      if (filters.reviewStatus) params.set('reviewStatus', filters.reviewStatus);
      if (filters.status) params.set('status', filters.status);
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);
      params.set('sort', filters.sort);
      params.set('dir', filters.dir);
      if (demoMode) params.set('demo', 'only');
      const result = await api<{ items: Ticket[]; total: number; page: number; pageSize: number }>(
        `/api/tickets?${params.toString()}`,
      );
      setData(result);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Tickets could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [filters, page, pageSize, demoMode]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 250);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    setPage(1);
  }, [filters.search, filters.staff, filters.category, filters.fallback, filters.reviewStatus, filters.status, filters.from, filters.to, filters.sort, filters.dir, demoMode]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const hasFilters = useMemo(
    () => Object.entries(filters).some(([key, value]) => key !== 'sort' && key !== 'dir' && value !== ''),
    [filters],
  );

  const update = (key: keyof TicketFilters, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  const exportQuery = new URLSearchParams();
  if (filters.from) exportQuery.set('from', filters.from);
  if (filters.to) exportQuery.set('to', filters.to);
  if (filters.staff) exportQuery.set('staff', filters.staff);
  if (demoMode) exportQuery.set('demo', 'only');

  return (
    <div className="page">
      <PageHeader
        eyebrow="Local records"
        title="Ticket explorer"
        description="Every row is backed by collected dashboard data. Unavailable fields are shown as unavailable, never as zero."
        actions={
          <>
            <button className="button button-ghost" onClick={() => download(`/api/export/tickets?format=json&${exportQuery}`)}>
              Export JSON
            </button>
            <button className="button button-ghost" onClick={() => download(`/api/export/tickets?format=csv&${exportQuery}`)}>
              Export CSV
            </button>
          </>
        }
      />

      {demoMode ? (
        <Alert tone="info" title="Viewing synthetic demo records only">
          Real records are hidden until you turn demo mode off in the header.
        </Alert>
      ) : null}

      <SectionCard title="Filters">
        <div className="filter-grid">
          <label className="field field-wide">
            <span className="field-label">Search</span>
            <input
              className="input"
              placeholder="Ticket ID, opener, claimant, closer or reason"
              value={filters.search}
              onChange={(event) => update('search', event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">Staff member</span>
            <input
              className="input"
              placeholder="Name or staff ID"
              value={filters.staff}
              onChange={(event) => update('staff', event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">Category</span>
            <select className="input" value={filters.category} onChange={(event) => update('category', event.target.value)}>
              <option value="">All categories</option>
              {taxonomy.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.code} · {category.points} pts
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Fallback</span>
            <select className="input" value={filters.fallback} onChange={(event) => update('fallback', event.target.value)}>
              <option value="">Any</option>
              <option value="true">Fallback only</option>
              <option value="false">No fallback</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">Review status</span>
            <select className="input" value={filters.reviewStatus} onChange={(event) => update('reviewStatus', event.target.value)}>
              <option value="">Any</option>
              <option value="pending">Pending</option>
              <option value="accepted">Accepted</option>
              <option value="corrected">Corrected</option>
              <option value="dismissed">Dismissed</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">Collection status</span>
            <select className="input" value={filters.status} onChange={(event) => update('status', event.target.value)}>
              <option value="">Any</option>
              <option value="collected">Collected</option>
              <option value="partial">Partial</option>
              <option value="no_transcript">No transcript</option>
              <option value="failed">Failed</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">From date</span>
            <input type="date" className="input" value={filters.from} onChange={(event) => update('from', event.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">To date</span>
            <input type="date" className="input" value={filters.to} onChange={(event) => update('to', event.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Sort</span>
            <select
              className="input"
              value={`${filters.sort}:${filters.dir}`}
              onChange={(event) => {
                const [sort, dir] = event.target.value.split(':');
                setFilters((current) => ({ ...current, sort: sort ?? 'id', dir: dir ?? 'desc' }));
              }}
            >
              <option value="id:desc">Ticket ID (newest first)</option>
              <option value="id:asc">Ticket ID (oldest first)</option>
              <option value="collected:desc">Collected time</option>
              <option value="base:desc">Base points</option>
              <option value="awarded:desc">Awarded points</option>
              <option value="reason:asc">Closing reason</option>
            </select>
          </label>
          {hasFilters ? (
            <button className="button button-ghost button-small filter-clear" onClick={() => setFilters(INITIAL_FILTERS)}>
              Clear filters
            </button>
          ) : null}
        </div>
      </SectionCard>

      {error ? <Alert tone="danger" title="Ticket explorer error">{error}</Alert> : null}

      <SectionCard
        title={
          <>
            {formatNumber(data?.total ?? 0)} ticket{data?.total === 1 ? '' : 's'}
            {loading ? <span className="muted"> · refreshing…</span> : null}
          </>
        }
        actions={
          <label className="inline-select">
            <span>Rows</span>
            <select
              className="input input-small"
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value));
                setPage(1);
              }}
            >
              <option value={10}>10</option>
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
          </label>
        }
      >
        {!data || data.items.length === 0 ? (
          <EmptyState
            title={loading ? 'Loading tickets…' : 'No tickets match these filters'}
            description={
              loading
                ? 'Reading local records.'
                : hasFilters
                  ? 'Adjust the filters to widen the search.'
                  : 'Collect a verified ticket range to populate the explorer.'
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Opener</th>
                  <th>Claimed by</th>
                  <th>Closed by</th>
                  <th>Closing reason</th>
                  <th>Category</th>
                  <th className="num">Base</th>
                  <th>Staff credit</th>
                  <th className="num">Awarded</th>
                  <th>Review</th>
                  <th>Collected</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((ticket) => (
                  <tr key={ticket.ticketId} onClick={() => setSelected(ticket.ticketId)} className="clickable-row">
                    <td>
                      <div className="ticket-id">#{ticket.ticketId}</div>
                      <div className="inline-badges">
                        <StatusBadge value={ticket.collectionStatus} />
                        {ticket.isDemo ? <ToneBadge tone="accent">demo</ToneBadge> : null}
                      </div>
                    </td>
                    <td>
                      <ValueOrUnavailable value={ticket.openerUsername} />
                      <div className="cell-sub">{formatDate(ticket.openedAt)}</div>
                    </td>
                    <td>
                      <ValueOrUnavailable
                        value={ticket.claimedByName ?? ticket.claimedById}
                        state={ticket.claimedState}
                        unavailableLabel="Unavailable"
                      />
                      {ticket.claimedState === 'unclaimed' ? <div className="cell-sub">confirmed unclaimed</div> : null}
                    </td>
                    <td>
                      <ValueOrUnavailable
                        value={ticket.closedByName ?? ticket.closedById}
                        state={ticket.closedState}
                        unavailableLabel="Unavailable"
                      />
                    </td>
                    <td className="reason-cell">
                      {ticket.closeReasonState === 'unavailable' ? (
                        <span className="unavailable">Unavailable</span>
                      ) : ticket.closeReasonState === 'empty' ? (
                        <span className="muted">Empty</span>
                      ) : (
                        <span dir="auto" title={ticket.closeReason ?? ''}>
                          {ticket.closeReason}
                        </span>
                      )}
                    </td>
                    <td>
                      {ticket.assessment ? (
                        <CategoryChips
                          categories={ticket.assessment.categories}
                          taxonomyById={taxonomyById}
                          fallback={ticket.assessment.fallback}
                        />
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="num">{ticket.assessment ? formatPoints(ticket.assessment.basePoints) : '—'}</td>
                    <td>
                      {ticket.assessment ? (
                        <div>
                          <StatusBadge value={ticket.assessment.creditStatus} />
                          {ticket.assessment.creditStaffName ? (
                            <div className="cell-sub">{ticket.assessment.creditStaffName}</div>
                          ) : null}
                        </div>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="num">
                      {ticket.assessment?.awardedPoints === null || ticket.assessment === null
                        ? ticket.assessment?.creditStatus === 'unresolved'
                          ? 'Unresolved'
                          : '—'
                        : formatPoints(ticket.assessment.awardedPoints)}
                    </td>
                    <td>{ticket.review ? <StatusBadge value={ticket.review.status} /> : <span className="muted">—</span>}</td>
                    <td className="cell-sub">
                      {formatDate(ticket.collectedAt)}
                      {ticket.messageCount ? <div>{ticket.messageCount} messages</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data && data.items.length > 0 ? (
          <div className="pagination">
            <button className="button button-ghost button-small" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1}>
              Previous
            </button>
            <span>
              Page {data.page} of {totalPages}
            </span>
            <button
              className="button button-ghost button-small"
              onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
              disabled={page >= totalPages}
            >
              Next
            </button>
          </div>
        ) : null}
      </SectionCard>

      {selected ? <TicketDetail ticketId={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}
