import fs from 'node:fs';
import {createHash} from 'node:crypto';

export function installationId(root) {
  const real = fs.realpathSync.native(root);
  return createHash('sha256').update(process.platform === 'win32' ? real.toLowerCase() : real).digest('hex');
}

export function localOperationTimeout(script, action) {
  if (script === 'import_persona.py' && action === 'import') return 600000;
  if (script === 'api_settings.py' && ['test', 'models'].includes(action)) return 315000;
  return 65000;
}

export function readLogTail(file, lines) {
  if (!Number.isFinite(lines) || lines <= 0) return '';
  lines = Math.ceil(lines);
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'r');
    let position = fs.fstatSync(descriptor).size;
    let breaks = 0;
    const chunks = [];
    while (position > 0 && breaks < lines) {
      const start = Math.max(0, position - 65536);
      const buffer = Buffer.allocUnsafe(position - start);
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, start);
      if (!count) break;
      const chunk = buffer.subarray(0, count);
      for (const byte of chunk) if (byte === 10) breaks++;
      chunks.push(chunk);
      position = start;
    }
    return Buffer.concat(chunks.reverse()).toString('utf8').split(/\r?\n/).slice(-lines).join('\n');
  } catch { return ''; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
