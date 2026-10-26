import { useCallback, useEffect, useState } from 'react';
import { api, formatDate, formatPoints } from '../api';
import { useApp } from '../context';
import type { ReviewHistory, Ticket } from '../types';
import {
  Alert,
  CategoryChips,
  LoadingBlock,
  SectionCard,
  StatusBadge,
  ToneBadge,
  ValueOrUnavailable,
} from './ui';

export function TicketDetail({
  ticketId,
  onClose,
  onOpenReview,
}: {
  ticketId: string;
  onClose: () => void;
  onOpenReview?: (ticketId: string) => void;
}) {
  const { taxonomyById, notify } = useApp();
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [history, setHistory] = useState<ReviewHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api<{ ticket: Ticket; history: ReviewHistory[] }>(`/api/tickets/${ticketId}`);
      setTicket(result.ticket);
      setHistory(result.history);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'The ticket could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [ticketId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const reassess = async () => {
    setBusy(true);
    try {
      const result = await api<{ ticket: Ticket; history: ReviewHistory[] }>(
        `/api/tickets/${ticketId}/reassess`,
        { method: 'POST', body: '{}' },
      );
      setTicket(result.ticket);
      setHistory(result.history);
      notify('Ticket reassessed with the current classifier and scoring rules.');
    } catch (actionError) {
      notify(actionError instanceof Error ? actionError.message : 'Reassessment failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const assessment = ticket?.assessment;
  const review = ticket?.review;

  return (
    <div className="drawer-overlay" role="dialog" aria-modal="true" aria-label={`Ticket ${ticketId}`}>
      <button className="drawer-backdrop" aria-label="Close details" onClick={onClose} />
      <aside className="drawer">
        <header className="drawer-head">
          <div>
            <span className="eyebrow">Ticket detail</span>
            <h2>#{ticketId}</h2>
            <div className="inline-badges">
              {ticket ? <StatusBadge value={ticket.collectionStatus} /> : null}
              {review ? <StatusBadge value={review.status} /> : null}
              {ticket?.isDemo ? <ToneBadge tone="accent">Synthetic demo</ToneBadge> : null}
            </div>
          </div>
          <div className="drawer-head-actions">
            {ticket?.ticketUrl ? (
              <a className="button button-ghost button-small" href={ticket.ticketUrl} target="_blank" rel="noreferrer">
                Open in dashboard
              </a>
            ) : null}
            <button className="icon-button" onClick={onClose} aria-label="Close">
              ×
            </button>
          </div>
        </header>

        <div className="drawer-body">
          {loading ? <LoadingBlock label="Loading ticket…" /> : null}
          {error ? <Alert tone="danger" title="Ticket unavailable">{error}</Alert> : null}
          {ticket && !loading ? (
            <>
              {ticket.collectionError ? (
                <Alert tone="warn" title="Collection note">
                  {ticket.collectionError}
                </Alert>
              ) : null}
              {ticket.collectionStatus === 'partial' ? (
                <Alert tone="warn" title="Partial record">
                  The ticket metadata was collected, but the transcript could not be fully retrieved. Missing fields are
                  shown as unavailable, not as zero or empty.
                </Alert>
              ) : null}

              <SectionCard title="Original ticket information">
                <div className="detail-grid">
                  <div>
                    <span className="detail-label">Opened by</span>
                    <ValueOrUnavailable value={ticket.openerUsername} />
                  </div>
                  <div>
                    <span className="detail-label">Opening time</span>
                    <ValueOrUnavailable value={formatDate(ticket.openedAt)} state={ticket.openedAt ? undefined : 'unavailable'} />
                    {ticket.openedAtSource === 'transcript_first_message' ? (
                      <span className="detail-note">Derived from the first transcript message</span>
                    ) : null}
                  </div>
                  <div>
                    <span className="detail-label">Claimed by</span>
                    <ValueOrUnavailable
                      value={ticket.claimedByName ?? ticket.claimedById}
                      state={ticket.claimedState}
                      unavailableLabel="Field unavailable"
                    />
                    {ticket.claimedState === 'unclaimed' ? <span className="detail-note">Confirmed unclaimed</span> : null}
                  </div>
                  <div>
                    <span className="detail-label">Closed by</span>
                    <ValueOrUnavailable
                      value={ticket.closedByName ?? ticket.closedById}
                      state={ticket.closedState}
                      unavailableLabel="Field unavailable"
                    />
                  </div>
                  <div>
                    <span className="detail-label">Closed at</span>
                    <ValueOrUnavailable value={formatDate(ticket.closedAt)} state={ticket.closedAt ? undefined : 'unavailable'} />
                  </div>
                  <div>
                    <span className="detail-label">Player rating</span>
                    {ticket.rating === null ? (
                      <span className="unavailable">No rating / unavailable</span>
                    ) : (
                      <span>{ticket.rating} / 5</span>
                    )}
                  </div>
                  <div>
                    <span className="detail-label">Transcript</span>
                    <StatusBadge
                      value={
                        ticket.transcriptState === 'available'
                          ? 'collected'
                          : ticket.transcriptState === 'restricted'
                            ? 'partial'
                            : 'no_transcript'
                      }
                      label={
                        ticket.transcriptState === 'available'
                          ? `${ticket.messages.length} messages`
                          : ticket.transcriptState === 'restricted'
                            ? 'Restricted'
                            : 'Unavailable'
                      }
                    />
                  </div>
                  <div>
                    <span className="detail-label">Labels</span>
                    {ticket.labels.length ? ticket.labels.join(', ') : <span className="muted">—</span>}
                  </div>
                </div>
                <div className="reason-block">
                  <div className="reason-head">
                    <span className="detail-label">Closing reason (original, unmodified)</span>
                    <ToneBadge tone={ticket.closeReasonState === 'present' ? 'info' : 'neutral'}>
                      {ticket.closeReasonState}
                    </ToneBadge>
                  </div>
                  {ticket.closeReasonState === 'unavailable' ? (
                    <p className="unavailable">The closing reason could not be extracted. This is not treated as an empty reason.</p>
                  ) : ticket.closeReasonState === 'empty' ? (
                    <p className="muted">Confirmed empty closing reason.</p>
                  ) : (
                    <p className="original-reason" dir="auto">
                      {ticket.closeReason}
                    </p>
                  )}
                </div>
              </SectionCard>

              <SectionCard
                title="Classification & scoring"
                description="Category points are assigned by the application from the fixed taxonomy. The model never sets point values."
                actions={
                  assessment && !assessment.humanCorrected ? (
                    <button className="button button-ghost button-small" onClick={reassess} disabled={busy}>
                      {busy ? 'Reassessing…' : 'Reassess'}
                    </button>
                  ) : null
                }
              >
                {!assessment ? (
                  <Alert tone="info" title="Not classified yet">
                    This ticket has not been classified. Enable classification during collection or reassess it later.
                  </Alert>
                ) : (
                  <div className="stack">
                    {assessment.fallback ? (
                      <Alert tone="warn" title="General problem fallback">
                        No defensible category match was found for the nonempty closing reason. The existing General Issue
                        category is used with 2 base points and the item requires review.
                      </Alert>
                    ) : null}
                    {assessment.humanCorrected ? (
                      <Alert tone="success" title="Manager correction preserved">
                        This classification was corrected by a manager and will not be overwritten by reassessment.
                      </Alert>
                    ) : null}
                    <div className="inline-between">
                      <CategoryChips
                        categories={assessment.categories}
                        taxonomyById={taxonomyById}
                        fallback={assessment.fallback}
                      />
                      <div className="score-cluster">
                        <span>Base <strong>{formatPoints(assessment.basePoints)}</strong></span>
                        <span>Method <strong>{assessment.method.replaceAll('_', ' ')}</strong></span>
                        <span>
                          Confidence <strong>{assessment.confidence === null ? 'n/a' : `${Math.round(assessment.confidence * 100)}%`}</strong>
                        </span>
                      </div>
                    </div>
                    <div className="category-breakdown">
                      {assessment.categories.map((category) => (
                        <div className="breakdown-row" key={category.categoryId}>
                          <div>
                            <strong>{taxonomyById[category.categoryId]?.code ?? category.categoryId}</strong>
                            <span className="muted"> · {taxonomyById[category.categoryId]?.labelAr}</span>
                          </div>
                          <span>+{formatPoints(category.points)} pts</span>
                          <span className="muted">{category.method}</span>
                        </div>
                      ))}
                    </div>
                    <p className="explanation">{assessment.explanation}</p>
                    {assessment.alternatives.length > 0 ? (
                      <div>
                        <span className="detail-label">Alternative candidates</span>
                        <ul className="plain-list">
                          {assessment.alternatives.map((alternative) => (
                            <li key={alternative.categoryId}>
                              <strong>{taxonomyById[alternative.categoryId]?.code ?? alternative.categoryId}</strong> —{' '}
                              {alternative.reason}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {assessment.unresolvedPortion ? (
                      <Alert tone="warn" title="Unresolved portion">
                        {assessment.unresolvedPortion}
                      </Alert>
                    ) : null}
                  </div>
                )}
              </SectionCard>

              <SectionCard title="Staff credit">
                {!assessment ? (
                  <p className="muted">No assessment yet.</p>
                ) : (
                  <div className="stack">
                    <div className="inline-between">
                      <div className="inline-badges">
                        <ToneBadge tone={assessment.creditStatus === 'awarded' ? 'success' : assessment.creditStatus === 'unresolved' ? 'warn' : 'neutral'}>
                          Rule {assessment.creditRule} · {assessment.creditStatus.replaceAll('_', ' ')}
                        </ToneBadge>
                        {assessment.creditStaffName || assessment.creditStaffId ? (
                          <span className="credit-staff">
                            {assessment.creditStaffName ?? `Staff ${assessment.creditStaffId}`}
                          </span>
                        ) : null}
                      </div>
                      <div className="award-value">
                        {assessment.awardedPoints === null ? 'Award unresolved' : `${formatPoints(assessment.awardedPoints)} awarded`}
                      </div>
                    </div>
                    <p className="explanation">{assessment.creditExplanation}</p>
                    <div className="compare-grid">
                      <div className="compare-cell">
                        <span className="detail-label">Claimant</span>
                        <ValueOrUnavailable
                          value={ticket.claimedByName ?? ticket.claimedById}
                          state={ticket.claimedState}
                          unavailableLabel="Field unavailable"
                        />
                        <span className="detail-note">{ticket.claimedState.replaceAll('_', ' ')}</span>
                      </div>
                      <div className="compare-cell">
                        <span className="detail-label">Closer</span>
                        <ValueOrUnavailable
                          value={ticket.closedByName ?? ticket.closedById}
                          state={ticket.closedState}
                          unavailableLabel="Field unavailable"
                        />
                        <span className="detail-note">{ticket.closedState.replaceAll('_', ' ')}</span>
                      </div>
                    </div>
                  </div>
                )}
              </SectionCard>

              {review ? (
                <SectionCard
                  title="Review status"
                  actions={
                    onOpenReview && review.status === 'pending' ? (
                      <button className="button button-ghost button-small" onClick={() => onOpenReview(ticket.ticketId)}>
                        Open review queue
                      </button>
                    ) : null
                  }
                >
                  <div className="stack">
                    <StatusBadge value={review.status} />
                    {review.reasons.length ? (
                      <ul className="plain-list">
                        {review.reasons.map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted">No open review reasons.</p>
                    )}
                    {review.resolutionNote ? (
                      <p className="explanation">Resolution note: {review.resolutionNote}</p>
                    ) : null}
                  </div>
                </SectionCard>
              ) : null}

              <SectionCard title={`Transcript (${ticket.messages.length} messages)`}>
                {ticket.messages.length === 0 ? (
                  <p className="muted">
                    {ticket.transcriptState === 'restricted'
                      ? 'The dashboard restricted this transcript.'
                      : 'No transcript content is stored for this ticket.'}
                  </p>
                ) : (
                  <div className="transcript">
                    {ticket.messages.map((message) => (
                      <div className="transcript-message" key={`${message.seq}-${message.messageId ?? ''}`}>
                        <div className="transcript-meta">
                          <strong>{message.authorName ?? 'Unknown author'}</strong>
                          <span>{formatDate(message.timestamp)}</span>
                        </div>
                        <p className="transcript-content" dir="auto">
                          {message.content || <span className="muted">[no text content]</span>}
                        </p>
                        {message.attachments.length > 0 || message.embeds.length > 0 ? (
                          <span className="detail-note">
                            {message.attachments.length} attachment(s), {message.embeds.length} embed(s)
                          </span>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </SectionCard>

              {history.length > 0 ? (
                <SectionCard title="Review history">
                  <ol className="history-list">
                    {history.map((entry) => (
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

              {ticket.rawFieldNames.length > 0 ? (
                <details className="diagnostic-details">
                  <summary>Dashboard fields captured ({ticket.rawFieldNames.length})</summary>
                  <p className="muted">
                    Field names only, for troubleshooting dashboard changes. Ticket text is not duplicated here.
                  </p>
                  <code>{ticket.rawFieldNames.join(', ')}</code>
                </details>
              ) : null}
            </>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
