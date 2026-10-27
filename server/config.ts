import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(here, '..');

export const APP_VERSION = '2.0.0';
export const TAXONOMY_VERSION = '1.1.0';
export const CLASSIFIER_VERSION = '2.1.0';
export const SCHEMA_VERSION = 2;

export const DATA_DIR = process.env.TICKETS_DATA_DIR
  ? path.resolve(process.env.TICKETS_DATA_DIR)
  : path.join(APP_ROOT, 'data');

export const DB_PATH = path.join(DATA_DIR, 'ticketsmanage.db');
export const PROFILE_DIR = path.join(DATA_DIR, 'browser-profile');
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
export const EXPORT_DIR = path.join(DATA_DIR, 'exports');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
export const WEB_DIST = path.join(APP_ROOT, 'web-dist');

export const DEFAULT_DASHBOARD_URL =
  'https://dashboard.tickets.bot/manage/1276839639285760081/transcripts';
export const DEFAULT_GUILD_ID = '1276839639285760081';
export const DEFAULT_API_ORIGIN = 'https://api.tickets.bot';

/**
 * The only cloud destination this application will ever send the stored cloud
 * API key to. OpenRouter is the approved provider; the key is a credential and
 * must not be able to travel to an endpoint that was supplied by a request or
 * a stale setting row.
 */
export const CLOUD_PROVIDER_BASE_URL = 'https://openrouter.ai/api/v1';

const APPROVED_CLOUD_HOSTS = new Set(['openrouter.ai']);
const APPROVED_CLOUD_PATHS = new Set(['/', '', '/api', '/api/', '/api/v1', '/api/v1/', '/v1', '/v1/']);

/**
 * The approved OpenRouter base URL for a configured value, or null when the
 * value is missing, malformed, uses another hostname, a non-HTTPS scheme, or
 * embedded credentials. Callers treat null as "do not send the key".
 */
export function resolveApprovedCloudBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== '443') return null;
  if (url.search || url.hash) return null;
  if (!APPROVED_CLOUD_HOSTS.has(url.hostname.toLowerCase())) return null;
  return APPROVED_CLOUD_PATHS.has(url.pathname.toLowerCase()) ? CLOUD_PROVIDER_BASE_URL : null;
}

const configuredPort = Number(process.env.PORT);
export const PORT =
  Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65536
    ? configuredPort
    : 5178;
export const HOST = '127.0.0.1';

export const LARGE_RANGE_THRESHOLD = 200;
export const MAX_RANGE_SIZE = 1_000_000;

// Largest interval the missing-ID report will enumerate in one request. It
// bounds both the SQL scan and the response body, so the derived report stays a
// read-only convenience rather than an unbounded query. Larger intervals are
// refused with an explicit error instead of silently returning nothing.
export const MISSING_IDS_MAX_WINDOW = 10_000;

export function ensureRuntimeDirs(): void {
  for (const dir of [DATA_DIR, BACKUP_DIR, EXPORT_DIR, LOG_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
