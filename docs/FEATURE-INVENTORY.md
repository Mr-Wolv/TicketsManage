# Feature Inventory (TicketsManage)

**Document ID:** FEAT-INV  
**Date:** 2026-10-25  
**Application Version:** 2.0.0  
**Status:** Based on codebase inspection

## 1. Backend Features (Server)

### Core Infrastructure
| Feature ID | Feature Name | Location | Description | Status |
|---|---|---|---|---|
| FEAT-S001 | HTTP Server (Express) | server/index.ts | Main server, static file serving, security headers | Implemented |
| FEAT-S002 | REST API Router | server/routes.ts | All API endpoints with validation | Implemented |
| FEAT-S003 | SQLite Database (node:sqlite) | server/db.ts | Schema, migrations, CRUD operations, transactions | Implemented |
| FEAT-S004 | Logger | server/logger.ts | Application logging | Implemented |
| FEAT-S005 | Configuration | server/config.ts | App settings, paths, constants | Implemented |

### Connection & Authentication
| Feature ID | Feature Name | Location | Description | Status |
|---|---|---|---|---|
| FEAT-S010 | Playwright Browser Connection | server/connection.ts | Persistent browser profile, dashboard auth | Implemented |
| FEAT-S011 | Session Management | server/connection.ts | Connect, verify, disconnect, reset profile | Implemented |
| FEAT-S012 | API Access Capture | server/connection.ts | Capture dashboard API headers/tokens (in memory) | Implemented |

### Collection
| Feature ID | Feature Name | Location | Description | Status |
|---|---|---|---|---|
| FEAT-S020 | Ticket Collector | server/collector.ts | Playwright-based extraction from dashboard | Implemented |
| FEAT-S021 | Collection Service | server/collection-service.ts | Range collection, checkpoints, pause/resume/cancel | Implemented |
| FEAT-S022 | Claim Inference | server/collector.ts | Parse "Claimed Ticket" messages, Claim buttons | Implemented |
| FEAT-S023 | Rate Limit Handling | server/collector.ts | Retry-After, backoff, cooldown, serialization | Implemented |
| FEAT-S024 | Incremental vs Full Mode | server/collection-service.ts | Reuse existing data in incremental mode | Implemented |

### Classification & Scoring
| Feature ID | Feature Name | Location | Description | Status |
|---|---|---|---|---|
| FEAT-S030 | Taxonomy | server/classifier/taxonomy.ts | Fixed 10 categories with points, Arabic labels | Implemented |
| FEAT-S031 | Normalization | server/classifier/normalize.ts | Arabic/Arabizi normalization, diacritics, digits | Implemented |
| FEAT-S032 | Rules Engine | server/classifier/rules.ts | Pattern matching, fuzzy matching, compound splitting | Implemented |
| FEAT-S033 | Classification Pipeline | server/classifier/pipeline.ts | Layered classification, fallback logic | Implemented |
| FEAT-S034 | Ollama Client | server/classifier/ollama.ts | Local model integration (offline/eval only) | Implemented |
| FEAT-S035 | Assessment Service | server/assessment-service.ts | Orchestrates classification and scoring | Implemented |
| FEAT-S036 | Scoring Engine | server/scoring.ts | Staff credit rules A-E, base points calculation | Implemented |

### Reports & Exports
| Feature ID | Feature Name | Location | Description | Status |
|---|---|---|---|---|
| FEAT-S040 | Staff Reports | server/reports.ts | Per-staff aggregates, filtering by date basis | Implemented |
| FEAT-S041 | Exports | server/exports.ts | JSON/CSV export with formula neutralization | Implemented |
| FEAT-S042 | Demo Data | server/demo.ts | Synthetic test data (excluded from real metrics) | Implemented |

## 2. Frontend Features (Web UI)

### Pages
| Feature ID | Feature Name | Location | Description | Status |
|---|---|---|---|---|
| FEAT-W001 | App Shell & Routing | web/src/App.tsx | Main navigation, routing | Implemented |
| FEAT-W002 | Overview Dashboard | web/src/pages/Overview.tsx | Summary stats, connection status, quick actions | Implemented |
| FEAT-W003 | Collect Tickets | web/src/pages/Collect.tsx | Range input, preview, start/pause/resume/cancel | Implemented |
| FEAT-W004 | Tickets Explorer | web/src/pages/Tickets.tsx | Browse tickets, filters, detail view | Implemented |
| FEAT-W005 | Staff Performance | web/src/pages/Staff.tsx | Staff reports, date filters, drill-down | Implemented |
| FEAT-W006 | Review Queue | web/src/pages/Reviews.tsx | Pending reviews, correction workflow | Implemented |
| FEAT-W007 | Settings | web/src/pages/Settings.tsx | All configuration, backups, model, connection | Implemented |

### UI Components
| Feature ID | Feature Name | Location | Description | Status |
|---|---|---|---|---|
| FEAT-W010 | Status Components | web/src/components/* | Status badges, progress indicators | Implemented |
| FEAT-W011 | Forms & Inputs | web/src/components/* | Collection forms, settings forms | Implemented |
| FEAT-W012 | Tables & Lists | web/src/components/* | Data tables, pagination | Implemented |

## 3. Database Schema Features

| Feature ID | Feature Name | Location | Description | Status |
|---|---|---|---|---|
| FEAT-DB001 | Tickets Table | server/db.ts | Core ticket metadata with all fields | Implemented |
| FEAT-DB002 | Transcript Messages | server/db.ts | Ordered messages per ticket | Implemented |
| FEAT-DB003 | Assessments | server/db.ts | Classification results, scoring, credits | Implemented |
| FEAT-DB004 | Reviews | server/db.ts | Review queue, status, resolution | Implemented |
| FEAT-DB005 | Review History | server/db.ts | Audit trail of review actions | Implemented |
| FEAT-DB006 | Approved Aliases | server/db.ts | Manager corrections reused for future classification | Implemented |
| FEAT-DB007 | Collection Runs | server/db.ts | Run tracking, checkpoints, mode (incremental/full) | Implemented |
| FEAT-DB008 | Collection Items | server/db.ts | Per-ticket status in runs | Implemented |
| FEAT-DB009 | Collection Run Diagnostics | server/db.ts | Performance metrics per run | Implemented |
| FEAT-DB010 | Settings | server/db.ts | Persistent configuration | Implemented |
| FEAT-DB011 | Meta/Schema Versioning | server/db.ts | Schema migrations (v1→v2) | Implemented |

## 4. API Endpoints

### Health & Status
- `GET /api/health` - Health check
- `GET /api/status` - Full system status
- `GET /api/taxonomy` - Category taxonomy
- `GET /api/diagnostics` - System diagnostics (sanitized)

### Connection
- `GET /api/connection` - Connection status
- `POST /api/connection/connect` - Start browser for sign-in
- `POST /api/connection/verify` - Verify authentication
- `POST /api/connection/disconnect` - Disconnect
- `POST /api/connection/reset` - Reset browser profile

### Collection
- `POST /api/collection/preview` - Preview range
- `POST /api/collection/start` - Start collection
- `POST /api/collection/pause` - Pause collection
- `POST /api/collection/resume` - Resume collection
- `POST /api/collection/cancel` - Cancel collection
- `GET /api/collection/status` - Collection status

### Tickets & Data
- `GET /api/tickets` - List tickets with filters
- `GET /api/tickets/:id` - Get ticket details
- `POST /api/tickets/:id/reassess` - Reassess ticket

### Staff & Reports
- `GET /api/staff` - Staff performance report

### Assessments
- `POST /api/assessments/rescore` - Rescore all stored assessments
- `POST /api/assessments/reclassify` - Reclassify stale assessments

### Reviews
- `GET /api/reviews` - List reviews
- `GET /api/reviews/:id` - Get review details
- `POST /api/reviews/:id/accept` - Accept review
- `POST /api/reviews/:id/correct` - Correct classification
- `POST /api/reviews/:id/dismiss` - Dismiss review
- `POST /api/reviews/:id/reassess` - Reassess from review

### Exports
- `GET /api/export/tickets` - Export tickets (JSON/CSV)
- `GET /api/export/staff` - Export staff report (JSON/CSV)
- `GET /api/export/reviews` - Export reviews (JSON/CSV)

### Settings & Model
- `GET /api/settings` - Get settings
- `PUT /api/settings` - Update settings
- `GET /api/model` - Get model status
- `POST /api/model/detect` - Detect models
- `POST /api/model/test` - Test model

### Backups
- `GET /api/backups` - List backups
- `POST /api/backups` - Create backup
- `POST /api/backups/restore` - Restore backup

### Demo
- `POST /api/demo/seed` - Seed demo data
- `POST /api/demo/clear` - Clear demo data

## 5. CLI/Batch Scripts
| Feature ID | Feature Name | Location | Description | Status |
|---|---|---|---|---|
| FEAT-CMD001 | Setup Script | Setup.bat | Install deps, Playwright Chromium | Implemented |
| FEAT-CMD002 | Launch Script | TicketsManage.bat | Start the application | Implemented |
| FEAT-CMD003 | npm scripts | package.json | dev, build, test, typecheck, eval:model | Implemented |

## 6. Features Not Found / Missing (per requirements)
| Feature ID | Feature Name | Expected Location | Status | Notes |
|---|---|---|---|---|
| MISSING-001 | Benchmark UI/CSV import for manual expected totals | UI (Staff or Settings) | Missing | Required for benchmark comparison per req 3.3 |
| MISSING-002 | Live model scoring integration | Assessment service | Intentionally disabled | Conflicts with requirement - disabled to prevent model errors |
| MISSING-003 | 9-category mode (without Recharge) | Taxonomy/config | Missing | App has 10 categories including Recharge |

**Total Features Implemented:** ~85+ features across all categories
**Missing/Conflicted:** 3 features as noted above
