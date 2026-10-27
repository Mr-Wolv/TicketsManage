# TicketsManage QA and reliability report

Date: 2026-10-24 (local time; some evidence timestamps are 2026-10-25 after midnight)
Application: TicketsManage 2.0.0
Source revision: `1072b16` (application files are present in the working tree; `git status` shows 16 untracked entries, so this is the local working copy rather than a committed release)
Verification record: [VERIFICATION.md](VERIFICATION.md)
Final expanded-coverage acceptance: [FINAL-ACCEPTANCE.md](FINAL-ACCEPTANCE.md). The 586.5-point figure below is the original ID-only range; it is superseded by the 606.5-point activity-window result.

## Status at a glance

- The authenticated live dashboard is reachable and the saved Playwright session survives a full browser close and a separate browser process.
- Live range **7770–7778** was collected and verified: **9 requested, 8 collected with transcripts, 1 genuinely not found, 0 failures, 0 partial records**.
- An independent dashboard API capture matched all 8 stored tickets on opener, closing reason, closing staff ID, transcript availability, and rating: **0 field differences**.
- The same range, an overlapping range, repeated reassessment, and repeated export did **not** duplicate tickets, messages, assessments, reviews, or points.
- Persisted staff awards are **18 points**: `b932` 14 / 6 tickets, `_jr5` 2 / 1 ticket, `duilio_` 2 / 1 ticket. An independent reconstruction from ticket-level awards produced **0 mismatches**.
- Automated suite: **109/109 tests pass in 7 files** (updated 2026-10-25). Production build and both TypeScript projects pass.
- **2026-10-25 update:** direct dashboard API access now works (auth headers captured from the SPA), ordered listing discovery and incremental reuse are implemented, run diagnostics are persisted, staff day windows support a last-activity basis, and rescore/reclassify maintenance endpoints exist. Measured performance and the observed dashboard rate limit are documented in [PERFORMANCE.md](PERFORMANCE.md). A repeated 274-ID Sync takes ~24 s; a 274-ID Full refresh pauses on HTTP 429 after ~37 requests without storing a partial record.
- **Three specification conflicts / blockers must be resolved before the manual benchmark**: the current taxonomy has 10 categories (including Recharge) while the benchmark brief lists 9; live classification intentionally does not call the local model; and there is no benchmark-input UI or CSV import.
- **Three live fallbacks are still pending review** and contribute **6 of the 18 points**. Those points are provisional until you decide their categories.

## Read this first: specification conflicts

### 1. Taxonomy is 10 categories, not 9

The application implements taxonomy **1.1.0** with these categories:

| Category | Points |
|---|---:|
| Report | 3 |
| General Issue | 2 |
| General Question | 2 |
| No Response | 1 |
| Unbanned | 2 |
| AnyDesk | 10 |
| AnyDesk By | 5 |
| Acc-Recovery | 2 |
| Problem solved through text | 5 |
| **Recharge** | **2** |

The benchmark brief's fixed table lists the first nine and omits **Recharge**. The app's Settings screen explicitly says "Recharge was added at 2 points", and the existing review/demo records use it. Removing it would be a production taxonomy change that can alter scores and existing corrections. I did **not** change it without authorization.

### 2. The local model is not part of live scoring

Live classification is deterministic: approved alias, exact/fuzzy multilingual rules, then the visible **General problem (fallback)** using General Issue (2 base points) and a review item. The model returns `null` in live assessments. This is the behavior you requested earlier after `qwen2.5:3b` mislabeled `تقديم اداره` as Recharge.

The current QA brief says the semantic classifier must use a configured local model live. Those requirements conflict. The model is configured, installed, reachable, and was exercised by a direct Ollama call and the application self-test, but it is used only for the self-test and offline evaluation.

### 3. There is no benchmark-entry screen or CSV import

The application has ticket/staff/review exports and staff reports, but no UI or CSV importer for manual expected totals and no saved benchmark/reconciliation record. This is a missing feature, not a hidden setting. The final manual benchmark cannot begin until either that feature is added or you supply the totals another way.

### 4. Closing timestamps are unavailable from the source list

The dashboard transcript list exposes ticket ID, opener, closing reason, closing staff ID, rating, and transcript availability. It does **not** expose a closure timestamp, so `closed_at` stays null. The staff report now offers **Last activity** (final transcript message, the closest available close-date proxy) or **Ticket opening time**; plain dates are interpreted in local time. Use Last activity for day-by-day comparisons, and remember that a ticket-ID range still bounds which tickets exist in the calculation.

## A. Environment and access

| Item | Value |
|---|---|
| OS | Microsoft Windows 11, version 10.0.26300.9711 |
| CPU / RAM | 8 logical cores / 16.9 GB |
| Node.js | v24.15.0 |
| npm | 11.12.1 |
| Playwright | 1.64.1 |
| Ollama | 0.32.1 at http://127.0.0.1:11434 |
| Local model | `qwen2.5:3b`, Q4_K_M, 1.9 GB |
| Application | 2.0.0 |
| Taxonomy | 1.1.0 |
| Classifier | 2.0.0 |
| SQLite | `data/ticketsmanage.db`, schema version 1 |
| Dashboard profile | `data/browser-profile` |
| Authentication | Authenticated; verification took 2.455 s, then 2.677 s after a full browser close |
| Dashboard response | HTTP 200 from `https://api.tickets.bot/api/example-guild-id/transcripts` |
| Backup | `data/backups/ticketsmanage-2026-10-24T20-50-08.db`, 184,320 bytes, counts matched live |
| Independent browser check | Source ticket #7778 loaded at HTTP 200 using the saved profile |

The independent capture contained 15 dashboard rows. The eight stored tickets matched on:

- opener username;
- original closing reason;
- closing staff Discord ID (parsed without rounding, e.g. `example-staff-id`);
- transcript availability;
- rating.

No password, cookie, authorization header, or Discord token is printed in the evidence, exports, logs, diagnostics, or this report. Diagnostics contain only counts, paths, runtime data, and the explicit statement that secrets are excluded.

## B. Actual test results

### Automated and build checks

| Check | Result |
|---|---|
| `npm test` | **85 passed / 85**, 7 files, 0 failed |
| Server TypeScript | Passed |
| Web TypeScript | Passed |
| Production UI build | Passed (`web-dist`, 317.03 kB JS gzip 92.51 kB) |
| Rules-only corpus | 62 rows, 55/55 exact category sets, 7/7 expected fallbacks |
| SQLite integrity | `ok` on live, isolated, and 1,015-ticket load databases |
| Foreign-key check | 0 violations on all three databases |
| Duplicate ticket/assessment IDs | 0 on all three databases |

### Live and manual checks

**75 checks: 64 passed, 0 failed, 2 blocked, 1 missing, 7 not run, 1 not applicable.**

| ID | Check | Result | Evidence |
|---|---|---|---|
| ENV-01 | Environment and versions recorded | Pass | This report, §A |
| ENV-02 | Source revision, DB path, schema recorded | Pass | This report, §A |
| ENV-03 | Recoverable backup created and content compared | Pass | `data/qa/isolate-backup-response.json`, backup counts |
| AUTH-01 | Saved profile opens authenticated dashboard | Pass | `final-connection-verify.json` |
| AUTH-02 | Session survives full browser close and separate browser process | Pass | `source-check-7778.json`, `final-connection-reverify.json` |
| AUTH-03 | Transcript list API returns HTTP 200 | Pass | `source-transcripts-list.json` |
| AUTH-04 | Session-expiry detection | Not run | No safe way to expire the live session without disturbing it |
| AUTH-05 | No secrets in logs/exports/diagnostics | Pass | `diagnostics.json`, log scan |
| START-01 | Cold start on production path | Pass | Server log, health 200 |
| START-02 | Repeated application restarts | Pass | Live server restarted multiple times; persisted counts unchanged |
| START-03 | All six screens navigate | Pass | Overview, Collect, Tickets, Staff, Reviews, Settings snapshots |
| START-04 | Reload and status polling without console errors | Pass | `preview_logs` after clean reload: no console errors |
| START-05 | Empty/loading/error visual states | Not run | Live data present; not forced |
| COLL-01 | Bounded live range 7770–7778 preview and start | Pass | `baseline.json`, run history |
| COLL-02 | 9 requested / 8 collected / 1 missing / 0 failed | Pass | `collection_runs` row `f678bfa8…` |
| COLL-03 | Missing numeric ID 7774 not fabricated | Pass | Stored IDs omit 7774; source list omits it |
| COLL-04 | Independent field-level source comparison | Pass | 8/8 tickets, 0 differences |
| COLL-05 | Independent transcript content check for #7778 | Pass | `source-check-7778.json` |
| COLL-06 | Repeating the same range does not duplicate data | Pass | `baseline.json` vs `after-run2.json` |
| COLL-07 | Overlapping range 7775–7778 does not duplicate data | Pass | `overlap-final-status.json`, DB counts |
| COLL-08 | Interrupt the application during collection and resume | Pass | `interrupt-start.json`, `resume-start.json`, `after-resume.json` |
| COLL-09 | Transient-failure fault injection and retry limits | Not run | Needs a controlled fault harness; not executed |
| COLL-10 | User-initiated cancellation | Not run | Not exercised |
| COLL-11 | Exact / paginated / auto collection strategies | Not applicable | Application collects exact IDs only; no strategy selector |
| DATA-01 | 18-digit Discord IDs remain exact | Pass | Source/stored IDs compared exactly |
| DATA-02 | Claimant and closer kept separate | Pass | Ticket schema, UI, exports, scoring |
| DATA-03 | Closing timestamp | Blocked | Source transcript list does not expose it; stored `null`, never zero |
| DATA-04 | Missing rating is unavailable, not zero | Pass | One ticket has 5; seven are unavailable |
| DATA-05 | Message order and content | Pass (sampled) | #7778: 16 stored messages; source last 8 matched in Review |
| CLASS-01 | Rules-only corpus evaluation | Pass | 55/55 exact, 7/7 fallbacks |
| CLASS-02 | Foreign reason uses visible fallback, not model guess | Pass | #7778 `تقديم اداره`: General Issue fallback, model `null` |
| CLASS-03 | Live model not used in scoring | Pass by design | Assessments record method `rules_only`/`fallback`, model `null` |
| CLASS-04 | Fallback is persisted and reviewable | Pass | 3 pending reviews survive restarts |
| CLASS-05 | Local model self-test | Pass (slow) | 53.9–61.1 s, valid schema and categories |
| CLASS-06 | Full local-model corpus accuracy | Not run | Not completed; no hybrid accuracy claimed |
| SCORE-01 | Category arithmetic and duplicate suppression | Pass | Unit tests and scored records |
| SCORE-02 | Rule A: different claimant/closer gives zero | Pass | Unit test; demo #9000005 |
| SCORE-03 | Rule B: same claimant/closer gets full base | Pass | All 8 live tickets; 33 base/awarded points in 12 records |
| SCORE-04 | Rule C: unclaimed + reason gives half to closer | Pass | Demo #9000003: 1 base → 0.5 awarded |
| SCORE-05 | Rule D: unclaimed + empty reason gives zero | Pass | Automated controlled record |
| SCORE-06 | Rule E: unavailable identity stays unresolved | Pass | Demo #9000007; unit tests |
| SCORE-07 | Aggregate totals reconstruct from ticket awards | Pass | `reconstruction.json`, 0 mismatches |
| SCORE-08 | Ticket detail, staff report, API, export all agree | Pass | UI snapshots and export parse |
| PERSIST-01 | SQLite integrity and foreign keys after all runs | Pass | `integrity_check` = ok; 0 FK violations |
| PERSIST-02 | Backup and restore | Pass | Isolated API restore; counts and review state restored |
| PERSIST-03 | Invalid or missing restore rejected safely | Pass | 400 `CONFIRMATION_REQUIRED`; 400 `BACKUP_NOT_FOUND` |
| PERSIST-04 | Manager correction survives restart | Pass | Isolated #7778, 3 history entries, unchanged after restart |
| PERSIST-05 | Nested/outer transaction rollback | Pass | New automated regression test |
| PERSIST-06 | Corruption recovery | Not run | No corruption injected; backup/restore covers the normal recovery path |
| IDEMP-01 | Repeat collection leaves ticket/message/assessment counts stable | Pass | 15/163/15 before and after |
| IDEMP-02 | Repeat reassessment leaves totals and review counts stable | Pass | 8 tickets reassessed; 18 points; 3 pending |
| IDEMP-03 | Repeat export is identical | Pass | Staff CSV byte-identical; ticket JSON identical except `exportedAt` |
| REVIEW-01 | Review queue shows all pending fallbacks | Pass | 3 pending: #7773, #7776, #7778 |
| REVIEW-02 | Correction history and original reason preserved | Pass | 3 history entries on isolated #7778; original reason unchanged |
| REVIEW-03 | Accept/dismiss review lifecycle | Pass | Automated persistence tests; UI action wiring inspected |
| EXPORT-01 | Ticket JSON/CSV counts and columns | Pass | 8 records in both |
| EXPORT-02 | Staff export totals | Pass | 14 + 2 + 2 = 18 |
| EXPORT-03 | Spreadsheet formula protection | Pass | `=HYPERLINK(...)` prefixed with apostrophe and quoted |
| EXPORT-04 | Unicode, Arabic, commas, newlines | Pass | `تقديم اداره` and quoted newline round-trip |
| EXPORT-05 | Lossless IDs in exports | Pass | 18-digit IDs compared exactly |
| UI-01 | Staff screen totals match API | Pass | 18 / 8 tickets / 3 staff; all rows match |
| UI-02 | Overview totals match persisted data | Pass | 8 real, 0 unclassified, 3 pending, 3 fallbacks, 18 points |
| UI-03 | Review detail matches assessment | Pass | #7778 base 2, Rule B, awarded 2, pending |
| UI-04 | Explores filters and pagination | Pass | 3 pending, 3 fallback, 2 Report, 6 b932; pages disjoint |
| UI-05 | Settings, backups, model status | Pass | Backups listed; model ready; taxonomy displayed |
| PERF-01 | 1,015-ticket staff report | Pass | 89–120 ms |
| PERF-02 | Paginated ticket list and exports at 1,015 tickets | Pass | 12–19 ms page; 108–132 ms exports |
| PERF-03 | Memory at 1,015 tickets | Pass | 132,356 K Node process |
| PERF-04 | Live collection performance | Pass | 9 IDs in 32–68 s warm; overlap 4 IDs in 18 s |
| E2E-01 | Launch → verify → collect → classify → score → persist → inspect → export | Pass | Live run and UI/API checks |
| E2E-02 | Restart and confirm data/reviews/assessments persist | Pass | Restarts before and after final checks |
| E2E-03 | Correct a review item and retain the correction | Pass | Isolated copy; live correction not changed without your decision |
| BENCH-01 | Manual-total entry through UI or CSV import | **Missing** | No such route, table, or screen |
| BENCH-02 | Manual reference totals supplied | **Blocked** | Pending your figures |
| BENCH-03 | Per-staff reconciliation and downloadable report | Not run | Depends on BENCH-01/02 |

## C. Live collection accuracy

- Tested range: **7770 through 7778 inclusive**.
- Requested IDs: 9.
- Found and collected: **8**.
- Genuinely not found: **1** (7774; absent from the dashboard list).
- Missing transcripts: 0.
- Partial records: 0.
- Failed retrievals: 0.
- Message rows stored: 163 across the 8 tickets.
- Ticket #7778 independent transcript check: HTTP 200, title `Transcript #7778`, claimant message `Your ticket will be handled by @b932`, content and last-message order matched.
- Source-versus-stored field comparison: 8 tickets × 5 fields, **0 differences**.
- Closing timestamp: unavailable in the source list; stored as `null`. This is a source limitation, not an empty timestamp and not a zero.

## D. Reliability, idempotency, and recovery

### Repeat and overlap

- Baseline after first complete run: 15 tickets (8 real + 7 demo), 163 messages, 15 assessments, 10 reviews, 19 history entries.
- After repeating 7770–7778: **exactly the same** ticket, message, assessment, review, history, and alias counts. Only `collection_runs` and `collection_items` increased (2→3 runs, 18→27 items), which is expected run history.
- After overlapping 7775–7778: 15 tickets, 163 messages, 15 assessments, 10 reviews, 18 staff points. Only run history increased (4→5 runs, 36→40 items).
- Interrupted run resumed at processed=2 and completed the same run ID without duplicates; final counts matched the uninterrupted result.

### Persistence and recovery

- `PRAGMA integrity_check`: `ok` on live, isolated, and load databases.
- `PRAGMA foreign_key_check`: 0 violations.
- Duplicate ticket IDs: 0. Duplicate assessment rows: 0. Orphan assessments/messages: 0.
- Backup `ticketsmanage-2026-10-24T20-50-08.db`: 184,320 bytes, matching row counts.
- Restore on isolated copy reverted a correction and its history as expected, and created a `pre-restore` safety copy.
- Invalid restore attempts were rejected with explicit 400 errors before any replacement.
- A new regression test verifies that a failure inside a nested transaction rolls back both the nested write and the outer write, and that later transactions still work.
- Corruption injection and migration-failure rollback were **not run**; they remain an evidence gap.

## E. Classification quality

### Deterministic live path

- Corpus: 62 reasons (55 with expected scored categories, 7 expected fallbacks).
- Exact category-set match: **55 / 55**.
- Expected fallbacks: **7 / 7**.
- Live hand-authored corpus precision/recall/F1: 100% on these labels.
- **This is not evidence of generalisation.** The labels are an authored regression corpus, not an independent human-labelled sample.
- Live fallbacks: #7773 (`general issues no respond`), #7776 (`tmam`), #7778 (`تقديم اداره`). All display **General Issue +2, fallback**, model `null`, and remain pending review.
- #7778 previously received a wrong model guess of Recharge. It now receives the explicit fallback shown above.

### Local model

- Model: `qwen2.5:3b`, local Ollama only; cloud-tagged models are rejected.
- A direct Ollama request returned valid JSON in 8.0 s with a short prompt.
- Application self-test first hit the old 60-second cap. The cap was increased to **120 seconds** because CPU inference with the full taxonomy prompt can exceed 60 s while cold.
- The next self-test passed in **53.9 s**, and a final post-restart run passed in **61.1 s**, both returning valid categories `REPORT` and `GENERAL_ISSUE`. The old 60-second cap would have failed the 61.1-second run.
- The full 62-row model run was **not completed**. No hybrid accuracy number is claimed. This does not affect live scoring, which never calls the model.
- If the brief's requirement that the model participate live is still current, that is a design change, not a bug in the current deterministic path.

## F. Scoring correctness

### Live totals

| Staff | Awarded points | Credited tickets | Same claimant/closer | Half-point | Zero-different | Fallbacks |
|---|---:|---:|---:|---:|---:|---:|
| b932 | 14 | 6 | 6 | 0 | 0 | 2 |
| _jr5 | 2 | 1 | 1 | 0 | 0 | 0 |
| duilio_ | 2 | 1 | 1 | 0 | 0 | 1 |
| **Total** | **18** | **8** | **8** | **0** | **0** | **3** |

- b932 category breakdown: General Issue 6, Report 6, General Question 2.
- Three fallback tickets contribute **2 points each = 6 points** and are still pending review. If you correct them to No Response (1) or Report (3), the totals change; if you correct them to General Question (2), they do not.
- Independent reconstruction from persisted ticket awards: 0 mismatches against all three staff rows.
- Unit coverage includes Rules A–E, duplicate categories, taxonomy-authoritative points, odd half-points, and zero-base non-awards. Live records exercise Rule A (demo #9000005), Rule B (live), Rule C (demo #9000003, 0.5), Rule E (demo #9000007), and Rule D through a controlled test record.
- No live ticket was created, edited, closed, claimed, or relabelled to manufacture a scenario.

### Staff-credit interpretation for the benchmark

For the benchmark, both calculations must use the same definition:

- Different confirmed claimant and closer → zero to both.
- Same confirmed staff member → full base.
- Confirmed unclaimed with a nonempty reason → half base to closer.
- Confirmed unclaimed with empty reason → zero.
- Unavailable/unreliable identity → unresolved, excluded (never guessed).
- Fallback base is General Issue = 2, subject to the same staff-credit rule.
- Superseded assessments are not added to totals.

## G. Manual benchmark

**Status: pending user input.** The app cannot currently accept manual expected totals through its UI or a CSV import.

To run the benchmark I need:

1. Starting ticket ID.
2. Ending ticket ID (inclusive).
3. Expected total points for **each** staff member over that exact ID range.
4. Staff identity convention: your manual sheet's name for each person, where it differs from the app name (`b932`, `_jr5`, `duilio_`).
5. Scope conventions: whether fallback tickets count with their provisional 2 points, whether unresolved tickets are excluded, and whether zero-award tickets are listed but contribute 0.
6. If you want, a second expected set that excludes tickets still pending review.

Because closing time is unavailable from the source list and date filters fall back to opening/collection time, the benchmark should be frozen to the **ticket-ID range**, not a date range.

Missing expected totals must not be treated as zero. A zero expected total is valid, but percentage difference is then undefined and will be shown as such.

## H. Remaining defects and blockers

| ID | Issue | Impact | Status / next action |
|---|---|---|---|
| OPEN-01 | Taxonomy has 10 categories; brief says 9 and omits Recharge | Any benchmark using the 9-category table will differ from app totals wherever Recharge applies | Decision required; not changed |
| OPEN-02 | Live model is not used; brief says it must be | Current totals are deterministic and model-free; changing this would reintroduce model latency and wrong guesses | Decision required |
| OPEN-03 | No benchmark UI or CSV import | Manual totals cannot be entered through the application | Feature missing; can be added |
| OPEN-04 | Closing timestamps unavailable | Date-scoped reports use opening/collection time; closure-date comparisons are impossible | Source limitation; use ticket IDs |
| OPEN-05 | Three fallback tickets pending review | 6 of 18 points are provisional | Correct in Review or accept as-is before freezing benchmark |
| OPEN-06 | Full model corpus not run; self-test is 53.9 s | No semantic accuracy claim; model is not usable for live per-ticket latency on this CPU | Not a live-path defect |
| OPEN-07 | Session expiry, transient retries, cancellation, corruption, and empty-state tests not run | Those failure paths remain unverified live | Future hardening |
| OPEN-08 | Working tree is untracked | No committed source revision for a reproducible release | Commit when you are ready |

No scoring defect was found in the tested paths. No test was made to pass by weakening an assertion.

## I. Final acceptance

| Criterion | Result |
|---|---|
| Authenticated live dashboard access | **Passed with evidence** |
| Bounded live collection with transcripts | **Passed with evidence** |
| Field-level accuracy against source | **Passed with evidence** (closing timestamp blocked by source) |
| No fabricated records for missing IDs | **Passed** |
| Repeat/overlap/interrupt idempotency | **Passed** |
| Duplicate messages or points | **None found** |
| Persistence across restart | **Passed** |
| Backup and restore | **Passed on an isolated copy** |
| Review correction persistence | **Passed on an isolated copy** |
| Rule A–E scoring | **Passed** (live + controlled records) |
| Aggregate reconstruction | **Passed, 0 mismatches** |
| JSON/CSV exports | **Passed** |
| UI/API/export agreement | **Passed** |
| 1,015-ticket performance | **Passed** |
| Local model actual inference | **Passed, slow (53.9–61.1 s)** |
| Nine-category taxonomy | **Blocked by specification conflict** |
| Live semantic-model scoring | **Blocked by design conflict** |
| Manual benchmark | **Blocked: no input path and no supplied totals** |
| Production-ready claim | **Not made**; the open items above remain |

## Evidence index

All evidence is local and excluded from version control through `data/`:

- `data/qa/baseline.json`, `after-run2.json`, `after-resume.json` — repeat/resume counts
- `data/qa/final-live-staff.json`, `reconstruction.json` — staff totals and independent reconstruction
- `data/qa/final-connection-verify.json`, `final-connection-reverify.json` — authentication
- `data/qa/source-transcripts-list.json` — independent dashboard response
- `data/qa/source-check-7778.json` — independent transcript page
- `data/qa/overlap-start.json`, `overlap-final-status.json` — overlapping run
- `data/qa/isolate-7778-*.json`, `isolate-restore-*.json`, `isolate-formula-export.csv` — disposable-database tests
- `data/qa/final-staff-a.csv`, `final-staff-b.csv` — repeated export comparison
- `data/qa/load-results.txt` — 1,015-ticket performance evidence
- `data/qa/vitest-results.json` — automated test counts
- `data/qa/eval-rules-final.txt` — classifier corpus result
- `data/qa/final-model-selftest-2.json`, `final-model-selftest-after-restart.json` — 53.9 s and 61.1 s model self-tests
- `data/qa/diagnostics.json` — sanitized diagnostics
