const test = require('node:test'); const assert = require('node:assert');
const { detectTestCommand } = require('../src/detect'); const { tmpRepo } = require('./helpers');
test('npm test from package.json', () => {
  assert.equal(detectTestCommand(tmpRepo({ 'package.json': '{"scripts":{"test":"node --test"}}' })).command, 'npm test');
});
test('ignores npm placeholder script', () => {
  assert.equal(detectTestCommand(tmpRepo({ 'package.json': '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' })), null);
});
test('pnpm lockfile', () => {
  assert.equal(detectTestCommand(tmpRepo({ 'package.json': '{"scripts":{"test":"vitest"}}', 'pnpm-lock.yaml': '' })).command, 'pnpm test');
});
test('pytest via pyproject', () => {
  assert.equal(detectTestCommand(tmpRepo({ 'pyproject.toml': '[tool.pytest.ini_options]\n' })).command, 'pytest -q');
});
test('pytest via tests/test_*.py', () => {
  assert.equal(detectTestCommand(tmpRepo({ 'tests/test_x.py': '' })).command, 'pytest -q');
});
test('cargo and go', () => {
  assert.equal(detectTestCommand(tmpRepo({ 'Cargo.toml': '' })).command, 'cargo test');
  assert.equal(detectTestCommand(tmpRepo({ 'go.mod': '' })).command, 'go test ./...');
});
test('nothing detected', () => { assert.equal(detectTestCommand(tmpRepo({ 'README.md': 'x' })), null); });
