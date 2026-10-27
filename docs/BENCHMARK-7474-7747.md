# Benchmark: ticket IDs 7474–7747

Date: 2026-10-25
Application: TicketsManage 2.0.0 · Taxonomy 1.1.0 · Classifier **2.1.0**
Collection run: `8881a516-0c44-4e18-a754-b131ab22ee2e`
Source: authenticated live Tickets dashboard (read-only collection)

> **Superseded on 2026-10-25.** The ID-only range below missed 18 tickets that were opened before 7474 but active during 17–23 October. The expanded coverage, the 35.5-point bridge, the final per-staff reconciliation, and the acceptance matrix are in **[FINAL-ACCEPTANCE.md](FINAL-ACCEPTANCE.md)**. This document remains as the original ID-range record; do not use its totals as the final result.

This benchmark compares the application's ticket-level staff awards against the manual totals supplied by the account holder. The manual figures are treated as approximate: the account holder explicitly said some daily cells were miscalculated. The comparison therefore reports both the supplied sums and the arithmetic correction, and does not force the application to reproduce a manual error.

## 1. Scope and coverage

| Item | Result |
|---|---:|
| Inclusive ID range | 7474–7747 |
| Requested IDs | 274 |
| Collected with transcripts | **272** |
| Genuinely not found | **2** (#7700, #7737) |
| Failed | 0 |
| Transcript messages stored | 5,596 |
| Fallback classifications | **2** (#7571 `ban`, #7622 automatic closure) |
| Pending review items | 36 |
| Unresolved staff attribution | 2 |
| Zero-point cancellation/placeholder records | 14 |

Both missing IDs were checked directly in the authenticated dashboard. Each transcript page returned HTTP 200 with the visible text **“Transcript not found”**, so they were not fabricated or counted as zero-point tickets.

## 2. Name mapping

The manual table uses display names; the dashboard uses Discord IDs. The mapping is inferred from the staff ID on every stored ticket, not from a name-only join.

| Manual name | Application staff | ID | Basis |
|---|---|---|---|
| staff-d | `b932` | `example-staff-id` | largest ticket volume and total |
| Omar | `_jr5` | `1241894660541120632` | second-largest volume and total |
| staff-c | `xmax5696` | `744377778102730864` | direct name match |
| Sheroo | `4eroo` | `1108646863873249320` | closest name/transliteration and only remaining 14-ticket group |
| staff-e | `ahmed_labeb` | `481974168032772118` | direct name match |
| Heart | `_k.in` | `807010733325811712` | exact total match (20) |
| Duilio | `duilio_` | `750540980528218223` | direct name match |
| Comment | — | — | not a staff row in the application data |

Two application staff members are absent from the manual table:

| Application staff | ID | Tickets | Awarded |
|---|---|---:|---:|
| `staff-a.` | `example-staff-id-2` | 1 | 2.5 |
| `staff-b.` | `example-staff-id-3` | 1 | 1 |

Their **3.5** points explain part of the difference between the mapped staff total and the application-wide total.

## 3. Results by staff member

“Manual daily” is the sum of the seven daily columns. “Manual displayed” is the supplied Sum column. Seven displayed sums are one point higher than their own columns; that is a manual arithmetic difference, not an application award.

| Manual name | App staff | Manual daily | Donation | Manual displayed | App tickets | App points | App + manual donation | vs daily | vs displayed |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| staff-c | `xmax5696` | 67 | 3 | 71 | 25 | 54.5 | 57.5 | -12.5 | -16.5 |
| Omar | `_jr5` | 111 | 7 | 119 | 50 | 112 | 119 | +1 | -7 |
| staff-d | `b932` | 319 | 23 | 343 | 139 | 339.5 | 362.5 | +20.5 | -3.5 |
| Sheroo | `4eroo` | 38 | 1 | 40 | 14 | 24.5 | 25.5 | -13.5 | -15.5 |
| staff-e | `ahmed_labeb` | 29 | 9 | 39 | 19 | 36 | 45 | +7 | -3 |
| Heart | `_k.in` | 19 | 0 | 20 | 10 | 20 | 20 | +1 | 0 |
| Comment | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Duilio | `duilio_` | 0 | 2 | 3 | 3 | 0 | 2 | 0 | -3 |

## 4. Aggregate reconciliation

| Measure | Points |
|---|---:|
| Manual displayed total | **635** |
| Manual daily total | 583 |
| Manual daily + donations | 628 |
| Manual sum error (+1 on seven rows) | +7 |
| Application, mapped staff only | **586.5** |
| Application, including the two unlisted staff | **590** |
| Application + manual donations | 635 |
| Application + manual donations, mapped staff only | 631.5 |

The aggregate closes exactly:

- `590` application points + `45` manual donation points = **635**, the supplied displayed total.
- `586.5` mapped application points + `45` donations + `3.5` unlisted staff = **635**.
- Correcting the manual’s +1-per-row error gives **628**; adding the two unlisted staff gives **631.5**, which equals the mapped application score plus donations.

That exact aggregate does **not** mean every person matches. The staff-c/Sheroo deficits and the staff-d/staff-e surpluses largely cancel. They are reported below rather than hidden.

## 5. What changed in classifier 2.1.0

The first pass produced 36 fallbacks and 92 pending reviews. Inspecting the fallback reasons exposed two real classifier defects:

1. **Compound reasons were not split.** Values such as `general question /Solving problem`, `general issue / no respond`, and `report /generalquestio` contain known facets, but the normaliser converted the separators to spaces before matching. They fell back even though every facet was known.
2. **Cancellations were treated as support work.** `By Mistake`, `no reason`, `Reply received`, `تم الرد`, and `فتحها بلغلط` received the General Issue fallback and 2 provisional points. These are not foreign support reasons; they are cancellations or generic closures with no support work to score.

The fix:

- split raw reasons on `/`, newline, `;`, `|`, and `&` before matching each facet;
- merge all distinct facets, so a reason can legitimately score multiple categories;
- add the short aliases seen in the live range (`game password`, `game download`, `Bug Report`, `Script Report`, `Ranked report`, `report check`, `مردش لاكتر…`);
- require explicit silence/inactivity evidence before `NO_RESPONSE`, so a bare `respond` cannot fuzzy-match “no response”;
- return **0 categories and 0 points** for cancellations/placeholders, with an explicit review reason, instead of the General problem fallback.

Result on the same 272 tickets:

| Measure | Before 2.1.0 | After 2.1.0 |
|---|---:|---:|
| Fallbacks | 36 | **2** |
| Pending reviews | 92 | **36** |
| Mapped points | 554.0 | **586.5** |
| Unresolved attribution | 2 | 2 |

The 2 remaining fallbacks are genuinely unclear: `ban` (#7571) and `Automatically closed due to user leaving the server` (#7622).

## 6. Remaining differences and limits

1. **Donations are not part of the ticket taxonomy.** The application has no donation category or manual-adjustment store. The 45 manual donation points are added in this report only; the app itself reports 590 for the range (586.5 mapped).
2. **Manual daily data is approximate.** The account holder warned that some cells were miscalculated. Seven Sum cells are also +1 over their own columns. Per-person differences should be read as review leads, not as proof that the app is wrong.
3. **Day grouping now uses a close-date proxy.** The dashboard still exposes no closing timestamp. A new `dateBasis=activity` filter uses the final transcript message timestamp, which is the closest available evidence of when a ticket stopped being active. Section 8 compares the 17–23 October window on that basis; daily cells match several staff-days exactly, so this is substantially closer than the earlier opening-time fallback. It is still a proxy, not a recorded closure event.
4. **Some per-person gaps remain material.** staff-c is 12.5 below the manual daily total; Sheroo is 13.5 below; staff-d is 20.5 above; staff-e is 7 above. These are candidates for ticket-level review, not automatic score adjustments.
5. **Unlisted staff.** `staff-a.` and `staff-b.` account for 3.5 points and are absent from the manual table.
6. **Two tickets are genuinely missing** from the dashboard (#7700, #7737). The manual total may or may not include them; they cannot be scored.
7. **No live ticket was modified.** Collection is read-only. The only writes were local reassessments of already collected records and the benchmark/report files.

## 7. Reproducible evidence

- Full ticket-level CSV: [`data/qa/benchmark-tickets-7474-7747.csv`](../data/qa/benchmark-tickets-7474-7747.csv)
- Machine-readable summary: [`data/qa/benchmark-report.json`](../data/qa/benchmark-report.json)
- Manual input transcribed from the supplied image: [`data/qa/manual-benchmark.json`](../data/qa/manual-benchmark.json)
- Reclassification preview: [`data/qa/reclassify-preview.txt`](../data/qa/reclassify-preview.txt)
- Database backup before reassessment: `data/backups/ticketsmanage-2026-10-24T22-19-30.db`
- Source-check evidence for the two missing IDs: [`data/qa/missing-ids-check.jsonl`](../data/qa/missing-ids-check.jsonl)

The CSV contains staff IDs, reasons, categories, base points, credit rule, award, fallback status, review status, claimant, closer, and message count for every collected ticket. It does not contain cookies, tokens, passwords, or transcript bodies.

## 8. Date-window comparison: 17–23 October (local time)

The account holder asked for a comparison from **17 October 00:00 to 23 October 23:59:59** in local time, noting that some tickets in the ID range belong to older dates. The app now supports this with:

```text
GET /api/staff?from=2026-10-17&to=2026-10-23&dateBasis=activity
```

Dates are interpreted in the machine timezone (Africa/Cairo). “Activity” is the timestamp of the last transcript message. The dashboard has no closure timestamp, so this is the nearest evidence; a ticket may have closed shortly after that message.

### Result by staff member

| Staff | App points | App credited tickets | Manual Sum | Manual daily | Donation | App − manual daily |
|---|---:|---:|---:|---:|---:|---:|
| staff-d | 322.5 | 131 | 343 | 319 | 23 | +3.5 |
| Omar | 114 | 47 | 119 | 111 | 7 | +3 |
| staff-c | 52.5 | 24 | 71 | 67 | 3 | −14.5 |
| staff-e | 34 | 18 | 39 | 29 | 9 | +5 |
| Sheroo | 24.5 | 14 | 40 | 38 | 1 | −13.5 |
| Heart | 20 | 10 | 20 | 19 | 0 | +1 |
| Duilio | 0 | 0 | 3 | 0 | 2 | 0 |
| Comment | 0 | 0 | 0 | 0 | 0 | 0 |
| *(unlisted: staff-a. 2.5, staff-b. 1)* | 3.5 | 2 | — | — | — | — |
| **Total** | **571** | **246** | **635** | **583** | **45** | **−12** |

The app total includes the 3.5 points from two staff members who are not in the manual table. The eight named staff total 567.5.

### Day-by-day (app / manual)

| Staff | 17 Oct | 18 Oct | 19 Oct | 20 Oct | 21 Oct | 22 Oct | 23 Oct |
|---|---:|---:|---:|---:|---:|---:|---:|
| staff-c | 26.5 / 43 | **4 / 4** | **6 / 6** | **14 / 14** | 0 / 0 | 0 / 0 | 2 / 0 |
| Omar | **26 / 26** | 13 / 11 | 11 / 9 | 7 / 6 | **5 / 5** | **44 / 44** | 8 / 10 |
| staff-d | 72 / 62 | 86 / 83 | 40.5 / 33 | 62 / 64 | 28.5 / 34 | **16 / 16** | 17.5 / 27 |
| Sheroo | 1.5 / 16 | **4 / 4** | 0 / 0 | 0 / 0 | **11 / 11** | 8 / 7 | 0 / 0 |
| staff-e | **7 / 7** | 11 / 8 | 12 / 8 | **1 / 1** | **3 / 3** | 0 / 0 | 0 / 2 |
| Heart | **4 / 4** | 8 / 6 | **1 / 1** | **4 / 4** | 2 / 3 | 0 / 0 | **1 / 1** |
| Duilio | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |

Bold cells are exact matches. Sixteen of the 49 named staff-days match exactly, including the whole 18–20 October run for staff-c. This is strong evidence that the activity basis is the right day grouping.

### Remaining differences

1. **The 17th is incomplete in the ID range.** staff-c is 16.5 below and Sheroo 14.5 below on 17 October, while staff-d is 10 above. Tickets active on the 17th but opened before ID 7474 are not in the collected range. Widen the start ID (for example 7300) and re-sync to test that hypothesis. The dashboard rate limit may force several resumed runs for a range that large.
2. **Classification differences remain.** staff-d is +3, staff-e +5 and Heart +1 against the manual daily columns. Review their fallback/low-confidence tickets before treating these as app errors.
3. **The manual sheet is internally inconsistent.** Displayed sums are 635 but the daily columns plus donations total 628; Duilio’s displayed 3 cannot be produced by 0 daily + 2 donation. These are manual arithmetic differences, not awards the app can reproduce.
4. **Donations are outside the taxonomy.** The app does not invent donation points. The 45 donation points are shown only for reconciliation.
5. **Two unlisted staff** (`staff-a.` 2.5, `staff-b.` 1) are real awards absent from the manual table.
6. **No ticket was modified.** Collection remains read-only.

The machine-readable window summary is in `data/qa/window-17-23.json`.

## 9. Performance of the collection used for this benchmark

The performance work is documented in [PERFORMANCE.md](PERFORMANCE.md). Key measured figures:

| Workload | Result |
|---|---:|
| Full refresh, 7770–7779 (9 transcripts, 1 not found) | 10.2 s wall; median 548 ms/ticket |
| Incremental sync, 7474–7747 (272 reused, 2 not found) | 24.2 s wall; 0 transcripts |
| Rescore 266 stored assessments | 0.41 s |
| Staff report, 17–23 Oct activity window | 0.15 s |
| Full refresh 7474–7747 | Paused by dashboard HTTP 429 after 37 requests / 18 tickets |

The 274-ID full refresh could not finish in one pass because the dashboard rate-limits bursts even at one request per second. It paused without storing a partial record. This is an external constraint, not a skipped-ticket optimization.

### Everyday recommendation

- Use **Sync range** for repeated work (24 s for this range).
- Use **Full refresh** rarely and resume after a rate-limit pause.
- Use **Rescore stored results** after scoring-rule changes.
- Read staff numbers with **Last activity** and the exact date window; export the same filters for audit.
