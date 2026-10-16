import { useEffect, useReducer } from 'react';
import { closePartialJson, type CoachHint, type Speaker } from '@jm/shared';
import type { EngineStatus, SessionEvent, Snapshot } from '../api.ts';

export interface Turn {
  id: number;
  speaker: Speaker;
  text: string;
  startMs: number;
  endMs: number;
}

export interface LiveState {
  connected: boolean;
  engine: EngineStatus;
  live: boolean;
  ended: boolean;
  startedAt: string | null;
  mic: string | null;
  output: string | null;
  turns: Turn[];
  pending: { me: string | null; them: string | null };
  /** The card being written (raw streamed JSON) and the last finished one. */
  streaming: string | null;
  hint: CoachHint | null;
  /** Older cards, newest first, for a dim "earlier" list. */
  earlier: CoachHint[];
  level: { me: number; them: number };
  speaking: { me: boolean; them: boolean };
  audioFile: string | null;
  audioPending: boolean;
  errors: string[];
}

export const initialLive: LiveState = {
  connected: false,
  engine: { phase: 'stopped' },
  live: false,
  ended: false,
  startedAt: null,
  mic: null,
  output: null,
  turns: [],
  pending: { me: null, them: null },
  streaming: null,
  hint: null,
  earlier: [],
  level: { me: 0, them: 0 },
  speaking: { me: false, them: false },
  audioFile: null,
  audioPending: false,
  errors: [],
};

type Action = SessionEvent | { type: 'connected'; ok: boolean };

function fromSnapshot(s: Snapshot, prev: LiveState): LiveState {
  return {
    ...prev,
    connected: true,
    engine: s.engine,
    live: s.live,
    ended: s.ended,
    startedAt: s.startedAt,
    mic: s.mic,
    output: s.output,
    turns: s.turns,
    pending: s.pending,
    streaming: s.hint && !s.hint.done ? s.hint.text : null,
    hint: s.hint?.hint ?? prev.hint,
    audioFile: s.audioFile,
  };
}

export function liveReducer(st: LiveState, a: Action): LiveState {
  switch (a.type) {
    case 'connected':
      return { ...st, connected: a.ok };
    case 'snapshot':
      return fromSnapshot(a.snapshot, st);
    case 'status':
      return { ...st, engine: a.engine };
    case 'started':
      return {
        ...st,
        live: true,
        startedAt: a.startedAt,
        mic: a.mic,
        output: a.output,
        errors: [],
      };
    case 'transcript':
      if (!a.final) return { ...st, pending: { ...st.pending, [a.speaker]: a.text } };
      return {
        ...st,
        pending: { ...st.pending, [a.speaker]: null },
        turns: [
          ...st.turns,
          {
            id: a.segmentId ?? -st.turns.length,
            speaker: a.speaker,
            text: a.text,
            startMs: a.startMs,
            endMs: a.endMs ?? a.startMs,
          },
        ],
      };
    case 'speech':
      return { ...st, speaking: { ...st.speaking, [a.speaker]: a.active } };
    case 'level':
      return { ...st, level: { ...st.level, [a.speaker]: a.rms } };
    case 'hint':
      if (a.phase === 'start') return { ...st, streaming: '' };
      if (a.phase === 'delta') return { ...st, streaming: (st.streaming ?? '') + a.text };
      if (a.phase === 'done')
        return {
          ...st,
          streaming: null,
          hint: a.hint,
          earlier: st.hint ? [st.hint, ...st.earlier].slice(0, 6) : st.earlier,
        };
      if (a.phase === 'aborted') return { ...st, streaming: null };
      return { ...st, streaming: null, errors: [...st.errors, a.message].slice(-3) };
    case 'stopped':
      return {
        ...st,
        live: false,
        ended: true,
        pending: { me: null, them: null },
        audioPending: true,
      };
    case 'audioReady':
      return { ...st, audioFile: a.audioFile, audioPending: false };
    case 'error':
      return {
        ...st,
        errors: [
          ...st.errors,
          a.speaker ? `${a.speaker === 'me' ? 'Mic' : 'Speaker'}: ${a.message}` : a.message,
        ].slice(-3),
      };
  }
}

/** The live view of one call, fed by Server-Sent Events (reconnects on its own, resyncs from a snapshot). */
export function useLiveSession(sessionId: number | null) {
  const [state, dispatch] = useReducer(liveReducer, initialLive);
  useEffect(() => {
    if (sessionId == null) return;
    const es = new EventSource(`/api/interviews/${sessionId}/events`);
    es.onopen = () => dispatch({ type: 'connected', ok: true });
    es.onerror = () => dispatch({ type: 'connected', ok: false });
    es.onmessage = (m) => {
      try {
        dispatch(JSON.parse(m.data) as SessionEvent);
      } catch {
        // ignore a malformed line
      }
    };
    return () => es.close();
  }, [sessionId]);
  return state;
}

/** The card to show: the one being written once it has something to say, else the last one. */
export function currentCard(st: Pick<LiveState, 'streaming' | 'hint'>): {
  card: Partial<CoachHint> | null;
  writing: boolean;
} {
  const writing = st.streaming != null;
  if (writing) {
    const partial = closePartialJson(st.streaming!) as Partial<CoachHint> | null;
    if (partial && (partial.question || partial.probing)) return { card: partial, writing };
  }
  return { card: st.hint, writing };
}

/** Share of speaking time, from finished turns plus whatever is being said now. */
export function talkShare(turns: Turn[]) {
  let me = 0;
  let them = 0;
  for (const t of turns) {
    const d = Math.max(0, t.endMs - t.startMs);
    if (t.speaker === 'me') me += d;
    else them += d;
  }
  const total = me + them;
  return { meMs: me, themMs: them, mePct: total ? Math.round((me / total) * 100) : 0 };
}

export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};
