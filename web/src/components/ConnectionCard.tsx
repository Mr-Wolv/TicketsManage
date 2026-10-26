import { useState } from 'react';
import { api } from '../api';
import { useApp } from '../context';
import type { ConnectionStatus } from '../types';
import { Alert, SectionCard, StatusBadge } from './ui';

export function ConnectionCard({
  compact = false,
  onChanged,
}: {
  compact?: boolean;
  onChanged?: () => void;
}) {
  const { status, refreshStatus, notify } = useApp();
  const [busy, setBusy] = useState<'connect' | 'verify' | 'disconnect' | null>(null);
  const connection = status?.connection;
  if (!connection) return null;

  const run = async (action: 'connect' | 'verify' | 'disconnect') => {
    setBusy(action);
    try {
      const path =
        action === 'connect'
          ? '/api/connection/connect'
          : action === 'verify'
            ? '/api/connection/verify'
            : '/api/connection/disconnect';
      const result = await api<{ status: ConnectionStatus }>(path, {
        method: 'POST',
        body: '{}',
      });
      await refreshStatus();
      onChanged?.();
      if (result.status.state === 'authenticated') {
        notify('Connected. The authenticated Transcripts interface is reachable.');
      } else if (result.status.state === 'waiting_for_signin') {
        notify('Finish signing in in the dedicated browser window, then select Verify connection.', 'info');
      } else if (action === 'disconnect') {
        notify('Disconnected. The saved browser profile was kept.');
      } else {
        notify(result.status.message, 'error');
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Connection action failed.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const authenticated = connection.state === 'authenticated';
  return (
    <SectionCard
      title="Tickets dashboard"
      description="Uses a dedicated browser profile and the website’s normal Discord sign-in."
      className={compact ? 'card-compact' : ''}
      actions={<StatusBadge value={connection.state} />}
    >
      <div className="stack">
        <p className="connection-message">{connection.message}</p>
        {!compact ? (
          <Alert tone={authenticated ? 'success' : 'info'} title={authenticated ? 'Access verified' : 'How connecting works'}>
            {authenticated ? (
              <>
                Verified {connection.lastVerifiedAt ? new Date(connection.lastVerifiedAt).toLocaleString() : 'recently'}.
                The session is stored only in the private local browser profile.
              </>
            ) : (
              <>
                Select Connect to open the dedicated browser. Complete the normal Tickets/Discord sign-in there, then
                return here and select Verify connection. TicketsManage never asks for, reads, or stores your Discord token
                or password.
              </>
            )}
          </Alert>
        ) : null}
        <div className="button-row">
          <button
            className="button button-primary"
            onClick={() => run(connection.browserOpen ? 'verify' : 'connect')}
            disabled={busy !== null}
          >
            {busy === 'connect'
              ? 'Opening browser…'
              : busy === 'verify'
                ? 'Verifying…'
                : connection.browserOpen
                  ? 'Verify connection'
                  : authenticated
                    ? 'Re-verify connection'
                    : 'Connect to Tickets dashboard'}
          </button>
          {connection.browserOpen && !authenticated ? (
            <button className="button button-ghost" onClick={() => run('connect')} disabled={busy !== null}>
              Reopen sign-in window
            </button>
          ) : null}
          {authenticated || connection.browserOpen ? (
            <button className="button button-ghost" onClick={() => run('disconnect')} disabled={busy !== null}>
              {busy === 'disconnect' ? 'Closing…' : 'Disconnect'}
            </button>
          ) : null}
        </div>
        {connection.lastError ? (
          <details className="diagnostic-details">
            <summary>Last connection diagnostic</summary>
            <code>{connection.lastError}</code>
          </details>
        ) : null}
      </div>
    </SectionCard>
  );
}
