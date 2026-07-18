import test from 'node:test';
import assert from 'node:assert/strict';
import { formatBeijingTime } from '../lib/mailer.js';

test('user-facing timestamps are formatted in Beijing time', () => {
  assert.equal(
    formatBeijingTime('2026-07-18T00:00:00.000Z'),
    '2026-07-18 08:00:00'
  );
});
