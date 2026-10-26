# Backup and recovery

TicketsManage keeps everything in one local data directory. Nothing is stored in the cloud.

## Where the data lives

| Item | Default path |
|---|---|
| SQLite database | `data/ticketsmanage.db` (plus `-wal` and `-shm` while running) |
| Dedicated browser profile | `data/browser-profile/` |
| UI-created backups | `data/backups/` |
| Exports | `data/exports/` |
| Logs | `data/logs/` |
| Runtime data directory | Override with the `TICKETS_DATA_DIR` environment variable |

The exact paths are shown in **Settings → Data, backup and recovery**.

## Create a backup

### From the application (recommended)

1. Open **Settings**.
2. Select **Create backup now**.
3. The snapshot appears in the backup list under `data/backups`.

The application uses SQLite's `VACUUM INTO`, so the snapshot is consistent even while the database is open in WAL mode. It contains tickets, transcripts, classifications, corrections, review history, approved examples, settings, and collection-run checkpoints. It does **not** contain the browser session.

### Cold copy

Close TicketsManage completely, then copy the whole `data` directory (or at least `ticketsmanage.db` and any `-wal`/`-shm` files) to another drive. Copying only the `.db` while the application is running can miss recent WAL writes.

## Restore a backup

1. Open **Settings → Data, backup and recovery**.
2. Select a backup from the list.
3. Type `RESTORE` and select **Restore selected backup**.

Before replacing anything, TicketsManage:

1. opens the candidate and verifies it contains the required tables (`tickets`, `assessments`, `reviews`, `collection_runs`);
2. closes the live database;
3. writes a safety copy of the current file as `ticketsmanage.db.pre-restore-<timestamp>`;
4. copies the selected backup into place and reopens the database.

If validation fails, nothing is replaced.

Restoring does not change the browser profile. If the dashboard session has expired, reconnect and sign in again.

### Manual restore

Only when the application cannot start:

1. Close TicketsManage.
2. Locate the desired backup in `data/backups/`.
3. Rename the current `ticketsmanage.db` to `ticketsmanage.db.broken` and delete `ticketsmanage.db-wal` / `ticketsmanage.db-shm`.
4. Copy the backup to `data/ticketsmanage.db`.
5. Start TicketsManage and check **Overview → Tickets collected**.

Keep the renamed broken file until you have verified the restored data.

## Recover an interrupted collection

Collection writes a checkpoint for every processed ticket. If the application or computer stops mid-run:

1. Start TicketsManage.
2. Open **Collect tickets**. The interrupted run is shown with its last processed ticket.
3. Select **Resume**. Completed tickets are skipped, not re-fetched or duplicated.

A run can also be paused or cancelled from the same page. Cancelling keeps already collected tickets and their assessments.

## Reset the dashboard session

If sign-in is broken or you want to use another dashboard account:

1. Close any dedicated Chromium window opened by TicketsManage, or let the application close it.
2. In **Settings → Dedicated browser profile**, type `RESET` and select **Reset dedicated session**.

This deletes only `data/browser-profile`. Tickets, classifications, corrections, backups, and exports are unaffected. Your normal browser profile is never touched.

## Recover a corrupted database

The application refuses to start if the SQLite file is unreadable.

1. Keep a copy of the corrupted file for diagnosis.
2. Restore the newest backup using the manual procedure above.
3. If no backup exists, rename the database aside and start the application: it creates a new empty database. Previously collected data cannot be reconstructed without a backup; re-run collection for the affected range.
4. The dedicated browser profile can be rebuilt by signing in again.

## Remove all local data

Close TicketsManage and delete the `data` directory. This permanently removes the database, browser profile, backups, exports, logs, and model settings. There is no remote copy.

## What is not included

- The Playwright Chromium installation under the user's local application data.
- Ollama and its model files.
- Your normal browser profile or Discord credentials.
