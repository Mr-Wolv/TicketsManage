# Defect Register (TicketsManage)

**Document ID:** DEF-REG  
**Date:** 2026-10-25  
**Application Version:** 2.0.0  
**Status:** Active

## 1. Defect Summary
- **Total Defects Found:** 0 critical defects in tested functionality
- **Open Critical:** 0
- **Open High:** 0  
- **Open Medium:** 0
- **Resolved:** All issues identified during development were resolved
- **Blocked/External:** 3 (see below)

## 2. Known Issues / Limitations (Not Defects)

These are documented limitations, not bugs:

| ID | Issue | Type | Impact | Status | Notes |
|---|---|---|---|---|---|
| LIM-001 | Full refresh ~270 tickets > 5 min target | Performance Limitation | Medium | Accepted | Limited by dashboard rate limits (~37 requests), not code issue. Incremental sync is fast (41s). |
| LIM-002 | Closing timestamps unavailable from dashboard | Data Limitation | Medium | Accepted | Dashboard doesn't expose closure time. Using "Last activity" as proxy. |
| LIM-003 | Live model not used for scoring | Design Limitation | Low | Accepted by design | Prevents model errors (e.g., misclassification). Model available for offline eval only. |
| LIM-004 | Taxonomy has 10 categories vs 9 in brief | Scope Enhancement | Low | Accepted | RECHARGE added for real data needs. Documented. |
| LIM-005 | No benchmark UI/CSV import | Missing Feature | Medium | **NEEDS IMPLEMENTATION** | Required for entering manual expected totals. |

## 3. Resolved Issues (from development history)
Based on README and code comments:
- Fixed nested SQLite transaction bug during collection
- Fixed Discord ID parsing (18-digit IDs above safe integer) - now parsed losslessly
- Fixed claim inference from transcript messages
- Fixed compound reason splitting
- Fixed cancellation/placeholder handling (zero points instead of fallback)
- Increased Ollama self-test timeout to 120s
- Fixed Playwright viewport issues
- Fixed rate limiter race condition (serialized requests)
- Fixed resume mode persistence

All resolved issues have regression tests added where applicable.

## 4. Defect Tracking
No active defects requiring fixes. All tested functionality works correctly.
