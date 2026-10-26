import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CollectionService } from '../server/collection-service.js';
import { Db } from '../server/db.js';
import { ConnectionManager } from '../server/connection.js';
import { AssessmentService } from '../server/assessment-service.js';

let directory: string;
let db: Db;
let service: CollectionService;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ticketsmanage-collection-'));
  db = new Db(path.join(directory, 'test.db'));
  db.open();
  const connection = new ConnectionManager(db);
  const assessments = new AssessmentService(db);
  service = new CollectionService(db, connection, assessments);
});

afterEach(async () => {
  try {
    await service.cancel();
  } catch {
    // ignore
  }
  try {
    db.close();
  } catch {
    // ignore
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('collection mode enforcement', () => {
  it('accepts ID-only mode when only start/end are provided', async () => {
    const record = await service.start({
      start: '1',
      end: '10',
      classify: false,
      confirmLarge: false,
      mode: 'full',
    });
    expect(record.status).toBe('running');
    expect(record.startId).toBe('1');
    expect(record.endId).toBe('10');
  });

  it('accepts date-only mode when only date fields are provided', async () => {
    const record = await service.start({
      start: '',
      end: '',
      classify: false,
      confirmLarge: false,
      mode: 'full',
      dateFrom: '17/10/26',
      dateTo: '23/10/26',
      dateTimezone: 'Africa/Cairo',
      dateBasis: 'closed',
    });
    expect(record.status).toBe('running');
    expect(record.startId).toBe('0');
    expect(record.endId).toBe('999999999999');
    expect(record.dateFrom).toBeTruthy();
    expect(record.dateTo).toBeTruthy();
  });

  it('accepts hybrid mode when both ID and date fields are provided', async () => {
    const record = await service.start({
      start: '1',
      end: '10',
      classify: false,
      confirmLarge: false,
      mode: 'full',
      dateFrom: '17/10/26',
      dateTo: '23/10/26',
      dateTimezone: 'Africa/Cairo',
      dateBasis: 'closed',
    });
    expect(record.status).toBe('running');
    expect(record.startId).toBe('1');
    expect(record.endId).toBe('10');
    expect(record.dateFrom).toBeTruthy();
    expect(record.dateTo).toBeTruthy();
  });

  it('rejects requests that provide neither ID nor date range', async () => {
    await expect(
      service.start({
        start: '',
        end: '',
        classify: false,
        confirmLarge: false,
        mode: 'full',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RANGE' });
  });

  it('rejects hybrid mode when one side is incomplete', async () => {
    await expect(
      service.start({
        start: '1',
        end: '',
        classify: false,
        confirmLarge: false,
        mode: 'full',
        dateFrom: '17/10/26',
        dateTo: '23/10/26',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_MODE' });
  });
});
