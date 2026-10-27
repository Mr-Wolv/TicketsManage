import fs from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';
import { WEB_DIST } from './config.js';
import { log } from './logger.js';
import { createApiRouter, isLoopbackOrigin, localOriginGuard } from './routes.js';
import type { Db } from './db.js';
import type { ConnectionManager } from './connection.js';
import type { CollectionService } from './collection-service.js';
import type { AssessmentService } from './assessment-service.js';

export interface AppDependencies {
  db: Db;
  connection: ConnectionManager;
  assessments: AssessmentService;
  collection: CollectionService;
}

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;

/**
 * Rate limiting state lives per app instance so tests and the production
 * server never share counters.
 */
interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export function createApp(deps: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'",
    );
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    // A single, valid origin is echoed only when the caller is already a local
    // page. A malformed value (two space-separated origins) never matches any
    // browser origin, so echoing the request origin is both correct and
    // strictly narrower than advertising a fixed pair.
    const origin = req.get('origin');
    if (origin && isLoopbackOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  const rateLimitBuckets = new Map<string, RateLimitBucket>();
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
  app.use('/api', createApiRouter(deps));

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
    const typed = error as Error & { status?: number; type?: string; statusCode?: number };
    const message = typed instanceof Error ? typed.message : 'Unknown error';
    const status = typed.status ?? typed.statusCode;
    // body-parser reports malformed or oversized bodies through `type`. Those are
    // client mistakes and must not be reported as an internal server error.
    const bodyParserType = typeof typed.type === 'string' ? typed.type : '';
    const bodyParserFailure = /^(entity|request|charset|encoding|parameters|stream)/.test(bodyParserType);
    const tooLarge =
      bodyParserType === 'entity.too.large' || status === 413 || /entity too large|request entity/i.test(message);

    if (bodyParserFailure) {
      // body-parser error messages quote a fragment of the offending body, which
      // could be a partially typed API key or ticket text. Only the failure kind
      // is recorded; the content itself is never logged.
      log('error', 'server.body_rejected', {
        type: bodyParserType,
        status: status ?? 400,
      });
    } else {
      log('error', 'server.error', {
        status: status ?? undefined,
        message: message.slice(0, 400),
      });
    }
    if (res.headersSent) return;

    if (tooLarge) {
      res.status(413).json({
        error: {
          code: 'BODY_TOO_LARGE',
          message: 'The request body is too large.',
          details: null,
        },
      });
      return;
    }
    if (bodyParserFailure || (status !== undefined && status >= 400 && status < 500)) {
      res.status(400).json({
        error: {
          code: 'INVALID_REQUEST_BODY',
          message: 'The request body could not be read. Send a valid JSON body with content type application/json.',
          details: null,
        },
      });
      return;
    }
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The local application could not complete that request.',
        details: null,
      },
    });
  });

  return app;
}
