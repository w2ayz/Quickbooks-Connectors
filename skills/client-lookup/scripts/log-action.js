#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;

    // support --key=value
    if (token.includes('=')) {
      const [rawKey, ...rest] = token.slice(2).split('=');
      out[rawKey] = rest.join('=');
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = 'true';
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function bool(v, fallback = false) {
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'y'].includes(String(v).toLowerCase());
}

function buildReadable(entry) {
  return [
    `[${entry.timestamp}] ${entry.action} | ${entry.status.toUpperCase()}`,
    `- Query: ${entry.query}`,
    `- Customer: ${entry.customer_name} (ID: ${entry.customer_id})`,
    `- Originator: ${entry.originator}`,
    `- Report: ${entry.report_path}`,
    `- Email: prompted=${entry.email_prompted}, decision=${entry.email_decision}, to=${entry.email_to || '(none)'}`,
    `- Notes: ${entry.notes || '(none)'}`,
    ''
  ].join('\n');
}

// Rotate a log file if it exceeds maxBytes. Keeps up to maxFiles archives.
function rotateIfNeeded(filePath, maxBytes = 1 * 1024 * 1024, maxFiles = 5) {
  if (!fs.existsSync(filePath)) return;
  const { size } = fs.statSync(filePath);
  if (size < maxBytes) return;

  // Shift old archives: .4 → delete, .3 → .4, ..., .1 → .2, current → .1
  for (let i = maxFiles - 1; i >= 1; i--) {
    const older = `${filePath}.${i}`;
    const newer = `${filePath}.${i + 1}`;
    if (fs.existsSync(older)) {
      if (i === maxFiles - 1) fs.unlinkSync(older);
      else fs.renameSync(older, newer);
    }
  }
  fs.renameSync(filePath, `${filePath}.1`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const logPath = args.logPath || '/Users/vzeng/Quickbooks/Reports/client-lookup.log';
  const readablePath = args.readablePath || '/Users/vzeng/Quickbooks/Reports/client-lookup-readable.log';

  const entry = {
    timestamp: new Date().toISOString(),
    action: args.action || 'client_lookup',
    query: args.query || '',
    customer_id: args.customer_id || '',
    customer_name: args.customer_name || '',
    originator: args.originator || 'unknown',
    report_path: args.report_path || '',
    status: args.status || 'success',
    email_prompted: bool(args.email_prompted, true),
    email_decision: args.email_decision || 'pending',
    email_to: args.email_to === 'true' ? '' : (args.email_to || ''),
    notes: args.notes || ''
  };

  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.mkdirSync(path.dirname(readablePath), { recursive: true });

  // Rotate logs if over 1 MB (keeps up to 5 archives)
  rotateIfNeeded(logPath);
  rotateIfNeeded(readablePath);

  // machine-readable JSONL
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8');

  // human-readable log
  fs.appendFileSync(readablePath, buildReadable(entry), 'utf8');

  process.stdout.write(JSON.stringify({ ok: true, logPath, readablePath, entry }) + '\n');
}

try {
  main();
} catch (err) {
  process.stderr.write(`log-action failed: ${err.message}\n`);
  process.exit(1);
}
