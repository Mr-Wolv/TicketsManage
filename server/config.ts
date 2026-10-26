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

const configuredPort = Number(process.env.PORT);
export const PORT =
  Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65536
    ? configuredPort
    : 5178;
export const HOST = '127.0.0.1';

export const LARGE_RANGE_THRESHOLD = 200;
export const MAX_RANGE_SIZE = 1_000_000;

export function ensureRuntimeDirs(): void {
  for (const dir of [DATA_DIR, BACKUP_DIR, EXPORT_DIR, LOG_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
