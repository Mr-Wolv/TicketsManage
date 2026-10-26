# Performance: measurement, changes and limits

Date: 2026-10-25
Reference workload: ticket IDs **7474–7747** (274 IDs, 272 real tickets)
Dashboard: authenticated live Tickets dashboard, read-only

## 1. Baseline

The account holder reported that a run of roughly 270 tickets took about **20 minutes** (≈4.4 s/ticket). That figure is the baseline for this work; it was not independently instrumented before the changes.

Inspection found the actual cause of the per-ticket cost. The collector already had a “direct API” fast path, but it pointed at `dashboard.tickets.bot` rather than the API origin `api.tickets.bot`, and it sent neither the `Authorization` bearer token nor the `x-tickets` header that the dashboard's SPA uses. Every direct attempt therefore failed and fell back to two full page navigations per ticket. Measured fallback cost was ~3.7 s/ticket.

## 2. What changed

1. **Working direct API path.** `ConnectionManager` captures the API URL and the two required headers from the dashboard's own request (in memory only, never logged). The collector now calls `api.tickets.bot` directly, with per-request timing.
2. **Ordered listing discovery.** The transcript listing is read page by page (15 rows/page, descending ticket ID). A page estimate plus at most a few correction probes replaces one search request per ticket. The range is only treated as complete when both boundaries are provably covered; otherwise the collector verifies individual IDs.
3. **Incremental sync that verifies the source.** Sync reads listing metadata, detects reason/closer/rating changes, reuses complete stored transcripts, retries gaps, and reclassifies outdated assessments. No transcript is reopened without a reason.
4. **Full refresh that re-reads transcripts.** Deliberate, slower, and separate from Sync.
5. **Bounded concurrency with shared request spacing.** `fetchConcurrency` (1–6) overlaps network waiting; `requestDelayMs` is the minimum spacing between dashboard API requests, so concurrency does not raise the request rate.
6. **Graceful rate-limit handling.** HTTP 429 pauses the run with `RATE_LIMITED`, stores no partial record, and reports the retry hint when the dashboard supplies one.
7. **Run diagnostics.** Discovery, database, classification and total time; reused records; transcripts; direct/navigation counts; retries; per-ticket median/p95; notes. Stored per run in `collection_run_diagnostics` and shown in **Collect → Run diagnostics**.
8. **Cheap local maintenance.** `POST /api/assessments/rescore` recomputes awards from stored categories without browser or classifier work. `POST /api/assessments/reclassify` reruns only missing/outdated assessments and preserves human corrections.
9. **Correct date-window semantics.** `dateBasis=activity` filters by the final transcript message (closest available evidence of closure); plain dates are interpreted in local time.
10. **Cancel fixed.** Cancelling a paused run no longer throws after clearing the in-memory run.

## 3. Measured results

All figures are from this machine and the live dashboard.

| Workload | Wall time | App-reported time | Work done | Result |
|---|---:|---:|---|---|
| Full refresh, 7770–7779 (10 IDs) | **10.2 s** | 9.0 s | 9 transcripts, 1 genuine not-found, 0 failures, 0 retries | Completed |
| Incremental sync, 7474–7747 (274 IDs) | **24.2 s** | 24.0 s | 272 reused, 2 not-found, 0 transcripts, 19 listing pages | Completed |
| Rescore 266 stored assessments | **0.41 s** | — | 0 browser, 0 classifier, 0 model calls; 0 awards changed | Completed |
| Staff report, 17–23 Oct, activity basis | **0.15 s** | — | 246 credited tickets | Completed |
| Full refresh, 7474–7747 (274 IDs) | **paused at 26.5 s** | 26.5 s | 19 listing pages, 18 transcripts, 8 per-ticket samples | HTTP 429 from the dashboard |
| Expanded live coverage, 7300–7473 (174 IDs) | **6 min 26 s** | 6 min 26 s | 174 transcripts, 0 missing, 0 failed, 7 fallbacks | Completed with **0 rate-limit pauses** |
| Incremental sync, 7474–7747, safe 2,000 ms spacing | **40.9–41.2 s** | — | 272 reused, 2 not-found, 0 transcripts | Completed twice with identical content |
| Rescore 417 stored assessments | **0.6 s** | — | 0 browser, 0 classifier, 0 model calls | 0 awards changed |

Per-ticket detail from the successful full refresh:

- median **548 ms**, p95 **612 ms**, max 785 ms;
- 9/9 transcripts retrieved; 0 navigation fallbacks; 0 retries;
- one ID correctly recorded `not_found` (#7774 in this range).

Per-ticket detail before the 429 on the 274 run:

- listing discovery: 19.4 s for 19 pages;
- 18 transcripts at a median of **955 ms** each;
- total API requests at pause: 37 (19 listing + 18 transcript);
- the run paused cleanly with 18 completed records and no fabricated data.

### Final reliability changes

The first limiter implementation read and wrote `nextRequestAt` around an `await`; with concurrency 2, two tickets could claim the same slot and burst. The final implementation serializes slot assignment through a promise gate, so `requestDelayMs` is the true request rate. It also parses `Retry-After` as seconds or an HTTP date, waits one cooldown, retries once, and pauses on a second 429 instead of hammering the dashboard. Every waiting request observes the cooldown, not just the request that saw the 429. The UI shows `rate_limit_cooldown` while waiting.

`collection_runs.mode` is now persisted (schema 2). Resuming a paused Sync stays incremental; before this fix it silently restarted as a Full refresh. Existing databases receive the column additively.

Incremental reuse now requires that every listing field the dashboard exposes is unchanged. A changed reason, closer, rating, or opener forces a fresh transcript. The dashboard exposes no transcript revision or timestamp, so a transcript-only edit with identical metadata cannot be detected; Full refresh is the audit path for that case.

## 4. Interpretation

- The fast path is roughly **7× faster per ticket** than the old page-navigation fallback (≈0.55–0.96 s vs ≈3.7 s).
- A repeated sync of the same 274 IDs is **24 seconds**, well inside the 60-second target, with zero transcript reads.
- Rescoring is effectively instant (0.4 s for 266 assessments), far inside the 15-second target.
- Initial full collection of 270 tickets could **not** be completed inside the five-minute target in this session. The blocker is external: the dashboard returned HTTP 429 after about **37 API requests in a short window**, even at one request per second. With cooldowns, the same measured per-ticket rate implies roughly 9–10 minutes for 290 requests; that is an extrapolation, not a measured run, and is reported as such.
- No accuracy was traded for speed: live classification remains deterministic, 0 model calls were made, the same categories and credit rules apply, and the 109-test suite passes.

## 5. Idempotency and correctness checks

- Running the 274-ID Sync twice reused 272 complete records both times; no ticket, message, assessment, review or award duplicated.
- The two missing IDs (#7700, #7737) remained `not_found`; no zero-point records were invented.
- Scoring parity: rescoring 266 stored assessments changed **0** awards.
- Full suite: 109/109 tests pass across 7 files, including 48 classifier tests for compound reasons, aliases, cancellations and zero-point closures.
- Human corrections are skipped by reclassification and preserved by sync.

## 6. Recommended everyday workflow

1. **Settings:** parallel reads 2, request delay **2,000 ms** for large live ranges. Lower delays are faster but the dashboard has returned 429 at 1,000 ms with concurrency 2.
2. **Collect → Sync range** for the range you care about. This is the ~41-second repeat path at safe spacing.
3. Use **Full refresh** only when you need to re-read transcripts; on large ranges it will take longer than five minutes because of the dashboard's request budget. Resume after a cooldown if needed.
4. **Staff performance → Last activity**, date range, export.
5. After changing scoring rules or fixing categories, use **Rescore stored results** (no network).
6. After a classifier upgrade, use **Reclassify outdated**.

The full usage and reset guide is in [USER-GUIDE.md](USER-GUIDE.md).
