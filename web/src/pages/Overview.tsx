import { formatDate, formatNumber, formatPoints } from '../api';
import { useApp } from '../context';
import { ConnectionCard } from '../components/ConnectionCard';
import {
  Alert,
  EmptyState,
  LoadingBlock,
  MetricCard,
  PageHeader,
  Progress,
  SectionCard,
  StatusBadge,
  ToneBadge,
} from '../components/ui';

export function OverviewPage({
  onNavigate,
}: {
  onNavigate: (page: 'collect' | 'tickets' | 'staff' | 'reviews' | 'settings') => void;
}) {
  const { status, loading, demoMode, taxonomy, setDemoMode } = useApp();
  if (loading && !status) return <LoadingBlock label="Loading overview…" />;
  if (!status) return <Alert tone="danger" title="Application unavailable">The local server is not responding.</Alert>;

  const overview = demoMode ? status.demoOverview : status.overview;
  const setupPending = status.setup.filter((step) => !step.ready);
  const latestRun = status.latestRun;
  const connection = status.connection;
  const model = status.model;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Management dashboard"
        title="Overview"
        description="Private, local ticket intelligence for staff performance review."
        actions={
          <>
            <button className="button button-primary" onClick={() => onNavigate('collect')}>
              Collect tickets
            </button>
            <button className="button button-ghost" onClick={() => onNavigate('reviews')}>
              Review queue {overview.reviewPending > 0 ? `(${overview.reviewPending})` : ''}
            </button>
          </>
        }
      />

      {demoMode ? (
        <Alert
          tone="info"
          title="Synthetic demo data is shown"
          action={
            <button className="button button-ghost button-small" onClick={() => setDemoMode(false)}>
              Show real data
            </button>
          }
        >
          These records are clearly labelled synthetic examples (IDs 9000001+). They are stored separately and never mixed
          into real metrics, exports, or staff reports unless demo data is explicitly included.
        </Alert>
      ) : null}

      <div className="metric-grid">
        <MetricCard
          label="Tickets collected"
          value={formatNumber(overview.totalTickets)}
          hint={demoMode ? 'synthetic demo records' : 'real records'}
        />
        <MetricCard label="Waiting for classification" value={formatNumber(overview.waitingForClassification)} tone="warn" />
        <MetricCard label="Classified" value={formatNumber(overview.classified)} tone="success" />
        <MetricCard label="Review pending" value={formatNumber(overview.reviewPending)} tone={overview.reviewPending ? 'warn' : undefined} />
        <MetricCard label="Fallback classifications" value={formatNumber(overview.fallbackCount)} tone={overview.fallbackCount ? 'warn' : undefined} />
        <MetricCard label="Unresolved staff attribution" value={formatNumber(overview.unresolvedCredit)} tone={overview.unresolvedCredit ? 'danger' : undefined} />
        <MetricCard label="Staff points awarded" value={formatPoints(overview.awardedPoints)} hint="deterministic awards" />
        <MetricCard label="Last collection" value={formatDate(overview.lastCollectionAt)} hint={overview.lastCollectionAt ? '' : 'no completed run yet'} />
      </div>

      {!demoMode && setupPending.length > 0 ? (
        <SectionCard
          title="Setup checklist"
          description="TicketsManage is usable before every step is complete. Collection needs the dashboard connection; classification falls back visibly whenever it cannot match a reason."
        >
          <ol className="setup-list">
            {status.setup.map((step) => (
              <li key={step.id} className={step.ready ? 'setup-done' : 'setup-todo'}>
                <span className="setup-mark" aria-hidden="true">
                  {step.ready ? '✓' : '○'}
                </span>
                <div>
                  <strong>{step.label}</strong>
                  <p>{step.detail}</p>
                </div>
                {!step.ready && step.id === 'connection' ? (
                  <button className="button button-ghost button-small" onClick={() => onNavigate('settings')}>
                    Connect
                  </button>
                ) : null}
                {!step.ready && step.id === 'model' ? (
                  <button className="button button-ghost button-small" onClick={() => onNavigate('settings')}>
                    Configure
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
          <Alert tone="info" title="Security reminder">
            Sign in only through the dedicated browser’s normal Tickets/Discord login. Do not paste a Discord token here.
          </Alert>
        </SectionCard>
      ) : null}

      <div className="two-column">
        <ConnectionCard />
        <SectionCard
          title="Local semantic model"
          description="Interpretation stays on this computer through Ollama."
          actions={
            <StatusBadge
              value={model.running && model.selectedInstalled ? 'authenticated' : model.running ? 'pending' : 'failed'}
              label={model.running && model.selectedInstalled ? 'Ready' : model.running ? 'Model missing' : 'Runtime offline'}
            />
          }
        >
          <div className="stack">
            <div className="stat-row">
              <span>Selected model</span>
              <code>{model.selectedModel}</code>
            </div>
            <div className="stat-row">
              <span>Ollama</span>
              <span>{model.running ? `running${model.version ? ` · v${model.version}` : ''}` : model.error}</span>
            </div>
            <div className="stat-row">
              <span>Installed local models</span>
              <span>{model.localModels.length ? model.localModels.join(', ') : 'None detected'}</span>
            </div>
            {!model.selectedInstalled ? (
              <Alert tone="warn" title="A local model is required for semantic classification">
                Without a model, classification falls back to deterministic rules and is visibly flagged. Collection and
                review still work. Configure a small multilingual model in Settings.
              </Alert>
            ) : null}
            <button className="button button-ghost" onClick={() => onNavigate('settings')}>
              Model and classifier settings
            </button>
          </div>
        </SectionCard>
      </div>

      <SectionCard
        title="Latest collection run"
        description="Progress is checkpointed. Interrupted runs can resume without duplicating tickets."
        actions={
          latestRun ? (
            <button className="button button-ghost button-small" onClick={() => onNavigate('collect')}>
              Open collection
            </button>
          ) : null
        }
      >
        {!latestRun ? (
          <EmptyState
            title="No collection run yet"
            description="Connect the dashboard, enter an inclusive ticket ID range, and start a small validated collection first."
            action={
              <button className="button button-primary" onClick={() => onNavigate('collect')}>
                Collect your first tickets
              </button>
            }
          />
        ) : (
          <div className="stack">
            <div className="inline-between">
              <div>
                <div className="run-range">
                  #{latestRun.startId} → #{latestRun.endId}
                </div>
                <span className="muted">
                  {formatDate(latestRun.startedAt)} · {latestRun.requestedCount.toLocaleString()} requested ID(s)
                </span>
              </div>
              <StatusBadge value={latestRun.status} />
            </div>
            <Progress value={latestRun.processed} max={latestRun.requestedCount} />
            <div className="mini-grid">
              <MetricCard label="Collected" value={latestRun.collected} tone="success" />
              <MetricCard label="No transcript" value={latestRun.noTranscript} />
              <MetricCard label="Not found" value={latestRun.notFound} />
              <MetricCard label="Partial" value={latestRun.partial} tone={latestRun.partial ? 'warn' : undefined} />
              <MetricCard label="Failed" value={latestRun.failed} tone={latestRun.failed ? 'danger' : undefined} />
              <MetricCard label="Classified" value={latestRun.classified} />
              <MetricCard label="Fallbacks" value={latestRun.fallbacks} tone={latestRun.fallbacks ? 'warn' : undefined} />
            </div>
            {latestRun.errorMessage ? <Alert tone="warn" title={latestRun.errorCode ?? 'Run message'}>{latestRun.errorMessage}</Alert> : null}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Quick actions">
        <div className="action-grid">
          <button className="action-tile" onClick={() => onNavigate('collect')}>
            <span className="action-icon">↧</span>
            <strong>Collect tickets</strong>
            <span>Enter an inclusive range and watch verified progress.</span>
          </button>
          <button className="action-tile" onClick={() => onNavigate('tickets')}>
            <span className="action-icon">⌕</span>
            <strong>Ticket explorer</strong>
            <span>Search records, transcripts, scores and explanations.</span>
          </button>
          <button className="action-tile" onClick={() => onNavigate('staff')}>
            <span className="action-icon">☷</span>
            <strong>Staff performance</strong>
            <span>Final awards by staff, category breakdown and ratings.</span>
          </button>
          <button className="action-tile" onClick={() => onNavigate('reviews')}>
            <span className="action-icon">⚑</span>
            <strong>Review queue</strong>
            <span>Correct fallbacks and uncertain classifications.</span>
          </button>
        </div>
      </SectionCard>

      {!demoMode && status.demoOverview.totalTickets > 0 ? (
        <Alert
          tone="info"
          title="Demo data available"
          action={
            <button className="button button-ghost button-small" onClick={() => setDemoMode(true)}>
              Show demo data
            </button>
          }
        >
          {status.demoOverview.totalTickets} synthetic example ticket(s) are stored separately for exploring the interface.
          They are excluded from real metrics.
        </Alert>
      ) : null}

      <div className="privacy-note">
        <ToneBadge tone="accent">Local only</ToneBadge>
        Ticket metadata, transcripts, classifications, corrections and the browser profile stay in this computer’s data
        directory. Ticket text is never sent to a hosted model. Taxonomy v{status.taxonomyVersion} · {taxonomy.length} fixed
        categories.
      </div>
    </div>
  );
}
