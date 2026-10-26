import { useEffect, useState, type ReactNode } from 'react';
import { AppProvider, useApp } from './context';
import { OverviewPage } from './pages/Overview';
import { CollectPage } from './pages/Collect';
import { TicketsPage } from './pages/Tickets';
import { StaffPage } from './pages/Staff';
import { ReviewsPage } from './pages/Reviews';
import { SettingsPage } from './pages/Settings';
import { StatusBadge } from './components/ui';

type PageId = 'overview' | 'collect' | 'tickets' | 'staff' | 'reviews' | 'settings';

const PAGE_IDS: PageId[] = ['overview', 'collect', 'tickets', 'staff', 'reviews', 'settings'];

function pageFromHash(): PageId {
  const hash = window.location.hash.replace(/^#\/?/, '');
  return (PAGE_IDS as string[]).includes(hash) ? (hash as PageId) : 'overview';
}

export function App() {
  return (
    <AppProvider>
      <AppShell />
    </AppProvider>
  );
}

function AppShell() {
  const { status, loading, loadError, demoMode, setDemoMode, refreshStatus, toasts } = useApp();
  const [page, setPage] = useState<PageId>(pageFromHash);

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigate = (next: PageId) => {
    window.location.hash = `/${next}`;
    setPage(next);
  };

  const demoAvailable = (status?.demoOverview.totalTickets ?? 0) > 0;
  const connectionState = status?.connection.state ?? 'not_connected';
  const modelReady = Boolean(status?.model.running && status.model.selectedInstalled);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            TM
          </div>
          <div>
            <div className="brand-name">TicketsManage</div>
            <div className="brand-sub">Local ticket intelligence</div>
          </div>
        </div>

        <nav className="nav" aria-label="Main navigation">
          <NavItem id="overview" label="Overview" current={page} onNavigate={navigate} icon={<OverviewIcon />} />
          <NavItem id="collect" label="Collect tickets" current={page} onNavigate={navigate} icon={<CollectIcon />} />
          <NavItem id="tickets" label="Ticket explorer" current={page} onNavigate={navigate} icon={<TicketsIcon />} />
          <NavItem
            id="staff"
            label="Staff performance"
            current={page}
            onNavigate={navigate}
            icon={<StaffIcon />}
          />
          <NavItem
            id="reviews"
            label="Review queue"
            current={page}
            onNavigate={navigate}
            icon={<ReviewsIcon />}
            badge={status?.reviewCounts.pending ?? 0}
          />
          <NavItem id="settings" label="Settings" current={page} onNavigate={navigate} icon={<SettingsIcon />} />
        </nav>

        <div className="sidebar-bottom">
          <div className="sidebar-status">
            <span className={`status-dot ${connectionState === 'authenticated' ? 'dot-green' : connectionState === 'waiting_for_signin' ? 'dot-amber' : 'dot-gray'}`} />
            <span>{connectionState === 'authenticated' ? 'Dashboard connected' : connectionState.replaceAll('_', ' ')}</span>
          </div>
          <div className="sidebar-status">
            <span className={`status-dot ${modelReady ? 'dot-green' : 'dot-amber'}`} />
            <span>{modelReady ? 'Local model ready' : 'Model needs attention'}</span>
          </div>
          <div className="sidebar-version">v{status?.appVersion ?? '2.0.0'} · local only</div>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <div className="topbar-left">
            <span className="topbar-title">Private staff audit workspace</span>
            <span className="topbar-sep" />
            <span className="topbar-note">Data stays on this computer</span>
          </div>
          <div className="topbar-right">
            {status ? (
              <>
                <StatusBadge value={connectionState} />
                <span className="topbar-divider" />
                <span className="model-indicator">
                  <span className={`status-dot ${modelReady ? 'dot-green' : 'dot-amber'}`} />
                  {modelReady ? status.settings.model : 'Rules only'}
                </span>
              </>
            ) : null}
            {demoAvailable || demoMode ? (
              <label className="switch">
                <input
                  type="checkbox"
                  checked={demoMode}
                  onChange={(event) => setDemoMode(event.target.checked)}
                  disabled={!demoAvailable && !demoMode}
                />
                <span className="switch-track" aria-hidden="true">
                  <span className="switch-thumb" />
                </span>
                <span>Demo data</span>
              </label>
            ) : null}
            <button className="button button-ghost button-small" onClick={() => void refreshStatus()} disabled={loading}>
              Refresh
            </button>
          </div>
        </header>

        {loadError ? (
          <div className="global-error">
            <strong>Local application unavailable.</strong> {loadError}{' '}
            <button className="link-button" onClick={() => void refreshStatus()}>
              Retry
            </button>
          </div>
        ) : null}

        {demoMode ? <div className="demo-strip">Showing clearly separated synthetic demo records — not real tickets</div> : null}

        <main className="content">
          {page === 'overview' ? <OverviewPage onNavigate={navigate} /> : null}
          {page === 'collect' ? <CollectPage /> : null}
          {page === 'tickets' ? <TicketsPage /> : null}
          {page === 'staff' ? <StaffPage /> : null}
          {page === 'reviews' ? <ReviewsPage /> : null}
          {page === 'settings' ? <SettingsPage /> : null}
        </main>
      </div>

      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div className={`toast toast-${toast.type}`} key={toast.id}>
            <span className="toast-mark">{toast.type === 'error' ? '!' : toast.type === 'success' ? '✓' : 'i'}</span>
            <span>{toast.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function NavItem({
  id,
  label,
  current,
  onNavigate,
  icon,
  badge,
}: {
  id: PageId;
  label: string;
  current: PageId;
  onNavigate: (id: PageId) => void;
  icon: ReactNode;
  badge?: number;
}) {
  return (
    <button
      className={`nav-item${current === id ? ' nav-active' : ''}`}
      onClick={() => onNavigate(id)}
      aria-current={current === id ? 'page' : undefined}
    >
      <span className="nav-icon">{icon}</span>
      <span>{label}</span>
      {badge && badge > 0 ? <span className="nav-badge">{badge}</span> : null}
    </button>
  );
}

function OverviewIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="3" y="3" width="6" height="6" rx="1.2" />
      <rect x="11" y="3" width="6" height="6" rx="1.2" />
      <rect x="3" y="11" width="6" height="6" rx="1.2" />
      <rect x="11" y="11" width="6" height="6" rx="1.2" />
    </svg>
  );
}
function CollectIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 3v9m0 0 3.5-3.5M10 12 6.5 8.5M4 15.5h12" fill="none" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function TicketsIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 5.5h12v3a2 2 0 0 0 0 3v3H4v-3a2 2 0 0 0 0-3v-3Z" fill="none" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M8 6v8" fill="none" strokeWidth="1.2" strokeDasharray="1.5 2" />
    </svg>
  );
}
function StaffIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="7" cy="7" r="2.4" fill="none" strokeWidth="1.5" />
      <path d="M3.5 16c0-2.2 1.6-3.8 3.5-3.8s3.5 1.6 3.5 3.8" fill="none" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="13.5" cy="8" r="1.8" fill="none" strokeWidth="1.3" />
      <path d="M11.5 15.5c.2-1.7 1.2-2.8 2.7-2.8 1.4 0 2.4 1.1 2.5 2.8" fill="none" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
function ReviewsIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 4h9l3 3v9H4z" fill="none" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M7 8h6M7 11h4" fill="none" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
function SettingsIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="2.6" fill="none" strokeWidth="1.5" />
      <path d="M10 3v2M10 15v2M3 10h2M15 10h2M5.1 5.1l1.4 1.4M13.5 13.5l1.4 1.4M14.9 5.1l-1.4 1.4M6.5 13.5l-1.4 1.4" fill="none" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
