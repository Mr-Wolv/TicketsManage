export type CategoryId =
  | 'REPORT'
  | 'GENERAL_ISSUE'
  | 'GENERAL_QUESTION'
  | 'NO_RESPONSE'
  | 'UNBANNED'
  | 'ANYDESK'
  | 'ANYDESK_BY'
  | 'ACCOUNT_RECOVERY'
  | 'TEXT_PROBLEM_SOLVED'
  | 'RECHARGE';

export interface TaxonomyCategory {
  id: string;
  code: string;
  label: string;
  labelAr: string;
  points: number;
  description: string;
  distinction?: string;
  examples: string[];
  isCustom?: boolean;
}

export interface ApprovedReason {
  id: number;
  text: string;
  normalizedText: string;
  categoryId: string;
  sourceType: string;
  sourceTicketId: string | null;
  active: number;
  createdAt: string;
}

export interface TaxonomyOverride {
  categoryId: string;
  points: number;
  note: string;
  changedAt: string;
}

export interface CustomCategory {
  id: string;
  code: string;
  label: string;
  labelAr: string;
  description: string;
  points: number;
  distinction: string;
  examples: string[];
  negativeExamples: string[];
  active: number;
  createdAt: string;
}

export interface TaxonomyAuditEntry {
  id: number;
  action: string;
  entityType: string;
  entityId: string;
  oldValue: string | null;
  newValue: string | null;
  note: string;
  changedAt: string;
}

export interface CategoryAssessment {
  categoryId: CategoryId;
  points: number;
  evidence: string[];
  method: string;
  confidence: number | null;
}

export interface AlternativeCategory {
  categoryId: CategoryId;
  reason: string;
  source: string;
}

export interface Assessment {
  ticketId: string;
  originalReason: string | null;
  categories: CategoryAssessment[];
  basePoints: number;
  fallback: boolean;
  method: string;
  confidence: number | null;
  explanation: string;
  alternatives: AlternativeCategory[];
  reviewReasons: string[];
  unresolvedPortion: string | null;
  creditRule: string;
  creditStatus: string;
  creditStaffId: string | null;
  creditStaffName: string | null;
  awardedPoints: number | null;
  creditExplanation: string;
  model: string | null;
  taxonomyVersion: string;
  classifierVersion: string;
  humanCorrected: boolean;
  assessedAt: string;
}

export interface ReviewInfo {
  ticketId: string;
  status: string;
  reasons: string[];
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
}

export interface TranscriptMessage {
  seq: number;
  messageId: string | null;
  authorName: string | null;
  authorId: string | null;
  timestamp: string | null;
  content: string;
  embeds: unknown[];
  attachments: unknown[];
}

export interface Ticket {
  ticketId: string;
  openerUsername: string | null;
  openerUserId: string | null;
  openedAt: string | null;
  openedAtSource: string | null;
  claimedByName: string | null;
  claimedById: string | null;
  claimedState: 'present' | 'unclaimed' | 'unavailable';
  closedByName: string | null;
  closedById: string | null;
  closedState: 'present' | 'unclaimed' | 'unavailable';
  closedAt: string | null;
  closedAtSource: string | null;
  closeReason: string | null;
  closeReasonState: 'present' | 'empty' | 'unavailable';
  rating: number | null;
  ratingState: string;
  ticketUrl: string | null;
  transcriptState: string;
  labels: string[];
  collectionStatus: string;
  collectionError: string | null;
  collectedAt: string;
  updatedAt: string;
  isDemo: boolean;
  messageCount: number;
  lastActivityAt: string | null;
  messages: TranscriptMessage[];
  assessment: Assessment | null;
  review: ReviewInfo | null;
  rawFieldNames: string[];
}

export interface ConnectionStatus {
  state: string;
  message: string;
  browserOpen: boolean;
  profileExists: boolean;
  lastVerifiedAt: string | null;
  lastError: string | null;
  dashboardUrl: string;
  observedUrl: string | null;
}

export interface ModelStatus {
  running: boolean;
  version: string | null;
  baseUrl: string;
  selectedModel: string;
  selectedInstalled: boolean;
  models: Array<{
    name: string;
    size: number;
    parameterSize: string | null;
    quantization: string | null;
    remote: boolean;
  }>;
  localModels: string[];
  error: string | null;
}

export interface Overview {
  totalTickets: number;
  demoTickets: number;
  waitingForClassification: number;
  classified: number;
  reviewPending: number;
  fallbackCount: number;
  unresolvedCredit: number;
  awardedPoints: number;
  lastCollectionAt: string | null;
  latestRun: Run | null;
}

export interface Run {
  id: string;
  startId: string;
  endId: string;
  mode: 'incremental' | 'full';
  status: string;
  requestedCount: number;
  processed: number;
  collected: number;
  partial: number;
  noTranscript: number;
  notFound: number;
  failed: number;
  classified: number;
  fallbacks: number;
  classificationEnabled: boolean;
  stage: string;
  currentTicketId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string;
  finishedAt: string | null;
  lastUpdatedAt: string;
}

export interface SetupStep {
  id: string;
  label: string;
  ready: boolean;
  detail: string;
}

export interface StatusSnapshot {
  appVersion: string;
  taxonomyVersion: string;
  classifierVersion: string;
  overview: Overview;
  demoOverview: Overview;
  connection: ConnectionStatus;
  model: ModelStatus;
  collectionCounts: Record<string, number>;
  reviewCounts: Record<string, number>;
  setup: SetupStep[];
  settings: {
    model: string;
    semanticEnabled: boolean;
    classificationEnabled: boolean;
    dashboardUrl: string;
    guildId: string;
    autoReuseSession: boolean;
  };
  latestRun: Run | null;
  runs: Run[];
}

export interface RangePreview {
  ok: boolean;
  error?: string;
  startId?: string;
  endId?: string;
  count?: number;
  estimatedRequests?: number;
  large?: boolean;
  requiresConfirmation?: boolean;
  warnings?: string[];
  plan?: string;
  connection: ConnectionStatus;
}

export interface RunDiagnostics {
  mode: 'incremental' | 'full';
  timings: Record<string, number>;
  counts: {
    reused: number;
    fetchedTranscripts: number;
    directRequests: number;
    navigationRequests: number;
    listingPages: number;
    modelCalls: number;
    retries: number;
    failures: number;
    notFound: number;
  };
  perTicket: { count: number; averageMs: number; medianMs: number; p95Ms: number; maxMs: number };
  notes: string[];
  updatedAt: string;
}

export interface CollectionStatusResponse {
  run: Run | null;
  active: boolean;
  connection: ConnectionStatus;
  recentItems: Array<{
    ticketId: string;
    state: string;
    error: string | null;
    updatedAt: string;
    opener: string | null;
    reason: string | null;
    reasonState: string;
    categories: CategoryId[];
    fallback: boolean;
    basePoints: number | null;
    awardedPoints: number | null;
    creditStatus: string | null;
    reviewStatus: string | null;
  }>;
  counts: Record<string, number>;
  latestRun: Run | null;
  diagnostics: RunDiagnostics | null;
}

export interface ReviewItem {
  ticketId: string;
  status: string;
  reasons: string[];
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  originalCloseReason: string | null;
  closeReasonState: string;
  categories: CategoryAssessment[];
  basePoints: number;
  fallback: boolean;
  method: string;
  explanation: string;
  alternatives: AlternativeCategory[];
  assessment: Assessment | null;
  credit: {
    rule: string;
    status: string;
    staffId: string | null;
    staffName: string | null;
    awardedPoints: number | null;
    explanation: string;
  } | null;
  claimedBy: { name: string | null; id: string | null; state: string };
  closedBy: { name: string | null; id: string | null; state: string };
  opener: string | null;
  rating: number | null;
  transcriptState: string;
  sourceUrl: string | null;
  isDemo: boolean;
  review: ReviewInfo;
}

export interface StaffCategory {
  categoryId: CategoryId;
  code: string;
  label: string;
  points: number;
  tickets: number;
}

export interface StaffRow {
  staffKey: string;
  staffId: string | null;
  staffName: string | null;
  ticketsCredited: number;
  awardedPoints: number;
  sameClaimClose: number;
  unclaimedHalf: number;
  differentZero: number;
  fallbackTickets: number;
  ratingSum: number;
  ratingCount: number;
  avgRating: number | null;
  categories: StaffCategory[];
}

export interface StaffReport {
  generatedAt: string;
  period: { idStart: string | null; idEnd: string | null };
  includesDemo: boolean;
  filters: { staff: string | null };
  rows: StaffRow[];
  totals: {
    staffCount: number;
    ticketsCredited: number;
    awardedPoints: number;
    unresolvedCredit: number;
    fallbackTickets: number;
    ratedTickets: number;
  };
  methodology: string;
}

export interface AppSettings {
  dashboardUrl: string;
  guildId: string;
  ollamaUrl: string;
  model: string;
  modelTimeoutMs: number;
  semanticEnabled: boolean;
  aiMode?: 'deterministic' | 'shadow' | 'production';
  fuzzyThreshold: number;
  requestDelayMs: number;
  classificationEnabled: boolean;
  autoReuseSession: boolean;
  maxRetries: number;
  navigationTimeoutMs: number;
  fetchConcurrency: number;
  cloudProviderUrl: string;
  cloudApiKey: string;
  cloudModel: string;
  cloudTimeoutMs: number;
  cloudMaxWorkers: number;
}

/** Public-safe settings returned to the browser. Secrets are replaced with presence flags. */
export interface PublicSettings {
  dashboardUrl: string;
  guildId: string;
  ollamaUrl: string;
  model: string;
  modelTimeoutMs: number;
  semanticEnabled: boolean;
  aiMode?: 'deterministic' | 'shadow' | 'production';
  fuzzyThreshold: number;
  requestDelayMs: number;
  classificationEnabled: boolean;
  autoReuseSession: boolean;
  maxRetries: number;
  navigationTimeoutMs: number;
  fetchConcurrency: number;
  cloudProviderUrl: string;
  cloudApiKeyConfigured: boolean;
  cloudModel: string;
  cloudTimeoutMs: number;
  cloudMaxWorkers: number;
}

export interface SettingsResponse {
  settings: PublicSettings;
  meta: {
    appVersion: string;
    taxonomyVersion: string;
    classifierVersion: string;
    dataDir: string;
    dbPath: string;
    profileDir: string;
    backupDir: string;
    exportDir: string;
    browserInstalled: boolean;
    node: string;
    platform: string;
    taxonomy: TaxonomyCategory[];
  };
}

export interface ReviewHistory {
  id: number;
  action: string;
  previousCategories: string[] | null;
  newCategories: string[] | null;
  note: string | null;
  createdAt: string;
}
