'use strict';
const fs = require('fs');

// Text of the last assistant message in a Claude Code transcript (JSONL).
// Each line is an event; assistant turns look like
// {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}, {"type":"tool_use",...}]}}
function lastAssistantText(transcriptPath, maxBytes = 2 * 1024 * 1024) {
  if (!transcriptPath) return null;
  let data;
  try {
    const st = fs.statSync(transcriptPath);
    const fd = fs.openSync(transcriptPath, 'r');
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    data = buf.toString('utf8');
  } catch { return null; }
  const lines = data.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    const msg = ev.message || ev;
    if (ev.type !== 'assistant' && msg.role !== 'assistant') continue;
    const c = msg.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '';
    if (text.trim()) return text.trim();
  }
  return null;
}

// Prefer the hook's last_assistant_message (Claude Code docs: transcript may lag at Stop time).
function extractClaim(input) {
  if (input.last_assistant_message) return input.last_assistant_message;
  return lastAssistantText(input.transcript_path);
}

module.exports = { lastAssistantText, extractClaim };
