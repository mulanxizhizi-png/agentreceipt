'use strict';
// Partial-test detection: does the configured test command run only part of the suite that
// auto-detection (src/detect.js) would run? Deliberately conservative: we mark "partial" only when the
// configured command uses the SAME runner as the detected full command AND carries an explicit selection
// (a test path/file/node id, a name filter, a marker, last-failed, ...). Anything we can't parse
// (shell operators, a different runner, wrapper scripts) returns null = no mark. A missing mark is
// better than a false one.
const fs = require('fs');
const path = require('path');
const { detectTestCommand } = require('./detect');

// Minimal shell-word split with quotes. Returns null on shell syntax we don't analyse.
function words(cmd) {
  const s = String(cmd || '').trim();
  if (!s || /[;&|<>`]|\$\(|\n/.test(s.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, ''))) return null;
  const out = []; let cur = null, q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === q) q = null; else if (ch === '\\' && q === '"' && i + 1 < s.length) cur += s[++i]; else cur += ch; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur = cur || ''; continue; }
    if (/\s/.test(ch)) { if (cur !== null) { out.push(cur); cur = null; } continue; }
    if (ch === '\\' && i + 1 < s.length) { cur = (cur || '') + s[++i]; continue; }
    cur = (cur || '') + ch;
  }
  if (q) return null;
  if (cur !== null) out.push(cur);
  while (out.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(out[0])) out.shift(); // FOO=1 cmd ...
  return out.length ? out : null;
}

// Identify the runner. Returns { runner, args } or null.
const PY = /^(python3?(\.\d+)?|py)$/;
function runnerOf(w) {
  let a = w.slice();
  if (['uv', 'poetry', 'pdm', 'hatch', 'pipenv'].includes(a[0]) && a[1] === 'run') a = a.slice(2);
  if (a[0] === 'npx' || a[0] === 'pnpx' || a[0] === 'bunx') a = a.slice(1);
  if (PY.test(a[0]) && a[1] === '-m' && a[2] === 'pytest') return { runner: 'pytest', args: a.slice(3) };
  if (a[0] === 'pytest' || a[0] === 'py.test') return { runner: 'pytest', args: a.slice(1) };
  if (a[0] === 'cargo' && a[1] === 'test') return { runner: 'cargo', args: a.slice(2) };
  if (a[0] === 'go' && a[1] === 'test') return { runner: 'go', args: a.slice(2) };
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(a[0])) {
    if (a[1] === 'test' || (a[0] === 'npm' && a[1] === 't')) return { runner: 'script', pm: a[0], args: a.slice(2) };
    if ((a[1] === 'run' || a[1] === 'run-script') && a[2] === 'test') return { runner: 'script', pm: a[0], args: a.slice(3) };
  }
  return null;
}

const existsIn = (root, p) => { try { return fs.existsSync(path.join(root, p.split('::')[0])); } catch { return false; } };
// A positional path selects part of the suite when it's a file, a pytest node id, or a nested directory.
// A bare top-level directory (`pytest tests`) is usually the whole suite, so it is not marked.
function selectsPath(root, tok) {
  if (tok.startsWith('-') || !existsIn(root, tok)) return false;
  if (tok.includes('::')) return true;
  const p = tok.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!p || p === '.') return false;
  let st; try { st = fs.statSync(path.join(root, p)); } catch { return false; }
  return st.isFile() || p.includes('/');
}
const opt = (t) => t.split('=')[0];

function pytestPartial(root, args) {
  const SEL = ['-k', '-m', '--lf', '--last-failed', '--sw', '--stepwise', '--deselect', '--ignore', '--ignore-glob', '--co'];
  for (const t of args) { if (SEL.includes(opt(t))) return `pytest ${opt(t)}`; if (selectsPath(root, t)) return `path ${t}`; }
  return null;
}
// JS runners behind `npm test` / the test script itself: name/path filters.
function jsPartial(root, args) {
  const SEL = ['-t', '--testNamePattern', '--testPathPattern', '--testPathPatterns', '-g', '--grep', '-o', '--onlyChanged', '--changedSince', '--findRelatedTests', '--lastCommit', '--related', '--project', '--shard', '--test-name-pattern'];
  for (const t of args) { if (t === '--') continue; if (SEL.includes(opt(t))) return `filter ${opt(t)}`; if (selectsPath(root, t)) return `path ${t}`; }
  return null;
}
function cargoPartial(args) {
  const VAL = ['-p', '--package', '--features', '-F', '--target', '-j', '--jobs', '--manifest-path', '--profile', '--target-dir', '--color', '--config', '-Z', '--exclude', '--test', '--bin', '--example', '--bench'];
  const SEL = ['-p', '--package', '--lib', '--bins', '--bin', '--test', '--tests', '--doc', '--example', '--examples', '--bench', '--benches'];
  const i = args.indexOf('--');
  const pre = i >= 0 ? args.slice(0, i) : args, post = i >= 0 ? args.slice(i + 1) : [];
  for (let k = 0; k < pre.length; k++) {
    const t = pre[k];
    if (SEL.includes(opt(t))) return `cargo ${opt(t)}`;
    if (VAL.includes(t)) { k++; continue; }
    if (!t.startsWith('-')) return `filter ${t}`;
  }
  const PVAL = ['--test-threads', '--format', '--color', '-Z', '--logfile', '--report-time'];
  for (let k = 0; k < post.length; k++) {
    const t = post[k];
    if (['--skip', '--exact', '--ignored'].includes(opt(t))) return `cargo ${opt(t)}`;
    if (PVAL.includes(t)) { k++; continue; }
    if (!t.startsWith('-')) return `filter ${t}`;
  }
  return null;
}
function goPartial(args) {
  const VAL = ['-count', '-timeout', '-tags', '-p', '-parallel', '-coverprofile', '-covermode', '-coverpkg', '-cpu', '-bench', '-benchtime', '-o', '-exec', '-ldflags', '-gcflags', '-mod', '-modfile', '-outputdir', '-vet', '-shuffle'];
  const pkgs = [];
  for (let k = 0; k < args.length; k++) {
    const t = args[k];
    if (['-run', '-skip', '--run', '--skip'].includes(opt(t))) return `go ${opt(t).replace(/^--/, '-')}`;
    if (t.startsWith('-')) { if (!t.includes('=') && VAL.includes(t)) k++; continue; }
    if (t === '-args') break;
    pkgs.push(t);
  }
  if (!pkgs.length) return 'only the current package';
  if (pkgs.some((p) => p === './...' || p === '...')) return null;
  return `packages ${pkgs.join(' ')}`;
}

// Returns { partial: true, command, detectedCommand, reason } | { partial: false, ... } | null (unknown).
function testScope(root, command, detected = detectTestCommand(root)) {
  if (!detected || !command) return null;
  const cw = words(command), dw = words(detected.command);
  if (!cw || !dw) return null;
  const norm = (w) => w.join(' ');
  const base = { command, detectedCommand: detected.command };
  if (norm(cw) === norm(dw)) return { partial: false, ...base };
  const dr = runnerOf(dw);
  let cr = runnerOf(cw);
  // Detected `npm test` and the configured command is the package.json test script itself (+ args).
  if (dr && dr.runner === 'script' && (!cr || cr.runner !== 'script')) {
    let script = null;
    try { script = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts.test; } catch {}
    const sw = script && words(script);
    if (!sw) return null;
    const strip = (w) => (['npx', 'pnpx', 'bunx'].includes(w[0]) ? w.slice(1) : w);
    const a = strip(cw), s = strip(sw);
    if (a.length < s.length || norm(a.slice(0, s.length)) !== norm(s)) return null;
    const why = jsPartial(root, a.slice(s.length));
    return { partial: !!why, ...base, ...(why ? { reason: why } : {}) };
  }
  if (!dr || !cr || dr.runner !== cr.runner) return null;
  const why = cr.runner === 'pytest' ? pytestPartial(root, cr.args)
    : cr.runner === 'script' ? jsPartial(root, cr.args)
    : cr.runner === 'cargo' ? cargoPartial(cr.args)
    : cr.runner === 'go' ? goPartial(cr.args) : null;
  return { partial: !!why, ...base, ...(why ? { reason: why } : {}) };
}

module.exports = { testScope, words, runnerOf };
