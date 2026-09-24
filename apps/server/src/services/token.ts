import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../paths.ts';

/**
 * Shared secret for the Chrome extension. Created on first use in data/ (never committed);
 * the extension gets it from the native helper, so it's never typed or pasted.
 */
export function extensionToken(file = path.join(DATA_DIR, 'extension-token')): string {
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t) return t;
  } catch {
    // not created yet
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const t = randomBytes(24).toString('hex');
  fs.writeFileSync(file, t);
  return t;
}

export function tokenMatches(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
