const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chooseParameter, freezeParameter, assertFinalAllowed, createFinalLock } = require('../selection');

test('selection prioritizes validation robustness', () => {
  const chosen = chooseParameter([
    { id: 'overfit', medianValidationPf: 0.9, validationReturn: 0.5, validationDd: -0.5, frequencyPass: true },
    { id: 'robust', medianValidationPf: 1.3, validationReturn: 0.2, validationDd: -0.2, frequencyPass: true }
  ]);
  assert.equal(chosen.id, 'robust');
});

test('freeze refuses overwrite and final lock blocks rerun', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-lock-'));
  const frozen = path.join(dir, 'frozen.json'), lock = path.join(dir, 'final.lock');
  freezeParameter({ id: 'x', params: { fast: 50 } }, frozen, { dataHash: 'abc' });
  assert.throws(() => freezeParameter({ id: 'y' }, frozen, {}), /exists/);
  assertFinalAllowed(lock, frozen);
  createFinalLock(lock, frozen);
  assert.throws(() => assertFinalAllowed(lock, frozen), /already run/);
});
