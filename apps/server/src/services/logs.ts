/**
 * The app's log files in data/, for the Log page. Only a fixed set of names is ever served:
 * the server's output and errors (this run and the last three), and the web build's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../paths.ts';

const LOG_NAME = /^(server(-error)?(\.[1-3])?|build(-error)?)\.log$/;
const MAX_BYTES = 2 * 1024 * 1024;

export const isLogName = (name: string) => LOG_NAME.test(name);

function describe(name: string) {
  const run = name.match(/\.(\d)\.log$/)?.[1];
  const which = run ? `${run} run${run === '1' ? '' : 's'} ago` : 'this run';
  if (name.startsWith('server-error')) return { group: 'errors', label: `Errors (${which})` };
  if (name.startsWith('server'))
    return { group: 'server', label: run ? `Previous run (${which})` : 'This run' };
  return { group: 'build', label: name.startsWith('build-error') ? 'Build errors' : 'Build' };
}

export function listLogs(dir = DATA_DIR) {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter(isLogName);
  } catch {
    return [];
  }
  const order = (n: string) =>
    (n.startsWith('build') ? 100 : 0) +
    (n.includes('-error') ? 10 : 0) +
    Number(n.match(/\.(\d)\.log$/)?.[1] ?? 0);
  return names
    .map((name) => {
      const st = fs.statSync(path.join(dir, name));
      return { name, size: st.size, modified: st.mtime.toISOString(), ...describe(name) };
    })
    .sort((a, b) => order(a.name) - order(b.name));
}

const LEVELS: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

export interface LogEntry {
  n: number;
  time: string | null;
  level: string;
  msg: string;
  /** Named app event ("mail.sync.done"), "http" for a request line, null for plain text. */
  event: string | null;
  /** A request that went fine (2xx/3xx) — hidden by "Hide routine requests". */
  routine: boolean;
  details: Record<string, unknown> | null;
}

/** One line of the log: the server writes JSON (pino); anything else is shown as it is. */
export function parseLine(line: string, n: number): LogEntry {
  const plain = (level = 'info'): LogEntry => ({
    n,
    time: null,
    level,
    msg: line,
    event: null,
    routine: false,
    details: null,
  });
  if (!line.startsWith('{')) return plain(/error|exception|fail/i.test(line) ? 'error' : 'info');
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line);
  } catch {
    return plain();
  }
  const {
    level,
    time,
    msg,
    pid: _pid,
    hostname: _host,
    event,
    ...rest
  } = o as {
    level?: number;
    time?: number;
    msg?: string;
    pid?: unknown;
    hostname?: unknown;
    event?: string;
    [k: string]: unknown;
  };
  const lvl = LEVELS[level ?? 30] ?? 'info';
  // Fastify's own request lines (older logs): "incoming request" / "request completed".
  const req = rest.req as { method?: string; url?: string } | undefined;
  const res = rest.res as { statusCode?: number } | undefined;
  let text = msg ?? '';
  let ev = event ?? null;
  let routine = false;
  if (msg === 'incoming request' || msg === 'request completed') {
    ev = 'http';
    const status = res?.statusCode;
    text =
      msg === 'incoming request'
        ? `→ ${req?.method} ${req?.url}`
        : `← ${status} (${Math.round(Number(rest.responseTime) || 0)} ms)`;
    routine = !status || status < 400;
  } else if (event === 'http') {
    routine = Number(rest.status) < 400;
  }
  if (rest.err && typeof rest.err === 'object') {
    const e = rest.err as { message?: string };
    if (!text || text === e.message) text = e.message ?? text;
  }
  return {
    n,
    time: typeof time === 'number' ? new Date(time).toISOString() : null,
    level: lvl,
    msg: text,
    event: ev,
    routine,
    details: Object.keys(rest).length ? rest : null,
  };
}

/** The last `lines` lines of a log file (reads only its end when it's big). */
export function readLog(name: string, lines = 2000, dir = DATA_DIR) {
  if (!isLogName(name)) throw new Error('Not a log file');
  const file = path.join(dir, name);
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { name, size: 0, truncated: false, entries: [] as LogEntry[] };
  }
  const start = Math.max(0, size - MAX_BYTES);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(size - start);
  try {
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  // Windows PowerShell may write UTF-16 for redirected error output.
  let text = buf.includes(0)
    ? buf.toString('utf16le').replace(/^﻿/, '')
    : buf.toString('utf8').replace(/^﻿/, '');
  let all = text.split(/\r?\n/);
  if (start > 0) all = all.slice(1); // first line is cut off
  while (all.length && !all.at(-1)) all.pop();
  const truncated = start > 0 || all.length > lines;
  const firstN = Math.max(0, all.length - lines);
  return {
    name,
    size,
    truncated,
    entries: all.slice(firstN).map((l, i) => parseLine(l, firstN + i + 1)),
  };
}
