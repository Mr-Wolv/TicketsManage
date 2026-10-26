import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, download, formatDate, formatPoints } from '../api';
import { useApp } from '../context';
import {
  Alert,
  CategoryChips,
  EmptyState,
  LoadingBlock,
  PageHeader,
  SectionCard,
  StatusBadge,
  ToneBadge,
} from '../components/ui';
import type { ReviewHistory, ReviewItem, Ticket } from '../types';

const TABS = [
  { id: 'pending', label: 'Pending' },
  { id: 'all', label: 'All' },
  { id: 'accepted', label: 'Accepted' },
  { id: 'corrected', label: 'Corrected' },
  { id: 'dismissed', label: 'Dismissed' },
];

export function ReviewsPage() {
  const { taxonomy, taxonomyById, demoMode, notify, refreshStatus } = useApp();
  const [status, setStatus] = useState('pending');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [fallbackOnly, setFallbackOnly] = useState(false);
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ item: ReviewItem | null; ticket: Ticket; history: ReviewHistory[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [approveAlias, setApproveAlias] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ status });
      if (search) params.set('search', search);
      if (category) params.set('category', category);
      if (fallbackOnly) params.set('fallback', 'true');
      if (demoMode) params.set('demo', 'only');
      const result = await api<{ items: ReviewItem[]; counts: Record<string, number> }>(
        `/api/reviews?${params.toString()}`,
      );
      setItems(result.items);
      setCounts(result.counts);
      setError(null);
      if (result.items.length === 0) {
        setSelectedId(null);
      } else if (!selectedId || !result.items.some((item) => item.ticketId === selectedId)) {
        setSelectedId(result.items[0]!.ticketId);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'The review queue could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [status, search, category, fallbackOnly, demoMode, selectedId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadList(), 250);
    return () => window.clearTimeout(timer);
  }, [loadList]);

  const loadDetail = useCallback(
    async (ticketId: string) => {
      setDetailLoading(true);
      setActionError(null);
      setActionMessage(null);
      try {
        const result = await api<{ item: ReviewItem | null; ticket: Ticket; history: ReviewHistory[] }>(
          `/api/reviews/${ticketId}`,
        );
        setDetail(result);
        setSelectedCategories(
          (result.item?.categories ?? []).map((entry) => entry.categoryId),
        );
        setNote('');
        setApproveAlias(true);
      } catch (loadError) {
        setActionError(loadError instanceof Error ? loadError.message : 'The review item could not be loaded.');
        setDetail(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  const toggleCategory = (id: string) => {
    setSelectedCategories((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  };

  const previewBase = useMemo(
    () =>
      selectedCategories.reduce(
        (sum, id) => sum + (taxonomy.find((entry) => entry.id === id)?.points ?? 0),
        0,
      ),
    [selectedCategories, taxonomy],
  );

  const act = async (action: 'accept' | 'correct' | 'dismiss' | 'reassess') => {
    if (!selectedId) return;
    if (action === 'correct' && selectedCategories.length === 0 && detail?.item?.closeReasonState !== 'empty') {
      notify('Select at least one category for a nonempty closing reason.', 'error');
      return;
    }
    if (action === 'dismiss' && note.trim().length === 0) {
      notify('Add a short note explaining why this review item is being dismissed.', 'error');
      return;
    }
    setBusy(action);
    setActionError(null);
    setActionMessage(null);
    try {
      const body =
        action === 'correct'
          ? { categoryIds: selectedCategories, note, approveAlias }
          : action === 'accept' || action === 'dismiss'
            ? { note }
            : {};
      const result = await api<{ message?: string; reviewResolved?: boolean; stillPending?: boolean; aliasConflict?: boolean }>(
        `/api/reviews/${selectedId}/${action}`,
        { method: 'POST', body: JSON.stringify(body) },
      );
      setActionMessage(result.message ?? 'Action saved.');
      if (result.aliasConflict) {
        notify(
          'Correction saved. The approved alias replaced an earlier conflicting mapping; the previous alias is retained in history.',
          'info',
        );
      } else {
        notify(result.message ?? 'Review updated.');
      }
      await loadList();
      await loadDetail(selectedId);
      await refreshStatus();
    } catch (actionFailure) {
      setActionError(actionFailure instanceof Error ? actionFailure.message : 'The action failed.');
    } finally {
      setBusy(null);
    }
  };

  const exportParams = new URLSearchParams({ status });
  if (demoMode) exportParams.set('demo', 'only');

  return (
    <div className="page">
      <PageHeader
        eyebrow="Feedback loop"
        title="Review queue"
        description="Fallbacks, disagreements and unresolved attribution stay here until accepted, corrected or dismissed."
        actions={
          <>
            <button className="button button-ghost" onClick={() => download(`/api/export/reviews?format=json&${exportParams}`)}>
              Export JSON
            </button>
            <button className="button button-ghost" onClick={() => download(`/api/export/reviews?format=csv&${exportParams}`)}>
              Export CSV
            </button>
          </>
        }
      />

      {demoMode ? (
        <Alert tone="info" title="Reviewing synthetic demo items">
          These are not real tickets. Real review items are hidden while demo mode is on.
        </Alert>
      ) : null}

      <div className="tabs" role="tablist" aria-label="Review status">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={status === tab.id}
            className={`tab${status === tab.id ? ' tab-active' : ''}`}
            onClick={() => {
              setStatus(tab.id);
              setSelectedId(null);
            }}
          >
            {tab.label}
            {counts[tab.id] !== undefined ? <span className="tab-count">{counts[tab.id]}</span> : null}
          </button>
        ))}
      </div>

      <SectionCard>
        <div className="filter-grid review-filters">
          <label className="field field-wide">
            <span className="field-label">Search</span>
            <input
              className="input"
              placeholder="Ticket ID, closing reason or staff name"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">Category</span>
            <select className="input" value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="">Any category</option>
              {taxonomy.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.code}
                </option>
              ))}
            </select>
          </label>
          <label className="check-row checkbox-inline">
            <input type="checkbox" checked={fallbackOnly} onChange={(event) => setFallbackOnly(event.target.checked)} />
            <span>Fallback only</span>
          </label>
        </div>
      </SectionCard>

      {error ? <Alert tone="danger" title="Review queue error">{error}</Alert> : null}

      <div className="review-layout">
        <SectionCard title={`${items.length} item${items.length === 1 ? '' : 's'}`} className="review-list-card">
          {loading && items.length === 0 ? <LoadingBlock label="Loading review items…" /> : null}
          {!loading && items.length === 0 ? (
            <EmptyState
              title="Nothing to review here"
              description={
                status === 'pending'
                  ? 'No pending review items. Fallbacks and uncertain classifications appear here automatically.'
                  : 'No items match this status and filter.'
              }
            />
          ) : (
            <div className="review-list">
              {items.map((item) => (
                <button
                  key={item.ticketId}
                  className={`review-list-item${selectedId === item.ticketId ? ' review-list-active' : ''}`}
                  onClick={() => setSelectedId(item.ticketId)}
                >
                  <div className="inline-between">
                    <strong>#{item.ticketId}</strong>
                    <StatusBadge value={item.status} />
                  </div>
                  <p className="review-reason" dir="auto">
                    {item.originalCloseReason ??
                      (item.closeReasonState === 'unavailable' ? 'Closing reason unavailable' : 'Empty closing reason')}
                  </p>
                  <div className="inline-badges">
                    <CategoryChips
                      categories={item.categories}
                      taxonomyById={taxonomyById}
                      fallback={item.fallback}
                    />
                    {item.credit?.status === 'unresolved' ? <ToneBadge tone="warn">attribution unresolved</ToneBadge> : null}
                    {item.isDemo ? <ToneBadge tone="accent">demo</ToneBadge> : null}
                  </div>
                  <span className="cell-sub">
                    {item.reasons.length} review reason{item.reasons.length === 1 ? '' : 's'} · updated{' '}
                    {formatDate(item.updatedAt)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </SectionCard>

        <div className="review-detail">
          {detailLoading ? (
            <SectionCard>
              <LoadingBlock label="Loading review item…" />
            </SectionCard>
          ) : null}
          {!detailLoading && !detail ? (
            <SectionCard>
              <EmptyState title="Select a review item" description="Choose an item on the left to inspect its evidence and correction controls." />
            </SectionCard>
          ) : null}
          {detail && !detailLoading ? (
            <>
              <SectionCard
                title={
                  <span className="review-detail-title">
                    #{detail.ticket.ticketId}
                    <StatusBadge value={detail.item?.status ?? detail.ticket.review?.status ?? 'pending'} />
                    {detail.item?.fallback ? <ToneBadge tone="warn">fallback</ToneBadge> : null}
                    {detail.ticket.isDemo ? <ToneBadge tone="accent">demo</ToneBadge> : null}
                  </span>
                }
                actions={
                  detail.ticket.ticketUrl ? (
                    <a className="button button-ghost button-small" href={detail.ticket.ticketUrl} target="_blank" rel="noreferrer">
                      Dashboard source
                    </a>
                  ) : null
                }
              >
                <div className="stack">
                  {actionError ? <Alert tone="danger" title="Action failed">{actionError}</Alert> : null}
                  {actionMessage ? <Alert tone="info" title="Saved">{actionMessage}</Alert> : null}
                  <div>
                    <span className="detail-label">Original closing reason (preserved)</span>
                    <p className="original-reason" dir="auto">
                      {detail.item?.originalCloseReason ??
                        (detail.item?.closeReasonState === 'unavailable'
                          ? 'Unavailable — extraction failed. This is not an empty reason.'
                          : 'Confirmed empty closing reason.')}
                    </p>
                  </div>
                  <div className="review-evidence-grid">
                    <div>
                      <span className="detail-label">Current categories</span>
                      <CategoryChips
                        categories={detail.item?.categories ?? []}
                        taxonomyById={taxonomyById}
                        fallback={detail.item?.fallback}
                        emptyLabel="No categories"
                      />
                    </div>
                    <div>
                      <span className="detail-label">Base points</span>
                      <strong>{formatPoints(detail.item?.basePoints ?? 0)}</strong>
                    </div>
                    <div>
                      <span className="detail-label">Method</span>
                      <span>{detail.item?.method.replaceAll('_', ' ') ?? '—'}</span>
                    </div>
                    <div>
                      <span className="detail-label">Credit</span>
                      <span>
                        {detail.item?.credit
                          ? `Rule ${detail.item.credit.rule} · ${detail.item.credit.status.replaceAll('_', ' ')}`
                          : '—'}
                      </span>
                    </div>
                  </div>
                  <div>
                    <span className="detail-label">Review reasons</span>
                    <ul className="plain-list">
                      {(detail.item?.reasons ?? []).map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  </div>
                  {detail.item?.explanation ? <p className="explanation">{detail.item.explanation}</p> : null}
                  {detail.item?.alternatives.length ? (
                    <div>
                      <span className="detail-label">Alternatives considered</span>
                      <ul className="plain-list">
                        {detail.item.alternatives.map((alternative) => (
                          <li key={alternative.categoryId}>
                            <strong>{taxonomyById[alternative.categoryId]?.code ?? alternative.categoryId}</strong> —{' '}
                            {alternative.reason}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <div className="compare-grid">
                    <div className="compare-cell">
                      <span className="detail-label">Claimed by</span>
                      <span>{detail.item?.claimedBy.name ?? detail.item?.claimedBy.id ?? 'Unavailable'}</span>
                      <span className="detail-note">{detail.item?.claimedBy.state.replaceAll('_', ' ')}</span>
                    </div>
                    <div className="compare-cell">
                      <span className="detail-label">Closed by</span>
                      <span>{detail.item?.closedBy.name ?? detail.item?.closedBy.id ?? 'Unavailable'}</span>
                      <span className="detail-note">{detail.item?.closedBy.state.replaceAll('_', ' ')}</span>
                    </div>
                    <div className="compare-cell">
                      <span className="detail-label">Awarded points</span>
                      <span>
                        {detail.item?.credit?.awardedPoints === null || detail.item?.credit?.awardedPoints === undefined
                          ? 'Unresolved'
                          : formatPoints(detail.item.credit.awardedPoints)}
                      </span>
                      <span className="detail-note">{detail.item?.credit?.staffName ?? 'No identified staff'}</span>
                    </div>
                  </div>
                </div>
              </SectionCard>

              {detail.ticket.messages.length > 0 ? (
                <SectionCard title="Transcript context" description="Useful context, not mandatory proof of the closing reason.">
                  <div className="transcript transcript-compact">
                    {detail.ticket.messages.slice(-8).map((message) => (
                      <div className="transcript-message" key={`${message.seq}-${message.messageId ?? ''}`}>
                        <div className="transcript-meta">
                          <strong>{message.authorName ?? 'Unknown author'}</strong>
                          <span>{formatDate(message.timestamp)}</span>
                        </div>
                        <p className="transcript-content" dir="auto">
                          {message.content || <span className="muted">[no text content]</span>}
                        </p>
                      </div>
                    ))}
                  </div>
                  {detail.ticket.messages.length > 8 ? (
                    <p className="muted">Showing the last 8 messages of {detail.ticket.messages.length}.</p>
                  ) : null}
                </SectionCard>
              ) : null}

              {detail.ticket.review?.status === 'pending' ? (
                <SectionCard title="Resolve this item" description="Corrections are stored as history; the original dashboard reason is never overwritten.">
                  <div className="stack">
                    <div>
                      <span className="detail-label">Correct categories</span>
                      <div className="category-selector">
                        {taxonomy.map((entry) => (
                          <label
                            key={entry.id}
                            className={`category-option${selectedCategories.includes(entry.id) ? ' category-option-selected' : ''}`}
                          >
                            <input
                              type="checkbox"
                              checked={selectedCategories.includes(entry.id)}
                              onChange={() => toggleCategory(entry.id)}
                            />
                            <span>
                              <strong>{entry.code}</strong>
                              <span className="muted"> · {entry.labelAr}</span>
                              <span className="chip-points">{entry.points} pts</span>
                            </span>
                          </label>
                        ))}
                      </div>
                      <p className="muted">
                        Selected base points: <strong>{formatPoints(previewBase)}</strong>. Staff credit is recalculated
                        deterministically after the correction.
                      </p>
                    </div>
                    <label className="field">
                      <span className="field-label">Note (included in the correction history)</span>
                      <textarea
                        className="input textarea"
                        rows={2}
                        value={note}
                        onChange={(event) => setNote(event.target.value)}
                        placeholder="Why is this correction or dismissal appropriate?"
                      />
                    </label>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={approveAlias}
                        onChange={(event) => setApproveAlias(event.target.checked)}
                        disabled={detail.ticket.closeReasonState !== 'present'}
                      />
                      <span>
                        Approve this exact wording as a reusable alias for the selected categories. Conflicts are detected
                        and the previous mapping is retained in history.
                      </span>
                    </label>
                    <div className="button-row">
                      <button className="button button-secondary" onClick={() => void act('accept')} disabled={busy !== null}>
                        {busy === 'accept' ? 'Accepting…' : 'Accept prediction'}
                      </button>
                      <button
                        className="button button-primary"
                        onClick={() => void act('correct')}
                        disabled={busy !== null || detail.ticket.closeReasonState === 'empty'}
                      >
                        {busy === 'correct' ? 'Saving…' : 'Save correction'}
                      </button>
                      <button
                        className="button button-danger-ghost"
                        onClick={() => void act('dismiss')}
                        disabled={busy !== null}
                      >
                        {busy === 'dismiss' ? 'Dismissing…' : 'Dismiss with note'}
                      </button>
                      <button className="button button-ghost" onClick={() => void act('reassess')} disabled={busy !== null}>
                        {busy === 'reassess' ? 'Reassessing…' : 'Reassess'}
                      </button>
                    </div>
                    <p className="muted">
                      Accepting or correcting a classification does not fabricate missing staff attribution. If attribution
                      is unresolved, the item stays open until you dismiss it with a note.
                    </p>
                  </div>
                </SectionCard>
              ) : (
                <Alert tone="success" title="This review item is resolved">
                  Status: {detail.ticket.review?.status}. It remains searchable in the All tab and in the correction history.
                </Alert>
              )}

              {detail.history.length > 0 ? (
                <SectionCard title="Correction history">
                  <ol className="history-list">
                    {detail.history.map((entry) => (
                      <li key={entry.id}>
                        <div className="inline-between">
                          <strong>{entry.action}</strong>
                          <span className="muted">{formatDate(entry.createdAt)}</span>
                        </div>
                        {entry.previousCategories || entry.newCategories ? (
                          <div className="muted">
                            {entry.previousCategories?.join(', ') || 'none'} → {entry.newCategories?.join(', ') || 'none'}
                          </div>
                        ) : null}
                        {entry.note ? <p>{entry.note}</p> : null}
                      </li>
                    ))}
                  </ol>
                </SectionCard>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
