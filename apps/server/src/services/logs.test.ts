import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MailClient } from '@jm/mail';
import { buildApp } from '../app.ts';
import { openDb } from '../db/client.ts';
import { isLogName, listLogs, parseLine, readLog } from './logs.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jm-logs-'));

describe('log files', () => {
  it('serves only the app’s own log files', () => {
    for (const ok of [
      'server.log',
      'server-error.log',
      'server.1.log',
      'server-error.3.log',
      'build.log',
      'build-error.log',
    ])
      expect(isLogName(ok)).toBe(true);
    for (const bad of [
      '../.env',
      'jobmatrix.db',
      'server.9.log',
      '..\\server.log',
      'server.log/..',
      'extension-token',
      'native-host.cmd',
    ])
      expect(isLogName(bad)).toBe(false);
    expect(() => readLog('../.env')).toThrow();
  });

  it('lists them this-run first, with plain labels', () => {
    const dir = tmp();
    for (const n of ['build.log', 'server.1.log', 'server-error.log', 'server.log', 'notes.txt'])
      fs.writeFileSync(path.join(dir, n), 'x');
    expect(listLogs(dir).map((l) => [l.name, l.label])).toEqual([
      ['server.log', 'This run'],
      ['server.1.log', 'Previous run (1 run ago)'],
      ['server-error.log', 'Errors (this run)'],
      ['build.log', 'Build'],
    ]);
  });

  it('reads JSON lines into time, level, message and event', () => {
    const e = parseLine(
      JSON.stringify({
        level: 30,
        time: 1790373783939,
        pid: 1,
        hostname: 'h',
        event: 'mail.sync.done',
        scanned: 5,
        msg: 'Checked 5 emails',
      }),
      1,
    );
    expect(e).toMatchObject({
      level: 'info',
      event: 'mail.sync.done',
      msg: 'Checked 5 emails',
      routine: false,
      details: { scanned: 5 },
    });
    expect(e.time).toBe(new Date(1790373783939).toISOString());
    // Our one-line request entries, and Fastify's older two-line ones.
    expect(
      parseLine(
        JSON.stringify({ level: 30, event: 'http', status: 200, msg: 'GET /api/x → 200' }),
        2,
      ).routine,
    ).toBe(true);
    expect(
      parseLine(JSON.stringify({ level: 50, event: 'http', status: 500, msg: 'boom' }), 3),
    ).toMatchObject({ level: 'error', routine: false });
    expect(
      parseLine(
        JSON.stringify({
          level: 30,
          msg: 'incoming request',
          req: { method: 'GET', url: '/api/health' },
        }),
        4,
      ),
    ).toMatchObject({
      event: 'http',
      routine: true,
      msg: '→ GET /api/health',
    });
    expect(parseLine('Error: listen EADDRINUSE', 5)).toMatchObject({ level: 'error', event: null });
  });

  it('reads just the end of a big file', () => {
    const dir = tmp();
    const lines = Array.from({ length: 50_000 }, (_, i) =>
      JSON.stringify({ level: 30, time: 0, msg: `line ${i} ${'x'.repeat(40)}` }),
    );
    fs.writeFileSync(path.join(dir, 'server.log'), `${lines.join('\n')}\n`);
    const r = readLog('server.log', 100, dir);
    expect(r.truncated).toBe(true);
    expect(r.entries).toHaveLength(100);
    expect(r.entries.at(-1)!.msg).toMatch(/^line 49999 /);
  });

  it('reads UTF-16 error output from PowerShell', () => {
    const dir = tmp();
    fs.writeFileSync(
      path.join(dir, 'server-error.log'),
      Buffer.from('﻿node: something failed\r\n', 'utf16le'),
    );
    expect(readLog('server-error.log', 10, dir).entries.map((e) => e.msg)).toEqual([
      'node: something failed',
    ]);
  });
});

describe('email and log routes', () => {
  const fakeMail = {
    tokenPath: '',
    accessToken: async () => 't',
    startSignIn: async () => ({
      userCode: 'ABCD',
      verificationUri: 'https://microsoft.com/link',
      expiresAt: 1,
      done: new Promise(() => {}),
    }),
    status: async () => ({
      configured: true,
      signedIn: false,
      account: null,
      signingIn: null,
      lastError: null,
    }),
    async *messagesSince() {},
    message: async () => {
      throw new Error('none');
    },
  } as unknown as MailClient;

  it('status, connect, manual-by-default settings, and the log list', async () => {
    const app = buildApp(openDb(':memory:'), { mail: fakeMail });
    const s = (await app.inject({ method: 'GET', url: '/api/mail/status' })).json();
    expect(s).toMatchObject({
      configured: true,
      signedIn: false,
      intervalMinutes: -1,
      enabled: true,
      pending: 0,
      nextSyncAt: null,
    });
    expect(s.askAiUsd).toBeGreaterThan(0);
    const c = (await app.inject({ method: 'POST', url: '/api/mail/connect' })).json();
    expect(c).toMatchObject({ userCode: 'ABCD', verificationUri: 'https://microsoft.com/link' });
    const set = await app.inject({
      method: 'POST',
      url: '/api/mail/settings',
      payload: { intervalMinutes: 15 },
    });
    expect(set.json()).toMatchObject({ intervalMinutes: 15 });
    expect(set.json().nextSyncAt).not.toBeNull();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/mail/settings',
          payload: { intervalMinutes: 7 },
        })
      ).statusCode,
    ).toBe(400);
    await app.inject({
      method: 'POST',
      url: '/api/mail/settings',
      payload: { intervalMinutes: -1 },
    });
    expect((await app.inject({ method: 'GET', url: '/api/email-updates' })).json()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/logs/..%2F.env' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/logs' })).statusCode).toBe(200);
  });
});
