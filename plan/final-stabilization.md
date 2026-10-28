# TicketsManage Final Stabilization — Execution Plan

> **Status: Historical / superseded.** This document describes an earlier desired state and must not be treated as current requirements. See the current README and `plan/stewardship-plan.md` (if present) for authoritative behavior. Do not silently rewrite this historical account.

## Current State
- App v2.0.0, 111 tests passing, launcher working
- Roster: 456 tickets, 917 awarded points, 68 reviews
- Collector: ID-range only
- Reports: dateBasis = opened | activity (no closed)
- AI: deterministic by default; production mode available
- Reusable aliases: implemented via approved_aliases

## Phase A — Fix & Verify (no reset)

### A1: Date-based collection
- Backend: `collector.ts` add `fetchIdsByClosedAtRange(from, to, timezone)` — scan listing pages, filter by `closed_at`, stop when page is before range.
- Backend: `collection-service.ts` accept date range, translate to ID list via new collector method, store date params in run.
- Backend: `routes.ts` preview/start accept `fromDate`/`toDate`/`timezone`/`dateBasis`.
- Frontend: `Collect.tsx` replace ID inputs with date inputs (`DD/MM/YY`), timezone selector, date basis selector, keep ID mode as secondary diagnostic.
- Tests: add date validation, preview, and closed-at filtering tests.

### A2: Reusable corrections
- Verify `approved_aliases` survive reset and are used by classifier.
- Add test: create alias, reset roster, reclassify, verify alias still works.

### A3: AI integration
- Verify production path in `assessment-service.ts`: `aiMode === 'production'` calls `classifyReason` with `semanticMode: 'always'`.
- Add test: mock Ollama, set production mode, verify model is called for unfamiliar reason.

### A4: Feature audit
- Run full test suite, verify no regressions.
- Verify UI actions via API: backup, reset preview, reset, exports.

## Phase B — Reset & Calculate

### B1: Backup
- Create verified backup via `/api/backups`.

### B2: Reset
- POST `/api/reset/roster` with `RESET ROSTER`.
- Verify counts = 0.

### B3: Fresh collection
- Collect 17–23 Oct 2026 via date-based UI.
- Verify closed_at filtering.

### B4: Classify & score
- Run classification on fresh tickets.
- Generate staff report.

### B5: Benchmark
- Compare against supplied sums: 71, 119, 343, 40, 39, 20, 0, 3.
- Show 635 vs 628 discrepancy.
- Document ticket-level discrepancies.

### B6: Repeatability
- Re-run sync for same window.
- Verify no duplicates, totals unchanged.
