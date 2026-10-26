import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, formatDate, formatPoints } from '../api';
import { useApp } from '../context';
import { TicketDetail } from '../components/TicketDetail';
import { ConnectionCard } from '../components/ConnectionCard';
import {
  Alert,
  CategoryIdChips,
  EmptyState,
  MetricCard,
  PageHeader,
  Progress,
  SectionCard,
  StatusBadge,
  ToneBadge,
} from '../components/ui';
import type { CollectionStatusResponse, RangePreview, Ticket } from '../types';

const STAGE_LABELS: Record<string, string> = {
  starting: 'Starting',
  connecting: 'Connecting to the dashboard',
  discovering: 'Discovering tickets from the ordered listing',
  extracting: 'Extracting ticket',
  classifying: 'Classifying closing reason',
  pausing: 'Pausing safely',
  resuming: 'Resuming',
  paused: 'Paused',
  waiting_for_connection: 'Waiting for the dashboard connection',
  rate_limited: 'Rate-limited by the dashboard',
  rate_limit_cooldown: 'Waiting for the dashboard rate limit to reset',
  finished: 'Finished',
  cancelled: 'Cancelled',
};

export function CollectPage() {
  const { status, refreshStatus, notify, taxonomyById, demoMode } = useApp();
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [dateFrom, setDateFrom] = useState('17/10/26');
  const [dateTo, setDateTo] = useState('23/10/26');
  const [dateTimezone, setDateTimezone] = useState('Africa/Cairo');
  const [dateBasis, setDateBasis] = useState('closed');
  const [collectMode, setCollectMode] = useState<'date' | 'id' | 'hybrid'>('date');
  const [classify, setClassify] = useState(true);
  const [incremental, setIncremental] = useState(true);
  const [preview, setPreview] = useState<RangePreview | null>(null);
  const [confirmLarge, setConfirmLarge] = useState(false);
  const [collection, setCollection] = useState<CollectionStatusResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedTicket, setSelectedTicket] = useState<string | null>(null);
  const lastStatus = useRef<string | null>(null);
  const classifyTouched = useRef(false);

  const loadCollection = useCallback(async () => {
    try {
      const result = await api<CollectionStatusResponse>('/api/collection/status');
      setCollection(result);
      const nextStatus = result.run?.status ?? null;
      if (nextStatus !== lastStatus.current) {
        if (['completed', 'completed_with_errors', 'cancelled', 'paused'].includes(nextStatus ?? '')) {
          void refreshStatus();
        }
        lastStatus.current = nextStatus;
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Collection status is unavailable.');
    }
  }, [refreshStatus]);

  useEffect(() => {
    void loadCollection();
    const timer = window.setInterval(() => void loadCollection(), 1400);
    return () => window.clearInterval(timer);
  }, [loadCollection]);

  useEffect(() => {
    if (!classifyTouched.current) {
      setClassify(status?.settings.classificationEnabled ?? true);
    }
  }, [status?.settings.classificationEnabled]);

  const run = collection?.run ?? null;
  const diagnostics = collection?.diagnostics ?? null;
  const formatMs = (value: number | undefined): string => {
    if (value === undefined) return '—';
    if (value < 1000) return `${value} ms`;
    return `${(value / 1000).toFixed(1)} s`;
  };
  const connection = collection?.connection ?? status?.connection;
  const authenticated = connection?.state === 'authenticated';
  const activeOrPaused = Boolean(run && ['running', 'paused'].includes(run.status));
  const progressMax = run?.requestedCount ?? 0;
  const stageLabel = run ? STAGE_LABELS[run.stage] ?? run.stage.replaceAll('_', ' ') : '';

  const canConfirmLarge = useMemo(
    () => Boolean(preview?.ok && preview.requiresConfirmation && confirmLarge),
    [preview, confirmLarge],
  );

  const doPreview = async () => {
    setBusy('preview');
    setError(null);
    try {
      const body: Record<string, unknown> =
        collectMode === 'id'
          ? { start, end }
          : collectMode === 'date'
            ? { dateFrom, dateTo, dateTimezone, dateBasis }
            : { start, end, dateFrom, dateTo, dateTimezone, dateBasis };
      const result = await api<RangePreview>('/api/collection/preview', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setPreview(result);
      setConfirmLarge(false);
      if (!result.ok) notify(result.error ?? 'The range is not valid.', 'error');
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : 'Preview failed.');
    } finally {
      setBusy(null);
    }
  };

  const startRun = async () => {
    setError(null);
    if (collectMode === 'id' && (!preview || preview.startId !== start.trim() || preview.endId !== end.trim())) {
      await doPreview();
      notify('Review the range preview, then select Start collection again.', 'info');
      return;
    }
    if (collectMode === 'date' && !dateFrom && !dateTo) {
      await doPreview();
      notify('Review the date range preview, then select Start collection again.', 'info');
      return;
    }
    if (preview?.requiresConfirmation && !confirmLarge) {
      notify('Confirm the large-range warning before starting.', 'error');
      return;
    }
    if (!authenticated) {
      notify('Connect and verify the Tickets dashboard before starting.', 'error');
      return;
    }
    setBusy('start');
    try {
      const body: Record<string, unknown> =
        collectMode === 'id'
          ? {
              start: preview?.startId ?? start,
              end: preview?.endId ?? end,
              classify,
              confirmLarge,
              mode: incremental ? 'incremental' : 'full',
            }
          : collectMode === 'date'
            ? {
                dateFrom,
                dateTo,
                dateTimezone,
                dateBasis,
                classify,
                confirmLarge,
                mode: incremental ? 'incremental' : 'full',
              }
            : {
                start: preview?.startId ?? start,
                end: preview?.endId ?? end,
                dateFrom,
                dateTo,
                dateTimezone,
                dateBasis,
                classify,
                confirmLarge,
                mode: incremental ? 'incremental' : 'full',
              };
      await api('/api/collection/start', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      notify('Collection started. Progress is checkpointed after each ticket.');
      await loadCollection();
      await refreshStatus();
    } catch (startError) {
      if (startError instanceof ApiError) {
        setError(startError.message);
      } else {
        setError('The collection could not be started.');
      }
    } finally {
      setBusy(null);
    }
  };

  const action = async (name: 'pause' | 'resume' | 'cancel') => {
    setBusy(name);
    setError(null);
    try {
      await api(`/api/collection/${name}`, { method: 'POST', body: '{}' });
      notify(
        name === 'pause'
          ? 'Pause requested. The current ticket will finish first.'
          : name === 'resume'
            ? 'Collection resumed.'
            : 'Cancel requested.',
        'info',
      );
      await loadCollection();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : `Could not ${name} the run.`);
    } finally {
      setBusy(null);
    }
  };

  const openRecent = async (ticketId: string, state: string) => {
    if (['not_found', 'failed'].includes(state)) return;
    setSelectedTicket(ticketId);
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="Read-only collection"
        title="Collect tickets"
        description="Verify an inclusive ticket ID range and collect only what your authorized dashboard account can access."
      />

      {demoMode ? (
        <Alert tone="warn" title="Demo mode is on">
          Collection still operates on real dashboard data; demo mode only changes which stored records are displayed in
          other screens. Turn it off to see real metrics.
        </Alert>
      ) : null}

      <div className="collect-layout">
        <div className="stack">
          <ConnectionCard onChanged={loadCollection} />

          <SectionCard
            title={
              collectMode === 'date'
                ? 'Date range'
                : collectMode === 'id'
                  ? 'Ticket ID range'
                  : 'Ticket ID + date filter'
            }
            description={
              collectMode === 'date'
                ? 'Use DD/MM/YY. Closed-at is the date basis.'
                : collectMode === 'id'
                  ? 'Enter the inclusive ticket ID range.'
                  : 'Combine date and ID filters for precise collection.'
            }
          >
            <label className="field">
              <span className="field-label">Collection mode</span>
              <select
                className="input"
                value={collectMode}
                onChange={(event) => {
                  setCollectMode(event.target.value as 'date' | 'id' | 'hybrid');
                  setPreview(null);
                }}
              >
                <option value="date">By date</option>
                <option value="id">By ID</option>
                <option value="hybrid">By ID + date filter</option>
              </select>
            </label>
            {(collectMode === 'date' || collectMode === 'hybrid') && (
              <div className="form-grid">
                <label className="field">
                  <span className="field-label">From</span>
                  <input
                    className="input"
                    placeholder="17/10/26"
                    value={dateFrom}
                    onChange={(event) => {
                      setDateFrom(event.target.value.replace(/[^\d/]/g, '').slice(0, 8));
                      setPreview(null);
                    }}
                  />
                </label>
                <label className="field">
                  <span className="field-label">To</span>
                  <input
                    className="input"
                    placeholder="23/10/26"
                    value={dateTo}
                    onChange={(event) => {
                      setDateTo(event.target.value.replace(/[^\d/]/g, '').slice(0, 8));
                      setPreview(null);
                    }}
                  />
                </label>
              </div>
            )}
            {(collectMode === 'date' || collectMode === 'hybrid') && (
              <div className="form-grid">
                <label className="field">
                  <span className="field-label">Timezone</span>
                  <select
                    className="input"
                    value={dateTimezone}
                    onChange={(event) => {
                      setDateTimezone(event.target.value);
                      setPreview(null);
                    }}
                  >
                    <option value="Africa/Cairo">Africa/Cairo</option>
                    <option value="UTC">UTC</option>
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">Date basis</span>
                  <select
                    className="input"
                    value={dateBasis}
                    onChange={(event) => {
                      setDateBasis(event.target.value);
                      setPreview(null);
                    }}
                  >
                    <option value="closed">Closed at</option>
                    <option value="opened">Opened at</option>
                    <option value="activity">Last activity</option>
                  </select>
                </label>
              </div>
            )}
            {(collectMode === 'id' || collectMode === 'hybrid') && (
              <div className="form-grid">
                <label className="field">
                  <span className="field-label">Starting ticket ID</span>
                  <input
                    className="input"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    placeholder="e.g. 7770"
                    value={start}
                    onChange={(event) => {
                      setStart(event.target.value.replace(/[^\d]/g, ''));
                      setPreview(null);
                    }}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Ending ticket ID</span>
                  <input
                    className="input"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    placeholder="e.g. 7778"
                    value={end}
                    onChange={(event) => {
                      setEnd(event.target.value.replace(/[^\d]/g, ''));
                      setPreview(null);
                    }}
                  />
                </label>
              </div>
            )}
            <label className="check-row">
              <input
                type="checkbox"
                checked={classify}
                onChange={(event) => {
                  classifyTouched.current = true;
                  setClassify(event.target.checked);
                }}
              />
              <span>
                Classify and score each ticket as it is collected (deterministic rules; unfamiliar wording gets a visible fallback for review)
              </span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={incremental}
                onChange={(event) => setIncremental(event.target.checked)}
              />
              <span>
                Reuse already collected records (incremental sync). This is fast and does not re-open the dashboard for
                stored tickets. Turn it off for a full refresh that re-verifies every ticket and transcript.
              </span>
            </label>
            {connection && !authenticated ? (
              <Alert tone="warn" title="Dashboard connection required">
                {connection.message} Connect above, finish the normal sign-in, then select Verify connection.
              </Alert>
            ) : null}
            <div className="button-row">
              <button className="button button-ghost" onClick={doPreview} disabled={busy !== null || (collectMode === "date" ? (!dateFrom || !dateTo) : (!start || !end))}>
                {busy === 'preview' ? 'Checking…' : 'Preview range'}
              </button>
              <button
                className="button button-primary"
                onClick={startRun}
                disabled={busy !== null || !authenticated || activeOrPaused || (collectMode === "date" ? (!dateFrom || !dateTo) : (!start || !end))}
              >
                {busy === 'start' ? 'Starting…' : 'Start collection'}
              </button>
              {run?.status === 'running' ? (
                <button className="button button-ghost" onClick={() => action('pause')} disabled={busy !== null}>
                  Pause
                </button>
              ) : null}
              {run?.status === 'paused' ? (
                <button className="button button-secondary" onClick={() => action('resume')} disabled={busy !== null}>
                  Resume interrupted run
                </button>
              ) : null}
              {run && ['running', 'paused'].includes(run.status) ? (
                <button className="button button-danger-ghost" onClick={() => action('cancel')} disabled={busy !== null}>
                  Cancel
                </button>
              ) : null}
            </div>
            {activeOrPaused ? (
              <p className="muted">
                A run already exists. Resume or cancel it before starting a new range. Paused runs are checkpointed in
                SQLite and survive application restarts.
              </p>
            ) : null}
          </SectionCard>

          {preview ? (
            <SectionCard title="Range preview">
              {!preview.ok ? (
                <Alert tone="danger" title="Range cannot be started">{preview.error}</Alert>
              ) : (
                <div className="stack">
                  <div className="preview-headline">
                    <span>
                      Inclusive range <strong>#{preview.startId}–#{preview.endId}</strong>
                    </span>
                    <ToneBadge tone={preview.large ? 'warn' : 'info'}>
                      {preview.count?.toLocaleString()} ticket ID(s)
                    </ToneBadge>
                  </div>
                  <p>{preview.plan}</p>
                  <div className="stat-row">
                    <span>Maximum network requests</span>
                    <strong>{preview.estimatedRequests?.toLocaleString()}</strong>
                  </div>
                  {preview.warnings?.map((warning) => (
                    <p className="muted" key={warning}>
                      {warning}
                    </p>
                  ))}
                  {preview.requiresConfirmation ? (
                    <label className="check-row confirm-row">
                      <input
                        type="checkbox"
                        checked={confirmLarge}
                        onChange={(event) => setConfirmLarge(event.target.checked)}
                      />
                      <span>
                        I understand this is a large range and want to start the collection. The run can be paused and
                        resumed.
                      </span>
                    </label>
                  ) : null}
                </div>
              )}
            </SectionCard>
          ) : null}

          {error ? (
            <Alert tone="danger" title="Collection message">
              {error}
            </Alert>
          ) : null}

          {run ? (
            <SectionCard
              title="Run progress"
              description="Progress reflects real work verified against the dashboard, not a simulated percentage."
              actions={<StatusBadge value={run.status} />}
            >
              <div className="stack">
                <div className="inline-between">
                  <div>
                    <div className="run-range">
                      #{run.startId} → #{run.endId}
                    </div>
                    <span className="muted">
                      Started {formatDate(run.startedAt)} · {run.requestedCount.toLocaleString()} requested ID(s) ·{' '}
                      {run.mode === 'incremental' ? 'Incremental sync' : 'Full refresh'}
                    </span>
                  </div>
                  <div className="run-stage">
                    <span className="detail-label">Stage</span>
                    <strong>{stageLabel}</strong>
                    {run.currentTicketId ? <code>#{run.currentTicketId}</code> : null}
                  </div>
                </div>
                <Progress value={run.processed} max={progressMax} />
                <div className="mini-grid">
                  <MetricCard label="Collected" value={run.collected} tone="success" />
                  <MetricCard label="No transcript" value={run.noTranscript} />
                  <MetricCard label="Not found" value={run.notFound} />
                  <MetricCard label="Partial" value={run.partial} tone={run.partial ? 'warn' : undefined} />
                  <MetricCard label="Failed" value={run.failed} tone={run.failed ? 'danger' : undefined} />
                  <MetricCard label="Classified" value={run.classified} />
                  <MetricCard label="Fallbacks" value={run.fallbacks} tone={run.fallbacks ? 'warn' : undefined} />
                </div>
                {run.errorMessage ? (
                  <Alert
                    tone={run.status === 'paused' ? 'warn' : 'danger'}
                    title={run.errorCode?.replaceAll('_', ' ') ?? 'Run message'}
                    action={
                      run.status === 'paused' ? (
                        <button className="button button-secondary button-small" onClick={() => action('resume')} disabled={busy !== null}>
                          Resume
                        </button>
                      ) : null
                    }
                  >
                    {run.errorMessage}
                  </Alert>
                ) : null}
                {run.status === 'paused' && !run.errorMessage ? (
                  <Alert tone="warn" title="Run paused">
                    Progress was checkpointed. Resume when the dashboard connection is available.
                  </Alert>
                ) : null}
              </div>
            </SectionCard>
          ) : null}

          {run && diagnostics ? (
            <SectionCard
              title="Run diagnostics"
              description="Measured stage timings for this run. Values come from the real work completed, not estimates."
            >
              <div className="stat-row">
                <span>Mode</span>
                <strong>{diagnostics.mode === 'incremental' ? 'Incremental sync' : 'Full refresh'}</strong>
              </div>
              <div className="stat-row">
                <span>Listing discovery</span>
                <strong>{formatMs(diagnostics.timings.listingMs)}</strong>
              </div>
              <div className="stat-row">
                <span>Reused complete records</span>
                <strong>{diagnostics.counts.reused.toLocaleString()}</strong>
              </div>
              <div className="stat-row">
                <span>Transcripts retrieved</span>
                <strong>{diagnostics.counts.fetchedTranscripts.toLocaleString()}</strong>
              </div>
              <div className="stat-row">
                <span>Direct API / navigation reads</span>
                <strong>
                  {diagnostics.counts.directRequests} / {diagnostics.counts.navigationRequests}
                </strong>
              </div>
              <div className="stat-row">
                <span>Classification / database time</span>
                <strong>
                  {formatMs(diagnostics.timings.classifyMs)} / {formatMs(diagnostics.timings.dbMs)}
                </strong>
              </div>
              <div className="stat-row">
                <span>Per-ticket median / p95</span>
                <strong>
                  {formatMs(diagnostics.perTicket.medianMs)} / {formatMs(diagnostics.perTicket.p95Ms)}
                </strong>
              </div>
              <div className="stat-row">
                <span>Total run time</span>
                <strong>{formatMs(diagnostics.timings.totalMs)}</strong>
              </div>
              {diagnostics.notes.length ? (
                <ul className="muted">
                  {diagnostics.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              ) : null}
            </SectionCard>
          ) : null}
        </div>

        <div className="stack">
          <SectionCard title="What happens during collection">
            <ol className="process-list">
              <li>
                Sync first reads the dashboard’s ordered ticket listing (15 rows per request) to discover the range and
                detect metadata changes. Complete stored records are reused without reopening their transcript.
              </li>
              <li>
                A full refresh re-reads every transcript through the dashboard’s authenticated JSON API, falling back to
                the page navigation path if that API is unavailable. No Discord token is stored by this application.
              </li>
              <li>Open the transcript view when available; store ordered messages and metadata locally.</li>
              <li>Classify the original close reason, apply fixed base points, then deterministic staff-credit rules.</li>
              <li>Checkpoint the item in SQLite so an interrupted run can resume without duplicates.</li>
            </ol>
            <Alert tone="info" title="Read-only guarantee">
              The collector never claims, closes, edits, relabels, reopens or deletes tickets. It only views pages and
              reads data your account can already see.
            </Alert>
          </SectionCard>

          <SectionCard title="Recently processed" description="Live items from the current or latest run.">
            {!collection?.recentItems.length ? (
              <EmptyState title="No processed items yet" description="Start a small verified range to validate extraction and scoring." />
            ) : (
              <div className="recent-list">
                {collection.recentItems.map((item) => (
                  <button
                    key={`${item.ticketId}-${item.updatedAt}`}
                    className={`recent-row${['not_found', 'failed'].includes(item.state) ? ' recent-static' : ''}`}
                    onClick={() => void openRecent(item.ticketId, item.state)}
                    disabled={['not_found', 'failed'].includes(item.state)}
                  >
                    <div className="recent-main">
                      <div className="inline-between">
                        <strong>#{item.ticketId}</strong>
                        <StatusBadge value={item.state} />
                      </div>
                      <div className="muted recent-reason" dir="auto">
                        {item.reason ?? (item.reasonState === 'unavailable' ? 'Closing reason unavailable' : 'No closing reason')}
                      </div>
                      <div className="inline-badges">
                        {item.categories.length ? (
                          <CategoryIdChips
                            categoryIds={item.categories}
                            taxonomyById={taxonomyById}
                            fallback={item.fallback}
                          />
                        ) : (
                          <span className="muted">Not classified</span>
                        )}
                        {item.awardedPoints !== null ? (
                          <span className="muted">{formatPoints(item.awardedPoints)} pts awarded</span>
                        ) : null}
                      </div>
                      {item.error ? <span className="recent-error">{item.error}</span> : null}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </SectionCard>

          <SectionCard title="Validation first">
            <p className="muted">
              Start with 5–20 known ticket IDs, compare a few records against the dashboard, then expand. If the dashboard
              changes structure, the collector pauses after three unexpected responses instead of storing invented records.
            </p>
          </SectionCard>
        </div>
      </div>

      {selectedTicket ? <TicketDetail ticketId={selectedTicket} onClose={() => setSelectedTicket(null)} /> : null}
    </div>
  );
}
