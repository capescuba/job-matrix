import { useSyncExternalStore } from 'react';
import type { RunEventEnvelope } from '../../server/src/services/aiEvents.ts';

/** Everything known about one AI run, built up from the server's live event feed. */
export interface AiRun {
  id: string;
  label: string;
  applicationId: number | null;
  /** Set for company-level runs (research). */
  companyId: number | null;
  startedAt: number;
  steps: { at: number; text: string; detail?: string }[];
  thinking: string;
  output: string;
  finishedAt: number | null;
  result: {
    text: string;
    ok: boolean;
    usageId: number | null;
    score?: number;
    gate?: string;
  } | null;
}

const runs = new Map<string, AiRun>();
const listeners = new Set<() => void>();
let snapshot: AiRun[] = [];
let source: EventSource | null = null;
let scheduled = false;

function apply(e: RunEventEnvelope) {
  if (e.type === 'start') {
    // Replays start with 'start', so resetting here makes reconnects idempotent.
    runs.set(e.runId, {
      id: e.runId,
      label: e.label,
      applicationId: e.applicationId,
      companyId: e.companyId,
      startedAt: e.at,
      steps: [],
      thinking: '',
      output: '',
      finishedAt: null,
      result: null,
    });
    return;
  }
  const run = runs.get(e.runId);
  if (!run) return;
  switch (e.type) {
    case 'step':
      run.steps.push({ at: e.at, text: e.text, detail: e.detail });
      break;
    case 'thinking':
      run.thinking += e.text;
      break;
    case 'output':
      run.output += e.text;
      break;
    case 'done':
    case 'error':
      run.finishedAt = e.at;
      run.result = {
        text: e.text,
        ok: e.type === 'done',
        usageId: e.usageId,
        ...(e.type === 'done' && { score: e.score, gate: e.gate }),
      };
      break;
  }
}

/**
 * Thinking/output deltas arrive many per second — batch re-renders to ~20/s. A timer, not
 * requestAnimationFrame, so the view keeps up while the tab is in the background.
 */
function notify() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    snapshot = [...runs.values()]
      .map((r) => ({ ...r, steps: [...r.steps] }))
      .sort((a, b) => b.startedAt - a.startedAt);
    listeners.forEach((l) => l());
  }, 50);
}

function connect() {
  if (source) return;
  source = new EventSource('/api/ai/events');
  source.onmessage = (m) => {
    apply(JSON.parse(m.data) as RunEventEnvelope);
    notify();
  };
}

function subscribe(l: () => void) {
  connect();
  listeners.add(l);
  return () => listeners.delete(l);
}

/** All recent AI runs, newest first. */
export function useAiRuns(): AiRun[] {
  return useSyncExternalStore(subscribe, () => snapshot);
}

/** Output keys in the order the model writes them — how far along it is. */
const OUTPUT_KEYS = [
  'verdict',
  'summary',
  'whyNotHigher',
  'parts',
  'criteria',
  'strengths',
  'gaps',
  'flags',
  'facts',
  'interviewFocus',
  'talkingPoints',
];

/**
 * Real progress, from what's actually streamed: sending → thinking → each section of the answer
 * as the model writes it. Returns 0–1 and a label.
 */
const RESEARCH_KEYS = [
  'flags',
  'snapshot',
  'momentum',
  'news',
  'culture',
  'interview',
  'comp',
  'financials',
  'questionsToAsk',
  'sources',
];

export function runProgress(run: AiRun): { value: number; label: string } {
  if (run.result) return { value: 1, label: run.result.ok ? 'Done' : 'Failed' };
  if (run.companyId != null) {
    // Research: searching (up to ~8) then writing the brief section by section.
    const searches = run.steps.filter((s) => s.text.startsWith('Searching')).length;
    const json = run.output.slice(run.output.indexOf('{') + 1);
    if (run.output.includes('{')) {
      const written = RESEARCH_KEYS.filter((k) => json.includes(`"${k}"`)).length;
      const current = RESEARCH_KEYS[Math.max(0, written - 1)];
      return { value: 0.5 + 0.45 * (written / RESEARCH_KEYS.length), label: `Writing: ${current}` };
    }
    return {
      value: 0.05 + 0.4 * Math.min(1, searches / 8),
      label: searches ? `Searching (${searches} so far)` : 'Starting',
    };
  }
  if (run.output) {
    const written = OUTPUT_KEYS.filter((k) => run.output.includes(`"${k}"`)).length;
    const current = OUTPUT_KEYS[Math.max(0, written - 1)];
    return { value: 0.35 + 0.6 * (written / OUTPUT_KEYS.length), label: `Writing: ${current}` };
  }
  if (run.thinking) return { value: 0.2, label: 'Thinking' };
  return { value: 0.08, label: run.steps.at(-1)?.text ?? 'Starting' };
}

/** Part scores as soon as each appears in the streamed JSON. */
export function partialParts(output: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of output.matchAll(
    /"(skills|level|logistics|pay|upside)"\s*:\s*\{\s*"score"\s*:\s*([\d.]+)/g,
  ))
    out[m[1]] = Number(m[2]);
  return out;
}
