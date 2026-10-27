import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createApp } from '../server/app.js';
import { Db } from '../server/db.js';
import { ConnectionManager } from '../server/connection.js';
import { AssessmentService } from '../server/assessment-service.js';
import { CollectionService } from '../server/collection-service.js';

let db: Db;
let server: http.Server;

beforeEach(() => {
  db = new Db(':memory:');
  db.open();
  const connection = new ConnectionManager(db);
  const assessments = new AssessmentService(db);
  const collection = new CollectionService(db, connection, assessments);
  // The real application stack, so these assertions describe the shipped
  // middleware and cannot drift from server/index.ts.
  server = http.createServer(createApp({ db, connection, assessments, collection }));
});

afterEach(() => {
  server.close();
  db.close();
});

async function request(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
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
      const req = http.request({ method, path, host: '127.0.0.1', port, headers }, (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, headers: res.headers });
      });
      req.on('error', reject);
      req.end();
    }
  });
}

describe('security headers and rate limiting', () => {
  it('echoes a loopback origin and hardens every API response', async () => {
    const { status, headers } = await request('GET', '/api/health', {
      origin: 'http://127.0.0.1:5178',
    });
    expect(status).toBe(200);
    expect(headers['access-control-allow-origin']).toBe('http://127.0.0.1:5178');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['cache-control']).toBe('no-store');
  });

  it('never echoes a cross-site origin', async () => {
    const { headers } = await request('GET', '/api/health', { origin: 'https://evil.example' });
    expect(headers['access-control-allow-origin']).toBeUndefined();
  });

  it('handles preflight OPTIONS requests', async () => {
    const { status } = await request('OPTIONS', '/api/health');
    expect(status).toBe(204);
  });

  it('does not expose the stored cloud API key in settings responses', async () => {
    const secret = 'test-secret-key-do-not-leak';
    await new Promise<void>((resolve) => {
      if (server.listening) {
        resolve();
        return;
      }
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    const port: number = typeof address === 'object' && address ? address.port : 1;

    const putBody = await new Promise<string>((resolve, reject) => {
      const req = http.request({
        method: 'PUT',
        path: '/api/settings',
        host: '127.0.0.1',
        port,
        headers: { 'content-type': 'application/json' },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
      req.write(JSON.stringify({ cloudApiKey: secret, cloudProviderUrl: 'https://openrouter.ai/api/v1', cloudModel: 'test-model' }));
      req.end();
    });
    expect(putBody).toContain('"cloudApiKeyConfigured":true');

    const getBody = await new Promise<string>((resolve, reject) => {
      const req = http.request({ method: 'GET', path: '/api/settings', host: '127.0.0.1', port }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
      req.end();
    });

    expect(getBody).not.toContain(secret);
    expect(getBody).toContain('"cloudApiKeyConfigured":true');
    expect(getBody).not.toContain('"cloudApiKey":"test-secret-key-do-not-leak"');
  });
});
