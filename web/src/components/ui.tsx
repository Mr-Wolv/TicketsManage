import type { ReactNode } from 'react';
import { formatPoints } from '../api';
import type { CategoryAssessment, TaxonomyCategory } from '../types';

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span className="spinner-wrap" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

const STATE_LABELS: Record<string, { label: string; tone: string }> = {
  authenticated: { label: 'Connected', tone: 'success' },
  not_connected: { label: 'Not connected', tone: 'neutral' },
  browser_starting: { label: 'Browser starting', tone: 'info' },
  waiting_for_signin: { label: 'Waiting for sign-in', tone: 'warn' },
  session_expired: { label: 'Session expired', tone: 'warn' },
  access_denied: { label: 'Access denied', tone: 'danger' },
  dashboard_unavailable: { label: 'Dashboard unavailable', tone: 'danger' },
  unexpected_page: { label: 'Unexpected page', tone: 'danger' },
  data_unavailable: { label: 'Data unavailable', tone: 'warn' },
  pending: { label: 'Pending review', tone: 'warn' },
  accepted: { label: 'Accepted', tone: 'success' },
  corrected: { label: 'Corrected', tone: 'info' },
  dismissed: { label: 'Dismissed', tone: 'neutral' },
  collected: { label: 'Collected', tone: 'success' },
  partial: { label: 'Partial', tone: 'warn' },
  no_transcript: { label: 'No transcript', tone: 'neutral' },
  not_found: { label: 'Not found', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
  completed: { label: 'Completed', tone: 'success' },
  completed_with_errors: { label: 'Completed with errors', tone: 'warn' },
  running: { label: 'Running', tone: 'info' },
  paused: { label: 'Paused', tone: 'warn' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  awarded: { label: 'Awarded', tone: 'success' },
  zero_different: { label: 'Zero — different staff', tone: 'danger' },
  unresolved: { label: 'Unresolved', tone: 'warn' },
  none: { label: 'No award', tone: 'neutral' },
  fallback: { label: 'Fallback', tone: 'warn' },
};

export function StatusBadge({ value, label }: { value: string; label?: string }) {
  const entry = STATE_LABELS[value] ?? { label: value.replaceAll('_', ' '), tone: 'neutral' };
  return (
    <span className={`badge badge-${entry.tone}`}>
      <span className="badge-dot" aria-hidden="true" />
      {label ?? entry.label}
    </span>
  );
}

export function ToneBadge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'success' | 'warn' | 'danger' | 'info' | 'neutral' | 'accent';
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function MetricCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'accent' | 'warn' | 'danger' | 'success';
}) {
  return (
    <div className={`metric-card${tone ? ` metric-${tone}` : ''}`}>
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
      {hint ? <span className="metric-hint">{hint}</span> : null}
    </div>
  );
}

export function SectionCard({
  title,
  description,
  actions,
  children,
  className = '',
  id,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section className={`card ${className}`} id={id}>
      {title || description || actions ? (
        <div className="card-head">
          <div>
            {title ? <h2>{title}</h2> : null}
            {description ? <p className="card-description">{description}</p> : null}
          </div>
          {actions ? <div className="card-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-mark" aria-hidden="true">
        ◇
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function Alert({
  tone = 'info',
  title,
  children,
  action,
}: {
  tone?: 'info' | 'warn' | 'danger' | 'success';
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`alert alert-${tone}${action ? ' alert-with-action' : ''}`} role={tone === 'danger' ? 'alert' : undefined}>
      <div>
        {title ? <strong>{title}</strong> : null}
        <div className="alert-body">{children}</div>
      </div>
      {action ? <div className="alert-action">{action}</div> : null}
    </div>
  );
}

export function Progress({ value, max }: { value: number; max: number }) {
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 1000) / 10) : 0;
  return (
    <div className="progress-wrap">
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <span className="progress-label">
        {percent.toFixed(1)}% · {value.toLocaleString()} of {max.toLocaleString()}
      </span>
    </div>
  );
}

export function CategoryChips({
  categories,
  taxonomyById,
  fallback,
  emptyLabel = 'Not classified',
}: {
  categories: CategoryAssessment[];
  taxonomyById: Record<string, TaxonomyCategory>;
  fallback?: boolean;
  emptyLabel?: string;
}) {
  if (categories.length === 0) return <span className="muted">{emptyLabel}</span>;
  return (
    <span className="chips">
      {categories.map((category) => {
        const definition = taxonomyById[category.categoryId];
        return (
          <span className="chip" key={category.categoryId} title={definition?.description}>
            {definition?.code ?? category.categoryId}
            <span className="chip-points">+{formatPoints(category.points)}</span>
          </span>
        );
      })}
      {fallback ? <span className="chip chip-fallback">fallback</span> : null}
    </span>
  );
}

export function CategoryIdChips({
  categoryIds,
  taxonomyById,
  fallback,
}: {
  categoryIds: string[];
  taxonomyById: Record<string, TaxonomyCategory>;
  fallback?: boolean;
}) {
  if (categoryIds.length === 0) return <span className="muted">—</span>;
  return (
    <span className="chips">
      {categoryIds.map((id) => (
        <span className="chip" key={id}>
          {taxonomyById[id]?.code ?? id}
        </span>
      ))}
      {fallback ? <span className="chip chip-fallback">fallback</span> : null}
    </span>
  );
}

export function ValueOrUnavailable({
  value,
  state,
  unavailableLabel = 'Unavailable',
}: {
  value: ReactNode;
  state?: string;
  unavailableLabel?: string;
}) {
  if (state === 'unavailable') return <span className="unavailable">{unavailableLabel}</span>;
  if (value === null || value === undefined || value === '') {
    return <span className="muted">—</span>;
  }
  return <>{value}</>;
}

export function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`field${wide ? ' field-wide' : ''}`}>
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function LoadingBlock({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading-block">
      <Spinner label={label} />
    </div>
  );
}
