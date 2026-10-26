import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Db } from '../server/db.js';
import { loadUnifiedTaxonomy } from '../server/classifier/taxonomy.js';
import { TAXONOMY } from '../server/classifier/taxonomy.js';

let directory: string;
let db: Db;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ticketsmanage-unified-taxonomy-'));
  db = new Db(path.join(directory, 'test.db'));
  db.open();
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('unified taxonomy migration', () => {
  it('backfills fixed taxonomy and custom categories into taxonomy_categories', () => {
    db.addCustomCategory({
      id: 'CUSTOM_TEST',
      code: 'CT',
      label: 'Custom Test',
      labelAr: '',
      description: 'Test category',
      points: 5,
      examples: ['test example'],
    });
    db.migrateUnifiedTaxonomy();

    const unified = db.loadUnifiedTaxonomy();
    const fixed = unified.filter((item) => item.isFixed);
    const custom = unified.filter((item) => !item.isFixed);

    expect(fixed).toHaveLength(TAXONOMY.length);
    expect(custom).toHaveLength(1);
    expect(custom[0]!.id).toBe('CUSTOM_TEST');
    expect(custom[0]!.points).toBe(5);
  });

  it('updates an existing unified category without duplicating it', () => {
    db.migrateUnifiedTaxonomy();
    db.saveUnifiedCategory({
      id: 'RECHARGE',
      code: 'RECHARGE',
      label: 'Recharge',
      labelAr: 'شحن',
      description: 'Updated description',
      points: 7,
      examples: ['recharge'],
    });

    const unified = db.loadUnifiedTaxonomy();
    const recharge = unified.find((item) => item.id === 'RECHARGE')!;
    expect(recharge.points).toBe(7);
    expect(recharge.description).toBe('Updated description');
    expect(unified).toHaveLength(TAXONOMY.length);
  });

  it('loads unified taxonomy into classifier map', () => {
    db.addCustomCategory({
      id: 'CUSTOM_MAP',
      code: 'CM',
      label: 'Custom Map',
      labelAr: '',
      description: '',
      points: 4,
      examples: ['map'],
    });
    db.migrateUnifiedTaxonomy();

    const map = loadUnifiedTaxonomy(db);
    expect(map['RECHARGE']?.points).toBe(TAXONOMY.find((c) => c.id === 'RECHARGE')!.points);
    expect(map['CUSTOM_MAP']?.points).toBe(4);
    expect(map['CUSTOM_MAP']?.isCustom).toBe(true);
  });
});
