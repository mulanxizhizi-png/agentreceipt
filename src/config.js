'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = '.agentreceipt';
const DEFAULTS = { version: 1, testCommand: null, timeoutSec: 300, maxBlocks: 3 };

function findRoot(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    // not a git repo: walk up looking for .agentreceipt
    let d = path.resolve(cwd);
    for (;;) {
      if (fs.existsSync(path.join(d, DIR, 'config.json'))) return d;
      const p = path.dirname(d);
      if (p === d) return path.resolve(cwd);
      d = p;
    }
  }
}

function configPath(root) { return path.join(root, DIR, 'config.json'); }

function loadConfig(root) {
  const p = configPath(root);
  if (!fs.existsSync(p)) return null;
  return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
}

function saveConfig(root, cfg) {
  fs.mkdirSync(path.join(root, DIR), { recursive: true });
  fs.writeFileSync(configPath(root), JSON.stringify({ ...DEFAULTS, ...cfg }, null, 2) + '\n');
}

module.exports = { DIR, DEFAULTS, findRoot, loadConfig, saveConfig, configPath };
