import { describe, expect, it } from 'vitest';
import type { CoachHint } from '@jm/shared';
import { clock, currentCard, initialLive, liveReducer, talkShare, type Turn } from './live.ts';

const hint: CoachHint = {
  question: 'Why us?',
  probing: 'Motivation',
  points: ['a'],
  story: null,
  watch: null,
  askBack: null,
};

describe('liveReducer', () => {
  it('replaces a speaker’s partial line, then appends the final turn', () => {
    let s = liveReducer(initialLive, {
      type: 'transcript',
      speaker: 'them',
      text: 'So why',
      startMs: 0,
      final: false,
    });
    expect(s.pending.them).toBe('So why');
    s = liveReducer(s, {
      type: 'transcript',
      speaker: 'them',
      text: 'So why us?',
      startMs: 0,
      endMs: 1500,
      final: true,
      segmentId: 7,
    });
    expect(s.pending.them).toBeNull();
    expect(s.turns).toEqual([
      { id: 7, speaker: 'them', text: 'So why us?', startMs: 0, endMs: 1500 },
    ]);
  });

  it('streams a card, keeps the previous one as earlier, and drops an aborted one', () => {
    let s = liveReducer(initialLive, {
      type: 'hint',
      phase: 'done',
      trigger: 'utterance',
      hint,
      hintId: 1,
    });
    s = liveReducer(s, { type: 'hint', phase: 'start', trigger: 'nudge' });
    s = liveReducer(s, { type: 'hint', phase: 'delta', text: '{"question":"Next' });
    expect(s.streaming).toBe('{"question":"Next');
    s = liveReducer(s, { type: 'hint', phase: 'aborted' });
    expect(s.streaming).toBeNull();
    expect(s.hint).toBe(hint);
    s = liveReducer(s, {
      type: 'hint',
      phase: 'done',
      trigger: 'nudge',
      hint: { ...hint, question: 'Q2' },
      hintId: 2,
    });
    expect(s.earlier).toEqual([hint]);
  });

  it('marks the recording as being prepared after stop, until it is ready', () => {
    let s = liveReducer({ ...initialLive, live: true }, { type: 'stopped', durationMs: 1000 });
    expect(s).toMatchObject({ live: false, ended: true, audioPending: true });
    s = liveReducer(s, { type: 'audioReady', audioFile: 'call.ogg', audioMs: 1000 });
    expect(s).toMatchObject({ audioPending: false, audioFile: 'call.ogg' });
  });
});

describe('currentCard', () => {
  it('shows the card being written once it has a question, else the last card', () => {
    expect(currentCard({ streaming: '{"ques', hint })).toEqual({ card: hint, writing: true });
    expect(currentCard({ streaming: '{"question":"Tell me', hint }).card).toEqual({
      question: 'Tell me',
    });
    expect(currentCard({ streaming: null, hint: null })).toEqual({ card: null, writing: false });
  });
});

describe('talkShare and clock', () => {
  it('splits speaking time by speaker', () => {
    const turns: Turn[] = [
      { id: 1, speaker: 'them', text: 'q', startMs: 0, endMs: 6000 },
      { id: 2, speaker: 'me', text: 'a', startMs: 6000, endMs: 10_000 },
    ];
    expect(talkShare(turns)).toEqual({ meMs: 4000, themMs: 6000, mePct: 40 });
    expect(talkShare([]).mePct).toBe(0);
  });

  it('formats elapsed time', () => {
    expect(clock(65_000)).toBe('1:05');
    expect(clock(3_725_000)).toBe('1:02:05');
  });
});
