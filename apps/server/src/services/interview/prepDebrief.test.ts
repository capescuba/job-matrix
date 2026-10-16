import { beforeEach, describe, expect, it } from 'vitest';
import type { LLMProvider, StructuredRequest } from '@jm/ai';
import type { Debrief, PrepCard } from '@jm/shared';
import { openDb, type Db } from '../../db/client.ts';
import { activities, aiUsage } from '../../db/schema.ts';
import { createApplication } from '../applications.ts';
import { loadCoachContext, renderContext } from './context.ts';
import { DebriefNotReadyError, debriefSession, renderTranscript } from './debrief.ts';
import { generatePrep } from './prep.ts';
import { appendSegment, createSession, endSession, getSession, saveHint, setAsked } from './store.ts';

const prep: PrepCard = {
  headline: 'Logistics, level and motivation',
  leadWith: ['Program scale', 'Agentic AI migration', 'Customer-facing delivery'],
  likelyQuestions: [{ question: 'Why leave?', approach: 'Growth, cite Workday' }],
  stories: [{ name: 'Workday: migration', use: 'Leadership under pressure' }],
  risks: ['Level: confirm Senior'],
  askThem: ['What does success look like?'],
  logistics: [],
};
const debrief: Debrief = {
  summary: 'It went well. They liked the migration story. Next is a manager call.',
  questions: [{ question: 'Why this role?', yourAnswer: 'Scale and AI', landed: 'strong', better: null }],
  theyShared: ['Two more rounds'],
  followUps: ['Send the resume'],
  thankYouPoints: ['The migration story'],
  nextRound: 'Hiring manager next week',
};

function provider(data: unknown, seen: StructuredRequest<never>[] = []): LLMProvider {
  return {
    name: 'fake',
    defaultModel: 'm',
    complete: async () => '',
    completeStructured: (async (req: StructuredRequest<never>) => {
      seen.push(req);
      return { data, provider: 'fake', model: req.model ?? 'm', usage: { inputTokens: 1000, outputTokens: 400 } };
    }) as unknown as LLMProvider['completeStructured'],
  };
}

let db: Db;
let appId: number;
let sessionId: number;
beforeEach(() => {
  db = openDb(':memory:');
  appId = createApplication(db, { company: 'Acme', title: 'Technical Program Manager' });
  sessionId = createSession(db, appId, { round: 'Recruiter screen', coachModel: 'claude-sonnet-5-5' }).id;
});

describe('coach context', () => {
  it('renders the same bytes every time, so the cached prefix stays valid', () => {
    const a = renderContext(loadCoachContext(db, sessionId));
    const b = renderContext(loadCoachContext(db, sessionId));
    expect(a).toBe(b);
    expect(a).toContain('<role>Technical Program Manager at Acme</role>');
    expect(a).toContain('<round>Recruiter screen</round>');
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe('prep card', () => {
  it('is generated once on the coach model, logged, and then served from the session', async () => {
    const seen: StructuredRequest<never>[] = [];
    const p = provider(prep, seen);
    const first = await generatePrep(db, sessionId, { provider: p });
    const second = await generatePrep(db, sessionId, { provider: p });
    expect(first).toEqual(prep);
    expect(second).toEqual(prep);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low' });
    expect(db.select().from(aiUsage).all().map((r) => r.feature)).toEqual(['prep']);
    expect(getSession(db, sessionId).prep).toEqual(prep);
  });
});

describe('debrief', () => {
  it('refuses until the call has ended', async () => {
    await expect(debriefSession(db, sessionId, { provider: provider(debrief) })).rejects.toBeInstanceOf(
      DebriefNotReadyError,
    );
  });

  it('writes the summary once, logs one Interview activity, and sends the transcript', async () => {
    const t = appendSegment(db, sessionId, { speaker: 'them', text: 'Why this role?', startMs: 65_000, endMs: 67_000 });
    appendSegment(db, sessionId, { speaker: 'me', text: 'Scale and AI.', startMs: 68_000, endMs: 70_000 });
    saveHint(db, sessionId, {
      segmentId: t,
      trigger: 'utterance',
      hint: { question: 'Why this role?', probing: 'Motivation', points: [], story: null, watch: null, askBack: null },
      usageId: null,
      atMs: 67_500,
    });
    setAsked(db, sessionId, ['What does success look like?']);
    endSession(db, sessionId, 120_000);

    const seen: StructuredRequest<never>[] = [];
    const p = provider(debrief, seen);
    const first = await debriefSession(db, sessionId, { provider: p });
    const again = await debriefSession(db, sessionId, { provider: p });

    expect(first).toEqual(debrief);
    expect(again).toEqual(debrief);
    expect(seen).toHaveLength(1);
    expect(seen[0].prompt).toContain('[01:05] THEM: Why this role?');
    expect(seen[0].prompt).toContain('coach card: probing "Motivation"');
    expect(seen[0].prompt).toContain('What does success look like?');

    const acts = db.select().from(activities).all().filter((a) => a.kind === 'Interview');
    expect(acts).toHaveLength(1);
    expect(acts[0].summary).toBe('Recruiter screen: It went well.');
    expect(getSession(db, sessionId).activityId).toBe(acts[0].id);
  });

  it('formats timestamps as minutes and seconds', () => {
    expect(
      renderTranscript([{ id: 1, speaker: 'me', text: 'hi', startMs: 3_725_000 }], []),
    ).toBe('[62:05] ME: hi');
  });
});
