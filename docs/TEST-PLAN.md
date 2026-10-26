# Test Plan (TicketsManage)

**Document ID:** TEST-PLAN  
**Date:** 2026-10-25  
**Application Version:** 2.0.0  
**Status:** Active

## 1. Test Objectives
1. Verify all in-scope requirements are implemented correctly
2. Validate the application meets management workflow needs
3. Ensure reliability, idempotency, and data integrity
4. Verify live dashboard integration works correctly
5. Identify and document any defects or gaps

## 2. Test Levels

### 2.1 Unit Tests (Automated)
**Location:** tests/*.test.ts  
**Status:** 109/109 passing

| Test Suite | Tests | Coverage | Status |
|---|---|---|---|
| taxonomy.test.ts | 7 | Taxonomy structure, points, uniqueness | PASS |
| scoring.test.ts | 15 | Staff credit rules A-E, base points, half-points | PASS |
| classifier.test.ts | 48 | Normalization, classification, fallbacks, compound reasons, cancellations | PASS |
| collector.test.ts | 8 | ID parsing, rate limits, claim inference | PASS |
| range.test.ts | 9 | Range validation | PASS |
| csv.test.ts | 6 | CSV formatting, formula neutralization | PASS |
| persistence.test.ts | 16 | SQLite operations, transactions, backup/restore, assessments | PASS |

### 2.2 Integration Tests
| Test ID | Test Case | Preconditions | Steps | Expected Result | Priority |
|---|---|---|---|---|---|
| INT-001 | Backup and restore | DB with data | Create backup, modify DB, restore | Data restored correctly | Critical |
| INT-002 | Assessment end-to-end | Ticket in DB | Run assessTicket | Categories, scores, review created correctly | Critical |
| INT-003 | Review correction workflow | Ticket with review | Correct classification, approve alias | Assessment updated, review resolved/updated, history added | Critical |
| INT-004 | Rescore all | Assessments exist | Run rescoreAll | Scores recalculated without reclassification | Critical |
| INT-005 | Reclassify stale | Old assessments | Run reclassifyStale | Only stale updated, human corrections preserved | Critical |

### 2.3 Live Integration Tests
| Test ID | Test Case | Preconditions | Steps | Expected Result | Priority |
|---|---|---|---|---|---|
| LIVE-001 | Dashboard connection | Browser profile exists | Connect and verify | Authenticated state | Critical |
| LIVE-002 | Small range collection | Connected | Collect 7770-7778 | 8 collected, 1 not found, correct data | Critical |
| LIVE-003 | Large range collection | Connected | Collect 7474-7747 | 272 collected with transcripts | Critical |
| LIVE-004 | Rate limit handling | Connected | Trigger 429 scenario | Proper backoff, no data loss | Critical |
| LIVE-005 | Claim/closer extraction | Connected | Verify same/different person cases | Correct staff attribution | Critical |

### 2.4 End-to-End UI Tests
| Test ID | Test Case | Preconditions | Steps | Expected Result | Priority |
|---|---|---|---|---|---|
| E2E-001 | Full workflow | Fresh start | Launch → connect → collect → review → export | All steps work | Critical |
| E2E-002 | Restart persistence | Data exists | Restart app | All data, reviews, corrections persist | Critical |
| E2E-003 | Review correction via UI | Pending review | Open review, correct, save | Updated in UI and DB | Critical |
| E2E-004 | Export from UI | Data exists | Export JSON and CSV | Files downloaded correctly | Critical |
| E2E-005 | Staff report accuracy | Data exists | View staff report | Matches DB calculations | Critical |

### 2.5 Reliability & Recovery Tests
| Test ID | Test Case | Preconditions | Steps | Expected Result | Priority |
|---|---|---|---|---|---|
| REL-001 | Idempotent collection | Data collected | Collect same range again | No duplicates | Critical |
| REL-002 | Pause and resume | Collection running | Pause, restart app, resume | Continues from checkpoint | Critical |
| REL-003 | Transaction rollback | DB open | Simulate failure in transaction | Rollback works correctly | Critical |
| REL-004 | Invalid backup restore | Backup exists | Try invalid restore | Rejected with error | Critical |
| REL-005 | Orphan data handling | Data exists | Various edge cases | No crashes, handled gracefully | High |

## 3. Test Execution Strategy
1. Run automated unit tests first: `npm test`
2. Run type checks: `npm run typecheck`
3. Run build: `npm run build`
4. Perform manual UI testing
5. Perform live integration tests if dashboard accessible
6. Document all results

## 4. Acceptance Criteria
- All 109 unit tests pass
- TypeScript compiles with no errors
- Production build succeeds
- All critical requirements verified
- No unresolved critical defects
- Documentation complete
