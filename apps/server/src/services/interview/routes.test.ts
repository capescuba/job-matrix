import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AudioEngine, EngineEvent, EngineStatus, StartOptions } from '@jm/audio-engine';
import type { BlocksRequest, LLMProvider, StructuredRequest } from '@jm/ai';
import type { CoachHint, Debrief } from '@jm/shared';
import { buildApp } from '../../app.ts';
import { openDb, type Db } from '../../db/client.ts';
import { activities } from '../../db/schema.ts';
import { createApplication } from '../applications.ts';
import { activeSessionCount } from './session.ts';

const hint: CoachHint = {
  question: 'Why are you leaving Workday?',
  probing: 'Motivation, flight risk',
  points: ['Ready for customer-facing delivery', 'Built agentic AI platform'],
  story: 'Workday: agentic AI platform',
  watch: null,
  askBack: null,
};
const debrief: Debrief = {
  summary: 'Solid screen. They want an FDE with program depth.',
  questions: [],
  theyShared: ['Two more rounds'],
  followUps: [],
  thankYouPoints: ['Customer delivery'],
  nextRound: null,
};

/** Plays the part of engine.py: records what it was asked and lets the test push events. */
class FakeEngine implements AudioEngine {
  readonly name = 'fake';
  started: StartOptions | null = null;
  private listeners = new Set<(s: EngineStatus) => void>();
  private current: EngineStatus = { phase: 'stopped' };
  status() {
    return this.current;
  }
  onStatus(l: (s: EngineStatus) => void) {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }
  async ensureReady() {
    this.current = { phase: 'ready', device: 'cuda' };
    for (const l of this.listeners) l(this.current);
  }
  async listDevices() {
    return {
      inputs: [{ index: 1, name: 'Headset Mic', isDefault: true }],
      outputs: [{ index: 2, name: 'Headphones [Loopback]', isDefault: true }],
    };
  }
  async start(o: StartOptions) {
    await this.ensureReady();
    this.started = o;
    if (o.record) {
      fs.mkdirSync(o.dir, { recursive: true });
      fs.writeFileSync(path.join(o.dir, 'me.wav'), Buffer.alloc(44 + 32_000));
      fs.writeFileSync(path.join(o.dir, 'them.wav'), Buffer.alloc(44 + 32_000));
    }
    return { mic: { name: 'Headset Mic', rate: 48000 }, output: { name: 'Headphones [Loopback]', rate: 48000 } };
  }
  push(e: EngineEvent) {
    this.started?.onEvent(e);
  }
  async stop() {
    this.push({ type: 'final', track: 'me', text: 'Thanks so much for your time.', startMs: 9000, endMs: 10_500 });
    return { durationMs: 11_000, files: { me: 'me.wav', them: 'them.wav' } };
  }
  async shutdown() {}
}

const provider = (): LLMProvider => ({
  name: 'fake',
  defaultModel: 'm',
  complete: async () => '',
  completeStructured: (async (req: StructuredRequest<never>) => ({
    data: req.system.startsWith('You debrief') ? debrief : null,
    provider: 'fake',
    model: 'claude-opus-5-5',
    usage: { inputTokens: 100, outputTokens: 100 },
  })) as unknown as LLMProvider['completeStructured'],
  completeBlocks: (async (req: BlocksRequest<never>) => {
    req.onEvent?.({ type: 'output', text: '{"question":"Why are' });
    return { data: hint, provider: 'fake', model: 'claude-sonnet-5-5', usage: { inputTokens: 50, outputTokens: 40, cacheReadTokens: 9000 } };
  }) as unknown as LLMProvider['completeBlocks'],
});

/** Reads Server-Sent Events into an array as they arrive. */
async function sse(url: string) {
  const res = await fetch(url);
  const events: Record<string, unknown>[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let open = true;
  void (async () => {
    while (open) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (chunk.startsWith('data: ')) events.push(JSON.parse(chunk.slice(6)));
      }
    }
  })();
  return {
    events,
    close: () => {
      open = false;
      void reader.cancel();
    },
    until: async (pred: (e: Record<string, unknown>) => boolean) => {
      for (let i = 0; i < 200; i++) {
        if (events.some(pred)) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`event never came; got ${JSON.stringify(events.map((e) => e.type))}`);
    },
  };
}

let db: Db;
let root: string;
let engine: FakeEngine;
let app: ReturnType<typeof buildApp>;
let base: string;
let appId: number;

beforeEach(async () => {
  db = openDb(':memory:');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-coach-'));
  engine = new FakeEngine();
  app = buildApp(db, {
    interview: { audioEngine: engine, provider, root, rememberDevices: () => {} },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  appId = createApplication(db, { company: 'Acme', title: 'Forward Deployed Engineer' });
});
afterEach(async () => {
  await app.close();
});

const post = (url: string, body?: unknown) =>
  fetch(base + url, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

describe('interview coach routes', () => {
  it('runs a whole call: stream, start, transcript, coach card, stop, recording, debrief', async () => {
    const created = await post(`/api/applications/${appId}/interviews`, { round: 'Recruiter screen' });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: number };

    const stream = await sse(`${base}/api/interviews/${id}/events`);
    await stream.until((e) => e.type === 'snapshot');

    const start = await post(`/api/interviews/${id}/start`);
    expect(start.status).toBe(200);
    expect(engine.started).toMatchObject({ record: true, prompt: 'Acme, Forward Deployed Engineer' });
    expect(activeSessionCount()).toBe(1);

    engine.push({ type: 'level', track: 'them', rms: 0.2, ms: 2000 });
    engine.push({ type: 'partial', track: 'them', text: 'So why are you', startMs: 1000 });
    engine.push({ type: 'final', track: 'them', text: 'So why are you leaving Workday?', startMs: 1000, endMs: 3000 });
    await stream.until((e) => e.type === 'hint' && e.phase === 'done');

    const types = stream.events.map((e) => (e.type === 'hint' ? `hint:${e.phase}` : e.type));
    expect(types).toEqual(
      expect.arrayContaining(['snapshot', 'status', 'started', 'level', 'transcript', 'hint:start', 'hint:delta', 'hint:done']),
    );

    // A page opened mid-call gets everything so far.
    const late = await sse(`${base}/api/interviews/${id}/events`);
    await late.until((e) => e.type === 'snapshot');
    const snap = late.events[0].snapshot as { live: boolean; turns: unknown[]; hint: { hint: CoachHint } };
    expect(snap.live).toBe(true);
    expect(snap.turns).toHaveLength(1);
    expect(snap.hint.hint.probing).toBe('Motivation, flight risk');
    late.close();

    // Deleting a running call is refused.
    expect((await fetch(`${base}/api/interviews/${id}`, { method: 'DELETE' })).status).toBe(409);

    const stopped = await post(`/api/interviews/${id}/stop`);
    expect(await stopped.json()).toEqual({ durationMs: 11_000 });
    await stream.until((e) => e.type === 'audioReady');
    stream.close();
    expect(activeSessionCount()).toBe(0);

    const detail = (await (await fetch(`${base}/api/interviews/${id}`)).json()) as {
      segments: { speaker: string }[];
      hints: unknown[];
      audioFile: string | null;
      endedAt: string | null;
      company: string;
    };
    expect(detail.segments.map((s) => s.speaker)).toEqual(['them', 'me']);
    expect(detail.hints).toHaveLength(1);
    expect(detail.endedAt).not.toBeNull();
    expect(detail.company).toBe('Acme');
    // ffmpeg may or may not be on this machine: either the merged file or a kept WAV.
    expect(['call.ogg', 'them.wav']).toContain(detail.audioFile);

    const audio = await fetch(`${base}/api/interviews/${id}/audio`, { headers: { Range: 'bytes=0-9' } });
    expect(audio.status).toBe(206);
    expect(audio.headers.get('content-range')).toMatch(/^bytes 0-9\//);
    expect((await audio.arrayBuffer()).byteLength).toBe(10);

    const d = await post(`/api/interviews/${id}/debrief`);
    expect(d.status).toBe(200);
    expect(((await d.json()) as Debrief).summary).toMatch(/Solid screen/);
    expect(db.select().from(activities).all().filter((a) => a.kind === 'Interview')).toHaveLength(1);

    const list = (await (await fetch(`${base}/api/applications/${appId}/interviews`)).json()) as {
      hasSummary: boolean;
    }[];
    expect(list[0].hasSummary).toBeTruthy();

    expect((await fetch(`${base}/api/interviews/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect(fs.existsSync(path.join(root, String(id)))).toBe(false);
  });

  it('refuses a debrief before the call has ended, and a second call while one is running', async () => {
    const a = (await (await post(`/api/applications/${appId}/interviews`, { round: 'Technical' })).json()) as { id: number };
    const b = (await (await post(`/api/applications/${appId}/interviews`, { round: 'Technical' })).json()) as { id: number };
    expect((await post(`/api/interviews/${a.id}/debrief`)).status).toBe(409);
    expect((await post(`/api/interviews/${a.id}/start`)).status).toBe(200);
    expect((await post(`/api/interviews/${b.id}/start`)).status).toBe(409);
    await post(`/api/interviews/${a.id}/stop`);
  });

  it('lists devices and reports the engine', async () => {
    const d = (await (await fetch(`${base}/api/interview/devices`)).json()) as { outputs: { name: string }[] };
    expect(d.outputs[0].name).toBe('Headphones [Loopback]');
    const e = (await (await fetch(`${base}/api/interview/engine`)).json()) as { installed: boolean };
    expect(e.installed).toBe(true);
  });

  it('rejects an unknown round', async () => {
    expect((await post(`/api/applications/${appId}/interviews`, { round: 'Coffee chat' })).status).toBe(400);
  });
});
