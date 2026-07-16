const test = require('node:test');
const assert = require('node:assert/strict');
const { validationWindows, serializeCsv } = require('../run');

test('validation windows do not cross final boundary', () => {
  const windows = validationWindows('2024-01-01', '2025-06-30');
  assert.ok(windows.length >= 5);
  assert.equal(windows.at(-1)[1], '2025-06-30');
  assert.ok(windows.every(([start, end]) => start <= end && end < '2025-07-01'));
});

test('CSV serializer quotes commas and preserves headers', () => {
  const csv = serializeCsv([{ a: 'x,y', b: 2 }], ['a', 'b']);
  assert.equal(csv, 'a,b\n"x,y",2');
});
