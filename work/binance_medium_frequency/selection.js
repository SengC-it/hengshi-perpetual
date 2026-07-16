const fs = require('fs');
const crypto = require('crypto');

function chooseParameter(rows) {
  const sorted = rows.slice().sort((a, b) => Number(b.frequencyPass) - Number(a.frequencyPass)
    || b.medianValidationPf - a.medianValidationPf
    || b.validationReturn - a.validationReturn
    || Math.abs(a.validationDd) - Math.abs(b.validationDd)
    || JSON.stringify(a.params || a.id).localeCompare(JSON.stringify(b.params || b.id)));
  if (!sorted.length) throw new Error('no parameter rows');
  return sorted[0];
}

function freezeParameter(row, file, provenance) {
  if (fs.existsSync(file)) throw new Error(`frozen parameter exists: ${file}`);
  fs.writeFileSync(file, JSON.stringify({ createdAt: new Date().toISOString(), selected: row, provenance }, null, 2));
}

function assertFinalAllowed(lockFile, frozenFile) {
  if (!fs.existsSync(frozenFile)) throw new Error('frozen parameter missing');
  if (fs.existsSync(lockFile)) throw new Error('final test already run');
}

function createFinalLock(lockFile, frozenFile) {
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(frozenFile)).digest('hex');
  fs.writeFileSync(lockFile, JSON.stringify({ createdAt: new Date().toISOString(), frozenSha256: sha256 }, null, 2));
  return sha256;
}

module.exports = { chooseParameter, freezeParameter, assertFinalAllowed, createFinalLock };
