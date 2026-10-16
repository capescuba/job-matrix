import { AbortedError, LLMError, type Block, type LLMProvider } from '@jm/ai';
import { coachHintSchema, type CoachHint, type Speaker } from '@jm/shared';
import type { Db } from '../../db/client.ts';
import { COACH_EFFORT } from '../settings.ts';
import { recordUsage } from '../usage.ts';
import { renderContext, type CoachContext } from './context.ts';
import { saveHint, type SessionRow } from './store.ts';

export const COACH_SYSTEM_PROMPT = `You coach a job seeker live, during an interview call, in the few seconds after the interviewer stops talking. Your output is glanced at while they speak, not read, so every field is short and concrete.

You get the applicant's context (resume, career profile, the job, the company brief, answers they drafted, earlier rounds, a prep card) and the running transcript. Lines are tagged THEM (the interviewer) and ME (the applicant). Respond to the latest THEM turn.

Fields:
- question: the question actually being asked, reworded clearly in one line. Null when the latest THEM turn is not a question (small talk, an acknowledgement, them describing the role or process). When it is not a question, keep points to at most one note worth remembering, or leave it empty.
- probing: what they are really assessing, 12 words or fewer.
- points: up to 3 things to say, 12 words or fewer each. Concrete: a number, a program, an outcome. Use only facts from the resume, career profile and drafted answers. Never invent employers, numbers, projects or dates.
- story: the one experience to reach for, named by company and program, for example "Workday: agentic AI platform migration". Null when nothing fits.
- watch: a trap or red flag, only when it is real: an early compensation anchor, an illegal question, a known gap being probed, something that contradicts a drafted answer. Otherwise null.
- askBack: a question for them, only when it is natural: they opened the floor, or the topic matches a prepared question that has not been asked yet. Otherwise null.

Calibrate to the round. In a recruiter screen the questions are about logistics, motivation, level, compensation and timeline: keep points to short factual answers and watch for compensation anchoring. In a hiring manager or technical round they probe depth, numbers and trade-offs: point to the specific story and the number that proves it.

Write in the second person to the applicant. No preamble, no markdown, no filler.`;

/** One finished utterance, as the coach sees it. */
export interface Turn {
  speaker: Speaker;
  text: string;
  startMs: number;
}

const label = (s: Speaker) => (s === 'them' ? 'THEM' : 'ME');
const renderTurns = (turns: Turn[]) => turns.map((t) => `${label(t.speaker)}: ${t.text}`).join('\n');

/**
 * The transcript as an append-only list of chunks. Every coach call commits the finished turns
 * since the last call as one new chunk, so call N's prompt is a strict prefix of call N+1's and
 * the cache breakpoint on the newest chunk lets the next call read everything before it.
 */
export class CoachTranscript {
  private readonly chunks: string[] = [];
  private pending: Turn[] = [];
  /** The interviewer's words that are still being said, not yet final. */
  partialThem = '';

  addFinal(turn: Turn) {
    this.pending.push(turn);
  }

  /** Moves finished turns into a new chunk and returns every chunk so far. */
  commit(): string[] {
    if (this.pending.length) {
      this.chunks.push(renderTurns(this.pending));
      this.pending = [];
    }
    return [...this.chunks];
  }
}

/** The prompt for one call: stable system + context, committed transcript, then a volatile tail. */
export function buildCoachBlocks(
  ctx: CoachContext,
  transcript: CoachTranscript,
  asked: string[],
): { system: Block[]; content: Block[] } {
  const chunks = transcript.commit();
  const tail = [
    transcript.partialThem ? `THEM (still talking): ${transcript.partialThem}` : '',
    asked.length ? `Questions the applicant has already asked: ${asked.join(' | ')}` : '',
    'Coach the next ten seconds.',
  ]
    .filter(Boolean)
    .join('\n\n');
  return {
    system: [{ text: COACH_SYSTEM_PROMPT }, { text: renderContext(ctx), cache: true }],
    content: [
      ...(chunks.length
        ? chunks.map((text, i) => ({ text, cache: i === chunks.length - 1 }))
        : [{ text: '(The call has just started.)', cache: false }]),
      { text: tail },
    ],
  };
}

export type CoachTrigger = 'utterance' | 'nudge';

export type CoachEvent =
  | { type: 'hint'; phase: 'start'; trigger: CoachTrigger }
  | { type: 'hint'; phase: 'delta'; text: string }
  | { type: 'hint'; phase: 'done'; trigger: CoachTrigger; hint: CoachHint; hintId: number }
  | { type: 'hint'; phase: 'aborted' }
  | { type: 'hint'; phase: 'error'; message: string };

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/**
 * Decides when to ask the coach. A newer trigger aborts the call in flight; interviewer
 * utterances are spaced at least `minIntervalMs` apart (a burst becomes one call at the end of the
 * wait); a nudge goes now; "mm-hmm" does not count as something to coach.
 */
export class CoachScheduler {
  private lastStart = Number.NEGATIVE_INFINITY;
  private timer: unknown = null;
  private runId = 0;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;

  constructor(
    private readonly o: {
      run: (kind: CoachTrigger) => Promise<void>;
      abort: () => void;
      minIntervalMs?: number;
      now?: () => number;
      setTimer?: (fn: () => void, ms: number) => unknown;
      clearTimer?: (h: unknown) => void;
    },
  ) {
    this.minIntervalMs = o.minIntervalMs ?? 4000;
    this.now = o.now ?? Date.now;
    this.setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = o.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  trigger(kind: CoachTrigger, text = '') {
    if (kind === 'utterance' && wordCount(text) < 3) return;
    if (kind === 'nudge') return this.start(kind);
    const wait = this.lastStart + this.minIntervalMs - this.now();
    if (wait <= 0) return this.start(kind);
    // Within the spacing window: one deferred call replaces any earlier deferred one.
    if (this.timer != null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => this.start(kind), wait);
  }

  /** Stop everything, e.g. when the call ends. */
  cancel() {
    if (this.timer != null) this.clearTimer(this.timer);
    this.timer = null;
    this.runId++;
    this.o.abort();
  }

  private start(kind: CoachTrigger) {
    if (this.timer != null) this.clearTimer(this.timer);
    this.timer = null;
    this.o.abort();
    this.lastStart = this.now();
    const id = ++this.runId;
    void this.o.run(kind).catch(() => {
      // run() reports its own failures; a stale id just means a newer call took over
      void id;
    });
  }
}

export interface CoachRunnerDeps {
  db: Db;
  provider: LLMProvider;
  session: SessionRow;
  ctx: CoachContext;
  transcript: CoachTranscript;
  asked: () => string[];
  emit: (e: CoachEvent) => void;
  /** Session-clock ms, for stamping when a hint fired. */
  clockMs: () => number;
}

/** Runs one coach call at a time and streams the card as it arrives. */
export class CoachRunner {
  private controller: AbortController | null = null;
  /** The latest segment id from the interviewer, so a hint can be tied to what prompted it. */
  lastSegmentId: number | null = null;

  constructor(private readonly d: CoachRunnerDeps) {}

  abort() {
    this.controller?.abort();
    this.controller = null;
  }

  async run(trigger: CoachTrigger): Promise<void> {
    const { db, provider, session, ctx, transcript } = this.d;
    if (!provider.completeBlocks)
      return this.d.emit({ type: 'hint', phase: 'error', message: 'This AI provider cannot coach live.' });
    const controller = new AbortController();
    this.controller = controller;
    const atMs = this.d.clockMs();
    const segmentId = this.lastSegmentId;
    const { system, content } = buildCoachBlocks(ctx, transcript, this.d.asked());
    this.d.emit({ type: 'hint', phase: 'start', trigger });
    try {
      const res = await provider.completeBlocks({
        model: session.coachModel,
        schema: coachHintSchema,
        system,
        content,
        effort: COACH_EFFORT,
        signal: controller.signal,
        onEvent: (e) => e.type === 'output' && this.d.emit({ type: 'hint', phase: 'delta', text: e.text }),
      });
      const usageId = recordUsage(db, {
        feature: 'coach',
        provider: res.provider,
        model: res.model,
        usage: res.usage,
        applicationId: ctx.applicationId,
        companyId: ctx.companyId,
        trace: res.trace,
      });
      const hintId = saveHint(db, session.id, { segmentId, trigger, hint: res.data, usageId, atMs });
      this.d.emit({ type: 'hint', phase: 'done', trigger, hint: res.data, hintId });
    } catch (e) {
      if (e instanceof AbortedError) {
        // Aborted calls are still billed for what they read, so they are logged too.
        recordUsage(db, {
          feature: 'coach',
          provider: provider.name,
          model: session.coachModel,
          usage: e.usage,
          applicationId: ctx.applicationId,
          companyId: ctx.companyId,
          trace: e.trace,
          error: 'aborted',
        });
        this.d.emit({ type: 'hint', phase: 'aborted' });
      } else {
        const message = e instanceof LLMError ? e.message : (e as Error).message;
        this.d.emit({ type: 'hint', phase: 'error', message });
      }
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }
}
