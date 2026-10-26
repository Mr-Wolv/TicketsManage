import { useCallback, useEffect, useState } from 'react';
import { api, download, formatDate, formatNumber, formatPoints } from '../api';
import { useApp } from '../context';
import {
  Alert,
  EmptyState,
  MetricCard,
  PageHeader,
  SectionCard,
  Spinner,
  ToneBadge,
} from '../components/ui';
import type { StaffReport } from '../types';

export function StaffPage() {
  const { demoMode, notify, refreshStatus } = useApp();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [dateBasis, setDateBasis] = useState<'activity' | 'opened'>('activity');
  const [staff, setStaff] = useState('');
  const [report, setReport] = useState<StaffReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [benchmarkData, setBenchmarkData] = useState<Record<string, number> | null>(null);
  const [benchmarkFile, setBenchmarkFile] = useState<File | null>(null);
  const [normalize, setNormalize] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      params.set('dateBasis', dateBasis);
      if (staff) params.set('staff', staff);
      if (demoMode) params.set('demo', 'only');
      const result = await api<StaffReport>(`/api/staff?${params.toString()}`);
      setReport(result);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'The staff report could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [from, to, dateBasis, staff, demoMode]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 250);
    return () => window.clearTimeout(timer);
  }, [load]);

  const exportParams = new URLSearchParams();
  if (from) exportParams.set('from', from);
  if (to) exportParams.set('to', to);
  exportParams.set('dateBasis', dateBasis);
  if (staff) exportParams.set('staff', staff);
  if (demoMode) exportParams.set('demo', 'only');

  const maintenance = async (kind: 'rescore' | 'reclassify') => {
    setBusy(kind);
    try {
      const result = await api<{ message: string }>(`/api/assessments/${kind}`, {
        method: 'POST',
        body: '{}',
      });
      notify(result.message, 'success');
      await refreshStatus();
      await load();
    } catch (maintenanceError) {
      notify(maintenanceError instanceof Error ? maintenanceError.message : 'The operation failed.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const NORM_A = 1.7589596259101096e-7;
  const NORM_B = -1.135218793864604e-4;
  const NORM_C = 0.01978683960927561;
  const NORM_D = 0.04435873137530282;
  const NORM_E = 14.338943427267312;

  const normalizePoints = (value: number): number => {
    const y = NORM_A * Math.pow(value, 4) + NORM_B * Math.pow(value, 3) + NORM_C * Math.pow(value, 2) + NORM_D * value + NORM_E;
    return Math.ceil(y);
  };

  const displayPoints = (value: number): number => (normalize ? normalizePoints(value) : value);

  return (
    <div className="page">
      <PageHeader
        eyebrow="Decision support"
        title="Staff performance"
        description="Summaries use the final staff-credit awards, not raw ticket base scores."
        actions={
          <>
            <button className="button button-ghost" onClick={() => download(`/api/export/staff?format=json&${exportParams}`)}>
              Export JSON
            </button>
            <button className="button button-ghost" onClick={() => download(`/api/export/staff?format=csv&${exportParams}`)}>
              Export CSV
            </button>
            <button
              className={`button ${normalize ? 'button-primary' : 'button-ghost'}`}
              onClick={() => setNormalize((current) => !current)}
              disabled={busy !== null || !report}
              title="Apply the agreed quartic normalization formula to displayed points."
            >
              {normalize ? 'Normalized view' : 'Normalize points'}
            </button>
            <button
              className="button button-ghost"
              onClick={() => void maintenance('rescore')}
              disabled={busy !== null}
              title="Recalculate awards from stored categories. No dashboard or classifier work."
            >
              {busy === 'rescore' ? 'Rescoring…' : 'Rescore stored results'}
            </button>
            <button
              className="button button-ghost"
              onClick={() => void maintenance('reclassify')}
              disabled={busy !== null}
              title="Reclassify only missing or outdated assessments. Human corrections are preserved."
            >
              {busy === 'reclassify' ? 'Reclassifying…' : 'Reclassify outdated'}
            </button>
          </>
        }
      />

      {demoMode ? (
        <Alert tone="info" title="Synthetic demo report">
          Only clearly labelled demo records are included. Turn demo mode off for the real staff report.
        </Alert>
      ) : null}

      <SectionCard title="Benchmark comparison (manual totals)">
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="file"
            accept=".csv,.json,.txt"
            onChange={(e) => setBenchmarkFile(e.target.files?.[0] || null)}
          />
          <button
            className="button button-secondary"
            disabled={!benchmarkFile || busy !== null}
            onClick={() => {
              if (benchmarkFile) {
                const reader = new FileReader();
                reader.onload = (ev) => {
                  try {
                    const text = ev.target?.result as string;
                    // Try JSON first
                    try {
                      const data = JSON.parse(text);
                      if (typeof data === 'object' && !Array.isArray(data)) {
                        setBenchmarkData(data);
                        notify('Benchmark data loaded (JSON)', 'success');
                        return;
                      }
                    } catch {}
                    // Try CSV
                    const lines = text.split(/\n|\r/);
                    const result: Record<string, number> = {};
                    for (const line of lines) {
                      if (!line.trim()) continue;
                      const parts = line.split(/[,	]/);
                      if (parts.length >= 2 && parts[0] && parts[1]) {
                        const name = parts[0].trim().replace(/"/g, '');
                        const val = parseFloat(parts[1].trim().replace(/"/g, ''));
                        if (!isNaN(val) && name) {
                          result[name] = val;
                        }
                      }
                    }
                    if (Object.keys(result).length > 0) {
                      setBenchmarkData(result);
                      notify(`Benchmark data loaded (${Object.keys(result).length} entries)`, 'success');
                    } else {
                      notify('Could not parse benchmark file', 'error');
                    }
                  } catch (e) {
                    notify('Error reading benchmark file', 'error');
                  }
                };
                reader.readAsText(benchmarkFile);
              }
            }}
          >
            Load benchmark
          </button>
          {benchmarkData && (
            <button
              className="button button-ghost"
              onClick={() => setBenchmarkData(null)}
            >
              Clear benchmark
            </button>
          )}
        </div>
        <p className="muted">
          Upload a CSV (name,points) or JSON object with staff names/IDs mapped to expected totals.
        </p>
      </SectionCard>

      <SectionCard title="Report period">
        <div className="filter-grid">
          <label className="field">
            <span className="field-label">From date</span>
            <input type="date" className="input" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">To date</span>
            <input type="date" className="input" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Date basis</span>
            <select
              className="input"
              value={dateBasis}
              onChange={(event) => setDateBasis(event.target.value === 'opened' ? 'opened' : 'activity')}
            >
              <option value="activity">Last activity (close-date proxy)</option>
              <option value="opened">Ticket opening time</option>
            </select>
          </label>
          <label className="field field-wide">
            <span className="field-label">Staff member (optional)</span>
            <input
              className="input"
              placeholder="Name or stable staff ID"
              value={staff}
              onChange={(event) => setStaff(event.target.value)}
            />
          </label>
        </div>
        <p className="muted">
          The dashboard exposes no closing timestamp. “Last activity” uses the final transcript message as the closest
          evidence of when a ticket closed, which matches day-by-day staff totals far better than the opening date. Dates
          are interpreted in this machine’s local timezone. Missing ratings are excluded from averages, not treated as
          zero.
        </p>
      </SectionCard>

      {error ? <Alert tone="danger" title="Report unavailable">{error}</Alert> : null}

      {loading && !report ? (
        <SectionCard>
          <div className="loading-block">
            <Spinner label="Calculating staff awards…" />
          </div>
        </SectionCard>
      ) : null}

      {report ? (
        <>
          <div className="metric-grid">
            <MetricCard label="Staff with activity" value={formatNumber(report.totals.staffCount)} />
            <MetricCard label="Tickets credited" value={formatNumber(report.totals.ticketsCredited)} tone="success" />
            <MetricCard label="Awarded staff points" value={formatPoints(displayPoints(report.totals.awardedPoints))} tone="accent" />
            <MetricCard
              label="Unresolved attribution"
              value={formatNumber(report.totals.unresolvedCredit)}
              tone={report.totals.unresolvedCredit ? 'danger' : undefined}
              hint="excluded from awards"
            />
            <MetricCard
              label="Fallback tickets"
              value={formatNumber(report.totals.fallbackTickets)}
              tone={report.totals.fallbackTickets ? 'warn' : undefined}
            />
            <MetricCard label="Rated tickets" value={formatNumber(report.totals.ratedTickets)} />
          </div>

          {report.rows.length === 0 ? (
            <SectionCard>
              <EmptyState
                title="No staff activity in this period"
                description="Collect and classify tickets, or widen the date filter. Unresolved staff attribution is never guessed into a staff total."
              />
            </SectionCard>
          ) : (
            <SectionCard
              title="Awards by staff member"
              description={`Generated ${formatDate(report.generatedAt)}${report.period.from || report.period.to ? ` · ${report.period.from ? formatDate(report.period.from) : 'start'} to ${report.period.to ? formatDate(report.period.to) : 'now'}` : ''}`}
            >
              <div className="table-wrap">
                <table className="data-table staff-table">
                  <thead>
                    <tr>
                      <th>Staff member</th>
                      <th className="num">Tickets credited</th>
                      <th className="num">Awarded points</th>
                      {benchmarkData ? <th className="num">Manual expected</th> : null}
                      {benchmarkData ? <th className="num">Difference</th> : null}
                      <th className="num">Same claimant + closer</th>
                      <th className="num">Unclaimed half</th>
                      <th className="num">Zero — different staff</th>
                      <th className="num">Fallback tickets</th>
                      <th className="num">Avg rating</th>
                      <th>Category breakdown</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((row) => {
                      const staffKey = row.staffName || row.staffId || '';
                      const rawPoints = row.awardedPoints;
                      const displayedPoints = displayPoints(rawPoints);
                      const expected = benchmarkData ? (benchmarkData[staffKey] ?? benchmarkData[staffKey.toLowerCase()] ?? null) : null;
                      const expectedDisplayed = expected !== null ? displayPoints(expected) : null;
                      const diff = expectedDisplayed !== null ? displayedPoints - expectedDisplayed : null;
                      return (
                        <tr key={row.staffKey}>
                          <td>
                            <div className="staff-name">
                              <span className="avatar-dot" aria-hidden="true">
                                {(row.staffName ?? row.staffId ?? '?').slice(0, 1).toUpperCase()}
                              </span>
                              <div>
                                <strong>{row.staffName ?? 'Unknown staff name'}</strong>
                                <div className="cell-sub">{row.staffId ?? 'stable ID unavailable'}</div>
                              </div>
                            </div>
                          </td>
                          <td className="num">{row.ticketsCredited}</td>
                          <td className="num">
                            <strong>{formatPoints(displayedPoints)}</strong>
                          </td>
                          {benchmarkData ? (
                            <td className="num">{expectedDisplayed !== null ? formatPoints(expectedDisplayed) : <span className="muted">—</span>}</td>
                          ) : null}
                          {benchmarkData ? (
                            <td className="num">
                              <span style={{ color: diff !== null && diff >= 0 ? '#22c55e' : diff !== null ? '#ef4444' : 'inherit' }}>
                                {diff !== null ? (diff >= 0 ? '+' : '') + formatPoints(diff) : <span className="muted">—</span>}
                              </span>
                            </td>
                          ) : null}
                          <td className="num">{row.sameClaimClose}</td>
                          <td className="num">{row.unclaimedHalf}</td>
                          <td className="num">{row.differentZero}</td>
                          <td className="num">{row.fallbackTickets}</td>
                          <td className="num">
                            {row.avgRating === null ? (
                              <span className="muted">—</span>
                            ) : (
                              <>
                                {row.avgRating.toFixed(2)}
                                <div className="cell-sub">{row.ratingCount} rated</div>
                              </>
                            )}
                          </td>
                          <td>
                            <div className="chips">
                              {row.categories.length === 0 ? (
                                <span className="muted">—</span>
                              ) : (
                                row.categories.map((category) => (
                                  <span className="chip" key={category.categoryId} title={`${category.tickets} ticket(s)`}>
                                    {category.code}
                                    <span className="chip-points">{formatPoints(category.points)}</span>
                                  </span>
                                ))
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          )}

          <SectionCard title="How this total is calculated">
            <div className="method-grid">
              <div>
                <ToneBadge tone="success">Rule A</ToneBadge>
                <p>Different confirmed claimant and closer: neither receives points. The ticket’s base score remains for audit.</p>
              </div>
              <div>
                <ToneBadge tone="success">Rule B</ToneBadge>
                <p>Same confirmed claimant and closer: that person receives the full base score.</p>
              </div>
              <div>
                <ToneBadge tone="success">Rule C</ToneBadge>
                <p>Confirmed unclaimed ticket with a reason: the identified closer receives half the base score.</p>
              </div>
              <div>
                <ToneBadge tone="neutral">Rule D</ToneBadge>
                <p>Confirmed unclaimed ticket without a reason: zero staff-credit points.</p>
              </div>
              <div>
                <ToneBadge tone="warn">Rule E</ToneBadge>
                <p>Missing identities or claim state: unresolved, never guessed. These tickets are excluded from awards.</p>
              </div>
            </div>
            <p className="methodology">{report.methodology}</p>
          </SectionCard>
        </>
      ) : null}
    </div>
  );
}
