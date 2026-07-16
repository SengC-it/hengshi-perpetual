import test from 'node:test';
import assert from 'node:assert/strict';
import { TABLES } from '../lib/db.js';

test('all shared Supabase tables use the hengshi prefix', () => {
  assert.deepEqual(Object.values(TABLES), [
    'hengshi_scan_runs',
    'hengshi_signals',
    'hengshi_paper_positions',
    'hengshi_paper_trades'
  ]);
  assert.ok(Object.values(TABLES).every((table) => table.startsWith('hengshi_')));
});
