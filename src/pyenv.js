'use strict';
// Execution context for receipts, and the optional clean environment (config.cleanEnv).
// Python: a stale __pycache__/*.pyc whose header still matches (same mtime + size) can make tests
// run old bytecode instead of the source on disk. cleanEnv points PYTHONPYCACHEPREFIX at a fresh
// empty temp dir and disables bytecode writes for the verification run, so source is always compiled.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PY_MARKERS = ['pyproject.toml', 'setup.py', 'setup.cfg', 'tox.ini', 'noxfile.py', 'pytest.ini', 'requirements.txt', 'Pipfile', 'conftest.py'];

function isPythonProject(root) {
  if (PY_MARKERS.some((f) => fs.existsSync(path.join(root, f)))) return true;
  try { return fs.readdirSync(root).some((f) => f.endsWith('.py')); } catch { return false; }
}

function pythonInfo(root, env) {
  for (const exe of ['python3', 'python']) {
    const r = spawnSync(exe, ['-c', 'import sys,platform;print(sys.executable);print(platform.python_version())'], { cwd: root, env, encoding: 'utf8', timeout: 5000 });
    if (r.status === 0) { const [executable, version] = r.stdout.trim().split('\n'); return { command: exe, executable, version }; }
  }
  return null;
}

// Returns { env, environment, cleanup }.
function prepareEnv(root, cfg) {
  const python = isPythonProject(root);
  const environment = { cleanEnv: !!cfg.cleanEnv };
  let env = {}, dir = null;
  if (cfg.cleanEnv) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentreceipt-pycache-'));
    env = { PYTHONPYCACHEPREFIX: dir, PYTHONDONTWRITEBYTECODE: '1' };
    environment.python = { pycachePrefix: 'fresh empty temp dir', dontWriteBytecode: true };
  }
  if (python || cfg.cleanEnv) {
    const info = pythonInfo(root, { ...process.env, ...env });
    if (info) environment.python = { ...(environment.python || {}), ...info };
  }
  return { env, environment, cleanup: () => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } };
}

module.exports = { prepareEnv, isPythonProject, pythonInfo };
