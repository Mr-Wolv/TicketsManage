import { useCallback, useEffect, useState } from 'react';
import { api, download, formatDate } from '../api';
import { useApp } from '../context';
import { ConnectionCard } from '../components/ConnectionCard';
import {
  Alert,
  LoadingBlock,
  PageHeader,
  SectionCard,
  StatusBadge,
  ToneBadge,
} from '../components/ui';
import type { AppSettings, ModelStatus, SettingsResponse, ApprovedReason, CustomCategory, TaxonomyAuditEntry, TaxonomyOverride } from '../types';
import { flushSync } from 'react-dom';

interface BackupEntry {
  file: string;
  size: number;
  createdAt: string;
}

export function SettingsPage() {
  const { status, refreshStatus, notify, taxonomy } = useApp();
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [form, setForm] = useState<AppSettings | null>(null);
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [resetConfirm, setResetConfirm] = useState('');
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [selectedBackup, setSelectedBackup] = useState('');
  const [restoreConfirm, setRestoreConfirm] = useState('');
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
    latencyMs: number;
    categories: string[];
    sample: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<TaxonomyOverride[]>([]);
  const [customCategories, setCustomCategories] = useState<CustomCategory[]>([]);
  const [approvedReasons, setApprovedReasons] = useState<ApprovedReason[]>([]);
  const [auditLog, setAuditLog] = useState<TaxonomyAuditEntry[]>([]);
  const [taxonomyLoadError, setTaxonomyLoadError] = useState<string | null>(null);
  const [cloudFreeModels, setCloudFreeModels] = useState<string[]>([]);
  const [cloudModelError, setCloudModelError] = useState<string | null>(null);
  const [customForm, setCustomForm] = useState({
    id: '', code: '', label: '', labelAr: '', description: '', points: 2, distinction: '', examples: '', negativeExamples: '',
  });
  const [reasonForm, setReasonForm] = useState({ text: '', categoryId: '' });
  const [reasonSearch, setReasonSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [settingsResult, backupResult] = await Promise.all([
        api<SettingsResponse>('/api/settings'),
        api<{ backups: BackupEntry[] }>('/api/backups'),
      ]);
      setData(settingsResult);
      setForm(settingsResult.settings);
      setBackups(backupResult.backups);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Settings could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTaxonomy = useCallback(async () => {
    setBusy('taxonomy');
    setTaxonomyLoadError(null);
    try {
      const overridesResult = await api<TaxonomyOverride[]>('/api/taxonomy/overrides').catch(() => null);
      const customResult = await api<CustomCategory[]>('/api/taxonomy/custom-categories').catch(() => null);
      const reasonsResult = await api<ApprovedReason[]>('/api/taxonomy/approved-reasons').catch(() => null);
      const auditResult = await api<TaxonomyAuditEntry[]>('/api/taxonomy/audit').catch(() => null);
      setOverrides(overridesResult ?? []);
      setCustomCategories(customResult ?? []);
      setApprovedReasons(reasonsResult ?? []);
      setAuditLog(auditResult ?? []);

      const missing = [
        overridesResult === null ? 'overrides' : null,
        customResult === null ? 'custom categories' : null,
        reasonsResult === null ? 'approved reasons' : null,
        auditResult === null ? 'audit log' : null,
      ].filter(Boolean);
      if (missing.length === 4) {
        setTaxonomyLoadError('Fluid taxonomy data could not be loaded. Check the server connection and try again.');
      } else if (missing.length > 0) {
        setTaxonomyLoadError(`Some taxonomy data could not be loaded: ${missing.join(', ')}. Other sections are still available.`);
      }
    } catch {
      setTaxonomyLoadError('Fluid taxonomy data could not be loaded: unexpected failure.');
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (status?.model) setModelStatus(status.model);
  }, [status?.model]);

  useEffect(() => {
    void loadTaxonomy();
  }, [loadTaxonomy]);

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setForm((current) => (current ? { ...current, [key]: value } : current));
  };

  const save = async () => {
    if (!form) return;
    flushSync(() => {
      setSaving(true);
    });
    setError(null);
    await new Promise((resolve) => setTimeout(resolve, 30));
    try {
      const result = await api<{ settings: AppSettings; message: string }>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify(form),
      });
      setForm(result.settings);
      notify(result.message);
      await refreshStatus();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Settings could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const detectModels = async () => {
    setBusy('detect');
    try {
      const result = await api<ModelStatus>('/api/model/detect', { method: 'POST', body: '{}' });
      setModelStatus(result);
      notify(result.running ? 'Ollama status refreshed.' : 'Ollama is not reachable.', result.running ? 'success' : 'error');
      await refreshStatus();
    } catch (detectError) {
      notify(detectError instanceof Error ? detectError.message : 'Model detection failed.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const testModel = async () => {
    setBusy('test');
    setTestResult(null);
    try {
      const result = await api<{
        ok: boolean;
        message: string;
        latencyMs: number;
        categories: string[];
        sample: string;
        status: ModelStatus;
      }>('/api/model/test', { method: 'POST', body: '{}' });
      setTestResult(result);
      setModelStatus(result.status);
      notify(result.ok ? 'Model self-test passed.' : 'Model self-test did not pass.', result.ok ? 'success' : 'error');
      await refreshStatus();
    } catch (testError) {
      notify(testError instanceof Error ? testError.message : 'Model self-test failed.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const resetProfile = async () => {
    if (resetConfirm !== 'RESET') {
      notify('Type RESET to confirm deleting the dedicated browser profile.', 'error');
      return;
    }
    setBusy('reset');
    try {
      await api('/api/connection/reset', {
        method: 'POST',
        body: JSON.stringify({ confirm: 'RESET' }),
      });
      setResetConfirm('');
      notify('Dedicated browser profile deleted. Your normal browser is unaffected.');
      await refreshStatus();
    } catch (resetError) {
      notify(resetError instanceof Error ? resetError.message : 'Profile reset failed.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const createBackup = async () => {
    setBusy('backup');
    try {
      await api('/api/backups', { method: 'POST', body: '{}' });
      const result = await api<{ backups: BackupEntry[] }>('/api/backups');
      setBackups(result.backups);
      notify('Local backup created.');
    } catch (backupError) {
      notify(backupError instanceof Error ? backupError.message : 'Backup failed.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const restoreBackup = async () => {
    if (restoreConfirm !== 'RESTORE') {
      notify('Type RESTORE to confirm replacing the current local database.', 'error');
      return;
    }
    if (!selectedBackup) {
      notify('Select a backup file first.', 'error');
      return;
    }
    setBusy('restore');
    try {
      const result = await api<{ message: string }>('/api/backups/restore', {
        method: 'POST',
        body: JSON.stringify({ file: selectedBackup, confirm: 'RESTORE' }),
      });
      setRestoreConfirm('');
      notify(result.message);
      await load();
      await refreshStatus();
    } catch (restoreError) {
      notify(restoreError instanceof Error ? restoreError.message : 'Restore failed.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const seedDemo = async () => {
    setBusy('demo');
    try {
      const result = await api<{ created: number; skipped: number; message: string }>('/api/demo/seed', {
        method: 'POST',
        body: '{}',
      });
      notify(result.message);
      await refreshStatus();
    } catch (demoError) {
      notify(demoError instanceof Error ? demoError.message : 'Demo data could not be created.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const clearDemo = async () => {
    setBusy('demo-clear');
    try {
      const result = await api<{ removed: number; message: string }>('/api/demo/clear', {
        method: 'POST',
        body: '{}',
      });
      notify(result.message);
      await refreshStatus();
    } catch (demoError) {
      notify(demoError instanceof Error ? demoError.message : 'Demo data could not be cleared.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const saveOverride = async (categoryId: string, points: number) => {
    setBusy('override');
    try {
      await api(`/api/taxonomy/overrides/${encodeURIComponent(categoryId)}`, {
        method: 'PUT',
        body: JSON.stringify({ points }),
      });
      await loadTaxonomy();
      notify('Points updated.');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to update points.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const saveCustomCategory = async () => {
    setBusy('custom');
    try {
      await api('/api/taxonomy/custom-categories', {
        method: 'POST',
        body: JSON.stringify({
          id: customForm.id,
          code: customForm.code,
          label: customForm.label,
          labelAr: customForm.labelAr,
          description: customForm.description,
          points: customForm.points,
          distinction: customForm.distinction,
          examples: customForm.examples ? customForm.examples.split('\n').filter(Boolean) : [],
          negativeExamples: customForm.negativeExamples ? customForm.negativeExamples.split('\n').filter(Boolean) : [],
        }),
      });
      setCustomForm({ id: '', code: '', label: '', labelAr: '', description: '', points: 2, distinction: '', examples: '', negativeExamples: '' });
      await loadTaxonomy();
      notify('Custom category added.');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to add custom category.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const deleteCustomCategory = async (id: string) => {
    setBusy('del-custom');
    try {
      await api(`/api/taxonomy/custom-categories/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await loadTaxonomy();
      notify('Custom category removed.');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to remove custom category.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const saveApprovedReason = async () => {
    setBusy('reason');
    try {
      await api('/api/taxonomy/approved-reasons', {
        method: 'POST',
        body: JSON.stringify({ text: reasonForm.text, categoryId: reasonForm.categoryId }),
      });
      setReasonForm({ text: '', categoryId: '' });
      await loadTaxonomy();
      notify('Approved reason added.');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to add approved reason.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const deleteApprovedReason = async (id: number) => {
    setBusy('del-reason');
    try {
      await api(`/api/taxonomy/approved-reasons/${id}`, { method: 'DELETE' });
      await loadTaxonomy();
      notify('Approved reason removed.');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to remove approved reason.', 'error');
    } finally {
      setBusy(null);
    }
  };

  if (loading && !data) return <LoadingBlock label="Loading settings…" />;
  if (!data || !form) {
    return (
      <div className="page">
        <PageHeader title="Settings" />
        <Alert tone="danger" title="Settings unavailable">{error ?? 'The local server is not responding.'}</Alert>
      </div>
    );
  }

  const localModels = modelStatus?.localModels ?? [];
  const recommendation = 'qwen2.5:3b';

  return (
    <div className="page">
      <PageHeader
        eyebrow="Configuration"
        title="Settings & connections"
        description="All settings are stored locally. No passwords, Discord tokens, or browser authorization headers are shown or stored here."
        actions={
          <button className="button button-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        }
      />

      {error ? <Alert tone="danger" title="Settings error">{error}</Alert> : null}

      <ConnectionCard />

      <SectionCard
        title="Dedicated browser profile"
        description="The Playwright profile is separate from your normal browser. It persists between runs and is excluded from version control."
      >
        <div className="stack">
          <div className="stat-list">
            <div className="stat-row">
              <span>Profile directory</span>
              <code>{data.meta.profileDir}</code>
            </div>
            <div className="stat-row">
              <span>Browser installed</span>
              <span>{data.meta.browserInstalled ? 'Yes' : 'No — run npx playwright install chromium'}</span>
            </div>
            <div className="stat-row">
              <span>Profile exists</span>
              <span>{status?.connection.profileExists ? 'Yes' : 'Not yet created'}</span>
            </div>
          </div>
          <Alert tone="warn" title="Reset session">
            Resetting deletes only the TicketsManage browser profile and signs this dedicated session out. It does not
            affect your normal Chrome profile. Type RESET to enable the action.
          </Alert>
          <div className="inline-form">
            <input
              className="input"
              placeholder="Type RESET"
              value={resetConfirm}
              onChange={(event) => setResetConfirm(event.target.value)}
            />
            <button className="button button-danger-ghost" onClick={resetProfile} disabled={resetConfirm !== 'RESET' || busy !== null}>
              {busy === 'reset' ? 'Resetting…' : 'Reset dedicated session'}
            </button>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Local semantic model (AI-assisted classification)"
        description="Configure the local Ollama model for shadow evaluation or production AI-assisted classification. All ticket data stays local."
        actions={
          <StatusBadge
            value={modelStatus?.running && modelStatus.selectedInstalled ? 'authenticated' : modelStatus?.running ? 'pending' : 'failed'}
            label={modelStatus?.running && modelStatus.selectedInstalled ? 'Ready' : modelStatus?.running ? 'Model missing' : 'Runtime offline'}
          />
        }
      >
        <div className="stack">
          <div className="form-grid">
            <label className="field field-wide">
              <span className="field-label">AI mode</span>
              <select
                className="input"
                value={form.aiMode ?? 'deterministic'}
                onChange={(event) => update('aiMode', event.target.value as AppSettings['aiMode'])}
              >
                <option value="deterministic">Deterministic (rules only)</option>
                <option value="shadow">Shadow evaluation (model predicts, does not change scores)</option>
                <option value="production">AI-assisted production (model used in live classification)</option>
              </select>
              <span className="field-hint">
                Shadow logs predictions for evaluation. Production mode uses the model for eligible cases with safeguards.
              </span>
            </label>
            <label className="field field-wide">
              <span className="field-label">Ollama URL</span>
              <input className="input" value={form.ollamaUrl} onChange={(event) => update('ollamaUrl', event.target.value)} />
            </label>
            <label className="field field-wide">
              <span className="field-label">Selected model</span>
              {localModels.length > 0 ? (
                <select
                  className="input"
                  value={localModels.includes(form.model) ? form.model : ''}
                  onChange={(event) => update('model', event.target.value)}
                >
                  <option value="">Custom / not installed</option>
                  {localModels.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              ) : null}
              <input
                className="input"
                value={form.model}
                onChange={(event) => update('model', event.target.value)}
                placeholder={recommendation}
              />
            </label>
          </div>
          <div className="stat-list">
            <div className="stat-row">
              <span>Runtime</span>
              <span>
                {modelStatus?.running
                  ? `running${modelStatus.version ? ` · v${modelStatus.version}` : ''} at ${modelStatus.baseUrl}`
                  : modelStatus?.error ?? 'Not checked'}
              </span>
            </div>
            <div className="stat-row">
              <span>Installed local models</span>
              <span>{localModels.length ? localModels.join(', ') : 'None'}</span>
            </div>
            <div className="stat-row">
              <span>Cloud-only models</span>
              <span>
                {modelStatus?.models.filter((model) => model.remote).length ?? 0} (never used by TicketsManage)
              </span>
            </div>
          </div>
          <div className="button-row">
            <button className="button button-ghost" onClick={detectModels} disabled={busy !== null}>
              {busy === 'detect' ? 'Detecting…' : 'Detect models'}
            </button>
            <button className="button button-secondary" onClick={testModel} disabled={busy !== null || !form.semanticEnabled}>
              {busy === 'test' ? 'Testing…' : 'Run classifier self-test'}
            </button>
          </div>
          {testResult ? (
            <Alert tone={testResult.ok ? 'success' : 'warn'} title={testResult.ok ? 'Self-test passed' : 'Self-test failed'}>
              {testResult.message} {testResult.categories.length ? `Returned: ${testResult.categories.join(', ')}.` : ''} Latency:{' '}
              {testResult.latencyMs} ms. The harmless sample was: “{testResult.sample}”
            </Alert>
          ) : null}
          {!modelStatus?.selectedInstalled ? (
            <Alert tone="warn" title="Install the recommended small multilingual model">
              <p>
                Recommended: <code>{recommendation}</code> — a small multilingual instruction model (about 1.9 GB download,
                roughly 3 GB RAM while loaded). It handles English, Arabic, Egyptian dialect and mixed wording reasonably
                well for this constrained classification task.
              </p>
              <p>
                In a terminal run <code>ollama pull {recommendation}</code>, then select Detect models here. A larger model
                may improve Arabic nuance, but needs more RAM. Do not switch to a hosted API; privacy is preserved locally.
              </p>
            </Alert>
          ) : null}
        </div>
      </SectionCard>

      <SectionCard
        title="Cloud semantic provider (optional)"
        description="Use an OpenAI-compatible provider for optional AI-assisted classification. Your API key is stored locally and never sent anywhere except the provider you choose."
      >
        <div className="stack">
          <div className="form-grid">
            <label className="field field-wide">
              <span className="field-label">Provider</span>
              <select
                className="input"
                value={form.cloudProviderUrl ? 'custom' : 'none'}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === 'custom') {
                    update('cloudProviderUrl', 'https://');
                    update('cloudModel', '');
                  } else {
                    update('cloudProviderUrl', '');
                    update('cloudModel', '');
                    update('cloudApiKey', '');
                  }
                }}
              >
                <option value="none">None (deterministic only)</option>
                <option value="custom">Custom OpenAI-compatible endpoint</option>
              </select>
              <span className="field-hint">
                Pick a provider below, then enter its base URL, model ID, and API key. For OpenRouter, use the free-model selector to choose a currently free model.
              </span>
            </label>
            {form.cloudProviderUrl ? (
              <>
                <label className="field field-wide">
                  <span className="field-label">Provider base URL</span>
                  <input
                    className="input"
                    value={form.cloudProviderUrl}
                    onChange={(event) => update('cloudProviderUrl', event.target.value)}
                    placeholder="https://openrouter.ai/api/v1"
                  />
                </label>
                <label className="field field-wide">
                  <span className="field-label">Model ID</span>
                  <input
                    className="input"
                    value={form.cloudModel}
                    onChange={(event) => update('cloudModel', event.target.value)}
                    placeholder="e.g. meta-llama/llama-3.1-8b-instruct"
                  />
                </label>
                <label className="field field-wide">
                  <span className="field-label">API key</span>
                  <input
                    className="input"
                    type="password"
                    value={form.cloudApiKey}
                    onChange={(event) => update('cloudApiKey', event.target.value)}
                    placeholder="sk-or-..."
                  />
                  <span className="field-hint">Stored in local settings only.</span>
                </label>
                <label className="field field-wide">
                  <span className="field-label">Timeout (ms)</span>
                  <input
                    className="input"
                    type="number"
                    min={1000}
                    max={300000}
                    step={1000}
                    value={form.cloudTimeoutMs}
                    onChange={(event) => update('cloudTimeoutMs', Number(event.target.value))}
                  />
                </label>
                <div className="inline-form">
                  <button
                    className="button button-secondary"
                    onClick={async () => {
                      setBusy('cloud-models');
                      setCloudModelError(null);
                      try {
                        const response = await fetch('https://openrouter.ai/api/v1/models', {
                          headers: { Authorization: `Bearer ${form.cloudApiKey}` },
                        });
                        if (!response.ok) throw new Error(`OpenRouter responded ${response.status}`);
                        const payload = (await response.json()) as Record<string, unknown>;
                        const models = Array.isArray((payload.data as Array<Record<string, unknown>>) ?? [])
                          ? (payload.data as Array<Record<string, unknown>>)
                          : [];
                        const free = models
                          .filter((model) => {
                            const pricing = model.pricing as Record<string, string> | undefined;
                            return (
                              pricing?.prompt === '0' &&
                              pricing?.completion === '0' &&
                              typeof model.id === 'string'
                            );
                          })
                          .map((model) => String(model.id));
                        setCloudFreeModels(free);
                        if (free.length === 0) {
                          setCloudModelError('No free models found in the current OpenRouter roster.');
                        }
                      } catch (error) {
                        setCloudModelError(error instanceof Error ? error.message : 'Could not load free models.');
                      } finally {
                        setBusy(null);
                      }
                    }}
                    disabled={busy !== null || !form.cloudApiKey}
                  >
                    {busy === 'cloud-models' ? 'Checking…' : 'Check OpenRouter free models'}
                  </button>
                  {cloudFreeModels.length > 0 ? (
                    <select
                      className="input"
                      value={form.cloudModel}
                      onChange={(event) => update('cloudModel', event.target.value)}
                    >
                      <option value="">Select free model…</option>
                      {cloudFreeModels.map((modelId) => (
                        <option key={modelId} value={modelId}>
                          {modelId}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </div>
                {cloudModelError ? (
                  <p className="muted" style={{ color: '#b45309' }}>
                    {cloudModelError}
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Classification and collection behaviour">
        <div className="form-grid">
          <label className="check-row field-wide">
            <input
              type="checkbox"
              checked={form.semanticEnabled}
              onChange={(event) => update('semanticEnabled', event.target.checked)}
            />
            <span>Allow AI-assisted classification (local or cloud). In production mode this affects live ticket scoring.</span>
          </label>
          <label className="check-row field-wide">
            <input
              type="checkbox"
              checked={form.classificationEnabled}
              onChange={(event) => update('classificationEnabled', event.target.checked)}
            />
            <span>Classify new tickets during collection by default</span>
          </label>
          <label className="check-row field-wide">
            <input
              type="checkbox"
              checked={form.autoReuseSession}
              onChange={(event) => update('autoReuseSession', event.target.checked)}
            />
            <span>Try to reuse the saved dashboard session on startup (headless verification)</span>
          </label>
          <label className="field">
            <span className="field-label">Fuzzy-match threshold (0.50–0.98)</span>
            <input
              type="number"
              min={0.5}
              max={0.98}
              step={0.01}
              className="input"
              value={form.fuzzyThreshold}
              onChange={(event) => update('fuzzyThreshold', Number(event.target.value))}
            />
          </label>
          <label className="field">
            <span className="field-label">Delay between tickets (ms)</span>
            <input
              type="number"
              min={0}
              max={10000}
              step={50}
              className="input"
              value={form.requestDelayMs}
              onChange={(event) => update('requestDelayMs', Number(event.target.value))}
            />
          </label>
          <label className="field">
            <span className="field-label">Parallel transcript reads</span>
            <input
              type="number"
              min={1}
              max={6}
              className="input"
              value={form.fetchConcurrency}
              onChange={(event) => update('fetchConcurrency', Number(event.target.value))}
            />
            <span className="field-hint">
              1 is sequential. 2–4 overlaps network waiting without hammering the dashboard.
            </span>
          </label>
          <label className="field">
            <span className="field-label">Retries per ticket</span>
            <input
              type="number"
              min={0}
              max={5}
              className="input"
              value={form.maxRetries}
              onChange={(event) => update('maxRetries', Number(event.target.value))}
            />
          </label>
          <label className="field">
            <span className="field-label">Model wait limit for offline tools (ms)</span>
            <input
              type="number"
              min={1000}
              max={120000}
              step={1000}
              className="input"
              value={form.modelTimeoutMs}
              onChange={(event) => update('modelTimeoutMs', Number(event.target.value))}
            />
            <span className="field-hint">
              Live collection never waits for the model. Unfamiliar wording gets the visible General problem fallback
              immediately, with an explanation and a correction action in Review.
            </span>
          </label>
          <label className="field">
            <span className="field-label">Dashboard navigation timeout (ms)</span>
            <input
              type="number"
              min={5000}
              max={120000}
              step={1000}
              className="input"
              value={form.navigationTimeoutMs}
              onChange={(event) => update('navigationTimeoutMs', Number(event.target.value))}
            />
          </label>
          <label className="field field-wide">
            <span className="field-label">Tickets dashboard URL</span>
            <input className="input" value={form.dashboardUrl} onChange={(event) => update('dashboardUrl', event.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Discord server / guild ID</span>
            <input className="input" value={form.guildId} onChange={(event) => update('guildId', event.target.value.replace(/\D/g, ''))} />
          </label>
        </div>
        <p className="muted">
          Changing the dashboard URL or guild requires verifying the connection again. Rate limits are respected: the
          collector pauses rather than trying to evade them.
        </p>
      </SectionCard>

      <SectionCard
        title="Fixed taxonomy"
        description="Point values are code-level rules, not model output. They cannot be edited from this interface."
      >
        <div className="table-wrap">
          <table className="data-table taxonomy-table">
            <thead>
              <tr>
                <th>Category</th>
                <th>Arabic</th>
                <th className="num">Points</th>
                <th>Meaning</th>
              </tr>
            </thead>
            <tbody>
              {taxonomy.map((category) => (
                <tr key={category.id}>
                  <td>
                    <strong>{category.code}</strong>
                    <div className="cell-sub">{category.id}</div>
                  </td>
                  <td dir="rtl">{category.labelAr}</td>
                  <td className="num">
                    <ToneBadge tone="accent">{category.points}</ToneBadge>
                  </td>
                  <td className="taxonomy-description">{category.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted">
          General problem fallback uses the existing General Issue category (2 points) and is always marked for review.
          Recharge was added at 2 points, including its Arabic and Arabizi aliases.
        </p>
      </SectionCard>

      <SectionCard
        title="Fluid taxonomy"
        description="Point overrides, custom categories, and approved reasons are stored locally and reused automatically."
      >
        <div className="stack">
          {taxonomyLoadError ? (
            <Alert tone="danger" title="Taxonomy loading issue">
              {taxonomyLoadError}
            </Alert>
          ) : null}
          <div className="form-grid">
            <h3>Point overrides</h3>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Category</th>
                    <th className="num">Base</th>
                    <th className="num">Override</th>
                    <th>Note</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {taxonomy.filter((c) => !c.isCustom).map((category) => {
                    const ov = overrides.find((o) => o.categoryId === category.id);
                    return (
                      <tr key={category.id}>
                        <td>
                          <strong>{category.code}</strong>
                          <div className="cell-sub">{category.id}</div>
                        </td>
                        <td className="num">{category.points}</td>
                        <td className="num">
                          <input
                            type="number"
                            className="input input-sm"
                            value={ov?.points ?? category.points}
                            onChange={(e) =>
                              saveOverride(category.id, Number(e.target.value))
                            }
                            min={0}
                            step={1}
                          />
                        </td>
                        <td>
                          <input
                            className="input input-sm"
                            value={ov?.note ?? ''}
                            onChange={(e) =>
                              saveOverride(category.id, ov?.points ?? category.points)
                            }
                            placeholder="optional note"
                          />
                        </td>
                        <td>
                          {ov ? (
                            <span className="muted">saved {new Date(ov.changedAt).toLocaleString()}</span>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="form-grid">
            <h3>Custom categories</h3>
            <div className="inline-form">
              <input
                className="input"
                placeholder="ID (e.g. VIP)"
                value={customForm.id}
                onChange={(e) => setCustomForm((f) => ({ ...f, id: e.target.value }))}
              />
              <input
                className="input"
                placeholder="Code"
                value={customForm.code}
                onChange={(e) => setCustomForm((f) => ({ ...f, code: e.target.value }))}
              />
              <input
                className="input"
                placeholder="Label"
                value={customForm.label}
                onChange={(e) => setCustomForm((f) => ({ ...f, label: e.target.value }))}
              />
              <input
                className="input"
                placeholder="Label (AR)"
                value={customForm.labelAr}
                onChange={(e) => setCustomForm((f) => ({ ...f, labelAr: e.target.value }))}
              />
              <input
                className="input"
                placeholder="Description"
                value={customForm.description}
                onChange={(e) => setCustomForm((f) => ({ ...f, description: e.target.value }))}
              />
              <input
                type="number"
                className="input"
                placeholder="Points"
                value={customForm.points}
                onChange={(e) => setCustomForm((f) => ({ ...f, points: Number(e.target.value) }))}
                min={0}
                step={1}
              />
              <input
                className="input"
                placeholder="Distinction (optional)"
                value={customForm.distinction}
                onChange={(e) => setCustomForm((f) => ({ ...f, distinction: e.target.value }))}
              />
              <input
                className="input"
                placeholder="Examples (one per line)"
                value={customForm.examples}
                onChange={(e) => setCustomForm((f) => ({ ...f, examples: e.target.value }))}
              />
              <input
                className="input"
                placeholder="Negative examples (one per line)"
                value={customForm.negativeExamples}
                onChange={(e) => setCustomForm((f) => ({ ...f, negativeExamples: e.target.value }))}
              />
              <button className="button button-secondary" onClick={saveCustomCategory} disabled={busy !== null}>
                Add custom category
              </button>
            </div>
            {customCategories.length === 0 ? (
              <p className="muted">No custom categories yet.</p>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Code</th>
                      <th>Label</th>
                      <th>Arabic</th>
                      <th className="num">Points</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {customCategories.map((cat) => (
                      <tr key={cat.id}>
                        <td>{cat.id}</td>
                        <td>{cat.code}</td>
                        <td>{cat.label}</td>
                        <td dir="rtl">{cat.labelAr}</td>
                        <td className="num">{cat.points}</td>
                        <td>
                          <button
                            className="button button-danger-ghost button-sm"
                            onClick={() => deleteCustomCategory(cat.id)}
                            disabled={busy !== null}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="form-grid">
            <h3>Approved reasons</h3>
            <div className="inline-form">
              <input
                className="input"
                placeholder="Close reason text"
                value={reasonForm.text}
                onChange={(e) => setReasonForm((f) => ({ ...f, text: e.target.value }))}
              />
              <select
                className="input"
                value={reasonForm.categoryId}
                onChange={(e) => setReasonForm((f) => ({ ...f, categoryId: e.target.value }))}
              >
                <option value="">Category…</option>
                {taxonomy.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.code} ({cat.id})
                  </option>
                ))}
                {customCategories.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.code} ({cat.id}) — custom
                  </option>
                ))}
              </select>
              <button className="button button-secondary" onClick={saveApprovedReason} disabled={busy !== null}>
                Add approved reason
              </button>
            </div>
            <input
              className="input"
              placeholder="Search approved reasons…"
              value={reasonSearch}
              onChange={(e) => setReasonSearch(e.target.value)}
            />
            {approvedReasons.filter((r) => {
              if (!reasonSearch) return true;
              const q = reasonSearch.toLowerCase();
              return (
                r.text.toLowerCase().includes(q) ||
                r.categoryId.toLowerCase().includes(q) ||
                r.normalizedText.toLowerCase().includes(q)
              );
            }).length === 0 ? (
              <p className="muted">No approved reasons yet.</p>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Text</th>
                      <th>Category</th>
                      <th>Source</th>
                      <th>Created</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {approvedReasons
                      .filter((r) => {
                        if (!reasonSearch) return true;
                        const q = reasonSearch.toLowerCase();
                        return (
                          r.text.toLowerCase().includes(q) ||
                          r.categoryId.toLowerCase().includes(q) ||
                          r.normalizedText.toLowerCase().includes(q)
                        );
                      })
                      .map((reason) => (
                        <tr key={reason.id}>
                          <td>{reason.text}</td>
                          <td>
                            <ToneBadge tone="accent">
                              {taxonomy.find((c) => c.id === reason.categoryId)?.code ?? reason.categoryId}
                            </ToneBadge>
                          </td>
                          <td>{reason.sourceType}</td>
                          <td>{new Date(reason.createdAt).toLocaleString()}</td>
                          <td>
                            <button
                              className="button button-danger-ghost button-sm"
                              onClick={() => deleteApprovedReason(reason.id)}
                              disabled={busy !== null}
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="form-grid">
            <h3>Audit log</h3>
            {auditLog.length === 0 ? (
              <p className="muted">No taxonomy changes recorded yet.</p>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Action</th>
                      <th>Entity</th>
                      <th>Old</th>
                      <th>New</th>
                      <th>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditLog.slice(0, 20).map((entry) => (
                      <tr key={entry.id}>
                        <td>{new Date(entry.changedAt).toLocaleString()}</td>
                        <td>{entry.action}</td>
                        <td>
                          {entry.entityType}: {entry.entityId}
                        </td>
                        <td>{entry.oldValue ?? '—'}</td>
                        <td>{entry.newValue ?? '—'}</td>
                        <td>{entry.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Data, backup and recovery">
        <div className="stack">
          <div className="stat-list">
            <div className="stat-row">
              <span>Data directory</span>
              <code>{data.meta.dataDir}</code>
            </div>
            <div className="stat-row">
              <span>SQLite database</span>
              <code>{data.meta.dbPath}</code>
            </div>
            <div className="stat-row">
              <span>Backups</span>
              <code>{data.meta.backupDir}</code>
            </div>
            <div className="stat-row">
              <span>Exports</span>
              <code>{data.meta.exportDir}</code>
            </div>
          </div>
          <p className="muted">
            Backups use SQLite’s consistent VACUUM INTO. The database is never deleted by an application update. To remove
            all local data deliberately, close TicketsManage and delete the data directory shown above.
          </p>
          <div className="button-row">
            <button className="button button-secondary" onClick={createBackup} disabled={busy !== null}>
              {busy === 'backup' ? 'Creating…' : 'Create backup now'}
            </button>
          </div>
          <div className="backup-list">
            {backups.length === 0 ? (
              <p className="muted">No backups yet.</p>
            ) : (
              backups.map((backup) => (
                <label className={`backup-row${selectedBackup === backup.file ? ' backup-selected' : ''}`} key={backup.file}>
                  <input
                    type="radio"
                    name="backup"
                    value={backup.file}
                    checked={selectedBackup === backup.file}
                    onChange={() => setSelectedBackup(backup.file)}
                  />
                  <span>
                    <strong>{backup.file}</strong>
                    <span className="muted">
                      {' '}
                      · {(backup.size / 1024 / 1024).toFixed(2)} MB · {formatDate(backup.createdAt)}
                    </span>
                  </span>
                </label>
              ))
            )}
          </div>
          {backups.length > 0 ? (
            <div className="restore-box">
              <Alert tone="warn" title="Restore replaces the current database">
                A safety copy of the current database is kept beside the live file. Restoring does not change the browser
                profile. Type RESTORE to confirm.
              </Alert>
              <div className="inline-form">
                <input
                  className="input"
                  placeholder="Type RESTORE"
                  value={restoreConfirm}
                  onChange={(event) => setRestoreConfirm(event.target.value)}
                />
                <button
                  className="button button-danger-ghost"
                  onClick={restoreBackup}
                  disabled={restoreConfirm !== 'RESTORE' || !selectedBackup || busy !== null}
                >
                  {busy === 'restore' ? 'Restoring…' : 'Restore selected backup'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </SectionCard>

      <SectionCard
        title="Demonstration data"
        description="Synthetic examples are stored separately and marked with demo IDs. They are excluded from real metrics and can be removed at any time."
      >
        <div className="stack">
          <div className="stat-row">
            <span>Synthetic demo tickets stored</span>
            <strong>{status?.demoOverview.totalTickets ?? 0}</strong>
          </div>
          <div className="button-row">
            <button className="button button-ghost" onClick={seedDemo} disabled={busy !== null}>
              {busy === 'demo' ? 'Creating…' : 'Create/refresh demo data'}
            </button>
            <button className="button button-danger-ghost" onClick={clearDemo} disabled={busy !== null}>
              {busy === 'demo-clear' ? 'Removing…' : 'Remove all demo data'}
            </button>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Reset roster (start fresh)">
        <div className="stack">
          <Alert tone="warn" title="This clears collected roster data">
            Reset removes locally collected tickets, transcripts, assessments, reviews, collection runs and cached reports.
            It does <strong>not</strong> modify Discord/Tickets dashboard data. A verified backup is created before reset.
            Settings, taxonomy, browser profile, auth state and <strong>approved aliases</strong> (reusable corrections) are
            preserved.
          </Alert>
          <div className="button-row">
            <button
              className="button button-ghost"
              onClick={async () => {
                try {
                  const response = await fetch('/api/reset/preview');
                  const payload = await response.json();
                  if (payload.error) throw new Error(payload.error.message);
                  const c = payload.counts ?? {};
                  notify(
                    `Preview: tickets ${c.tickets ?? 0}, messages ${c.transcriptMessages ?? 0}, assessments ${c.assessments ?? 0}, reviews ${c.reviews ?? 0}, runs ${c.collectionRuns ?? 0}`,
                    'info',
                  );
                } catch (error) {
                  notify(error instanceof Error ? error.message : 'Failed to load reset preview', 'error');
                }
              }}
              disabled={busy !== null}
            >
              Preview affected data
            </button>
          </div>
          <div className="restore-box">
            <p className="muted">
              Type <strong>RESET ROSTER</strong> to confirm. If a collection is running, stop it first.
            </p>
            <div className="inline-form">
              <input
                className="input"
                placeholder="Type RESET ROSTER"
                value={restoreConfirm}
                onChange={(event) => setRestoreConfirm(event.target.value)}
              />
              <button
                className="button button-danger-ghost"
                onClick={async () => {
                  if (restoreConfirm !== 'RESET ROSTER') {
                    notify('Type RESET ROSTER to confirm', 'error');
                    return;
                  }
                  setBusy('restore');
                  try {
                    const response = await fetch('/api/reset/roster', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ confirm: 'RESET ROSTER' }),
                    });
                    const payload = await response.json();
                    if (!response.ok || payload.error) {
                      throw new Error(payload.error?.message ?? 'Reset failed');
                    }
                    notify(payload.message ?? 'Roster reset complete', 'success');
                    setRestoreConfirm('');
                    await load();
                  } catch (error) {
                    notify(error instanceof Error ? error.message : 'Reset failed', 'error');
                  } finally {
                    setBusy(null);
                  }
                }}
                disabled={restoreConfirm !== 'RESET ROSTER' || busy !== null}
              >
                {busy === 'restore' ? 'Resetting…' : 'Reset roster'}
              </button>
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Diagnostics">
        <div className="stack">
          <p className="muted">
            Sanitized diagnostics include runtime resources, counts, connection state, model availability and recent
            structured logs. They never include ticket transcripts, closing reasons, cookies, tokens or authorization
            headers.
          </p>
          <div className="button-row">
            <button className="button button-ghost" onClick={() => download('/api/diagnostics?download=1')}>
              Export sanitized diagnostics
            </button>
            <button className="button button-ghost" onClick={() => void load()}>
              Refresh settings
            </button>
          </div>
          <div className="stat-list">
            <div className="stat-row">
              <span>Application / taxonomy / classifier</span>
              <code>
                {data.meta.appVersion} / {data.meta.taxonomyVersion} / {data.meta.classifierVersion}
              </code>
            </div>
            <div className="stat-row">
              <span>Runtime</span>
              <code>
                Node {data.meta.node} · {data.meta.platform}
              </code>
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Privacy and safety">
        <ul className="plain-list">
          <li>No Discord user token is requested, read or stored. Sign-in uses the dedicated browser’s normal flow.</li>
          <li>Ticket content and transcripts are never sent to hosted AI or third-party classification services.</li>
          <li>The collector only reads pages and data your authorized dashboard account can already access.</li>
          <li>The collector never claims, closes, edits, relabels or deletes tickets.</li>
          <li>Report totals are decision support, not automatic disciplinary decisions.</li>
        </ul>
      </SectionCard>
    </div>
  );
}
