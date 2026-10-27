# TicketsManage

A local-first ticket intelligence and staff performance application. It collects ticket records, classifies closing reasons, calculates staff performance points, supports human review, and exports reports through a responsive web interface.

TicketsManage is UI-first. You launch it, sign in to the dashboard in a dedicated browser, enter an inclusive ticket-ID range, and work entirely from the local web interface. Data, the browser profile, corrections, and exports stay on this computer.

> **Start here:** [docs/USER-GUIDE.md](docs/USER-GUIDE.md) covers the complete everyday workflow — Sync vs Full refresh, staff numbers and ID ranges, exports, backups, resets, and troubleshooting.
>
> **Status:** the application, storage, collection pipeline, scoring, review workflow, reports, exports, and tests are implemented. The final QA campaign is recorded in [docs/QA-REPORT.md](docs/QA-REPORT.md), the live 7474–7747 comparison is in [docs/BENCHMARK-7474-7747.md](docs/BENCHMARK-7474-7747.md), and measured collection performance is in [docs/PERFORMANCE.md](docs/PERFORMANCE.md). Live collection has been exercised against the real Tickets dashboard for **7770–7778** (8 tickets with transcripts, 1 ID genuinely not found) and **7474–7747** (272 collected, 2 genuinely not found, 0 failures). Live classification is **deterministic**: known wording and compound reasons are scored immediately, cancellations receive zero, and unfamiliar wording receives an explicit **General problem (fallback)** and a review item. The local Ollama model is installed and self-tested, but it **does not score live tickets**; it is retained for offline evaluation only.

---

## Quick start (Windows)

Requirements: Windows 10/11, Node.js 24 LTS recommended (22.13+ also works), and internet access for the one-time install. Setup checks for the built-in `node:sqlite` module. Ollama is optional and is used only by the model self-test and the offline evaluation command; it is not needed to collect, classify, review, or report.

1. Double-click **[Setup.bat](Setup.bat)** once. It installs dependencies, installs the Playwright Chromium browser used for the dedicated profile, and builds the interface.
2. Double-click **[TicketsManage.bat](TicketsManage.bat)**. The application starts at <http://127.0.0.1:5178> and opens your default browser.

Manual equivalent:

```bash
npm run setup          # npm install + Playwright Chromium
npm run build:web      # build the local interface
npm start              # http://127.0.0.1:5178
```

If port 5178 is occupied, run `set PORT=5179&& npm start` (or close the other instance). The application binds to `127.0.0.1` only.

---

## First use

### 1. Connect the dashboard

1. Open **Overview → Connect to Tickets dashboard** (or **Settings → Connection**).
2. A dedicated Chromium window opens with the Tickets dashboard.
3. Complete the normal Discord/Tickets sign-in there, including any verification.
4. Return to TicketsManage and select **Verify connection**.

TicketsManage never asks for, reads, or stores a Discord token or password. It drives the dashboard's own Transcripts page and reads the data the page itself loads. The persistent browser profile lives in `data/browser-profile` and is excluded from version control.

### 2. Choose a small test range

On **Collect tickets**, enter a start and end ticket ID. The preview shows the inclusive count and warns above 200 IDs. Start with a small range that you know exists in the dashboard. Collection is read-only: it never claims, closes, edits, labels, or messages a ticket.

Progress is checkpointed per ticket. **Pause**, **Cancel**, and **Resume** are available, and a run interrupted by shutdown can be resumed after restart. Missing tickets, missing transcripts, restricted transcripts, and extraction failures are recorded as distinct states — never invented.

### 3. Classification and the optional local model

Live classification is deterministic and runs in this order:

1. approved manager corrections for the same exact wording;
2. exact and fuzzy multilingual rules, including compound reasons split on `/`, newline, `;`, `|`, and `&`;
3. an explicit, reviewable **General problem (fallback)** when no confident match exists.

A model guess never assigns points. If a closing reason is unfamiliar, the ticket receives the fallback with a plain explanation — *“I could not confidently classify this closing reason. I applied the General problem fallback (General Issue, 2 base points) and sent the ticket to Review.”* — and appears in the review queue. Correcting it once teaches the exact wording for future runs. Cancellations and placeholders such as “By Mistake”, “no reason”, “Reply received”, and “تم الرد” are not foreign support reasons: they receive **zero categories and zero points**, with a review item explaining the decision, rather than the fallback award.

The local Ollama integration remains available for offline evaluation and the built-in self-test. Install [Ollama](https://ollama.com/download) only if you want to use those tools:

```bash
ollama pull qwen2.5:3b
```

In **Settings → Local semantic model (offline evaluation)**, select the model and use **Detect models** / **Run classifier self-test**. The default is `qwen2.5:3b` (about 2 GB, comfortable on 8 GB RAM). Cloud-hosted Ollama models are deliberately rejected so ticket text never leaves the machine. The full model corpus has not been run because this CPU needs roughly 13–54 seconds per call; no hybrid accuracy is claimed. The self-test allows 120 seconds so a cold model is not reported as a timeout.

### 4. Review and correct

**Review queue** contains fallbacks, low-confidence results, unresolved staff attribution, and missing data. Open an item to:

- inspect the original unmodified closing reason, transcript, evidence, and alternatives;
- select the correct fixed categories;
- optionally approve the exact wording as a reusable example for future classifications;
- reassess, accept, or dismiss the item.

Corrections are stored in SQLite, appear in the correction history, and survive restart. Reassessment does not duplicate points, messages, or records. Full instructions, including staff-number retrieval and resets, are in [docs/USER-GUIDE.md](docs/USER-GUIDE.md).

### 5. Reports and exports

- **Staff performance** shows base points, staff-credit outcomes, category breakdowns, ratings, and ticket drill-downs. Filter by **ticket ID start/end** to scope the report to a collected range. **Rescore stored results** and **Reclassify outdated** run without reopening the dashboard.
- **Ticket explorer** filters by staff, category, fallback, review status, collection status, and ticket ID range. Enter a start and end ID and it also lists the IDs in that inclusive interval that have **no local record**, each tagged **Not collected**, with a count of how many of the interval's IDs are collected and an explicit empty state when there are none, none are collected, or the interval itself is unusable. These markers are derived from the local collection: an ID they flag may still exist on the dashboard, so the wording never claims a ticket does not exist. They are presentation only — no ticket, assessment, review or score is created for a gap.
- The missing-ID report covers intervals of up to **10,000 IDs** in one request. A wider interval is refused with a readable explanation instead of a silently empty list, and at most the first 200 markers are drawn at once (with a note pointing to the rest) so a wide interval cannot flood the page.
- **Export JSON** and **Export CSV** write to `data/exports`. CSV cells are RFC 4180 quoted and text beginning with `=`, `+`, `-`, `@`, tab, or carriage return is neutralised against spreadsheet formulas. Unavailable values export as empty cells, not zero.

---

## Categories and points

The taxonomy is fixed. Live classifications come from approved corrections and deterministic rules, with a visible fallback for unknown wording; no model output supplies live categories or points. Points always come from this table.

| Category | Arabic | Base points |
|---|---|---:|
| Report | بلاغ | 3 |
| General Issue | مشكلة عامة | 2 |
| General Question | سؤال عام | 2 |
| No Response | لا يوجد رد | 1 |
| Unbanned | إلغاء الحظر | 2 |
| AnyDesk | أني ديسك | 10 |
| AnyDesk By | أني ديسك بواسطة موظف | 5 |
| Acc-Recovery | استعادة الحساب | 2 |
| Problem solved through text | تم حل المشكلة بالكتابة | 5 |
| **Recharge** | **شحن** | **2** |

Notes:

- **Recharge** covers a completed recharge/top-up (in-game currency, credit, account balance). A player merely *asking* how to recharge is a General Question, not Recharge. Arabic, Egyptian Arabic, and Arabizi variants are included in the deterministic alias rules.
- A reason may contain multiple distinct purposes; each distinct category is awarded once. Duplicate categories never double-score.
- `ANYDESK` and `ANYDESK_BY` are mutually exclusive; any remaining overlap is reconciled and flagged.
- The fallback is displayed as **General problem (fallback)** but uses the existing General Issue category worth 2 base points. It is always reviewable.

## Staff-credit rules

Base points describe the ticket. Staff-credit describes what a person is awarded.

| Rule | Situation | Staff award |
|---|---|---|
| A | Confirmed claimant and closer are different people | **0 for both**; base preserved for audit |
| B | Same confirmed person claimed and closed | Full base |
| C | Confirmed unclaimed, nonempty closing reason | Half base to the identified closer |
| D | Confirmed unclaimed, empty closing reason | 0 |
| E | Claimant/closer/reason cannot be established reliably | **Unresolved**, never guessed |

A missing dashboard field is not treated as “unclaimed”. Half-points are exact (for example, 5 → 2.5). Unavailable information is shown as unavailable, never as a genuine zero.

---

## Architecture

```
server/
  index.ts                 HTTP server, security headers, static UI
  routes.ts                Local REST API, validation, exports, backups
  db.ts                    SQLite schema, migrations, repositories, backup/restore
  connection.ts            Playwright profile, sign-in, connection verification
  collector.ts             Read-only dashboard extraction via the Transcripts UI
  collection-service.ts    Inclusive range runs, checkpoints, pause/resume/cancel
  classifier/
    taxonomy.ts            Fixed categories, Arabic labels, points, examples
    normalize.ts           Arabic/Arabizi normalisation, negation, fuzzy similarity
    rules.ts               Exact, phrase and typo-tolerant matching
    ollama.ts              Local model adapter for self-test/offline evaluation
    pipeline.ts            Deterministic layering, explicit fallback, review reasons
  scoring.ts               Base score and the five staff-credit rules
  assessment-service.ts    Persistence of classification, credit and reviews
  reports.ts, exports.ts   Staff aggregation and safe JSON/CSV exports
  demo.ts                  Clearly separated synthetic records
web/                       React management interface
tests/                     Unit and integration tests
eval/                      Labeled multilingual classification corpus
scripts/evaluate-model.ts  Offline corpus evaluation (rules or local model)
data/                      Created at runtime: database, profile, exports, logs, backups
```

SQLite is Node's built-in `node:sqlite`; there is no native module to compile. The database uses WAL mode, foreign keys, and a single row per ticket.

### Security and privacy

- Binds to `127.0.0.1`; no LAN exposure.
- Every `/api` request must carry a loopback `Host` header. A public hostname that resolves to `127.0.0.1` (DNS rebinding) is refused with `403 HOST_NOT_ALLOWED`, reads included.
- State-changing requests must not carry a cross-site origin; `Origin: null` (sandboxed iframe, `data:` URL) is refused as well. Requests with no Origin header at all are still accepted, so local scripts and the packaged launcher keep working.
- `POST /api/settings` accepts only the declared runtime type of each setting: `"false"`, `[]`, `{}` and numeric strings are rejected with `400 INVALID_SETTINGS_TYPE` instead of being coerced. A blank, omitted or non-string cloud API key means "leave the stored key unchanged"; removing the credential is a deliberate action (`clearCloudApiKey: true`, the **Remove stored key** button in Settings).
- The cloud destination is pinned to OpenRouter (`https://openrouter.ai/api/v1`). The endpoint is validated when settings are saved and again at the point of use, so the stored API key is never attached to a request aimed at another host, even if a settings row was written outside the API.
- Cloud/AI provider responses are untrusted input: category IDs are checked against the taxonomy, duplicates are collapsed, and confidence, evidence and text fields are bounded before anything is stored. A response that invents categories is discarded and the ticket stays in Review. Ticket text is serialised as JSON in the prompt, so a reason containing `</reason>` or a forged header cannot leave the untrusted-data boundary.
- CSP, `nosniff`, `DENY` framing, `no-referrer`, `same-origin` resource policy, and `no-store` on API responses. CORS echoes the caller's origin only when that origin is loopback, so no malformed `Access-Control-Allow-Origin` value is ever sent.
- Malformed and oversized request bodies are reported as `400 INVALID_REQUEST_BODY` / `413 BODY_TOO_LARGE`; the rejected body is never written to the log.
- During offline evaluation, ticket text is treated as untrusted data in the model prompt and the model's output is schema-validated. Live tickets are never sent to the model.
- No Discord token or password is extracted, logged, or stored. The persistent Chromium profile is the session.
- Only the local Ollama endpoint is used; cloud model tags are rejected.
- Collection is read-only. No ticket action is ever performed through Discord.

### REST API (local only)

`GET /api/health`, `/api/taxonomy`, `/api/connection`, `/api/collection/status`, `/api/tickets`, `/api/tickets/missing-ids?start=&end=`, `/api/tickets/:id`, `/api/staff`, `/api/reviews`, `/api/settings`, `/api/backups`, `/api/export/*`.

State-changing routes include `/api/connection/*`, `/api/collection/*`, `/api/reviews/:id/*`, `/api/demo/*`, `/api/settings`, `/api/backups/*`, and `/api/classifier/test`.

---

## Verification status

Implemented and locally verified:

- TypeScript server and web typechecks.
- Production UI build.
- **204 automated tests in 16 files** across taxonomy, scoring, classifier, collector parsing, claim inference, CSV, range validation, SQLite persistence, review lifecycle, end-to-end assessment, and the missing-ID interval report.
- The missing-ID report is covered by `tests/missing-ids.test.ts` (14 tests) against the real app over HTTP: fully collected intervals, internal gaps, missing boundaries, an empty collection, single-ID intervals, sparse and noncontiguous IDs, inclusive boundaries, numeric (never lexicographic) ordering, IDs beyond `Number.MAX_SAFE_INTEGER` staying exact, real/demo scoping, malformed and reversed intervals, an oversized interval, and the guarantee that computing the report writes no ticket, assessment, review or run.
- An adversarial suite (`tests/adversarial.test.ts`, 50 tests) attacks the application's own trust boundaries: non-loopback `Host` and `Origin: null` requests, malformed and oversized bodies, settings type confusion (`"false"` for a boolean, `null` for the API key, prototype-sensitive keys), credential lifecycle, a stored cloud endpoint aimed at another host, prompt-injection text containing closing delimiters, non-numeric and negative paging values, `LIKE` wildcards in search, provider responses that invent category IDs or return 200 KB of junk, review items whose staff attribution is still unresolved, unsupported export formats, and exports of records holding an unknown category ID.
- Rules-only corpus: **62 reasons**, 55 with scored labels, 7 expected fallbacks. All 55 exact category sets matched, micro precision/recall/F1 100%, and all 7 expected fallbacks were produced. The corpus includes Arabic, Egyptian Arabic, Arabizi, English, multi-label reasons, negations, staff-failure distractors, Recharge positives/negatives, and a foreign staff-application reason that must fall back.
- **Live dashboard collection** against the real Tickets dashboard on 2026-10-24, range **7770–7778**: 9 requested, **8 collected with transcripts**, **1 not found** (#7774), **0 failures**. Pause/resume was not needed in that run; checkpoints and retries are covered by tests.
- **Final benchmark closure** on 2026-10-25: the 7474–7747 range was extended with **174/174** tickets from **7300–7473** to capture tickets opened before 7474 but active during 17–23 October. The expanded activity window contains **275 tickets** and **606.5 points**. The 18 added tickets are worth **35.5 points**; they move Xmax to **66.5 vs 67** manual and Sheroo to **36 vs 38**, but push Henry to **330.5 vs 319**. See [docs/FINAL-ACCEPTANCE.md](docs/FINAL-ACCEPTANCE.md) and [docs/BENCHMARK-7474-7747.md](docs/BENCHMARK-7474-7747.md).
- Live attribution was fixed and exercised: the dashboard sends Discord IDs as JSON numbers above JavaScript's safe-integer limit. IDs are now parsed losslessly, so closer `752978053101256744` remains exact instead of being rounded to `...700`. Claimants are read from the transcript's own “Claimed Ticket” control message. All 8 live tickets resolved to the same confirmed claimant and closer, so staff credit is awarded instead of showing “unresolved”.
- Live fallback behaviour verified: #7778 (`تقديم اداره`) originally received a wrong model guess of Recharge in an earlier run. With deterministic live classification it now produces **General problem (fallback)**, model `null`, with the explanation quoted above, and stays in Review. #7776 (`tmam`) also falls back visibly. #7773 (`general issues no respond`) is now classified as **General Issue + No Response (3 points)** and remains in Review only for the fuzzy-match flag. The other live reviews were auto-resolved after their attribution reasons disappeared.
- UI exercised against both real and demo data, including the Recharge category (Arabic reason → Recharge, 2 base, 2 awarded), fallback explanations, claimant/closer display, and the review/correction workflow. After classifier 2.1.0 reassessment and a restart, the old 8-ticket range shows **19 points** (`b932` 15 / 6 tickets, `_jr5` 2 / 1, `duilio_` 2 / 1), **2 fallback items** (#7776, #7778), and **3 pending reviews** (#7773 fuzzy match, #7776, #7778).
- Backup creation, validation, and restore exercised by an integration test; CSV/JSON exports and foreign-Origin rejection were exercised through the running app.
- `TicketsManage.bat` was executed end to end and served `/api/health` on port 5178.
- Local model installed (`qwen2.5:3b`, 1.9 GB) and its built-in self-test returned a valid schema and category. During QA a cold run hit the former 60-second cap; loaded runs completed in **53.9 s** and **61.1 s** and returned a valid category. The self-test cap is now 120 s. The full hybrid corpus evaluation was stopped because that latency is not usable in a live workflow; no hybrid accuracy is claimed.

**Performance (measured 2026-10-25):** a repeated 274-ID Sync completed in **41 s** at the safe 2,000 ms spacing (272 reused, zero transcript reads); at 1,000 ms the same sync took 24.2 s, but the earlier 1,000 ms Full refresh hit HTTP 429 after 37 requests. A 174-ticket expanded run with transcripts completed in **6 min 26 s** with **zero rate-limit pauses**. Rescoring 417 stored assessments took **0.6 s** and changed **0 awards**. The five-minute full-refresh target for ~270 tickets is not met: the dashboard's observed budget is about 37 requests per window. The 429 limiter is now serialized, honours `Retry-After`, and pauses safely after one cooldown retry. Details: [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

**Staff day windows:** the dashboard exposes no closing timestamp. Reports default to **Last activity**, the final transcript message timestamp, which matches manual day columns far better than opening time; **Ticket opening time** remains selectable. Plain dates are interpreted in local time. See [docs/USER-GUIDE.md](docs/USER-GUIDE.md#4-get-staff-numbers).

Not yet covered:

1. **A full ~270-ticket Full refresh inside five minutes.** The expanded 174-ticket run took 6 min 26 s at safe spacing; the dashboard budget, not the collector, is the limit. Repeated Sync is fast.
2. **A manager-approved semantic sample.** The local model and runtime are verified, but live scoring intentionally never calls the model. A bounded hybrid sample of three real reasons passed a smoke test; general semantic accuracy is not claimed.
3. **Ancient tickets below ID 7300.** Coverage is proven from #7392 upward and bounded below by #7300; a larger historical scan was not authorized.

Final acceptance matrix and blockers: [docs/FINAL-ACCEPTANCE.md](docs/FINAL-ACCEPTANCE.md).

---

## Backup and recovery

See **[docs/BACKUP-AND-RECOVERY.md](docs/BACKUP-AND-RECOVERY.md)**. In short:

- **Settings → Backups → Create backup** writes a consistent `VACUUM INTO` snapshot under `data/backups`.
- Restore validates that the file is a real TicketsManage database, writes a safety copy of the current database first, and refuses invalid files.
- For a manual cold backup, close the application and copy the whole `data` directory.
- To reset the dashboard session, close the application and delete `data/browser-profile`; tickets and corrections are unaffected.

## Development

```bash
npm run typecheck
npm test
npm run build
npm run dev:web      # Vite UI at http://127.0.0.1:5173, proxies /api to 5178
npm run dev:server   # API with watch mode
```

`npm run eval:model -- --rules-only` evaluates the deterministic stages used by live classification. Add `--model <name>` to force the local model over every corpus row for an offline latency/accuracy measurement. This does not change how live tickets are scored. Reports are written to `data/eval/`.

## Troubleshooting

| Symptom | Resolution |
|---|---|
| Port already in use | Close the other instance or `set PORT=5179&& npm start` |
| “The interface has not been built” | Run `npm run build:web` |
| Connect opens but never verifies | Complete sign-in in the dedicated window, then select Verify; check `data/logs` |
| Discord Authorize button is cut off or the window will not resize | This was caused by a fixed Playwright viewport. Close the dedicated browser and TicketsManage completely, relaunch, and select Connect again. The window now opens maximized through CDP and uses a real resizable viewport; OAuth popups are also maximized. |
| Session expired | **Reconnect** in Settings; sign in again in the dedicated window |
| “Model Missing” (only needed for self-test/offline evaluation) | `ollama pull qwen2.5:3b`, then Detect models in Settings |
| Ollama unreachable (only affects self-test/offline evaluation) | Start Ollama (`ollama serve`) or install it. Live collection and classification do not use it. |
| Collection says not found | The ID does not exist or is outside this dashboard/guild |
| `RATE_LIMITED` | Wait 1–2 minutes, keep request delay at **2,000 ms**, then Resume |
| Staff totals differ from a hand sheet | Check date basis, local window, donations (not scored), Rule A conflicts, unresolved attribution, and whether older active tickets are outside the ID range |
| CSV opens with formula text | That is intentional protection; the leading apostrophe prevents execution |

### Mobile access scope

The interface uses responsive CSS breakpoints (desktop, tablet, mobile) and is usable on small screens.

However, this release does **not** support a phone connecting to the running instance from another device. The server binds to `127.0.0.1` only. A phone cannot reach `127.0.0.1` on the host machine, and the dashboard/OAuth flow is not configured for non-local callbacks.

A phone can access the interface only if you run the application on the phone itself (for example, via a local Node environment on that device).

Do not delete `data/ticketsmanage.db` while the application is running. Use the UI backup/restore or close the application first.
