import { beforeEach, describe, expect, it } from 'vitest';
import { AbortedError, type BlocksRequest, type LLMProvider } from '@jm/ai';
import type { CoachHint } from '@jm/shared';
import { openDb, type Db } from '../../db/client.ts';
import { aiUsage } from '../../db/schema.ts';
import { createApplication } from '../applications.ts';
import {
  CoachRunner,
  CoachScheduler,
  CoachTranscript,
  buildCoachBlocks,
  type CoachEvent,
} from './coach.ts';
import { loadCoachContext } from './context.ts';
import { createSession, getSession } from './store.ts';

const hint: CoachHint = {
  question: 'Why this role?',
  probing: 'Motivation and fit',
  points: ['Led platform migration', 'Cut cost 30%'],
  story: 'Workday: migration',
  watch: null,
  askBack: null,
};

let db: Db;
let sessionId: number;
beforeEach(() => {
  db = openDb(':memory:');
  const appId = createApplication(db, { company: 'Acme', title: 'Technical Program Manager' });
  sessionId = createSession(db, appId, { round: 'Recruiter screen', coachModel: 'claude-sonnet-5-5' }).id;
});

describe('buildCoachBlocks', () => {
  it('keeps the context cached and each call a strict prefix of the next', () => {
    const ctx = loadCoachContext(db, sessionId);
    const t = new CoachTranscript();
    t.addFinal({ speaker: 'them', text: 'Tell me about yourself.', startMs: 1000 });
    const first = buildCoachBlocks(ctx, t, []);

    t.addFinal({ speaker: 'me', text: 'I run large programs.', startMs: 5000 });
    t.addFinal({ speaker: 'them', text: 'Why are you leaving?', startMs: 9000 });
    t.partialThem = 'and what are you looking';
    const second = buildCoachBlocks(ctx, t, ['What does success look like?']);

    // Stable system, byte for byte, with the breakpoint on the applicant context.
    expect(second.system).toEqual(first.system);
    expect(first.system.map((b) => Boolean(b.cache))).toEqual([false, true]);

    // Committed chunks are append-only: every chunk of call 1 is still there, unchanged.
    const chunks = (c: typeof first) => c.content.slice(0, -1).map((b) => b.text);
    expect(chunks(second).slice(0, chunks(first).length)).toEqual(chunks(first));
    expect(chunks(second)).toHaveLength(2);

    // Only the newest committed chunk carries a breakpoint; the tail is never cached.
    expect(second.content.map((b) => Boolean(b.cache))).toEqual([false, true, false]);
    const tail = second.content.at(-1)!.text;
    expect(tail).toContain('THEM (still talking): and what are you looking');
    expect(tail).toContain('already asked: What does success look like?');
    expect(chunks(second).join('\n')).not.toContain('still talking');
  });

  it('says so when the call has just started', () => {
    const { content } = buildCoachBlocks(loadCoachContext(db, sessionId), new CoachTranscript(), []);
    expect(content[0].text).toMatch(/just started/);
  });
});

/** A hand-cranked clock and timer, so spacing is tested without waiting. */
function clock() {
  let t = 100_000;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let n = 0;
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++n;
      timers.push({ at: t + ms, fn, id });
      return id;
    },
    clearTimer: (h: unknown) => {
      const i = timers.findIndex((x) => x.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
    advance(ms: number) {
      t += ms;
      for (const x of timers.filter((x) => x.at <= t).sort((a, b) => a.at - b.at)) {
        timers.splice(timers.indexOf(x), 1);
        x.fn();
      }
    },
    pending: () => timers.length,
  };
}

describe('CoachScheduler', () => {
  function setup() {
    const c = clock();
    const log: string[] = [];
    const s = new CoachScheduler({
      run: async (k) => void log.push(`run:${k}`),
      abort: () => void log.push('abort'),
      now: c.now,
      setTimer: c.setTimer,
      clearTimer: c.clearTimer,
    });
    return { c, log, s };
  }

  it('ignores backchannel like "mm-hmm" and "right"', () => {
    const { log, s } = setup();
    s.trigger('utterance', 'mm-hmm');
    s.trigger('utterance', 'right, okay');
    expect(log).toEqual([]);
  });

  it('runs a first utterance at once and aborts the call in flight each time', () => {
    const { log, s } = setup();
    s.trigger('utterance', 'tell me about a hard launch');
    expect(log).toEqual(['abort', 'run:utterance']);
  });

  it('spaces utterances 4 s apart and folds a burst into one call at the end of the wait', () => {
    const { c, log, s } = setup();
    s.trigger('utterance', 'first question here');
    log.length = 0;
    c.advance(1000);
    s.trigger('utterance', 'second thing they said');
    c.advance(500);
    s.trigger('utterance', 'and a third thing');
    expect(log).toEqual([]);
    expect(c.pending()).toBe(1);
    c.advance(2400);
    expect(log).toEqual([]);
    c.advance(200);
    expect(log).toEqual(['abort', 'run:utterance']);
  });

  it('a nudge goes now, even inside the wait, and cancels the deferred call', () => {
    const { c, log, s } = setup();
    s.trigger('utterance', 'first question here');
    c.advance(1000);
    s.trigger('utterance', 'another longer utterance');
    log.length = 0;
    s.trigger('nudge');
    expect(log).toEqual(['abort', 'run:nudge']);
    expect(c.pending()).toBe(0);
  });

  it('cancel stops a deferred call and aborts the one in flight', () => {
    const { c, log, s } = setup();
    s.trigger('utterance', 'first question here');
    c.advance(1000);
    s.trigger('utterance', 'another longer utterance');
    log.length = 0;
    s.cancel();
    c.advance(10_000);
    expect(log).toEqual(['abort']);
  });
});

describe('CoachRunner', () => {
  function runner(provider: Partial<LLMProvider>, events: CoachEvent[]) {
    const ctx = loadCoachContext(db, sessionId);
    const transcript = new CoachTranscript();
    transcript.addFinal({ speaker: 'them', text: 'Why this role?', startMs: 2000 });
    return new CoachRunner({
      db,
      provider: { name: 'fake', defaultModel: 'm', ...provider } as LLMProvider,
      session: { ...getSession(db, sessionId) },
      ctx,
      transcript,
      asked: () => [],
      emit: (e) => events.push(e),
      clockMs: () => 12_345,
    });
  }

  it('streams the card, saves the hint with when it fired, and logs the call', async () => {
    const events: CoachEvent[] = [];
    let req: BlocksRequest<never> | undefined;
    const r = runner(
      {
        completeBlocks: (async (q: BlocksRequest<never>) => {
          req = q;
          q.onEvent?.({ type: 'output', text: '{"question":' });
          return {
            data: hint,
            provider: 'fake',
            model: 'claude-sonnet-5-5',
            usage: { inputTokens: 200, outputTokens: 50, cacheReadTokens: 8000 },
          };
        }) as unknown as LLMProvider['completeBlocks'],
      },
      events,
    );
    r.lastSegmentId = null;
    await r.run('utterance');

    expect(req).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low' });
    expect(events.map((e) => (e.type === 'hint' ? e.phase : e.type))).toEqual(['start', 'delta', 'done']);
    const saved = getSession(db, sessionId).hints;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ trigger: 'utterance', atMs: 12_345, hint: { probing: 'Motivation and fit' } });
    const rows = db.select().from(aiUsage).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ feature: 'coach', cacheReadTokens: 8000, error: null });
  });

  it('records an aborted call as billed but failed, and tells the UI', async () => {
    const events: CoachEvent[] = [];
    const r = runner(
      {
        completeBlocks: (async () => {
          throw Object.assign(new AbortedError('Aborted'), {
            usage: { inputTokens: 300, outputTokens: 2, cacheReadTokens: 7000 },
          });
        }) as unknown as LLMProvider['completeBlocks'],
      },
      events,
    );
    await r.run('nudge');
    expect(events.at(-1)).toMatchObject({ type: 'hint', phase: 'aborted' });
    expect(getSession(db, sessionId).hints).toHaveLength(0);
    expect(db.select().from(aiUsage).get()).toMatchObject({ error: 'aborted', cacheReadTokens: 7000 });
  });

  it('reports a provider failure instead of throwing', async () => {
    const events: CoachEvent[] = [];
    const r = runner(
      {
        completeBlocks: (async () => {
          throw new Error('boom');
        }) as unknown as LLMProvider['completeBlocks'],
      },
      events,
    );
    await r.run('utterance');
    expect(events.at(-1)).toEqual({ type: 'hint', phase: 'error', message: 'boom' });
  });
});
