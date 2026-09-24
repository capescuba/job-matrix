import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

/**
 * Live feed of what AI calls are doing, streamed to the browser (Server-Sent Events).
 * In memory only: the durable record of each call is the ai_usage row.
 */
export type RunEvent =
  | { type: 'start'; label: string; applicationId: number | null }
  | { type: 'step'; text: string; detail?: string }
  | { type: 'thinking'; text: string }
  | { type: 'output'; text: string }
  | { type: 'done'; text: string; usageId: number | null; score?: number; gate?: string }
  | { type: 'error'; text: string; usageId: number | null };

export type RunEventEnvelope = RunEvent & { runId: string; at: number };

interface Run {
  id: string;
  label: string;
  applicationId: number | null;
  startedAt: number;
  finished: boolean;
  events: RunEventEnvelope[];
}

const bus = new EventEmitter();
bus.setMaxListeners(100);
const runs = new Map<string, Run>();
/** Finished runs stay replayable briefly so a page opened mid-way or just after can catch up. */
const KEEP_FINISHED_MS = 5 * 60_000;

export interface RunHandle {
  id: string;
  emit(e: Exclude<RunEvent, { type: 'start' }>): void;
  /** Timestamped step, e.g. step('Sending to Claude Opus 5', 'effort: low'). */
  step(text: string, detail?: string): void;
}

export function startRun(label: string, applicationId: number | null): RunHandle {
  const run: Run = {
    id: randomUUID(),
    label,
    applicationId,
    startedAt: Date.now(),
    finished: false,
    events: [],
  };
  runs.set(run.id, run);
  const publish = (e: RunEvent) => {
    const env = { ...e, runId: run.id, at: Date.now() } as RunEventEnvelope;
    run.events.push(env);
    if (e.type === 'done' || e.type === 'error') {
      run.finished = true;
      setTimeout(() => runs.delete(run.id), KEEP_FINISHED_MS).unref();
    }
    bus.emit('event', env);
  };
  publish({ type: 'start', label, applicationId });
  return {
    id: run.id,
    emit: publish,
    step: (text, detail) => publish({ type: 'step', text, detail }),
  };
}

/** Recent runs' events (in order), for a subscriber that just connected. */
export function replay(applicationId?: number): RunEventEnvelope[] {
  return [...runs.values()]
    .filter((r) => applicationId == null || r.applicationId === applicationId)
    .sort((a, b) => a.startedAt - b.startedAt)
    .flatMap((r) => r.events);
}

export function subscribe(listener: (e: RunEventEnvelope) => void): () => void {
  bus.on('event', listener);
  return () => bus.off('event', listener);
}

export const activeRunCount = () => [...runs.values()].filter((r) => !r.finished).length;
