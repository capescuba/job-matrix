import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import {
  EngineError,
  type AudioDevice,
  type AudioEngine,
  type EngineEvent,
  type EnginePhase,
  type EngineStatus,
  type StartOptions,
  type StartResult,
  type StopResult,
} from './types.ts';

export interface LocalEngineOptions {
  /** The venv's python.exe. */
  pythonExe: string;
  /** apps/audio-engine/engine.py */
  enginePy: string;
  port?: number;
  model?: string;
  /** Lines the engine prints (JSON) or errors on stderr. */
  onLog?: (line: string, stream: 'out' | 'err') => void;
  /** Give up waiting for the model after this long (first run downloads about 1.6 GB). */
  startupTimeoutMs?: number;
  /** Poll interval while the model loads. */
  pollMs?: number;
}

interface Pending {
  types: string[];
  resolve: (m: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  /** An engine error with this `for` rejects the request. */
  forKind: string;
}

/** Talks to apps/audio-engine/engine.py over HTTP /health and one control WebSocket. */
export class LocalAudioEngine implements AudioEngine {
  readonly name = 'whisper-local';
  private readonly port: number;
  private readonly model: string;
  private readonly timeout: number;
  private readonly pollMs: number;
  private current: EngineStatus = { phase: 'stopped' };
  private readonly listeners = new Set<(s: EngineStatus) => void>();
  private child: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private ready: Promise<void> | null = null;
  private pending: Pending[] = [];
  private onEvent: ((e: EngineEvent) => void) | null = null;

  constructor(private readonly o: LocalEngineOptions) {
    this.port = o.port ?? 5175;
    this.model = o.model ?? 'large-v3-turbo';
    this.timeout = o.startupTimeoutMs ?? 10 * 60_000;
    this.pollMs = o.pollMs ?? 500;
  }

  status(): EngineStatus {
    return this.current;
  }

  onStatus(listener: (s: EngineStatus) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private setStatus(phase: EnginePhase, detail?: string, device?: string) {
    this.current = { phase, ...(detail && { detail }), ...(device && { device }) };
    for (const l of this.listeners) l(this.current);
  }

  private async health(): Promise<{ phase: EnginePhase; detail?: string; device?: string } | null> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      return (await res.json()) as { phase: EnginePhase; detail?: string; device?: string };
    } catch {
      return null;
    }
  }

  ensureReady(): Promise<void> {
    if (this.current.phase === 'ready' && this.ws?.readyState === WebSocket.OPEN)
      return Promise.resolve();
    this.ready ??= this.boot().finally(() => {
      this.ready = null;
    });
    return this.ready;
  }

  private async boot(): Promise<void> {
    let h = await this.health();
    if (h) this.setStatus(h.phase, h.detail, h.device);
    else {
      this.spawnEngine();
      this.setStatus('starting');
    }
    const deadline = Date.now() + this.timeout;
    for (;;) {
      h = await this.health();
      if (h) {
        this.setStatus(h.phase, h.detail, h.device);
        if (h.phase === 'ready') break;
        if (h.phase === 'error')
          throw new EngineError(`The speech engine failed to start: ${h.detail ?? 'unknown error'}`);
      } else if (!this.child) {
        this.setStatus('error', 'The speech engine is not running.');
        throw new EngineError('The speech engine is not running and could not be started.');
      }
      if (Date.now() > deadline) {
        this.setStatus('error', 'Timed out loading the speech model.');
        throw new EngineError('Timed out waiting for the speech model to load.');
      }
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
    await this.connect();
  }

  private spawnEngine() {
    const child = spawn(
      this.o.pythonExe,
      [this.o.enginePy, '--port', String(this.port), '--model', this.model],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: path.dirname(this.o.enginePy) },
    );
    this.child = child;
    const lines = (stream: NodeJS.ReadableStream, kind: 'out' | 'err') => {
      let buf = '';
      stream.on('data', (d: Buffer) => {
        buf += d.toString('utf8');
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) this.o.onLog?.(line, kind);
        }
      });
    };
    lines(child.stdout!, 'out');
    lines(child.stderr!, 'err');
    child.on('error', (e) => {
      this.o.onLog?.(`spawn failed: ${e.message}`, 'err');
      this.child = null;
      this.setStatus('error', e.message);
    });
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      this.ws = null;
      this.failPending(new EngineError(`The speech engine stopped (exit ${code}).`));
      this.setStatus('stopped');
    });
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}/control`);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        this.ws = ws;
        resolve();
      };
      ws.onerror = () => reject(new EngineError('Could not connect to the speech engine.'));
      ws.onmessage = (m) => this.handle(typeof m.data === 'string' ? m.data : '');
      ws.onclose = () => {
        if (this.ws === ws) this.ws = null;
        this.failPending(new EngineError('The connection to the speech engine was lost.'));
      };
    });
  }

  private handle(raw: string) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.type === 'event') {
      this.onEvent?.(msg.event as EngineEvent);
      return;
    }
    if (msg.type === 'error') {
      const i = this.pending.findIndex((p) => p.forKind === msg.for);
      if (i >= 0) {
        const [p] = this.pending.splice(i, 1);
        p.reject(new EngineError(String(msg.message ?? 'Speech engine error')));
      } else this.onEvent?.({ type: 'error', message: String(msg.message ?? 'Speech engine error') });
      return;
    }
    const i = this.pending.findIndex((p) => p.types.includes(String(msg.type)));
    if (i >= 0) this.pending.splice(i, 1)[0].resolve(msg);
  }

  private failPending(e: Error) {
    const list = this.pending;
    this.pending = [];
    for (const p of list) p.reject(e);
  }

  private request(
    body: Record<string, unknown>,
    reply: string,
    timeoutMs = 30_000,
  ): Promise<Record<string, unknown>> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN)
      return Promise.reject(new EngineError('The speech engine is not connected.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = this.pending.filter((p) => p !== entry);
        reject(new EngineError(`The speech engine did not answer (${String(body.type)}).`));
      }, timeoutMs);
      const entry: Pending = {
        types: [reply],
        forKind: String(body.type),
        resolve: (m) => (clearTimeout(timer), resolve(m)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      };
      this.pending.push(entry);
      ws.send(JSON.stringify(body));
    });
  }

  async listDevices() {
    await this.ensureReady();
    const m = await this.request({ type: 'devices' }, 'devices');
    return { inputs: m.inputs as AudioDevice[], outputs: m.outputs as AudioDevice[] };
  }

  async start(opts: StartOptions): Promise<StartResult> {
    await this.ensureReady();
    this.onEvent = opts.onEvent;
    try {
      const m = await this.request(
        {
          type: 'start',
          dir: opts.dir,
          mic: opts.mic,
          output: opts.output,
          record: opts.record,
          language: opts.language ?? 'en',
          prompt: opts.prompt ?? '',
        },
        'started',
      );
      return { mic: m.mic as StartResult['mic'], output: m.output as StartResult['output'] };
    } catch (e) {
      this.onEvent = null;
      throw e;
    }
  }

  async stop(): Promise<StopResult> {
    try {
      const m = await this.request({ type: 'stop' }, 'stopped', 120_000);
      return {
        durationMs: Number(m.durationMs ?? 0),
        files: (m.files as StopResult['files']) ?? null,
      };
    } finally {
      this.onEvent = null;
    }
  }

  async shutdown() {
    this.ws?.close();
    this.ws = null;
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill();
    this.setStatus('stopped');
  }
}
