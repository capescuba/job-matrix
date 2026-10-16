import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { LocalAudioEngine } from './localEngine.ts';
import type { EngineEvent, EngineStatus } from './types.ts';

/** A stand-in for engine.py: /health and /control on a loopback port. No sound device, no GPU. */
async function fakeEngine(phases: string[]) {
  const sockets: ServerSocket[] = [];
  const received: Record<string, unknown>[] = [];
  let polls = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      const phase = phases[Math.min(polls++, phases.length - 1)];
      res.writeHead(phase === 'ready' ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ phase, device: phase === 'ready' ? 'cuda' : undefined }));
    } else res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server, path: '/control' });
  wss.on('connection', (ws) => {
    sockets.push(ws);
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as Record<string, unknown>;
      received.push(msg);
      if (msg.type === 'devices')
        ws.send(
          JSON.stringify({
            type: 'devices',
            inputs: [{ index: 1, name: 'Headset Mic', isDefault: true }],
            outputs: [{ index: 7, name: 'Speakers [Loopback]', isDefault: true }],
          }),
        );
      if (msg.type === 'start') {
        if (msg.mic === 'missing') {
          ws.send(JSON.stringify({ type: 'error', for: 'start', message: 'No microphone found.' }));
          return;
        }
        ws.send(
          JSON.stringify({
            type: 'started',
            mic: { name: 'Headset Mic', rate: 48000 },
            output: { name: 'Speakers [Loopback]', rate: 48000 },
          }),
        );
        ws.send(
          JSON.stringify({
            type: 'event',
            event: { type: 'final', track: 'them', text: 'Tell me about yourself', startMs: 500, endMs: 2400 },
          }),
        );
      }
      if (msg.type === 'stop')
        ws.send(
          JSON.stringify({ type: 'stopped', durationMs: 61_000, files: { me: 'me.wav', them: 'them.wav' } }),
        );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    received,
    sockets,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.terminate();
        wss.close(() => server.close(() => r()));
      }),
  };
}

let toClose: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of toClose) await c();
  toClose = [];
});

async function setup(phases: string[]) {
  const fake = await fakeEngine(phases);
  toClose.push(fake.close);
  const engine = new LocalAudioEngine({
    pythonExe: 'not-used',
    enginePy: 'not-used',
    port: fake.port,
    pollMs: 5,
  });
  toClose.push(() => engine.shutdown());
  return { fake, engine };
}

describe('LocalAudioEngine', () => {
  it('waits for the model to load, reporting each phase, then connects', async () => {
    const { engine } = await setup(['loading', 'loading', 'ready']);
    const seen: EngineStatus[] = [];
    engine.onStatus((s) => seen.push(s));
    await engine.ensureReady();
    expect(seen.map((s) => s.phase)).toEqual(['loading', 'loading', 'ready']);
    expect(engine.status()).toEqual({ phase: 'ready', device: 'cuda' });
    await engine.ensureReady(); // already connected: no new polling
  });

  it('lists devices', async () => {
    const { engine } = await setup(['ready']);
    const d = await engine.listDevices();
    expect(d.inputs[0]).toMatchObject({ name: 'Headset Mic', isDefault: true });
    expect(d.outputs[0].name).toBe('Speakers [Loopback]');
  });

  it('starts a call, relays events, and stops with the recording files', async () => {
    const { engine, fake } = await setup(['ready']);
    const events: EngineEvent[] = [];
    const started = await engine.start({
      dir: 'C:/data/interviews/1',
      mic: null,
      output: null,
      record: true,
      prompt: 'Acme, TPM',
      onEvent: (e) => events.push(e),
    });
    expect(started.output).toEqual({ name: 'Speakers [Loopback]', rate: 48000 });
    expect(fake.received.find((m) => m.type === 'start')).toMatchObject({
      dir: 'C:/data/interviews/1',
      record: true,
      language: 'en',
      prompt: 'Acme, TPM',
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual([
      { type: 'final', track: 'them', text: 'Tell me about yourself', startMs: 500, endMs: 2400 },
    ]);
    const stopped = await engine.stop();
    expect(stopped).toEqual({ durationMs: 61_000, files: { me: 'me.wav', them: 'them.wav' } });
  });

  it('turns an engine error into a rejection with its message', async () => {
    const { engine } = await setup(['ready']);
    await expect(
      engine.start({ dir: 'x', mic: 'missing', output: null, record: false, onEvent: () => {} }),
    ).rejects.toThrow('No microphone found.');
  });

  it('fails clearly when the engine reports an error while loading', async () => {
    const { engine } = await setup(['loading', 'error']);
    await expect(engine.ensureReady()).rejects.toThrow(/failed to start/);
  });

  it('rejects requests when the connection drops mid-call', async () => {
    const { engine, fake } = await setup(['ready']);
    await engine.ensureReady();
    for (const s of fake.sockets) s.terminate();
    await new Promise((r) => setTimeout(r, 30));
    await expect(engine.stop()).rejects.toThrow(/not connected/);
  });
});
