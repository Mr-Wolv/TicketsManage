import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import express from 'express';
import {
  APP_VERSION,
  DB_PATH,
  HOST,
  PORT,
  WEB_DIST,
  ensureRuntimeDirs,
} from './config.js';
import { Db } from './db.js';
import { ConnectionManager } from './connection.js';
import { AssessmentService } from './assessment-service.js';
import { CollectionService } from './collection-service.js';
import { createApiRouter, localOriginGuard } from './routes.js';
import { log } from './logger.js';

ensureRuntimeDirs();

const db = new Db(DB_PATH);
db.open();
const connection = new ConnectionManager(db);
const assessments = new AssessmentService(db);
const collection = new CollectionService(db, connection, assessments);
collection.recoverAfterRestart();

const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'",
  );
  res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:5178 http://localhost:5178');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (_req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;
app.use('/api', (req, res, next) => {
  const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return next();
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_MAX) {
    res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
    res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests.', details: null } });
    return;
  }
  next();
});

app.use('/api', localOriginGuard);
app.use(express.json({ limit: '1mb' }));
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use('/api', createApiRouter({ db, connection, assessments, collection }));

if (fs.existsSync(WEB_DIST)) {
  app.use(
    express.static(WEB_DIST, {
      index: false,
      maxAge: '1h',
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-store');
      },
    }),
  );
  app.use((req, res, next) => {
    if (req.method !== 'GET') {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(WEB_DIST, 'index.html'));
  });
} else {
  app.use((_req, res) => {
    res
      .status(200)
      .type('html')
      .send(
        '<!doctype html><html><head><meta charset="utf-8"><title>TicketsManage setup</title></head><body style="font-family:system-ui;max-width:640px;margin:60px auto"><h1>TicketsManage</h1><p>The dashboard has not been built yet.</p><p>Run <code>npm run build:web</code> once, then restart the application with <code>npm start</code>.</p></body></html>',
      );
  });
}

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  log('error', 'server.error', { message: message.slice(0, 400) });
  if (res.headersSent) return;
  const bodyTooLarge = /entity too large|request entity/i.test(message);
  res.status(bodyTooLarge ? 413 : 500).json({
    error: {
      code: bodyTooLarge ? 'BODY_TOO_LARGE' : 'INTERNAL_ERROR',
      message: bodyTooLarge
        ? 'The request body is too large.'
        : 'The local application could not complete that request.',
    },
  });
});

const server = app.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  log('info', 'server.started', { version: APP_VERSION, url });
  console.log('');
  console.log(`TicketsManage ${APP_VERSION}`);
  console.log(`Open: ${url}`);
  console.log('All ticket data stays in the local data directory.');
  console.log('');
  if (process.env.TICKETS_NO_OPEN !== '1') {
    try {
      if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', url], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        }).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch {
      /* opening the browser is best effort */
    }
  }
  if (process.env.TICKETS_NO_PROBE !== '1') {
    setTimeout(() => {
      connection.probeSavedSession().catch((error) => {
        log('warn', 'connection.probe_failed', {
          message: error instanceof Error ? error.message.slice(0, 300) : 'unknown',
        });
      });
    }, 1500);
  }
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `Port ${PORT} is already in use. Close the other TicketsManage instance or set PORT to a free port.`,
    );
    process.exit(1);
  } else {
    console.error('The local server could not start:', error.message);
    process.exitCode = 1;
  }
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'server.shutdown', { signal });
  server.close();
  await connection.shutdown().catch(() => undefined);
  db.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
  log('error', 'server.uncaught', { message: error.message.slice(0, 400) });
});
process.on('unhandledRejection', (reason) => {
  log('error', 'server.unhandled_rejection', {
    message: reason instanceof Error ? reason.message.slice(0, 400) : String(reason).slice(0, 400),
  });
});
