// Pure `.env` string helpers extracted from main.js + src/core/first-run.js.
// No fs, no process.env, no config access — string in, string/object out — so
// the .env parse/format/upsert round-trip is unit-testable without booting the
// Electron app. The fs-backed callers (main.js persistEnvUpdates,
// FirstRunManager._readEnv) keep the I/O and delegate the transforms here.

// Format a value for a single .env line. Newlines are collapsed to spaces and
// backslashes are kept verbatim (doubling them corrupts Windows paths on the
// next load). Values containing whitespace, a double-quote, or a leading '#'
// are wrapped in single quotes so dotenv parses them as one token — essential
// for Whisper commands like:  "C:\Users\Jane Doe\...\python.exe" -m whisper
function formatEnvValue(raw) {
  const v = String(raw).replace(/[\r\n]+/g, ' ').trim();
  if (!/[\s"#]/.test(v)) return v;
  if (!v.includes("'")) return `'${v}'`;
  // Rare: value already contains a single quote — fall back to double quotes.
  return `"${v.replace(/"/g, '\\"')}"`;
}

// Parse .env file CONTENT (a string, not a path) into a key/value object.
// Skips blank + comment lines, unwraps quoted values, and strips an unquoted
// trailing " #" inline comment. Mirrors dotenv closely enough for our keys.
function parseEnv(content) {
  const result = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // If the value is quoted, find the matching closing quote and
    // take everything between. Anything after the closing quote is
    // treated as trailing whitespace/comment.
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      const closeIdx = value.indexOf(quote, 1);
      if (closeIdx !== -1) {
        value = value.slice(1, closeIdx);
      }
    } else {
      // Unquoted: strip trailing inline comment (a " #" sequence).
      const hashIdx = value.indexOf(' #');
      if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
    }

    result[key] = value;
  }
  return result;
}

// Upsert `updates` into existing .env CONTENT and return the new content
// string. Existing `KEY=` lines whose key is in `updates` are replaced in
// place (value via formatEnvValue); keys not already present are appended;
// comments and unrelated lines are preserved. Pure: no process.env mutation,
// no file I/O — the caller owns those.
function upsertEnvContent(existing, updates) {
  const existingLines = existing.length > 0 ? existing.split(/\r?\n/) : [];
  const updated = new Set();
  const outLines = [];

  for (const line of existingLines) {
    // Match "KEY=" (with optional whitespace) but skip comment lines
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && Object.prototype.hasOwnProperty.call(updates, m[1])) {
      const key = m[1];
      outLines.push(`${key}=${formatEnvValue(updates[key])}`);
      updated.add(key);
    } else {
      outLines.push(line);
    }
  }

  // Append any keys that weren't already present
  for (const key of Object.keys(updates)) {
    if (!updated.has(key)) {
      outLines.push(`${key}=${formatEnvValue(updates[key])}`);
      updated.add(key);
    }
  }

  return outLines.join('\n');
}

module.exports = { parseEnv, formatEnvValue, upsertEnvContent };
