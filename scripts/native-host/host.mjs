// Job Matrix native helper for the Chrome extension. Chrome starts it for each message.
//   {type:'start'} → starts Job Matrix if it isn't running, then replies {ok, token, url}
//   {type:'token'} → replies {ok, token}
// Registered by scripts/install-extension.ps1 (per user; only the Job Matrix extension may call it).
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, encode } from './protocol.mjs';

// The Job Matrix folder it serves: --root "<dir>" (set by install-extension.ps1), else this repo.
const rootArg = process.argv.indexOf('--root');
const root =
  rootArg > 0 && process.argv[rootArg + 1]
    ? path.resolve(process.argv[rootArg + 1])
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tokenFile = path.join(root, 'data', 'extension-token');
const APP_URL = 'http://127.0.0.1:5174';

/** Same format the server creates (services/token.ts) — whichever runs first makes it. */
function token() {
  try {
    const t = fs.readFileSync(tokenFile, 'utf8').trim();
    if (t) return t;
  } catch {
    // not created yet
  }
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  const t = randomBytes(24).toString('hex');
  fs.writeFileSync(tokenFile, t);
  return t;
}

async function up() {
  try {
    const r = await fetch(`${APP_URL}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Runs the normal launcher without opening a tab. It's started through WMI so it isn't part of
 * this helper's process tree — Chrome ends the helper as soon as it has replied.
 */
function launch() {
  const script = path.join(root, 'scripts', 'launch.ps1');
  const cmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}" -NoBrowser`;
  return new Promise((resolve) =>
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmd.replace(/'/g, "''")}'; CurrentDirectory = '${root.replace(/'/g, "''")}' } | Out-Null`,
      ],
      { windowsHide: true },
      () => resolve(),
    ),
  );
}

async function handle(msg) {
  if (msg?.type === 'token') return { ok: true, token: token() };
  if (msg?.type === 'start') {
    if (!(await up())) {
      await launch();
      const deadline = Date.now() + 60_000; // the first start may rebuild the UI
      while (!(await up())) {
        if (Date.now() > deadline)
          return {
            ok: false,
            error: `Job Matrix didn't start. See ${path.join(root, 'data', 'server-error.log')}`,
          };
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    return { ok: true, token: token(), url: APP_URL };
  }
  return { ok: false, error: `Unknown message type: ${msg?.type}` };
}

let buf = Buffer.alloc(0);
process.stdin.on('data', async (chunk) => {
  const { messages, rest } = decode(Buffer.concat([buf, chunk]));
  buf = rest;
  for (const m of messages) {
    let reply;
    try {
      reply = await handle(m);
    } catch (e) {
      reply = { ok: false, error: String(e?.message ?? e) };
    }
    process.stdout.write(encode(reply));
  }
});
process.stdin.on('end', () => process.exit(0));
