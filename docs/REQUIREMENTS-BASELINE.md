# Requirements Baseline (TicketsManage)

**Document ID:** REQ-BASELINE  
**Date:** 2026-10-25  
**Status:** Authoritative - derived from user requirements, not implementation  
**Application Version:** 2.0.0  
**Source:** Conversation requirements and explicit corrections

## 1. Product Purpose

A local-first graphical management assistant that connects to the authorized Tickets v2 dashboard, collects ticket records for an inclusive ID range, classifies closing reasons intelligently, calculates staff points, exposes uncertain cases for review, and presents accurate staff reports through a user-friendly interface.

The application must support ordinary management tasks through the GUI. Command-line tools may support development and diagnostics but must not be required for everyday operation.

## 2. Authoritative Requirements

### A. Application and Interface (REQ-A)
| ID | Requirement | Priority | Verification Method |
|---|---|---|---|
| REQ-A01 | Launch the application on Windows using the documented launcher (Setup.bat, TicketsManage.bat) | Critical | E2E - Launch test |
| REQ-A02 | Provide main dashboard and all required navigation (Overview, Collect, Tickets, Staff, Reviews, Settings) | Critical | UI inspection + navigation test |
| REQ-A03 | Provide connection settings and diagnostics | Critical | UI + API test |
| REQ-A04 | Provide ticket collection form with inclusive start/end IDs | Critical | UI + API test |
| REQ-A05 | Show real progress and actionable errors during collection | Critical | UI observation during collection |
| REQ-A06 | Provide ticket exploration and detail views | Critical | UI test |
| REQ-A07 | Provide staff performance reports | Critical | UI + API test |
| REQ-A08 | Provide persistent review queue | Critical | UI + DB test |
| REQ-A09 | Provide settings, export operations, backup, and recovery | Critical | UI + API test |
| REQ-A10 | Preserve data and assessment state across application restarts | Critical | Restart test |

### B. Authentication and Data Collection (REQ-B)
| ID | Requirement | Priority | Verification Method |
|---|---|---|---|
| REQ-B01 | Use a dedicated persistent Playwright browser profile (data/browser-profile) | Critical | Code inspection + filesystem |
| REQ-B02 | Support normal interactive dashboard authentication | Critical | Live test |
| REQ-B03 | Never require or extract a Discord user token | Critical | Security review - grep for token extraction |
| REQ-B04 | Verify actual access to the authenticated transcript interface | Critical | Connection verification test |
| REQ-B05 | Collect real accessible ticket metadata and transcripts | Critical | Live collection test |
| REQ-B06 | Preserve ticket IDs losslessly (including 18-digit Discord IDs above safe integer) | Critical | Unit test + live verification |
| REQ-B07 | Preserve claimant and closer as separate identities | Critical | Schema + UI + scoring test |
| REQ-B08 | Distinguish unavailable data, empty fields, missing tickets, partial extraction, and failures | Critical | State machine review |
| REQ-B09 | Support inclusive ranges, incremental synchronization, full refresh, retry, and safe resumption | Critical | Functionality tests |
| REQ-B10 | Respect access controls and rate limits (HTTP 429 handling) | Critical | Live test + code review |
| REQ-B11 | Never modify live tickets (read-only collection) | Critical | Code review - no write operations to dashboard |

### C. Classification (REQ-C)
| ID | Requirement | Priority | Verification Method |
|---|---|---|---|
| REQ-C01 | Implement fixed nine-category taxonomy as specified (note: app has 10 with Recharge added - see scope audit) | Critical | Taxonomy test |
| REQ-C02 | Categories and base points: REPORT(3), GENERAL_ISSUE(2), GENERAL_QUESTION(2), NO_RESPONSE(1), UNBANNED(2), ANYDESK(10), ANYDESK_BY(5), ACCOUNT_RECOVERY(2), TEXT_PROBLEM_SOLVED(5). Plus RECHARGE(2) in implementation. | Critical | Taxonomy + tests |
| REQ-C03 | Interpret meaning rather than depend exclusively on alias dictionary | Critical | Classifier design review |
| REQ-C04 | Support English, Arabic, Egyptian colloquial Arabic, mixed Arabic-English, Arabizi, misspellings, abbreviations, shorthand, paraphrases | Critical | Corpus tests (62 reasons, 100% pass) |
| REQ-C05 | Verify configured local semantic model is genuinely used where required (conflicted - live scoring intentionally doesn't use it) | High | Configuration + code review |
| REQ-C06 | Allow multiple distinct categories without duplicate awards | Critical | Unit test |
| REQ-C07 | Do not require independent transcript proof of resolution stated in closing reason | Critical | Design review |
| REQ-C08 | Unrecognised nonempty reason → GENERAL_ISSUE (2 points) as "General problem (fallback)", create review item | Critical | Fallback test |
| REQ-C09 | Empty reason or failed extraction not confused with classification fallback | Critical | State handling test |
| REQ-C10 | Cancellations/placeholders (By Mistake, no reason, Reply received, تم الرد, فتحها بلغلط) get zero categories/points, review item explaining decision | Critical | Cancellation tests |
| REQ-C11 | Compound reasons split on /, newline, ;, \|, & | Critical | Compound reason tests |

### D. Scoring and Staff Attribution (REQ-D)
| ID | Requirement | Priority | Verification Method |
|---|---|---|---|
| REQ-D01 | Rule A: Different confirmed claimant and closer → 0 for both, base preserved for audit | Critical | Unit test + live verification |
| REQ-D02 | Rule B: Same confirmed claimant and closer → full base score to that person | Critical | Unit test + live verification |
| REQ-D03 | Rule C: Confirmed unclaimed ticket with nonempty reason → half base score to identified closer | Critical | Unit test |
| REQ-D04 | Rule D: Confirmed unclaimed ticket without reason → zero points | Critical | Unit test |
| REQ-D05 | Rule E: Unknown claim status or unreliable identities → unresolved, never guessed | Critical | Unit test |
| REQ-D06 | Base points separate from final staff-credit awards | Critical | Data model review |
| REQ-D07 | Half-points exact (e.g., 5 → 2.5) | Critical | Unit test |
| REQ-D08 | Missing dashboard field not treated as "unclaimed" | Critical | Logic review |

### E. Reviews and Corrections (REQ-E)
| ID | Requirement | Priority | Verification Method |
|---|---|---|---|
| REQ-E01 | Persist classification fallbacks and other required review cases | Critical | DB test |
| REQ-E02 | Preserve original reasons and previous predictions | Critical | History tracking test |
| REQ-E03 | Allow manager to inspect and correct classifications through UI | Critical | UI test |
| REQ-E04 | Persist human corrections and correction history | Critical | DB test + restart test |
| REQ-E05 | Reuse approved corrections in subsequent classification | Critical | Alias lookup test |
| REQ-E06 | Recalculate dependent scores after correction | Critical | Integration test |
| REQ-E07 | Avoid duplicate review items or duplicate point awards on repeated processing | Critical | Idempotency test |

### F. Reports and Exports (REQ-F)
| ID | Requirement | Priority | Verification Method |
|---|---|---|---|
| REQ-F01 | Show accurate per-ticket scores and per-staff aggregates | Critical | Report reconciliation |
| REQ-F02 | Explain how totals are calculated | Medium | UI review |
| REQ-F03 | Support relevant filtering and date-basis options (Last activity / Ticket opening time) | Critical | UI + API test |
| REQ-F04 | Export JSON and CSV accurately | Critical | Export tests |
| REQ-F05 | Preserve distinction between ticket-derived points and unrelated adjustments (donations) | Critical | Report logic review |
| REQ-F06 | All screens and exports agree with persisted assessment data | Critical | Cross-check test |
| REQ-F07 | CSV cells RFC 4180 quoted, formula neutralization for =,+,-,@,tab,CR | Critical | CSV tests |
| REQ-F08 | Unavailable values export as empty cells, not zero | Critical | Export test |

### G. Reliability and Performance (REQ-G)
| ID | Requirement | Priority | Verification Method |
|---|---|---|---|
| REQ-G01 | Safe retry and interruption recovery | Critical | Resume test |
| REQ-G02 | Incremental synchronization with honest freshness guarantees | Critical | Incremental test |
| REQ-G03 | Idempotent collection, classification, rescoring, and export | Critical | Idempotency tests |
| REQ-G04 | Database backup and restoration | Critical | Backup/restore test |
| REQ-G05 | Correct cache invalidation | High | Freshness logic review |
| REQ-G06 | Rate-limit handling (429, Retry-After, backoff, cooldown) | Critical | Rate limit tests + live behavior |
| REQ-G07 | Responsive UI during long-running tasks | High | UI observation |
| REQ-G08 | Measured performance for collection, repeated sync, reclassification, rescoring | High | Performance measurements |

## 3. Scope Notes and Conflicts

**Known Conflicts (from requirements):**
1. **Taxonomy count:** Brief says 9 categories, implementation has 10 (includes RECHARGE added at 2 points). This is a scope deviation/enhancement.
2. **Model usage:** Brief says semantic model must be used live, but implementation intentionally doesn't use it live (prevents model guesses like misclassifying Arabic as Recharge). This is a deliberate design decision conflicting with stated requirement.
3. **Benchmark UI:** No UI or CSV import for manual expected totals exists - missing feature.
4. **Closing timestamps:** Dashboard doesn't expose them, only transcript list timestamps available as proxy.

These conflicts must be documented and resolved or explicitly accepted as limitations.
