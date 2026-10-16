'use strict';
// Optional agentundo integration. If agentundo is installed (its CLI shim exists) and set up in this
// project, record the snapshot id of the verified state on the receipt; green receipts mark it as
// last-known-good, red ones get a command to go back there. Absent or failing => null, receipt unchanged.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TIMEOUT_MS = () => Number(process.env.AGENTRECEIPT_UNDO_TIMEOUT_MS) || 8000;

function undoCli(env = process.env) { return path.join(env.AGENTUNDO_HOME || path.join(os.homedir(), '.agentundo'), 'bin', 'agentundo'); }

function recordUndo(root, status, receiptName, env = process.env) {
  if (env.AGENTRECEIPT_NO_UNDO === '1' || !['green', 'red', 'blocked'].includes(status)) return null;
  const cli = undoCli(env);
  if (!fs.existsSync(cli)) return null;
  try {
    const out = execFileSync(cli, ['receipt', '--status', status, '--receipt', receiptName, '--json'],
      { cwd: root, env, timeout: TIMEOUT_MS(), stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const j = JSON.parse(out.trim().split('\n').pop());
    if (!j || j.ok !== true || !Number.isInteger(j.snapshotId)) return null;
    return { tool: 'agentundo', snapshotId: j.snapshotId, lastKnownGood: status === 'green',
      lastGreenSnapshotId: Number.isInteger(j.lastGreenSnapshotId) ? j.lastGreenSnapshotId : null,
      restoreCommand: typeof j.restoreCommand === 'string' ? j.restoreCommand : null };
  } catch { return null; }
}

module.exports = { recordUndo, undoCli };
