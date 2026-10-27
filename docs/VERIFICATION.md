# Verification record

Date: 2026-10-25
Environment: Windows, 8 CPU cores, 15.7 GB RAM, Node.js 24, Ollama 0.32.1
Application version: 2.0.0 · Taxonomy 1.1.0 (Recharge added) · Classifier **2.1.0**

This file records what was actually executed. Anything that could not be executed is listed under **Not covered**. The QA campaign is in [QA-REPORT.md](QA-REPORT.md), the original ID-range comparison is in [BENCHMARK-7474-7747.md](BENCHMARK-7474-7747.md), and the final expanded-coverage acceptance result is in [FINAL-ACCEPTANCE.md](FINAL-ACCEPTANCE.md).

## Build and automated tests

| Check | Command | Result |
|---|---|---|
| Server TypeScript | `tsc -p tsconfig.server.json --noEmit` | Passed |
| Web TypeScript | `tsc -p web/tsconfig.json --noEmit` | Passed |
| Production UI build | `npm run build:web` | Passed (`web-dist`) |
| Test suite | `npm test` | **109 passed / 109** in 7 files |
| Rules-only corpus | `npm run eval:model -- --rules-only` | **55/55 exact sets**, 7/7 expected fallbacks |

Coverage:

- taxonomy completeness, unique ids, all point values, Recharge = 2, Arabic/Arabizi examples;
- base-score deduplication and taxonomy-authoritative points;
- staff-credit rules A–E, half-points, different-staff zero, unavailable fields unresolved, and 0-point explanations;
- Arabic/Arabizi/English normalisation, Recharge positives and negatives, multi-label reasons, compound reasons split on `/`, newline, `;`, `|`, and `&`, AnyDesk reconciliation, negation, fallback, approved aliases, typo tolerance;
- cancellation/placeholder reasons (`By Mistake`, `no reason`, `Reply received`, `تم الرد`, `فتحها بلغلط`) return no category and no points instead of the fallback;
- inclusive range validation (large ranges, leading zeros, oversized ranges, large integers);
- lossless parsing of Discord IDs above `Number.MAX_SAFE_INTEGER`, claimant inference from claim/unclaim control messages, and explicit no-claim evidence;
- automatic review resolution when reassessment leaves no actionable reason;
- CSV quoting, formula neutralisation, missing values;
- SQLite idempotent upserts, transcripts, settings persistence, approved corrections, reviews, nested transaction rollback, backup/validate/restore;
- end-to-end assessment: Recharge ticket → 2 base / 2 awarded, unclaimed Recharge → 1 half-point, fallback review survives reopen, human corrections are not overwritten.

## Classifier evaluation

Corpus: `eval/classification-corpus.json` — **62 reasons** (55 with scored labels, 7 expected fallbacks), Arabic, Egyptian Arabic, Arabizi, English, multi-label, negations, distractors, and a foreign staff-application reason that must fall back.

| Metric | Result |
|---|---:|
| Exact category-set match | 55 / 55 (100%) |
| Micro precision | 100% |
| Micro recall | 100% |
| Micro F1 | 100% |
| Expected fallback rows | 7 / 7 |
| Rows requiring review | 7 / 62 |

The alias tables and compound splitting were extended after live 7474–7747 exposed gaps. The corpus doubles as a regression suite; the 100% result is **not** evidence of generalisation to unseen wording. Unseen wording receives the explicit fallback described below.

## Live dashboard collection

Performed against the real Tickets v2 dashboard after the account holder completed the normal sign-in in the dedicated browser profile. No Discord token was requested, read, or stored. Collection is read-only; no ticket was claimed, closed, edited, labelled, or messaged.

### Initial range 7770–7778

Run: **2026-10-24 20:02–20:03 UTC**, inclusive range **7770–7778**.

| Result | Count |
|---|---:|
| Requested IDs | 9 |
| Collected with transcripts | 8 |
| Not found | 1 (#7774) |
| Failed | 0 |
| Classified | 8 |
| Fallbacks after 2.1.0 reassessment | 2 (#7776, #7778) |
| Pending reviews after 2.1.0 | 3 (#7773 fuzzy match, #7776, #7778) |

Observed evidence:

- The dashboard's own transcript list and render responses were read through the authenticated page. Each collected ticket has a stored transcript (for example 17 messages for #7770, 16 for #7778).
- The first attempt exposed a nested SQLite transaction bug: the first ticket extracted successfully, then collection aborted on save. The transaction layer was fixed and a regression test added.
- The dashboard sends `closed_by` as a JSON number above JavaScript's safe-integer limit. `JSON.parse` had rounded `example-staff-id` to `752978053101256700`, which made claimant/closer comparison fail. IDs are now parsed losslessly and the stored value is exact.
- The transcript list has no claimant column. The collector reads the ticket's own **Claimed Ticket** control message and resolves the staff name from the transcript's user directory. All 8 live tickets show a confirmed claimant and closer.
- #7778 (`تقديم اداره`) is a foreign staff-application reason. It is stored as the visible General problem fallback, not Recharge, and remains in Review.
- After classifier 2.1.0 reassessment, #7773 (`general issues no respond`) is classified as **General Issue + No Response = 3 points**, but remains pending only because fuzzy matching was used. The old range totals **19 points**: `b932` 15 / 6 tickets, `_jr5` 2 / 1, `duilio_` 2 / 1.
- Reassessment auto-resolved reviews whose only reason was missing attribution. The old range now shows **3 pending reviews** and **5 accepted** items.

### Benchmark range 7474–7747

> This is the original ID-only record. It excludes 18 tickets opened before 7474 but active during 17–23 October. The final expanded result is **606.5 points** and is documented in [FINAL-ACCEPTANCE.md](FINAL-ACCEPTANCE.md).

Run: **2026-10-24 21:33–21:50 UTC**, inclusive range **7474–7747**.

| Result | Count |
|---|---:|
| Requested IDs | 274 |
| Collected with transcripts | **272** |
| Not found | **2** (#7700, #7737) |
| Failed | 0 |
| Transcript messages stored | 5,596 |
| Fallbacks after 2.1.0 | **2** (#7571 `ban`, #7622 automatic closure) |
| Pending reviews after 2.1.0 | **36** |
| Unresolved staff attribution | 2 |
| Zero-point cancellations/placeholders | 14 |
| Application points (mapped staff) | **586.5** |
| Application points (including 2 unlisted staff) | **590** |

Both missing IDs were checked directly in the authenticated dashboard. Each transcript page returned HTTP 200 with the visible text **“Transcript not found”**. They were not fabricated or counted as zero-point tickets.

The full comparison is in [BENCHMARK-7474-7747.md](BENCHMARK-7474-7747.md). In brief:

- Supplied manual daily total: **583**; supplied displayed total: **635**.
- Mapped application total: **586.5**, which is **+3.5** against the supplied daily total.
- The displayed total includes **45 donation points** that the application does not track and a **+7 manual sum error** (seven rows are +1 over their own columns).
- Mapped application points + manual donations = **631.5**; adding the two unlisted staff (**3.5**) gives **635**.
- Per-person gaps remain (staff-c −12.5, Sheroo −13.5, staff-d +20.5, staff-e +7 against the daily columns), so the aggregate match is not evidence that every ticket was classified identically.

## Classifier 2.1.0 fixes

The first 7474–7747 pass produced 36 fallbacks and 92 pending reviews. Inspection found two real defects:

1. **Compound reasons were not split.** The normaliser converts `/` and newlines to spaces before matching, so `general question /Solving problem`, `general issue / no respond`, and similar values fell back even though every facet was known.
2. **Cancellations were scored as support work.** `By Mistake`, `no reason`, `Reply received`, `تم الرد`, and `فتحها بلغلط` received the General Issue fallback and 2 provisional points. These are not foreign support reasons; they are cancellations or generic closures.

The fix splits raw reasons before normalisation, merges distinct facets, adds live short aliases, requires explicit silence/inactivity evidence before `NO_RESPONSE`, and returns **zero categories and zero points** for cancellations/placeholders with an explicit review reason.

Result on the same 272 tickets:

| Measure | Before 2.1.0 | After 2.1.0 |
|---|---:|---:|
| Fallbacks | 36 | **2** |
| Pending reviews | 92 | **36** |
| Mapped points | 554.0 | **586.5** |
| Unresolved attribution | 2 | 2 |

The two remaining fallbacks are genuinely unclear: `ban` (#7571) and `Automatically closed due to user leaving the server` (#7622).

## UI and API acceptance checks performed

- Overview and API status agree on ticket, assessment, review, fallback, and award counts.
- Review detail for a zero-point cancellation (#7564) shows **no categories, 0 base, 0 awarded**, the explicit explanation, and a pending review reason; it is not labelled as a fallback.
- #7778 still shows the fallback explanation and remains reviewable.
- The category selector includes **Recharge · شحن · 2 pts**.
- Ticket explorer and CSV/JSON exports include fallback status, review status, and unresolved attribution without inventing values.
- A foreign-Origin `POST` was rejected with HTTP 403 `CROSS_ORIGIN_BLOCKED`.
- An application-created backup was written to `data/backups`; the pre-reassessment backup is `ticketsmanage-2026-10-24T22-19-30.db`.
- `TicketsManage.bat` was executed end to end and served `/api/health` on port 5178.

## Not covered

1. **Live ranges under rate limiting.** Verified runs cover 7770–7779 (full), a 274-ID incremental Sync, and a partial 274-ID Full refresh stopped by HTTP 429 after 37 requests. The app pauses without storing partial records. Very large ranges need resumed runs; session expiry and dashboard markup changes remain handled in code and tests rather than fully observed live.
2. **Full local-model accuracy.** The self-test passes, but the 62-row model run was not completed because of its measured latency. Live scoring does not depend on it. If a full measurement is wanted later, run it unattended:
   ```bash
   npm run eval:model -- --model qwen2.5:3b
   ```
   The script exits with code 2 and an actionable message if Ollama or the model is unavailable; it never reports a fabricated model result.
3. **Donation points.** The application has no donation category or manual-adjustment store. Donations are added only in the benchmark comparison, not in the app’s staff report.
4. **Closing timestamps.** The dashboard list does not expose one, so `closed_at` remains null. Reports offer **Last activity** (final transcript message, the closest evidence of closure) or **Ticket opening time**, interpreted in local time. Last activity matches many manual staff-days exactly; it is still a proxy, not a recorded closure event. Totals are comparable to a ticket-ID range; daily cells depend on this choice.
5. **Pause/resume against a live network failure.** Checkpoint and resume behaviour is covered by automated tests, but the verified live runs completed without needing it.

Nothing here claims that the full hybrid model run succeeded or that the model is used for live points.
