import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { decode, encode } from './protocol.mjs';

const hostScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'host.mjs');
let server;
afterEach(() => server?.close());

describe('native helper', () => {
  it('still replies to a slow "start" when Chrome closes stdin straight after sending it', async () => {
    // A stand-in Job Matrix whose health check answers after half a second.
    server = http.createServer((req, res) => setTimeout(() => res.end('{"ok":true}'), 500));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-host-'));
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(path.join(root, 'data', 'extension-token'), 'a'.repeat(48));

    const p = spawn(process.execPath, [hostScript, '--root', root], {
      env: { ...process.env, JM_APP_URL: `http://127.0.0.1:${server.address().port}` },
    });
    let out = Buffer.alloc(0);
    p.stdout.on('data', (d) => (out = Buffer.concat([out, d])));
    p.stdin.end(encode({ type: 'start' })); // like Chrome: message, then EOF
    const code = await new Promise((r) => p.on('exit', r));

    expect(code).toBe(0);
    expect(decode(out).messages).toEqual([
      { ok: true, token: 'a'.repeat(48), url: `http://127.0.0.1:${server.address().port}` },
    ]);
  });
});
