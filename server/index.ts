import { spawn } from 'node:child_process';
import { APP_VERSION, DB_PATH, HOST, PORT, ensureRuntimeDirs } from './config.js';
import { Db } from './db.js';
import { ConnectionManager } from './connection.js';
import { AssessmentService } from './assessment-service.js';
import { CollectionService } from './collection-service.js';
import { createApp } from './app.js';
import { log } from './logger.js';

ensureRuntimeDirs();

const db = new Db(DB_PATH);
db.open();
const connection = new ConnectionManager(db);
const assessments = new AssessmentService(db);
const collection = new CollectionService(db, connection, assessments);
collection.recoverAfterRestart();

const app = createApp({ db, connection, assessments, collection });

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
