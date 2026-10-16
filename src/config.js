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

class ConfigError extends Error {}

// Returns a list of problems (empty = valid). maxBlocks: finite integer >= 0 (0 = never block, only receipts).
// timeoutSec: finite number > 0. testCommand: non-empty string.
function validateConfig(cfg) {
  const errs = [];
  if (typeof cfg.testCommand !== 'string' || !cfg.testCommand.trim()) errs.push('testCommand must be a non-empty string');
  if (typeof cfg.maxBlocks !== 'number' || !Number.isInteger(cfg.maxBlocks) || cfg.maxBlocks < 0) errs.push(`maxBlocks must be an integer >= 0 (got ${JSON.stringify(cfg.maxBlocks)})`);
  if (typeof cfg.timeoutSec !== 'number' || !Number.isFinite(cfg.timeoutSec) || cfg.timeoutSec <= 0) errs.push(`timeoutSec must be a number > 0 (got ${JSON.stringify(cfg.timeoutSec)})`);
  if (cfg.criteriaFiles !== undefined && !(Array.isArray(cfg.criteriaFiles) && cfg.criteriaFiles.every((g) => typeof g === 'string' && g.trim()))) errs.push('criteriaFiles must be an array of glob strings');
  if (cfg.cleanEnv !== undefined && typeof cfg.cleanEnv !== 'boolean') errs.push('cleanEnv must be true or false');
  return errs;
}

// Strict number parsing for CLI flags: '3' -> 3, 'abc'/'' -> NaN (so validation rejects it).
function parseNum(v) { return typeof v === 'number' ? v : /^\s*-?\d+(\.\d+)?\s*$/.test(String(v)) ? Number(v) : NaN; }

function loadConfig(root) {
  const p = configPath(root);
  if (!fs.existsSync(p)) return null;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { throw new ConfigError(`${p}: invalid JSON (${e.message})`); }
  const cfg = { ...DEFAULTS, ...raw };
  const errs = validateConfig(cfg);
  if (errs.length) throw new ConfigError(`${p}: ${errs.join('; ')}`);
  return cfg;
}

function saveConfig(root, cfg) {
  fs.mkdirSync(path.join(root, DIR), { recursive: true });
  fs.writeFileSync(configPath(root), JSON.stringify({ ...DEFAULTS, ...cfg }, null, 2) + '\n');
}

function configFingerprint(root) {
  try { return 'sha256:' + require('crypto').createHash('sha256').update(fs.readFileSync(configPath(root))).digest('hex'); } catch { return null; }
}

module.exports = { configFingerprint, ConfigError, validateConfig, parseNum, DIR, DEFAULTS, findRoot, loadConfig, saveConfig, configPath };
