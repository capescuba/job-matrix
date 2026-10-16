import fs from 'node:fs';
import type { AudioEngine, EngineEvent, EngineStatus } from '@jm/audio-engine';
import { getProvider, type LLMProvider } from '@jm/ai';
import type { CoachHint, Speaker } from '@jm/shared';
import type { Db } from '../../db/client.ts';
import { INTERVIEWS_DIR } from '../../paths.ts';
import { logEvent } from '../log.ts';
import { updateSettings } from '../settings.ts';
import {
  CoachRunner,
  CoachScheduler,
  CoachTranscript,
  type CoachEvent,
  type CoachTrigger,
} from './coach.ts';
import { loadCoachContext, type CoachContext } from './context.ts';
import { mergeRecording } from './recording.ts';
import {
  appendSegment,
  endSession,
  getSessionRow,
  sessionDir,
  setAsked,
  setAudio,
  startSession,
  unfinishedSessions,
} from './store.ts';
import { wavDurationMs } from './recording.ts';
import path from 'node:path';

export interface TurnView {
  id: number;
  speaker: Speaker;
  text: string;
  startMs: number;
  endMs: number;
}

/** Everything the browser needs to draw the live view; sent on connect, so a reload loses nothing. */
export interface Snapshot {
  sessionId: number;
  engine: EngineStatus;
  live: boolean;
  startedAt: string | null;
  ended: boolean;
  mic: string | null;
  output: string | null;
  turns: TurnView[];
  pending: { me: string | null; them: string | null };
  hint: { text: string; done: boolean; hint: CoachHint | null } | null;
  audioFile: string | null;
}

export type SessionEvent =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'status'; engine: EngineStatus }
  | { type: 'started'; startedAt: string; mic: string | null; output: string | null }
  | { type: 'transcript'; speaker: Speaker; text: string; startMs: number; endMs?: number; final: boolean; segmentId?: number }
  | { type: 'speech'; speaker: Speaker; active: boolean; ms: number }
  | { type: 'level'; speaker: Speaker; rms: number }
  | CoachEvent
  | { type: 'stopped'; durationMs: number }
  | { type: 'audioReady'; audioFile: string | null; audioMs: number }
  | { type: 'error'; message: string; speaker?: Speaker };

export interface SessionDeps {
  db: Db;
  engine: AudioEngine;
  /** Resolved when the call starts, so a missing API key only matters then. */
  provider?: () => LLMProvider;
  root?: string;
  /** Saves the devices that worked; defaults to .env via updateSettings (tests pass a no-op). */
  rememberDevices?: (mic: string | null, output: string | null) => void;
}

const saveDevices = (mic: string | null, output: string | null) =>
  updateSettings({
    ...(mic && { AUDIO_MIC_DEVICE: mic }),
    ...(output && { AUDIO_OUTPUT_DEVICE: output }),
  });

export class InterviewSession {
  private readonly subscribers = new Set<(e: SessionEvent) => void>();
  private ctx: CoachContext | null = null;
  private readonly transcript = new CoachTranscript();
  private runner: CoachRunner | null = null;
  private scheduler: CoachScheduler | null = null;
  private turns: TurnView[] = [];
  private pending: { me: string | null; them: string | null } = { me: null, them: null };
  private hint: Snapshot['hint'] = null;
  private mic: string | null = null;
  private output: string | null = null;
  private startedAt: string | null = null;
  private ended = false;
  private audioFile: string | null = null;
  private lastEngineMs = 0;
  private unsubscribeStatus: (() => void) | null = null;
  private starting = false;

  constructor(
    readonly id: number,
    private readonly d: SessionDeps,
  ) {
    const row = getSessionRow(d.db, id);
    this.startedAt = row.startedAt;
    this.ended = Boolean(row.endedAt);
    this.audioFile = row.audioFile;
  }

  get live() {
    return this.startedAt != null && !this.ended;
  }

  /** True while the engine is being started or a call is running; keeps the server awake. */
  get busy() {
    return this.starting || this.live;
  }

  snapshot(): Snapshot {
    return {
      sessionId: this.id,
      engine: this.d.engine.status(),
      live: this.live,
      startedAt: this.startedAt,
      ended: this.ended,
      mic: this.mic,
      output: this.output,
      turns: this.turns,
      pending: this.pending,
      hint: this.hint,
      audioFile: this.audioFile,
    };
  }

  /** Sends the current state first, then every event after it. */
  subscribe(fn: (e: SessionEvent) => void): () => void {
    this.subscribers.add(fn);
    this.unsubscribeStatus ??= this.d.engine.onStatus((s) => this.emit({ type: 'status', engine: s }));
    fn({ type: 'snapshot', snapshot: this.snapshot() });
    return () => {
      this.subscribers.delete(fn);
      if (!this.subscribers.size && !this.busy) {
        this.unsubscribeStatus?.();
        this.unsubscribeStatus = null;
      }
    };
  }

  get subscriberCount() {
    return this.subscribers.size;
  }

  private emit(e: SessionEvent) {
    for (const s of this.subscribers) {
      try {
        s(e);
      } catch {
        // a closed client must not break the call
      }
    }
  }

  async start(): Promise<void> {
    if (this.live || this.starting) throw new Error('This call is already running.');
    if (this.ended) throw new Error('This call has already ended.');
    this.starting = true;
    try {
      const { db, engine } = this.d;
      const session = getSessionRow(db, this.id);
      const ctx = loadCoachContext(db, this.id);
      this.ctx = ctx;
      // Fail before opening any device if the coach could not run.
      const provider = (this.d.provider ?? getProvider)();
      const dir = sessionDir(this.id, this.d.root ?? INTERVIEWS_DIR);
      fs.mkdirSync(dir, { recursive: true });

      this.runner = new CoachRunner({
        db,
        provider,
        session,
        ctx,
        transcript: this.transcript,
        asked: () => (getSessionRow(db, this.id).askedQuestions as string[] | null) ?? [],
        emit: (e) => this.onCoachEvent(e),
        clockMs: () => this.lastEngineMs,
      });
      this.scheduler = new CoachScheduler({
        run: (kind) => this.runner!.run(kind),
        abort: () => this.runner!.abort(),
      });

      const started = await engine.start({
        dir,
        mic: session.micDevice,
        output: session.outputDevice,
        record: session.recordAudio,
        prompt: [ctx.company, ctx.title, ...ctx.contactNames].join(', '),
        onEvent: (e) => this.onEngineEvent(e),
      });
      this.mic = started.mic?.name ?? null;
      this.output = started.output?.name ?? null;
      const now = new Date();
      startSession(db, this.id, {
        transcriber: engine.name,
        micDevice: this.mic,
        outputDevice: this.output,
      }, now);
      this.startedAt = now.toISOString();
      // Remember the devices that worked, so next time they are preselected.
      (this.d.rememberDevices ?? saveDevices)(this.mic, this.output);
      logEvent('interview.start', `Interview call started (session ${this.id})`, {
        sessionId: this.id,
        mic: this.mic,
        output: this.output,
      });
      this.emit({ type: 'started', startedAt: this.startedAt, mic: this.mic, output: this.output });
    } catch (e) {
      this.runner = null;
      this.scheduler = null;
      throw e;
    } finally {
      this.starting = false;
    }
  }

  nudge() {
    if (!this.live) return;
    this.scheduler?.trigger('nudge');
  }

  asked(questions: string[]) {
    setAsked(this.d.db, this.id, questions);
  }

  private onCoachEvent(e: CoachEvent) {
    if (e.phase === 'start') this.hint = { text: '', done: false, hint: null };
    else if (e.phase === 'delta' && this.hint) this.hint.text += e.text;
    else if (e.phase === 'done') this.hint = { text: '', done: true, hint: e.hint };
    else if (e.phase === 'aborted' && this.hint && !this.hint.done) this.hint = null;
    this.emit(e);
  }

  private onEngineEvent(e: EngineEvent) {
    if (e.type === 'level' || e.type === 'speech') this.lastEngineMs = Math.max(this.lastEngineMs, e.ms);
    if (e.type === 'level') return this.emit({ type: 'level', speaker: e.track, rms: e.rms });
    if (e.type === 'speech')
      return this.emit({ type: 'speech', speaker: e.track, active: e.active, ms: e.ms });
    if (e.type === 'error')
      return this.emit({ type: 'error', message: e.message, ...(e.track && { speaker: e.track }) });
    if (e.type === 'partial') {
      this.pending[e.track] = e.text;
      if (e.track === 'them') this.transcript.partialThem = e.text;
      return this.emit({ type: 'transcript', speaker: e.track, text: e.text, startMs: e.startMs, final: false });
    }
    // final
    this.lastEngineMs = Math.max(this.lastEngineMs, e.endMs);
    this.pending[e.track] = null;
    const id = appendSegment(this.d.db, this.id, {
      speaker: e.track,
      text: e.text,
      startMs: e.startMs,
      endMs: e.endMs,
    });
    this.turns.push({ id, speaker: e.track, text: e.text, startMs: e.startMs, endMs: e.endMs });
    this.transcript.addFinal({ speaker: e.track, text: e.text, startMs: e.startMs });
    this.emit({
      type: 'transcript',
      speaker: e.track,
      text: e.text,
      startMs: e.startMs,
      endMs: e.endMs,
      final: true,
      segmentId: id,
    });
    if (e.track === 'them') {
      this.transcript.partialThem = '';
      if (this.runner) this.runner.lastSegmentId = id;
      this.scheduler?.trigger('utterance' satisfies CoachTrigger, e.text);
    }
  }

  async stop(): Promise<{ durationMs: number }> {
    if (!this.live) return { durationMs: 0 };
    this.scheduler?.cancel();
    let durationMs = 0;
    let files: Awaited<ReturnType<AudioEngine['stop']>>['files'] = null;
    try {
      const res = await this.d.engine.stop();
      durationMs = res.durationMs;
      files = res.files;
    } catch (e) {
      logEvent('interview.stop-failed', `Stopping the engine failed: ${(e as Error).message}`, { sessionId: this.id }, 'warn');
    }
    endSession(this.d.db, this.id, durationMs || null);
    this.ended = true;
    this.pending = { me: null, them: null };
    logEvent('interview.stop', `Interview call ended (session ${this.id})`, { sessionId: this.id, durationMs });
    this.emit({ type: 'stopped', durationMs });
    if (files) void this.finishRecording();
    return { durationMs };
  }

  /** Merges the two tracks into one file, in the background so Stop returns at once. */
  private async finishRecording() {
    const root = this.d.root ?? INTERVIEWS_DIR;
    try {
      const merged = await mergeRecording(sessionDir(this.id, root));
      if (merged) {
        setAudio(this.d.db, this.id, merged.file, merged.durationMs);
        this.audioFile = merged.file;
        this.emit({ type: 'audioReady', audioFile: merged.file, audioMs: merged.durationMs });
        if (!merged.stereo)
          logEvent('interview.no-ffmpeg', 'ffmpeg was not available; the call is kept as a WAV.', { sessionId: this.id }, 'warn');
      } else this.emit({ type: 'audioReady', audioFile: null, audioMs: 0 });
    } catch (e) {
      logEvent('interview.merge-failed', `Merging the recording failed: ${(e as Error).message}`, { sessionId: this.id }, 'error');
    }
  }
}

// ---------- the sessions that exist right now ----------

const sessions = new Map<number, InterviewSession>();

/** The in-memory session for an id, creating it on first use (e.g. when the page opens its stream). */
export function liveSession(deps: SessionDeps, id: number): InterviewSession {
  let s = sessions.get(id);
  if (!s) {
    s = new InterviewSession(id, deps);
    sessions.set(id, s);
  }
  return s;
}

export function existingSession(id: number) {
  return sessions.get(id);
}

/** Forget a session nobody is watching and that is not running. */
export function releaseSession(id: number) {
  const s = sessions.get(id);
  if (s && !s.busy && !s.subscriberCount) sessions.delete(id);
}

/** Calls in progress (or starting): the idle-exit timer must not shut the server down. */
export function activeSessionCount(): number {
  return [...sessions.values()].filter((s) => s.busy).length;
}

/**
 * On server start: a call that was never stopped (the server died) is ended, and whatever audio
 * reached the disk is merged. WAV headers are kept valid as they are written, so nothing is lost.
 */
export async function repairUnfinished(db: Db, root = INTERVIEWS_DIR): Promise<number> {
  const rows = unfinishedSessions(db);
  for (const r of rows) {
    const dir = sessionDir(r.id, root);
    const ms = Math.max(wavDurationMs(path.join(dir, 'me.wav')), wavDurationMs(path.join(dir, 'them.wav')));
    endSession(db, r.id, ms || null);
    const merged = await mergeRecording(dir);
    if (merged) setAudio(db, r.id, merged.file, merged.durationMs);
    logEvent('interview.repaired', `Ended an unfinished call (session ${r.id})`, { sessionId: r.id, ms }, 'warn');
  }
  return rows.length;
}
