// Renders a receipt JSON exactly as the CLI prints it (ANSI colors -> HTML), for screenshots.
const fs = require('fs'); const { formatReceipt } = require('../src/receipt');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const col = { '32;1': '#3fd068;font-weight:bold', '33;1': '#f2c94c;font-weight:bold', '31;1': '#ff5f56;font-weight:bold', '33': '#f2c94c', '31': '#ff5f56' };
const html = esc(formatReceipt(r, { color: true })).replace(/\x1b\[([\d;]+)m(.*?)\x1b\[0m/g, (_, c, t) => `<span style="color:${col[c].replace(';', ';')}">${t}</span>`);
fs.writeFileSync(process.argv[3], `<html><body style="margin:0;background:#1e1e1e"><div style="padding:24px 28px;display:inline-block"><div style="color:#888;font:13px Menlo,'DejaVu Sans Mono',monospace;margin-bottom:10px">$ codex  ·  agentreceipt Stop hook</div><pre style="margin:0;color:#e6e6e6;font:16px/1.45 Menlo,'DejaVu Sans Mono',monospace">${html}</pre></div></body></html>`);
