import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import { createApiRouter, localOriginGuard } from '../server/routes.js';
import { Db } from '../server/db.js';
import { ConnectionManager } from '../server/connection.js';
import { AssessmentService } from '../server/assessment-service.js';
import { CollectionService } from '../server/collection-service.js';

let db: Db;
let app: express.Express;
let server: http.Server;

beforeEach(() => {
  db = new Db(':memory:');
  db.open();
  const connection = new ConnectionManager(db);
  const assessments = new AssessmentService(db);
  const collection = new CollectionService(db, connection, assessments);
  app = express();
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
  app.use('/api', localOriginGuard);
  app.use('/api', createApiRouter({ db, connection, assessments, collection }));
  server = http.createServer(app);
});

afterEach(() => {
  server.close();
  db.close();
});

async function request(method: string, path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      server.listen(0, '127.0.0.1', () => {
        sendRequest();
      });
    } else {
      sendRequest();
    }

    function sendRequest() {
      const address = server.address();
      const port: number = typeof address === 'object' && address ? address.port : 1;
      const req = http.request({ method, path, host: '127.0.0.1', port }, (res) => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers });
      });
      req.on('error', reject);
      req.end();
    }
  });
}

describe('security headers and rate limiting', () => {
  it('returns CORS headers on API responses', async () => {
    const { status, headers } = await request('GET', '/api/health');
    expect(status).toBe(200);
    expect(headers['access-control-allow-origin']).toBe('http://127.0.0.1:5178 http://localhost:5178');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
  });

  it('handles preflight OPTIONS requests', async () => {
    const { status } = await request('OPTIONS', '/api/health');
    expect(status).toBe(204);
  });
});
