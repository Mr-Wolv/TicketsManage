# Final acceptance: benchmark closure and reliability

Date: 2026-10-25
Application: TicketsManage 2.0.0 · Taxonomy 1.1.0 · Classifier 2.1.0 · Schema 2
Dashboard: authenticated live Tickets dashboard, read-only
Source revision: `1072b16cef485162428ea2c9588b12f55a054457` (working tree contains the changes below)

This report closes the earlier benchmark gaps. It separates what was measured from what remains blocked or ambiguous. Nothing in this report was produced by skipping tickets, ignoring transcripts, disabling classification, or changing scoring rules.

## 1. Protected baseline

| Item | Result |
|---|---|
| Backup | `data/backups/final-closure-2026-10-24T23-44-39-742Z.db` |
| Backup method | SQLite `VACUUM INTO` while the application was idle |
| Integrity check | `ok` |
| Restore test | Restored into `data/qa/restore-verify.db`, integrity `ok`, read/write probe succeeded |
| Baseline counts | 288 tickets, 5,780 messages, 288 assessments, 103 reviews, 181 review-history rows, 1 approved alias |
| Original benchmark range | 7474–7747, 272 collected, 2 genuinely missing (#7700, #7737) |
| Original mapped result | 567.5 points across the eight manual names, 571 including two unlisted staff |

Machine-readable manifest: `data/qa/benchmark-baseline-manifest.json`.

## 2. Complete activity-window coverage

Window: **2026-10-17 00:00:00 through 2026-10-23 23:59:59.999 Africa/Cairo**. The date expression is the same one the Staff report uses: `closed_at` when present, otherwise the final transcript message, otherwise opening time.

The earlier 7474–7747 run missed tickets that were opened before 7474 but were still active during the window. The expanded run covered **7300–7473**.

| Item | Result |
|---|---:|
| Requested IDs | 174 |
| Collected with transcripts | **174** |
| Not found | 0 |
| Failed | 0 |
| Fallbacks | 7 |
| Duration | 6 min 26 s (00:53:09 → 00:59:35 UTC) |
| Rate-limit pauses | 0 |

The expanded dataset adds **18 tickets** to the activity window. They are worth **35.5 points**, including four 10-point AnyDesk tickets and one 5-point AnyDesk-by ticket.

### Boundary evidence

- The earliest ticket active in the window is **#7392** (opened 15 Oct, last activity 17 Oct).
- All 92 tickets from **7300 through 7391** ended before 17 October.
- Across the 174 adjacent tickets, the longest observed lifetime was **63.5 hours**; none exceeded 72 hours.
- Therefore a ticket below 7300 would need an extreme, unobserved lifetime of more than five days to land in this window. No such ticket is present in the scanned boundary.
- The scan proves coverage from 7392 upward. It does not mathematically prove that no ancient ticket below 7300 has an unusually long life; that would require scanning all history, which was not authorized.

Coverage detail and all 18 bridge tickets: `data/qa/final-reconciliation.json`.

## 3. Rate limiting and resumability

The earlier 429 was caused by a real concurrency defect: the limiter read and wrote `nextRequestAt` around an `await`, so two concurrent tickets could claim the same slot and burst. The direct API path is now gated by one serialized scheduler.

Implemented in `server/collector.ts`:

- One serialized request slot shared by listing pages, per-ticket search, and transcript reads.
- `Retry-After` parsed as delta-seconds or HTTP date, with a 180-second ceiling.
- One automatic cooldown-and-retry after a 429, honouring the hint; a second 429 pauses the run.
- Jitter added to spacing; cooldown blocks every waiting request, not just the one that saw the 429.
- The run remains checkpointed; completed tickets are kept and the run is never marked complete while rate-limited.
- UI stage `rate_limit_cooldown` shows the wait; a final pause shows `RATE_LIMITED` with Resume.

Mode persistence was also fixed: `collection_runs.mode` now stores `incremental` or `full`, so resuming a paused Sync no longer silently becomes a Full refresh. Existing databases migrate additively on open (schema 2).

Measured at a conservative **2,000 ms** spacing with concurrency 2:

| Workload | Result |
|---|---:|
| Expanded live run, 174 transcripts + listing | 6 min 26 s, 0 rate-limit pauses |
| Incremental sync, 274 IDs, 272 reused, 0 transcripts | 40.9–41.2 s per pass |
| Full refresh of 9 tickets (earlier, direct path) | 10.2 s, median 548 ms/ticket |

The five-minute full-refresh target for ~270 tickets is **not met and is not claimed**. The dashboard's observed budget is roughly 37 requests in a short window, so ~290 requests cannot be completed in five minutes without violating the limit. Repeated work is fast; the initial full read is externally bounded.

## 4. Incremental freshness

`Sync` reuses a stored transcript only when every listing field the dashboard exposes is unchanged. A changed close reason, closer, rating, or opener now forces a fresh transcript and reassessment. Previously the metadata was updated but the old transcript was reused.

The dashboard listing exposes only:

`ticket_id`, `username`, `close_reason`, `closed_by`, `rating`, `has_transcript`, `labels`

It exposes **no transcript revision, modification time, or claimant field**. A transcript-only edit with identical listing metadata cannot be detected. This is a documented limitation, not a guarantee:

- `Sync` is safe for filling gaps and detecting listing-visible changes.
- `Full refresh` is the audit path that re-reads every transcript.
- A claimant change is only visible after re-reading the transcript, so `Full refresh` is required for that class of change.

## 5. Manual reconciliation

The original manual figures are preserved unchanged. The sheet is internally inconsistent:

| Person | Displayed | Daily columns | Daily total | Donation | Daily + donation | Displayed minus arithmetic |
|---|---:|---:|---:|---:|---:|---:|
| staff-c | 71 | 43+4+6+14+0+0+0 | 67 | 3 | 70 | +1 |
| Omar | 119 | 26+11+9+6+5+44+10 | 111 | 7 | 118 | +1 |
| staff-d | 343 | 62+83+33+64+34+16+27 | 319 | 23 | 342 | +1 |
| Sheroo | 40 | 16+4+0+0+11+7+0 | 38 | 1 | 39 | +1 |
| staff-e | 39 | 7+8+8+1+3+0+2 | 29 | 9 | 38 | +1 |
| Heart | 20 | 4+6+1+4+3+0+1 | 19 | 0 | 19 | +1 |
| Comment | 0 | 0+0+0+0+0+0+0 | 0 | 0 | 0 | 0 |
| Duilio | 3 | 0+0+0+0+0+0+0 | 0 | 2 | 2 | +1 |
| **Total** | **635** | | **583** | **45** | **628** | **+7** |

Every named row's displayed sum is exactly one point above its own daily-plus-donation arithmetic. The total displayed sum is therefore **7 points higher** than the sheet's own columns. Duilio's displayed 3 cannot be produced from 0 daily points and a 2-point donation.

The application does not score donations. Compare ticket awards to the **daily ticket columns**, not to displayed totals that include donations.

Worksheet: `data/qa/manual-worksheet.md`.

## 6. Results by staff member

Full activity window, including the 18 pre-7474 tickets:

| Manual name | App staff | App points | App tickets | Manual daily | Manual displayed | vs daily | vs displayed |
|---|---|---:|---:|---:|---:|---:|---:|
| staff-d | `b932` | **330.5** | 139 (135 credited) | 319 | 343 | **+11.5** | -12.5 |
| Omar | `_jr5` | **114** | 49 (47 credited) | 111 | 119 | **+3** | -5 |
| staff-c | `xmax5696` | **66.5** | 27 | 67 | 71 | **-0.5** | -4.5 |
| Sheroo | `4eroo` | **36** | 23 (22 credited) | 38 | 40 | **-2** | -4 |
| staff-e | `ahmed_labeb` | **36** | 20 | 29 | 39 | **+7** | -3 |
| Heart | `_k.in` | **20** | 11 (10 credited) | 19 | 20 | **+1** | 0 |
| Duilio | `duilio_` | **0** | 3 (0 credited) | 0 | 3 | 0 | -3 |
| Comment | — | 0 | 0 | 0 | 0 | 0 | 0 |
| *(unlisted)* | staff-a. / staff-b. | **3.5** | 2 | — | — | — | — |
| **Total** | | **606.5** | 275 in window | **583** | **635** | **+23.5** | **-28.5** |

App mapped total is **603**; adding the two unlisted staff gives **606.5**.

### The bridge explains the apparent swing

The difference between the earlier result and this one is exactly the coverage extension:

| Staff | Original 7474–7747 | Pre-7474 tickets added | Full window | Diff vs manual daily, original | Diff vs manual daily, full |
|---|---:|---:|---:|---:|---:|
| staff-d | 322.5 | **+8** | 330.5 | +3.5 | +11.5 |
| Omar | 114 | 0 | 114 | +3 | +3 |
| staff-c | 52.5 | **+14** | 66.5 | -14.5 | **-0.5** |
| Sheroo | 24.5 | **+11.5** | 36 | -13.5 | **-2** |
| staff-e | 34 | +2 | 36 | +5 | +7 |
| Heart | 20 | 0 | 20 | +1 | +1 |
| Duilio | 0 | 0 | 0 | 0 | 0 |
| **Mapped total** | **567.5** | **+35.5** | **603** | **-15.5** | **+20** |

The extension clearly fixes **staff-c** (now 0.5 low) and **Sheroo** (now 2 low). It pushes **staff-d** from +3.5 to +11.5.

staff-d's bridge is exactly four tickets: **#7436, #7444, #7446, #7464** (2 points each). If the manual staff-d row covers only IDs 7474–7747, it would exclude those four, and 330.5 − 8 = **322.5**, only **+3.5** versus 319. That is a scope difference, not a scoring change.

staff-e's bridge is only **#7458 and #7459** (1 point each). His +7 is therefore **not** explained by the extension; +5 remains even in the original range and needs ticket-level checking against the sheet.

### What the remaining differences mean

- **staff-c -0.5, Sheroo -2, Heart +1, Omar +3** are within one or two tickets. They are plausible day-boundary, claimant-credit, or sheet-rounding differences.
- **staff-d +11.5** is mostly the four pre-7474 tickets. Confirm whether those IDs are in the staff-d sheet.
- **staff-e +7** is the main unexplained positive difference. His 20 tickets are all straightforward General Issue/Report/No Response awards with rule B; the sheet's staff-e row is either missing tickets or using a different attribution.
- **Duilio** has 3 zero-credit tickets (2 different claimant/closer, 1 cancellation) and 0 ticket points. His manual 3 is donation-only, so 0 is correct for ticket points.
- **Unresolved attribution** is limited to 2 tickets worth 4 base points (#7622 automatic closure with no identities, #7742 missing claimant). They are not silently awarded.

### Ticket-level evidence

- All 275 window tickets with categories, points, rule, claimant, closer, review status, and explanation: `data/qa/final-reconciliation-tickets.csv`.
- Per-staff variance candidates (fallbacks, rule C half-awards, zero-different, unresolved, pending): `data/qa/final-reconciliation.json` → `varianceByStaff`.
- The 18 bridge tickets with staff and points: `data/qa/final-reconciliation.json` → `coverage.belowTicketIds`.

## 7. Semantic model

The local model is installed and operational:

| Item | Result |
|---|---|
| Runtime | Ollama 0.32.1 at `http://127.0.0.1:11434` |
| Model | `qwen2.5:3b` (1.9 GB, Q4_K_M, local) |
| Built-in self-test | Passed, 51.6 s, valid schema and categories |
| Live classification | **Deterministic; model intentionally not called** |
| Offline live-reason sample | 3 actual reasons, hybrid mode, 72.8 s |

The three sampled live reasons:

1. `Automatically closed due to user leaving the server` → **fallback**, review required, 2 base points. This is the correct visible fallback for a system message that has no reliable category.
2. `مردش لاكتر من ساعتين` → **No Response**, hybrid, exact.
3. `report` → **Report**, hybrid, exact.

These labels are the operator's reading, not a manager-approved reference set. A manager review of a bounded sample remains **blocked**: it requires a human to label the sample. The model is not used for live points, so this does not change any stored award.

Important: the 100% deterministic corpus result is a 62-reason rule corpus, not evidence of general semantic understanding. The hybrid sample is only a smoke test.

## 8. Idempotency and recovery campaign

Run against the live application; no destructive operation was performed on live tickets. The pause/resume test used an already-collected range and only added run bookkeeping.

| Test | Result |
|---|---|
| Incremental Sync #1 (274 IDs) | Completed, 272 reused, 2 not-found, 0 transcripts, 0 failures, 40.9 s |
| Incremental Sync #2 (274 IDs) | Completed, identical ticket/message/assessment content hashes, 40.9 s |
| Rescore all stored assessments | 417 rescored, **0 awards changed**, 0.6 s |
| Reclassify stale assessments | **0** stale, 0 failed, human corrections preserved |
| Staff export twice | Identical rows and totals; only `generatedAt` differs |
| Pause during a 30-ID Sync | Paused with mode `incremental` |
| Resume | Resumed in **incremental** mode, not full; completed 30/30 |
| Content after pause/resume | Ticket, message, and assessment hashes unchanged |
| Application restart | Counts and totals identical before and after (463 tickets, 9,676 messages, 463 assessments, 133 reviews, 917 awarded points) |
| Duplicate tickets/messages/awards | None |

Only `collection_runs` and `collection_items` grew, which is expected audit history. Machine-readable evidence: `data/qa/idempotency-campaign-latest.json`, `data/qa/restart-before.json`, `data/qa/restart-after.json`.

## 9. Acceptance matrix

| Criterion | Status | Evidence |
|---|---|---|
| Database backup and restore verified | **PASS** | `benchmark-baseline-manifest.json`, `restore-verify.db` |
| Activity-window coverage | **PASS with documented bound** | 18 bridge tickets; min active ID 7392; all 7300–7391 ended earlier |
| Source metadata preserved | **PASS** | 7300–7473 run: 174/174 collected, 0 missing, 0 failed |
| Rate-limit handling | **PASS** | Serialized gate; 174-record run with 0 pauses; cooldown path unit-tested |
| Full refresh ~270 under five minutes | **FAIL / EXTERNAL LIMIT** | Dashboard budget ~37 requests per window; full run paused earlier at 37 requests |
| Cache freshness | **PASS with limitation** | Listing-visible changes force re-read; transcript-only edits undetectable without Full refresh |
| Incremental sync performance | **PASS** | 274 IDs in ~41 s at safe spacing; 24 s at 1 s spacing before the limiter change |
| Rescore / reclassify | **PASS** | 417 rescored, 0 changed; 0 stale |
| Idempotency | **PASS** | Two syncs, exports, pause/resume, restart; no content duplication |
| Semantic runtime | **PASS** | Ollama/model self-test and 3 live reasons |
| Semantic live scoring | **INTENTIONALLY OFF** | Deterministic classifier; fallback + review instead of model guess |
| Manager-approved semantic sample | **BLOCKED** | Requires manager labels |
| Per-staff reconciliation | **PARTIAL** | 18-ticket bridge isolated; manual scope ambiguity for staff-d; staff-e +7 unresolved |
| Manual sheet internal consistency | **FAIL (SOURCE DATA)** | Displayed 635 vs daily+donation 628; every row +1 |
| Ticket-level drill-down | **PASS** | 275-row CSV + variance JSON |
| No live ticket mutation | **PASS** | Read-only collection; no Discord actions |

## 10. Remaining blockers and precise next actions

1. **staff-d scope question.** Confirm whether #7436, #7444, #7446, #7464 are in the manual staff-d row. If not, the correct comparison is 322.5 vs 319 (+3.5), not 330.5 vs 319.
2. **staff-e +7.** Compare his 20 ticket IDs in the CSV against the sheet. The app's awards are all rule B and no fallbacks, so this is likely an omission or a manual attribution difference.
3. **Manual arithmetic.** Use the daily columns (583), not displayed sums (635), when comparing ticket points. The +7 is arithmetic, not scoring. Donations (45) are outside the taxonomy.
4. **Review queue.** 68 non-demo pending reviews exist; 38 are in this window. These are visible, not hidden. Resolve the high-value/fallback ones before treating the total as final.
5. **Full refresh.** Cannot meet five minutes under the observed dashboard budget. Use Sync for repeats; Full refresh is a rare audit operation and should be resumed after cooldowns.
6. **Semantic manager review.** If desired, label a bounded sample of actual reasons and run the hybrid evaluator against those labels. Do not interpret the 62-reason corpus as general semantic accuracy.
7. **Ancient active tickets.** Coverage is proven from 7392 upward and bounded below by 7300. A scan below 7300 would require authorization for a larger historical run.

## 11. Reproduce

```bash
npm run typecheck
npm test                 # 109 tests, 7 files
npm run build

# Live expanded coverage (read-only)
curl -X POST http://127.0.0.1:5178/api/collection/start \
  -H 'Content-Type: application/json' \
  -d '{"start":"7300","end":"7473","classify":true,"confirmLarge":false,"mode":"incremental"}'

# Reconciliation and worksheet
node data/qa/final-reconcile.mjs

# Idempotency campaign (does not modify tickets)
node data/qa/idempotency-campaign.mjs
```

Evidence index:

- `data/qa/final-reconciliation.json`
- `data/qa/final-reconciliation-tickets.csv`
- `data/qa/manual-worksheet.md`
- `data/qa/idempotency-campaign-latest.json`
- `data/qa/restart-before.json`, `data/qa/restart-after.json`
- `data/qa/benchmark-baseline-manifest.json`
- `data/eval/eval-hybrid-2026-10-25T00-18-15.json`
