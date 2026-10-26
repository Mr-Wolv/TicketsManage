import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR } from './config.js';

type Level = 'info' | 'warn' | 'error';
interface Entry {
  ts: string;
  level: Level;
  event: string;
  data?: Record<string, unknown>;
}

const ring: Entry[] = [];
const logFile = path.join(LOG_DIR, 'app.log');

/**
 * Structured local log. Callers must only pass non-sensitive diagnostics:
 * never cookies, authorization headers, passwords, or transcript text.
 */
export function log(level: Level, event: string, data?: Record<string, unknown>): void {
  const entry: Entry = { ts: new Date().toISOString(), level, event, ...(data ? { data } : {}) };
  ring.push(entry);
  if (ring.length > 400) ring.shift();
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Logging must never take the application down.
  }
  if (level === 'error') console.error(`[${event}]`, data ?? '');
}

export function recentLogs(limit = 100): Entry[] {
  return ring.slice(-limit);
}
