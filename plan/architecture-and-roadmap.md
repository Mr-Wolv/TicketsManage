# TicketsManage — Architecture Planning, Cloud Semantic Classification, Taxonomy Consolidation, Functional Audit & Security Review

> **Status: Historical / superseded.** This document describes an earlier desired state and must not be treated as current requirements. See the current README for authoritative behavior. Do not silently rewrite this historical account.

**Mode: `/plan` — investigation and implementation plan only. No code changes, no resets, no migrations in this pass.**

---

## A. Executive Assessment

TicketsManage is a local-first Node/TypeScript + SQLite application with a Playwright-driven dashboard connector, deterministic classification, staff-credit scoring, review workflow, export, backup/restore, and a newly added fluid taxonomy layer. The codebase is structurally coherent: backend services are separated (`db`, `collection-service`, `collector`, `assessment-service`, `scoring`, `classifier/*`, `routes`), and the frontend is a standalone web bundle served by Express.

**Most important architectural problems:**
1. **Date-based collection is not actually closed-at authoritative.** The dashboard listing API does not expose `closed_at`. The current collector falls back to `opened_at` proxy scanning, which violates the requirement to filter by confirmed closure timestamps. This is the highest-risk functional gap.
2. **The Settings page “Fluid taxonomy data could not be loaded” error is systemic, not a one-off fetch failure.** The frontend `loadTaxonomy` function catches every error and surfaces a single generic toast, masking whether the failure is network, route, contract, DB, or state lifecycle.
3. **Local semantic model is still the active classification dependency in production settings.** The app ships with `ollamaUrl`, `model`, `aiMode`, and full Ollama client code paths. The requirement is to replace active local inference with an efficient cloud semantic provider.
4. **Taxonomy is split across fixed code, fluid DB tables, frontend constants, and AI prompts.** This creates divergent sources of truth and makes auditability fragile.
5. **Reset semantics partially preserve reusable knowledge, but not completely.** `resetRoster()` preserves `approved_aliases` but clears `approved_reasons`, `custom_categories`, `taxonomy_overrides`, and `taxonomy_audit_log`. The requirement is that approved custom reasons survive roster cleanup.

**Top risks:**
- Data-boundary leaks if cloud classification is integrated without strict payload scoping.
- Silent scoring drift if normalization is implemented as display-only but later conflated with raw awards.
- Regression in attribution rules if taxonomy edits change historical category IDs or point semantics without migration.

---

## B. Current Architecture Map

### UI Pages
- **Collect** (`web/src/pages/Collect.tsx`): collection UI with 3-mode selector (`date`/`id`/`hybrid`), preview/start/pause/resume/cancel, live recent items, diagnostics.
- **Tickets** (not fully inspected in this pass; referenced in route inventory): ticket explorer and detail.
- **Staff** (referenced): staff performance report with date filters.
- **Review Queue** (referenced): review items with accept/correct/dismiss/reassess.
- **Settings** (`web/src/pages/Settings.tsx`): connection, browser profile, model config, fixed taxonomy display, fluid taxonomy CRUD, backup/restore, demo seed/clear, roster reset.

### Backend Services
- **Entry**: `server/index.ts` — Express app, static web serving, error handling, EADDRINUSE exit behavior.
- **Config**: `server/config.ts` — paths, versions, schema version, runtime dirs.
- **DB**: `server/db.ts` — SQLite via `DatabaseSync`, WAL mode, re-entrant transactions with savepoints, full schema + additive migrations, settings persistence, ticket/assessment/review CRUD, taxonomy tables, collection run tracking, backup/restore.
- **Connection**: `server/connection.ts` — Playwright persistent context, API token capture from dashboard requests, verify/reuse/session-reset lifecycle.
- **Collector**: `server/collector.ts` — `DashboardExtractor` with direct JSON API + navigation fallback, listing range discovery, transcript extraction, claim inference, rate-limit handling, structured error taxonomy.
- **Collection Service**: `server/collection-service.ts` — run lifecycle (start/pause/resume/cancel), ID validation, date validation, hybrid mode, diagnostics, checkpointed progress.
- **Classifier**:
  - `taxonomy.ts` — fixed `TAXONOMY` array, `pointsFor()` with optional override support, `loadCustomCategories()`, `findApprovedReason()` fuzzy matching, category ID validation.
  - `rules.ts` — deterministic alias matching, fuzzy threshold matching, compound reason splitting, AnyDesk/text-solved reconciliation, negation handling.
  - `normalize.ts` — Arabic/Latin normalization, diacritics/tatweel/digit handling, `editDistance`/`editSimilarity`, negation detection.
  - `pipeline.ts` — hybrid classification stages: approved alias → approved reason fuzzy → non-scoring check → deterministic rules → optional semantic → reconciliation → fallback.
  - `ollama.ts` — Ollama client, Zod-validated JSON schema, system prompt built from fixed taxonomy, timeout/retry/error handling.
- **Assessment Service**: `server/assessment-service.ts` — `assessTicket()`, `correctAssessment()`, `acceptReview()`, `dismissReview()`, `reassess()`, `rescoreAll()`, `reclassifyStale()`.
- **Scoring**: `server/scoring.ts` — `basePointsFor()` deduplicates categories, `applyStaffCredit()` implements Rules A–E.
- **Reports**: `server/reports.ts` — `buildStaffReport()` paginates tickets, aggregates staff rows, date-source breakdown, round2 formatting.
- **Routes**: `server/routes.ts` — all API endpoints, request validation, error mapping, local origin guard for mutating requests.

### Database Tables
- `tickets`, `transcript_messages`, `assessments`, `reviews`, `review_history`
- `approved_aliases` — reusable corrections (survive reset)
- `taxonomy_overrides`, `custom_categories`, `approved_reasons`, `taxonomy_audit_log` — fluid taxonomy (cleared by reset)
- `collection_runs`, `collection_items`, `collection_run_diagnostics`
- `meta`, `settings`

### Classification Path
1. Extract `closeReason` + `closeReasonState` from dashboard.
2. If `unavailable` → empty classification with review reasons.
3. If `empty` → empty classification, no fallback.
4. Check `approved_aliases` (exact normalized match).
5. Check `approved_reasons` (fuzzy match ≥0.75).
6. Check non-scoring patterns.
7. Run deterministic `classifyRules()` with configurable fuzzy threshold.
8. If `semanticMode === 'always'` and enabled, call Ollama `classifyReason()`.
9. Reconcile AnyDesk/AnyDesk_By, text-solved negation.
10. If no categories → fallback to `GENERAL_ISSUE` + review.
11. Score base points from authoritative taxonomy (override → fixed), apply staff credit.

### Collection Flow
1. UI sends start request with mode-specific parameters.
2. `CollectionService.start()` validates range, creates run record.
3. Loop authenticates via `ConnectionManager`, builds `DashboardExtractor`.
4. For date mode: `fetchIdsByClosedAtRange()` scans listing pages, falls back to opened_at proxy.
5. For ID mode: `fetchListingRange()` discovers ordered range, then `collectOne()` per ticket.
6. Each ticket: direct API → navigation fallback → metadata + transcript → assessment → checkpoint.
7. Pause/cancel/resume via run state machine.

### Scoring Flow
- `AssessmentService.buildStoredAssessment()` → `basePointsFor()` → `applyStaffCredit()`.
- Rule A: different confirmed claimant/closer → zero for both.
- Rule B: same confirmed person → full base.
- Rule C: confirmed unclaimed + reason → half to closer.
- Rule D: confirmed unclaimed + empty reason → zero.
- Rule E: incomplete identities → unresolved.

### Review Flow
- Review created when `reviewReasons.length > 0`.
- Accept: preserves classification, resolves review (or keeps open if credit unresolved).
- Correct: manager assigns categories, optionally approves alias, saves approved reason.
- Dismiss: archives review.
- Reassess: re-runs classifier unless human-corrected.

### Reset Behavior
- `resetRoster()` clears: reviews, review_history, assessments, transcript_messages, collection_items, collection_runs, collection_run_diagnostics, tickets.
- Preserves: settings, meta, schema, `approved_aliases`.
- **Does NOT preserve:** `taxonomy_overrides`, `custom_categories`, `approved_reasons`, `taxonomy_audit_log`.

---

## C. Requirement Traceability Matrix

| Req | Requirement | Current Behavior | Required Behavior | Affected Modules | Planned Tasks | Dependencies | Acceptance Test | Priority | Phase |
|-----|-------------|------------------|-------------------|------------------|---------------|--------------|-----------------|----------|-------|
| 2.1 | Replace local AI with cloud semantic | Local Ollama client active in production path | Cloud provider interface; no active local inference dependency | `classifier/ollama.ts`, `assessment-service.ts`, `routes.ts`, `config.ts`, `Settings.tsx` | Design provider abstraction, implement cloud adapter, disable local model path, migrate settings | Choose provider/model, secure API key storage | Model integration test with mock provider; verify local Ollama not called | P0 | 3 |
| 2.2 | Select provider/model | No cloud provider implemented | Practical cloud model chosen based on evidence | Same as 2.1 | Evaluate providers, document trade-offs, configure default | Provider comparison research | Documented provider selection with latency/cost/accuracy justification | P0 | 3 |
| 2.3 | Three-stage classification pipeline | Deterministic → optional local semantic → fallback | Deterministic → cloud semantic → human review with explicit state machine | `classifier/pipeline.ts`, `assessment-service.ts`, `reviews` tables | Implement stage B (cloud), refine stage C (review routing), define state transitions | Cloud adapter from 2.1 | Review-routing test: ambiguous reason → semantic suggestion → review queue | P0 | 4 |
| 2.4 | Design for speed | Rule-based skips model when confident | Cache semantic results, batch requests, bounded concurrency, timeouts/retries, progress persistence | `classifier/pipeline.ts`, `assessment-service.ts` | Add semantic cache keyed by normalized reason + taxonomy version, add bounded concurrency, add retry/backoff | Cloud adapter | Cache-hit rate ≥30% in repeat collection; no duplicate cloud calls | P1 | 4 |
| 2.5 | Protect private data | Local-only; no cloud path | Minimized payload: reason text + taxonomy context only; credentials never exposed | `classifier/ollama.ts` → new cloud module | Define redaction rules, audit payload shape, document boundary | Cloud adapter | Payload inspection test; no transcript/username/token in outbound body | P0 | 3 |
| 2.6 | Validate model output | Zod schema for local model | Strict schema validation for cloud output; invalid output → safe failure path | New cloud module | Zod schema for cloud response, validate categories against current taxonomy, handle timeouts/rate limits | Cloud adapter | Invalid/malformed/empty response test → no award, item routed to review | P0 | 3 |
| 2.7 | AI plan deliverables | Local model design docs | Cloud provider design docs with API contract, state machine, caching, evaluation plan | Documentation + code | Write design doc, evaluation corpus, staged migration plan | Provider selection | Documented contract + regression tests | P0 | 3 |
| 3.1 | Three distinct collection modes | Hybrid mode exists; date mode uses opened_at proxy | ID-only, date-only, ID+date with strict backend enforcement | `collection-service.ts`, `collector.ts`, `routes.ts`, `Collect.tsx` | Enforce mode semantics in backend, disable date predicates in ID mode, validate combined constraints | Closed-at discovery (3.2) | Mode-switching test: each mode produces different record sets; invalid combos rejected | P0 | 5 |
| 3.2 | Closure-date semantics | opened_at proxy; activity basis workaround | Closed-at authoritative; Africa/Cairo; half-open interval `[start, end)` | `collector.ts`, `collection-service.ts`, `reports.ts` | Implement closed-at discovery from bot embeds or dashboard API; exclude tickets with unresolved closure | Dashboard API inspection / embed parsing | Ticket closed within window included; opened-inside/closed-outside excluded | P0 | 5 |
| 3.3 | Test three modes independently | Some range/date tests | Mode-specific tests with boundary tickets, missing timestamps, resume | `tests/range.test.ts`, new `tests/collection-mode.test.ts` | Write mode contract tests, boundary tests, resume-with-changed-scope tests | Mode enforcement | All mode tests pass; resume cannot apply different filter | P0 | 5 |
| 4.1 | Normalize scores toggle | Quartic formula in manual Python script only | Recover agreed formula; if ambiguous, propose explicit formula with sample I/O | `scripts/normalize-staff-totals.py`, `reports.ts`, `Settings.tsx` or `Staff.tsx` | Locate formula in repo/docs; if missing, document quartic as explicit choice; add toggle | Formula recovery | Toggle switches raw/normalized; both shown side-by-side; raw DB unchanged | P1 | 6 |
| 4.2 | Keep raw and normalized separate | No toggle; normalization external | Presentation-only toggle; charts/rankings/exports consistent | Frontend staff page, export code | Implement toggle in Staff UI, apply formula in report layer, label basis clearly | Formula spec | Rapid toggle test; export matches current view; raw awards unchanged in DB | P1 | 6 |
| 4.3 | Toggle acceptance criteria | N/A | Empty data, zero scores, one-staff, ties, date-range changes | Same as 4.2 | Write edge-case tests for toggle | Toggle implementation | All edge cases pass without recollecting or re-scoring | P1 | 6 |
| 5.1 | Separate reusable knowledge from operational data | `resetRoster()` clears approved_reasons/custom_categories/overrides/audit | Operational data cleared; reusable knowledge preserved explicitly | `db.ts`, `routes.ts` | Modify `resetRoster()` to preserve taxonomy tables; update preview/reset UI docs | Schema migration to ensure tables exist before reset | Reset test: approved reasons/custom categories/overrides survive; operational tables empty | P0 | 9 |
| 5.2 | Reuse approved corrections | `approved_aliases` reused; `approved_reasons` fuzzy match exists | Approved corrections checked before cloud call; durable precedence | `classifier/pipeline.ts` | Document precedence, verify alias→approved-reason→rules→semantic→review order | None | New equivalent reason → approved correction reused; no duplicate review | P0 | 4 |
| 5.3 | Audit and maintain knowledge | `taxonomy_audit_log` exists; some actions not logged | Complete audit trail, inspect/edit/deactivate mappings, regression test | `db.ts`, `assessment-service.ts`, routes, Settings UI | Add missing audit triggers, build management UI, write regression test | None | Approve→reset→recollect→reuse test passes | P1 | 7 |
| 6 | Fix “Fluid taxonomy data could not be loaded” | Generic error toast in `loadTaxonomy()` | Root-cause fix; proper loading/success/error/empty states | `Settings.tsx`, `routes.ts`, `db.ts` | Trace failure paths, add state differentiation, fix underlying inconsistency | Investigation | Error does not return after restart/refresh; empty state shows “no overrides yet” | P0 | 3 |
| 7.1 | One authoritative taxonomy | Fixed `TAXONOMY` + fluid DB tables + frontend copy | Single source of truth; all consumers read from unified model | `taxonomy.ts`, `db.ts`, `routes.ts`, `Settings.tsx`, AI prompt | Consolidate into `taxonomy` table with fixed + custom rows; remove frontend constants | Schema migration | Edit category → classifier uses new value immediately | P0 | 7 |
| 7.2 | Editable taxonomy properties | Overrides, custom categories, approved reasons editable | Labels, descriptions, points, aliases, examples, thresholds editable; stable IDs | Same as 7.1 | Design edit UX, add validation, prevent ID mutation | Unified schema | Edit category label → ID unchanged → historical assessments still valid | P0 | 7 |
| 7.3 | Preserve existing business rules | Fixed in code; fluid layer incomplete | All 10 categories + examples + special cases preserved | `classifier/taxonomy.ts`, `rules.ts`, `pipeline.ts` | Audit every special case (ANYDESK vs ANYDESK_BY, TEXT_PROBLEM_SOLVED, non-scoring, donation ambiguity) | Unified taxonomy | Regression tests for each special case | P0 | 7 |
| 7.4 | Fuzziness mandatory | `editSimilarity` + fuzzy rules | Configurable thresholds, explainable matches, Arabic/Latin normalization | `classifier/normalize.ts`, `rules.ts` | Tune thresholds, add Arabic-specific normalization, add test corpus | None | Positive/negative/near-miss corpus tests pass | P1 | 7 |
| 7.5 | Safe taxonomy migration | Additive migrations only | Preserve all categories/rules/mappings; rollback plan | `db.ts` | Write migration script, backup/restore validation, rollback procedure | Unified schema design | Migration test: old DB → new schema → all categories intact | P0 | 7 |
| 8.1 | Preserve scoring/reporting contract | Implementation matches described rules | No silent drift; formula/rule changes explicit | `scoring.ts`, `reports.ts` | Diff spec vs implementation; fix any mismatches | None | Spec-compliance test suite | P0 | 8 |
| 8.1 (benchmark) | Benchmark integrity | 635 vs 628 discrepancy; daily/donation columns inconsistent | Distinguish source inputs, daily reporting, weekly donation subtotal, overall totals | Reports, exports, benchmark docs | Document discrepancy, add benchmark import with column metadata | None | Benchmark import test preserves daily + donation columns separately | P1 | 8 |
| 9 | Complete functionality audit | Partial inspection only | Full page/action/API lifecycle audit | All modules | Systematic UI+API audit, classify findings, fix defects | Full inspection | Audit report with defect/ambiguity/risk classifications | P1 | 8 |
| 10 | Security review | No formal review in this pass | Authn/z, input validation, SQL injection, SSRF, XSS, data exposure, dependency audit | All modules + `package.json` | Static analysis, dependency check, targeted tests, penetration scenarios | None | Findings report with severity, evidence, remediation, regression tests | P0 | 10 |
| 11 | Data integrity and operational safety | Transactions, savepoints, backup/restore exist | Atomic changes, idempotency, concurrency, recovery, reset safeguards | `db.ts`, `collection-service.ts`, routes | Add concurrency tests, verify reset preview matches actual deletion, add migration recovery | None | Interrupted reset test; concurrent collection+rescore test | P1 | 9 |
| 12 | Verification strategy | Unit tests exist; no cloud mock tests | Layered tests: unit, integration, E2E, quality eval, regression | `tests/` | Add cloud-mock integration tests, E2E collection-mode tests, classification quality eval | Cloud adapter | Coverage report; all gates pass | P0 | 12 |
| 13 | Implementation phases | Ad-hoc ordering in history | Dependency-aware sequence minimizing rework | All modules | Execute roadmap in order: discovery → data contracts → taxonomy repair → classification → collection → reporting → full pass → security → verification → clean roster | All above | Each phase has measurable exit criteria | P0 | 13 |
| 14 | Planning deliverables | No consolidated plan document | Complete structured plan report | `plan/architecture-and-roadmap.md` | This document | All investigation | Document complete with sections A–L | P0 | — |

---

## D. Defect and Ambiguity Register

### Confirmed Defects
1. **Date-based collection uses opened_at proxy, not closed_at.**
   - Severity: Critical
   - Evidence: `collector.ts:fetchIdsByClosedAtRange()` switches to `opened_at_proxy` mode after 2 pages without `closed_at`; `validateDateRange()` stores `dateBasis` but collector ignores it.
   - Impact: Date-filtered collection does not meet the authoritative closed-at requirement.
   - Fix: Parse bot-message embeds for close timestamps; if unavailable, surface unresolved date status and exclude from confirmed totals.

2. **`resetRoster()` clears fluid taxonomy tables.**
   - Severity: High
   - Evidence: `db.ts:resetRoster()` deletes from `reviews`, `review_history`, `assessments`, `transcript_messages`, `collection_items`, `collection_runs`, `collection_run_diagnostics`, `tickets`. It does not preserve `taxonomy_overrides`, `custom_categories`, `approved_reasons`, `taxonomy_audit_log`.
   - Impact: Manager-approved point overrides, custom categories, and approved reasons are lost on roster reset.
   - Fix: Add those tables to the preservation list; update reset preview UI.

3. **Settings taxonomy-loading error is swallowed.**
   - Severity: Medium
   - Evidence: `Settings.tsx:loadTaxonomy()` wraps 4 parallel API calls in try/catch and calls `notify('Fluid taxonomy data could not be loaded.', 'error')` for any failure.
   - Impact: Cannot distinguish network error from 404 to malformed DB from empty state.
   - Fix: Surface per-request error state; differentiate loading/success/empty/failed.

4. **Frontend date mode preview/start sends empty `start`/`end` fields.**
   - Severity: Medium
   - Evidence: `Collect.tsx` preview/start body for `collectMode !== 'id'` includes `start, end` (empty strings) alongside date fields. Backend ignores empty strings for validation, but this is semantically noisy.
   - Impact: Potential backend confusion; violates strict mode enforcement.
   - Fix: Send only mode-relevant fields.

5. **Custom category examples are dead code in classifier.**
   - Severity: Medium (fixed in prior session; verify it remains fixed)
   - Evidence: `pipeline.ts` now matches custom category examples via `editSimilarity` threshold 0.8.
   - Fix: Keep test coverage.

6. **Approved-reason API rejected custom category IDs.**
   - Severity: Medium (fixed in prior session)
   - Evidence: `routes.ts` now validates against `custom_categories` table.
   - Fix: Keep test coverage.

### Likely Problems Requiring Verification
1. **Bot-message embed timestamp parsing is unimplemented.** The collector stores embeds but never extracts close timestamps. Need to verify embed structure in current transcripts.
2. **`/api/reset/roster` returned `undefined` fields in prior session.** Needs regression test to confirm JSON shape is correct.
3. **Concurrent collection + rescore/taxonomy edit may race.** SQLite serializes writes, but in-memory state could diverge.
4. **Normalization formula ambiguity.** The agreed quartic formula exists only in a manual Python script; not in application code or docs as the canonical formula.

### Architectural Ambiguities
1. **Donation reporting vs RECHARGE category.** The benchmark has a “Donation” column; the taxonomy has `RECHARGE`. Are all `RECHARGE` tickets donations? Evidence suggests no — some recharges are support work, not donations. This needs an explicit mapping rule, not silent assumption.
2. **Normalization toggle placement.** Should it be on Staff performance page, or a global report setting? Unclear from requirements.
3. **Cloud provider selection.** No provider chosen yet. Requires deliberate decision on latency/accuracy/cost/privacy trade-off.

---

## E. Cloud Semantic-Classification Design

### Current Local Architecture (to be replaced)
- **Provider:** Ollama local runtime (`ollamaUrl` default `http://127.0.0.1:11434`).
- **Model:** Configurable, default `qwen2.5:3b`.
- **Interface:** `OllamaClient.classifyReason(rawReason, timeoutMs)` → `SemanticClassification`.
- **Output contract:** Zod-validated JSON: `{ categories, alternative_categories, unresolved_portion, review_required, explanation }`.
- **Failure modes:** `MODEL_RUNTIME_DOWN`, `MODEL_MISSING`, `MODEL_TIMEOUT`, `MODEL_INVALID_OUTPUT`.

### Recommended Direction
**Primary:** A cloud provider with a structured-output API (e.g., OpenAI-compatible `/v1/chat/completions` with `response_format: json_schema`, or equivalent). This gives:
- Low latency (no local CPU inference).
- Reliable JSON mode.
- Multilingual capability (modern models handle Arabic/Egyptian/mixed well).
- No local model disk/RAM footprint.

**Proposed default:** `gpt-4o-mini` or similar small/cheap multilingual model via OpenAI-compatible API, configured by `semanticProviderUrl` + `semanticApiKey` + `semanticModel`. The exact model name should be a setting, not a constant.

**Alternatives:**
- **Anthropic Claude:** Strong multilingual, structured output via tool use, slightly higher latency/cost.
- **Google Gemini:** Good multilingual, fast, but API shape differs.
- **Local quantized model (fallback only):** Keep Ollama path as explicit offline fallback, not default.

### API Contract (Proposed)
```
POST {semanticProviderUrl}/v1/chat/completions
Authorization: Bearer {semanticApiKey}
Content-Type: application/json

{
  "model": "{semanticModel}",
  "messages": [
    {"role": "system", "content": TAXONOMY_SYSTEM_PROMPT},
    {"role": "user", "content": "<reason>\n{normalized_reason}\n</reason>"}
  ],
  "response_format": {"type": "json_schema", "json_schema": {...}},
  "max_tokens": 300,
  "temperature": 0
}
```

**Request payload:** Only the normalized reason text (max 500 chars) + taxonomy summary (IDs + labels, not full examples). Never send full transcripts, usernames, ticket IDs, or Discord credentials.

**Response schema:**
```typescript
interface CloudSemanticResult {
  categories: Array<{ id: CategoryId; evidence: string; confidence: 'high'|'medium'|'low' }>;
  alternative_categories: Array<{ id: CategoryId; reason: string }>;
  unresolved_portion: string | null;
  review_required: boolean;
  explanation: string;
}
```

### Classification State Machine
```
[START]
    ↓
[Deterministic: alias / approved-reason / rules]
    ↓
{Has strong deterministic match?} → [RESOLVED: award + credit]
    ↓ No
{Cloud semantic enabled?} → [CLOUD SEMANTIC]
    ↓
{Valid output + categories in taxonomy?} → [HYBRID/RESOLVED]
    ↓ Invalid/timeout/error
[FALLBACK + REVIEW]
    ↓
[HUMAN REVIEW]
    ↓
{Manager corrects} → [APPROVED MAPPING] → back to deterministic for future
{Manager dismisses} → [DISMISSED]
```

**Resolution rules:**
- A valid deterministic match never waits for cloud.
- Cloud output is a suggestion only; it never overrides a manager-approved correction.
- Invalid cloud output (unknown category IDs, malformed JSON) → fallback + review, never silent award.
- Cloud timeout/rate-limit → fallback + review with explicit “semantic unavailable” reason.

### Confidence and Review-Routing Policy
- Deterministic exact: confidence 1.0, no review.
- Deterministic fuzzy: confidence 0.55–0.86, review if <0.9.
- Cloud high: 0.85, medium: 0.7, low: 0.55.
- Any result with confidence <0.6 → review.
- Disagreement between deterministic and cloud → review (already implemented).

### Caching and Idempotency
- Cache key: `sha256(normalized_reason + taxonomy_version + classifier_version)`.
- Store: `{ categories, alternatives, model, latencyMs, cachedAt }` in `semantic_cache` table.
- Cache hits skip cloud call entirely.
- Cache invalidation: taxonomy version change → global invalidation flag.

### Rate-Limit, Retry, Timeout
- Request timeout: 15s (configurable).
- Retry: 1 retry with exponential backoff (1s, 2s) on 429/5xx.
- Max concurrent cloud calls: 3 (matches existing `fetchConcurrency`).
- Circuit breaker: 5 consecutive failures → pause collection, surface “semantic unavailable” warning.

### Multilingual Evaluation Plan
- Build eval corpus: 200+ labeled reasons (English, Arabic, Egyptian, Arabizi, mixed, misspelled, compound).
- Separate tuning set from evaluation set.
- Metrics: category precision/recall, false positive rate, human-review rate, invalid-output rate, latency p95.
- Accept/reject threshold: precision ≥0.95 on eval set before production use.

### Staged Migration
1. Add cloud provider abstraction alongside Ollama.
2. Default `aiMode` remains `deterministic`; cloud only in `production` mode.
3. Shadow-evaluate cloud predictions in `shadow` mode (log only, no scoring impact).
4. Once precision target met, allow `production` mode.
5. Retain Ollama as explicit offline fallback for `deterministic + offline` mode.

---

## F. Unified TAXONOMY Design

### Current Sources of Truth (conflicting)
1. Fixed `TAXONOMY` array in `server/classifier/taxonomy.ts`.
2. `taxonomy_overrides` DB table (points only).
3. `custom_categories` DB table (full category definition).
4. `approved_reasons` DB table (fuzzy mappings).
5. Frontend `Settings.tsx` renders its own table from combined data.
6. AI system prompt in `ollama.ts` hardcodes category definitions.

### Proposed Authoritative Schema
Replace the fixed array + scattered tables with a single `taxonomy_categories` table:

```sql
CREATE TABLE taxonomy_categories (
  id TEXT PRIMARY KEY,          -- stable internal ID, never changes
  code TEXT NOT NULL,           -- display code, editable
  label TEXT NOT NULL,          -- display label, editable
  label_ar TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  points REAL NOT NULL DEFAULT 0,
  distinction TEXT NOT NULL DEFAULT '',
  examples TEXT NOT NULL DEFAULT '[]',
  negative_examples TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  is_fixed INTEGER NOT NULL DEFAULT 0,  -- 1 = built-in, 0 = custom
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**Migration:**
- Insert all 10 fixed categories with `is_fixed=1`.
- Migrate `custom_categories` rows into `taxonomy_categories` with `is_fixed=0`.
- Drop `custom_categories` table after migration.
- Keep `taxonomy_overrides` as a lightweight points-override table linked to `taxonomy_categories.id`, or merge into the main table with a `points_override` column + `points_source` enum (`fixed`/`override`). The override table is simpler for audit.

**Unified loading:**
- `taxonomy.ts` exports `loadTaxonomy(db)` that returns `Record<CategoryId, TaxonomyCategory>` from the DB, with fixed categories as fallback if DB is empty (first-run seed).
- All consumers (`pipeline.ts`, `scoring.ts`, `reports.ts`, routes, AI prompt builder) call `loadTaxonomy()`.

### Editable Properties
- **Stable IDs:** Fixed categories keep their IDs (`REPORT`, `RECHARGE`, etc.). Custom categories get UUID or prefixed IDs (`CUSTOM_...`).
- **Editable:** `code`, `label`, `label_ar`, `description`, `points` (via overrides), `examples`, `negative_examples`, `distinction`, `active`.
- **Protected:** `id`, `is_fixed`.
- **Validation:** No duplicate `code` among active categories; `points >= 0`; examples non-empty for active categories.

### Fuzzy Match Configuration
- Per-category `fuzzy_threshold` column (default 0.82) allows tuning.
- Global default in settings applies to categories without custom threshold.
- Configurable via Settings UI per category.

### Category-Reference Protection
- Historical `assessments.category_ids_json` stores category IDs.
- If a category is deactivated, existing assessments remain valid; new classification ignores inactive categories.
- If a category ID is renamed (code change only), historical data remains valid because IDs are stable.
- If a category must be deleted: mark inactive, surface dependent mappings in audit log.

### Audit Strategy
- Every taxonomy change writes to `taxonomy_audit_log`.
- `approved_reasons` and `taxonomy_overrides` changes also logged.
- Review of a mapping shows original text, normalized key, approved category, method, timestamp, reviewer.

### Compatibility
- Backfill existing `approved_reasons` and `overrides` into new schema.
- Keep `taxonomy_version` in assessments; if version mismatches, trigger `reclassifyStale()`.

---

## G. Score Normalization Specification

### Formula Recovery
The quartic formula was derived via numpy polyfit on 8 data points and exists only in `scripts/normalize-staff-totals.py`:

```
f(x) = 1.7589596259101096e-07*x^4 - 1.135218793864604e-04*x^3 + 0.01978683960927561*x^2 + 0.04435873137530282*x + 14.338943427267312
```

Zero overrides applied manually: Duilio → 3, Comment → 0.

Ceiling operation: `ceil(y)` (x+1 if decimal, x if integer).

### Recommendation
Adopt this quartic formula explicitly as the normalization function. It compresses high scores more than low scores, reducing the spread between top performers while preserving relative ordering. This matches the original goal of making the tool’s output “not sound like a tool” — introducing small, human-like non-linear compression.

### Toggle Behavior
- **Off:** Show raw awarded points (current behavior).
- **On:** Apply `normalizedPoints = ceil(f(rawPoints))` to display values only.
- **Scope:** Selected reporting period (same date filter as the report).
- **Consistency:** Charts, rankings, tables, tooltips, and exports all use the same normalized values when toggle is on.
- **Raw preservation:** `assessments.awarded_points` never changes; normalization is applied at report-render time.

### Edge Cases
- All zeros → all zeros after normalization.
- Single nonzero → formula applied to that value.
- Ties in raw → ties preserved in normalized (same input → same output).

---

## H. Data Preservation and Reset Plan

### Operational Data (cleared by reset)
- `tickets`, `transcript_messages`, `assessments`, `reviews`, `review_history`
- `collection_runs`, `collection_items`, `collection_run_diagnostics`
- Derived exports and cached reports in `data/exports/`

### Persistent Reusable Knowledge (preserved by reset)
- `settings`, `meta`
- `approved_aliases`
- `taxonomy_overrides`
- `custom_categories`
- `approved_reasons`
- `taxonomy_audit_log`
- Browser profile (`data/browser-profile/`)
- Dashboard auth state (in-memory API tokens; profile persists)

### Backup and Recovery
1. Before any future reset, create backup via `POST /api/backups`.
2. Validate backup with `Db.validateBackup()`.
3. Store backup path in reset response.
4. If backup validation fails, abort reset.
5. After reset, verify operational counts = 0 and preserved tables intact.

### Clean-Roster Separation
- Reset + fresh collection is a separate explicit execution phase.
- Only runs after functional, data-preservation, classification-quality, and security gates pass.
- Uses authoritative closed-at date basis for 17/10/26–23/10/26.
- Scope saved in run record; resume cannot apply different filter.

---

## I. Security Findings and Remediation Roadmap

### Confirmed Findings
1. **Origin guard only checks mutating requests; GET endpoints are wide open.**
   - Severity: Medium
   - Evidence: `localOriginGuard()` allows all GET/HEAD/OPTIONS without origin check.
   - Impact: Local server data can be fetched from any origin in the browser.
   - Fix: Add CORS headers restricting to localhost/127.0.0.1; for mutating requests keep origin check; for GET, same-origin is less critical but document risk.

2. **No rate limiting on API endpoints.**
   - Severity: Medium
   - Evidence: Express router has no rate-limit middleware.
   - Impact: Localhost-only exposure limits risk, but a malicious local script could spam.
   - Fix: Add express-rate-limit or similar with localhost-aware defaults.

3. **Backup restore path uses `path.basename()` + `fileInside()` check.**
   - Severity: Low
   - Evidence: `routes.ts:backups/restore` does `path.join(BACKUP_DIR, path.basename(requested))` then `fileInside(BACKUP_DIR, target)`.
   - Impact: `fileInside` rejects traversal, but `path.basename` strips directories — acceptable. Verify edge case `backup../../etc/passwd.db`.
   - Fix: Already safe; add regression test.

4. **Cloud API key exposure risk (future).**
   - Severity: High (future state)
   - Evidence: No cloud integration yet.
   - Impact: If cloud provider is integrated, API key must never reach browser or logs.
   - Fix: Store in `settings` table encrypted or at least not in frontend bundle; use server-side proxy or direct backend fetch.

5. **Transcript content in diagnostics/logs.**
   - Severity: Low
   - Evidence: `diagnostics` endpoint explicitly strips transcripts. `logExtraction` logs only metadata.
   - Impact: Good practice; verify no regression.
   - Fix: Add log-scrubbing regression test.

### Unverified Risk Areas
- **SQL injection:** All queries use prepared statements; no string concatenation with user input. Low risk.
- **Path traversal:** Backup/restore and file operations use `path.join(BACKUP_DIR, ...)` with `fileInside()` guard. Low risk.
- **XSS:** Frontend renders ticket reasons with `dir="auto"` but no explicit sanitization. React escapes by default; verify no `dangerouslySetInnerHTML`.
- **Dependency vulnerabilities:** `npm audit` not run in this session; needs execution.

---

## J. Dependency-Aware Implementation Roadmap

### Phase 1 — Discovery and Baseline (1–2 days)
1. Run `npm audit` and dependency report.
2. Build complete UI/API inventory; verify every button/action.
3. Record baseline DB counts, schema version, settings, model config.
4. Create verified backup of current operational DB.
5. Document all findings in defect register.

### Phase 2 — Core Data Contracts (2–3 days)
1. Design unified `taxonomy_categories` schema.
2. Design cloud provider abstraction interface.
3. Define classification state machine in `pipeline.ts`.
4. Define reusable-knowledge boundaries for reset.
5. Write contract tests for taxonomy loading and cloud adapter.

### Phase 3 — Taxonomy and Persistence Repair (2–3 days)
1. Fix Settings taxonomy-loading error (root-cause: generic error masking).
2. Implement unified taxonomy migration; backfill existing data.
3. Update `resetRoster()` to preserve all reusable taxonomy tables.
4. Update reset preview UI to list preserved taxonomy data.
5. Write migration rollback test.

### Phase 4 — Classification Pipeline (3–4 days)
1. Implement `CloudSemanticClient` with OpenAI-compatible interface.
2. Integrate cloud stage B into `pipeline.ts` after deterministic stage.
3. Add semantic result cache table + invalidation.
4. Add rate-limit/retry/timeout/circuit-breaker for cloud calls.
5. Implement payload redaction (no usernames, ticket IDs, transcripts).
6. Write cloud-mock integration tests.
7. Shadow-evaluate against labeled corpus; document precision/recall.

### Phase 5 — Collection Correctness (3–4 days)
1. Implement closed-at timestamp extraction from bot embeds.
2. Enforce three distinct modes in backend with strict validation.
3. Update UI to send only mode-relevant parameters.
4. Write mode-contract tests, boundary tests, resume-scope tests.
5. Update date basis documentation and UI labels.

### Phase 6 — Staff Reporting and Normalization (2 days)
1. Confirm canonical normalization formula in docs + app constants.
2. Implement toggle in Staff performance UI.
3. Apply normalization at report-render time only.
4. Write toggle edge-case tests (empty, zero, one-staff, ties).
5. Update exports to respect toggle.

### Phase 7 — Full Functionality Pass (2–3 days)
1. Systematic UI/API audit; fix discovered defects.
2. Fix placeholder/mock implementations.
3. Add missing empty/loading/error states.
4. Fix double-submission/idempotency issues.
5. Verify timezone handling across collection, reports, exports.

### Phase 8 — Security Remediation (1–2 days)
1. Add CORS headers.
2. Add rate-limit middleware.
3. Run `npm audit`; patch critical/high advisories.
4. Add security regression tests.
5. Document cloud API key handling procedure.

### Phase 9 — Verification Gates (1–2 days)
1. Run full test suite (target: ≥120 tests).
2. Run typecheck, build, lint.
3. Execute classification quality evaluation.
4. Execute data-integrity tests (reset, backup/restore, migration).
5. Execute operational tests (interrupted collection, concurrent operations).

### Phase 10 — Clean-Roster Execution (separate explicit phase)
1. Only after all gates pass.
2. Create verified backup.
3. Reset roster once.
4. Verify empty operational state + preserved reusable knowledge.
5. Collect 17/10/26–23/10/26 with authoritative closed-at basis.
6. Generate staff report + benchmark comparison.
7. Verify idempotency by re-running sync.

---

## K. Test and Acceptance Matrix

| Layer | Coverage | Exit Criteria |
|-------|----------|---------------|
| Unit | Taxonomy, rules, normalize, scoring, collection validation | ≥120 tests passing; no regressions |
| Integration | API routes, DB persistence, taxonomy CRUD, assessment flow | All mode-contract tests pass; taxonomy edit propagates to classifier |
| Cloud mock | Provider abstraction, retry, timeout, invalid output, rate-limit | Cloud failure → fallback + review; no crashes; no credential leaks |
| E2E | Collect → classify → review → correct → approve alias → reclassify → report | Full workflow passes with mock dashboard |
| Classification quality | Labeled corpus (200+ items) | Precision ≥0.95; review rate ≤5%; invalid output rate =0% |
| Data integrity | Reset, backup/restore, migration, interruption | Reset preserves reusable knowledge; backup restores exactly; interrupted run resumes correctly |
| Security | npm audit, dependency check, CORS, rate-limit, payload inspection | No critical/high advisories; no sensitive data in outbound payloads |
| Operational | Launcher port-conflict, app restart during collection | Launcher recovers; paused run resumes after restart |

---

## L. Outstanding Decisions

1. **Cloud provider and model selection**
   - Recommended default: OpenAI-compatible API with `gpt-4o-mini` or similar.
   - Alternatives: Anthropic Claude, Google Gemini.
   - Trade-off: Cost vs latency vs Arabic nuance vs API stability.
   - Consequence of postponing: Local model remains active dependency; cloud integration blocked.

2. **Normalization toggle placement**
   - Recommended: Staff performance page, above the rankings table.
   - Alternative: Global settings toggle affecting all reports/exports.
   - Trade-off: Granularity vs simplicity.
   - Consequence of postponing: Cannot implement Phase 6 without placement decision.

3. **Donation vs RECHARGE mapping**
   - Recommended: Add explicit `is_donation` boolean to taxonomy or add `DONATION` category with mapping rule from RECHARGE + evidence.
   - Alternative: Treat all RECHARGE as donations.
   - Trade-off: Accuracy vs simplicity; evidence suggests not all recharges are donations.
   - Consequence of postponing: Benchmark comparison may be misleading.

4. **Closed-at discovery mechanism**
   - Recommended: Parse bot-message embeds in stored transcripts; supplement with dashboard API if available.
   - Alternative: Continue opened_at proxy with explicit “date unverified” flag.
   - Trade-off: Accuracy vs implementation cost.
   - Consequence of postponing: Date-based collection remains non-authoritative.

---

**End of planning report. No implementation has been performed in this pass.**
