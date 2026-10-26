# TicketsManage — user guide

This is the practical, day-to-day guide. It covers connecting, collecting, reading staff numbers, correcting results, exporting, performance diagnostics, and resetting data safely.

## 1. Start and stop

1. Run **Setup.bat** once.
2. Run **TicketsManage.bat**. The app opens at <http://127.0.0.1:5178>.
3. Close the command window (or press `Ctrl+C` in it) to stop the app. The database and saved dashboard session stay on disk.

Data lives in `data/`:

| Path | Contents |
|---|---|
| `data/ticketsmanage.db` | Tickets, transcripts, assessments, reviews, aliases, collection runs |
| `data/browser-profile/` | Dedicated Playwright session (contains sign-in material — keep private) |
| `data/backups/` | Database backups created in Settings |
| `data/exports/` | JSON/CSV exports |
| `data/logs/` | Local structured logs |

## 2. Connect to the dashboard

Open **Settings → Connection** (or Overview) and select **Connect to Tickets dashboard**. Finish the normal Discord sign-in in the dedicated window, return to the app, then select **Verify connection**.

The app captures the dashboard's own short-lived API authorization in memory only. It never asks for or stores your Discord password or token. If the session expires, the run pauses with `AUTH_REQUIRED`; reconnect in Settings, then resume.

## 3. Collect tickets

Go to **Collect tickets**. Both endpoints are inclusive.

### Sync range (normal choice)

**Reuse already collected records (incremental sync)** is on by default. It:

- reads the dashboard's ordered listing, about 15 tickets per request;
- detects new tickets and metadata changes (closing reason, closer, rating);
- reuses a complete stored transcript only while those listing fields are unchanged; a changed field forces a fresh transcript and reassessment;
- reuses complete stored transcripts without reopening them when nothing visible changed;
- retries records that previously had no transcript or a failure;
- reclassifies records whose classifier/taxonomy version is older.

**Use this every day.** It is the fast path and is idempotent: tickets, messages, assessments, reviews and awards are updated, never duplicated.

### Full refresh (deliberate re-read)

Turn incremental sync **off** when you want every transcript re-read from the dashboard. This is slower and uses more dashboard requests. Use it after a long gap or when you suspect transcript content changed. The dashboard exposes no transcript revision, modification time, or claimant field, so a transcript-only edit with identical listing metadata cannot be detected by Sync. Full refresh is the truthful way to re-check transcripts and claimant changes.

### Pause, resume, cancel

Progress is checkpointed in SQLite after each ticket/batch. **Pause** finishes the current batch. **Resume** continues without repeating completed items and preserves the original mode: a paused Sync stays a Sync, not a Full refresh. An app restart converts a running job to paused. **Cancel** ends the run; the next run starts a fresh checkpoint.

### Rate limits

The dashboard rate-limits bursts. Requests pass through one serialized gate, so raising concurrency cannot create a burst. If the dashboard returns HTTP 429, the app honours `Retry-After`, waits one cooldown, and retries once; a second 429 pauses with `RATE_LIMITED` and stores no partial record. Completed tickets are kept. If it pauses, wait 1–2 minutes, then **Resume**. Collection is read-only: it never claims, closes, edits, labels or deletes tickets.

**Settings → Collection** controls:

| Setting | Meaning |
|---|---|
| Parallel transcript reads | 1–6. 1 = strictly sequential. 2–3 overlaps network waiting. |
| Delay between requests (ms) | True minimum spacing per dashboard API request. **2,000 ms** is the safe setting for large live ranges; 1,000 ms caused a 429 burst with concurrency 2. |
| Retries per ticket | Transient failures only; authentication and rate-limit errors always pause. |

Raising concurrency without raising the delay does **not** increase throughput; the shared request spacing is what protects the account.

## 4. Get staff numbers

Open **Staff performance**.

1. Set **From date** and **To date**.
2. Choose **Date basis**:
   - **Last activity (close-date proxy)** — the final transcript message timestamp. The dashboard has no closing timestamp; this is the closest evidence of the day a ticket stopped being active and matches manual day columns much better than opening time.
   - **Ticket opening time** — the day the ticket was created.
3. Optionally filter to one staff member.
4. Read **Awarded staff points** and **Tickets credited**, then use **Export CSV/JSON** for the same filters.

Dates are interpreted in the machine's local timezone (for example Africa/Cairo), so `2026-10-17` means local midnight to local 23:59:59.999.

### Command-line equivalents

```bash
# Staff totals for 17–23 Oct by last activity
curl -s "http://127.0.0.1:5178/api/staff?from=2026-10-17&to=2026-10-23&dateBasis=activity"

# Same, one staff ID
curl -s "http://127.0.0.1:5178/api/staff?from=2026-10-17&to=2026-10-23&dateBasis=activity&staff=752978053101256744"

# Ticket list with the same window
curl -s "http://127.0.0.1:5178/api/tickets?from=2026-10-17&to=2026-10-23&dateBasis=activity&pageSize=200"
```

Every award is explained ticket by ticket in **Ticket explorer** (staff, category, rule A–E, fallback, review state) and in the exports.

### Why points can differ from a hand-made sheet

- The sheet's Sum column may not equal its own daily columns + donation.
- Donations are not a ticket category; the app does not award donation points.
- Tickets outside the collected ID range cannot be included. If an older ticket was active during the window, widen the start ID.
- Cancellations and placeholders score zero by design.
- Claimant/closer conflicts score zero for both (Rule A).
- Missing identity is **unresolved**, never guessed.
- Unfamiliar wording becomes a visible fallback for review.

### Rescore vs reclassify

- **Rescore stored results** recalculates staff credit and awards from stored categories only. No browser and no classifier. Typical time for 270 tickets: under half a second.
- **Reclassify outdated** reruns the deterministic classifier only for tickets with a missing or outdated version. Human corrections are preserved.

Both buttons are in the Staff page header.

## 5. Review corrections

**Review queue** shows fallbacks, low-confidence results, missing data and unresolved attribution.

- **Accept** confirms the prediction.
- **Correct** selects the right fixed categories and can approve the exact wording as a reusable alias.
- **Dismiss** records an acknowledgement with a note.

A human correction is preserved across rescoring, reclassification and future syncs. Correcting a reason once trains that exact normalized wording for later tickets.

## 6. Exports

- Staff: JSON or CSV from the Staff page.
- Tickets and reviews: JSON or CSV from their pages.
- Files land in `data/exports`; the UI also downloads them.

CSV is RFC 4180 quoted, neutralises formula-leading cells, and exports unavailable values as empty cells rather than zero.

## 7. Performance diagnostics

After a run, the **Run diagnostics** card on Collect shows:

- mode (Sync/Full refresh);
- listing discovery time;
- records reused vs transcripts retrieved;
- direct API vs navigation reads;
- classification and database time;
- per-ticket median/p95;
- total run time and notes about fallbacks.

The same data is available at:

```bash
curl -s http://127.0.0.1:5178/api/collection/status
```

The measured baseline and optimizations are documented in [PERFORMANCE.md](PERFORMANCE.md). The final benchmark and acceptance matrix are in [FINAL-ACCEPTANCE.md](FINAL-ACCEPTANCE.md).

## 8. Backup and restore

**Settings → Data, backup and recovery**:

- **Create backup now** copies the SQLite database into `data/backups`.
- Select a backup and type `RESTORE` to restore it. Collection must not be active.
- Restoring replaces current tickets, transcripts, assessments, reviews and aliases with the backup's state.

Create a backup before large collections, before changing many corrections, and before a full reset.

## 9. Reset options

### Clear demo data only

**Settings → Demo mode / demo data → Clear demo data.** This removes only rows marked `is_demo = 1`. Real tickets are untouched.

### Reset the dashboard session

**Settings → Connection → Reset dedicated session** (type `RESET`). This deletes `data/browser-profile` and signs you out. It does not delete ticket data.

### Start fresh with all ticket data

This is destructive. Do it only after a backup.

1. Stop TicketsManage.
2. Create a backup in Settings first (or copy `data/ticketsmanage.db`).
3. Close the app and any dedicated Chromium window.
4. Rename the database files instead of deleting them:
   - `data/ticketsmanage.db` → `data/ticketsmanage.db.old`
   - `data/ticketsmanage.db-wal` → `data/ticketsmanage.db-wal.old` (if present)
   - `data/ticketsmanage.db-shm` → `data/ticketsmanage.db-shm.old` (if present)
5. Start TicketsManage. A new empty database is created; reconnect and collect.

To keep the old data available, use a separate data directory instead:

```bash
set TICKETS_DATA_DIR=D:\TicketsManage-fresh
npm start
```

The browser profile then lives in that directory too, so you will sign in once more.

### Reset only the awards, not the tickets

There is no global “delete all awards” button because awards are derived data. Options:

- **Rescore stored results** recomputes awards from stored categories (safe, instant).
- **Reclassify outdated** repairs missing/outdated classifications.
- To remove a specific wrong award, correct its categories in **Review queue** or reassess the ticket.
- A true zero-state requires the fresh database procedure above.

## 10. Troubleshooting

| Symptom | Action |
|---|---|
| `RATE_LIMITED` | Wait 1–2 minutes, then Resume. Keep delay at **2,000 ms** for large ranges. |
| `AUTH_REQUIRED` / session expired | Reconnect in Settings, Verify, Resume. |
| `WEBSITE_LAYOUT_CHANGED` | The dashboard response shape changed. Export diagnostics/logs; do not trust partial data. |
| Ticket not found | The dashboard does not have that ID. The app records `not_found`, never a fabricated zero. |
| Transcript unavailable/restricted | Stored as `no_transcript`/`partial`; not scored as a real ticket. Retried by Sync. |
| Slow first run | Discovery plus transcripts are network-bound. Later Syncs reuse stored work. |
| Staff total looks low | Check date basis, local timezone, unresolved attribution, Rule A conflicts, and whether the range covers older active tickets. |
| Wrong category | Correct it in Review queue; approve the alias to teach future runs. |

## 11. What is never done

- No ticket is created, claimed, closed, reopened, edited, relabelled or deleted by TicketsManage.
- No Discord token/password is read or stored by the app.
- No model guess assigns live points.
- Failed or missing data is never counted as a valid empty record.
- Human corrections and assessment history are not silently deleted.
