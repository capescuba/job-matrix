import { useEffect, useMemo, useRef, useState } from 'react';
import type { CoachHint } from '@jm/shared';
import { cx } from '../components/ui.tsx';
import { CoachCard } from './CoachCard.tsx';
import { clock, talkShare, type Turn } from './live.ts';

type Channel = 'both' | 'them' | 'me';

/**
 * Plays a recorded call (stereo: you left, them right) with the transcript scrolling along and
 * the coach cards shown where they fired. Click a line to jump there.
 */
export function Playback({
  sessionId,
  audioFile,
  turns,
  hints,
}: {
  sessionId: number;
  audioFile: string | null;
  turns: Turn[];
  hints: { segmentId: number | null; atMs: number; hint: CoachHint }[];
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const graph = useRef<{
    ctx: AudioContext;
    split: ChannelSplitterNode;
    merge: ChannelMergerNode;
  } | null>(null);
  const [t, setT] = useState(0);
  const [channel, setChannel] = useState<Channel>('both');
  const list = useRef<HTMLDivElement>(null);
  const stereo = audioFile?.endsWith('.ogg') ?? false;

  const hintBySegment = useMemo(() => {
    const m = new Map<number, CoachHint>();
    for (const h of hints) if (h.segmentId != null) m.set(h.segmentId, h.hint);
    return m;
  }, [hints]);
  const questionTurns = useMemo(
    () => turns.filter((x) => hintBySegment.has(x.id)),
    [turns, hintBySegment],
  );

  // The line being heard: the last one that started at or before now.
  const nowMs = t * 1000;
  const current = useMemo(() => {
    let lo = 0;
    let hi = turns.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (turns[mid].startMs <= nowMs) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }, [turns, nowMs]);
  const currentId = current >= 0 ? turns[current].id : null;
  const cardNow = useMemo(() => {
    for (let i = current; i >= 0; i--) {
      const h = hintBySegment.get(turns[i].id);
      if (h) return h;
    }
    return null;
  }, [current, turns, hintBySegment]);

  useEffect(() => {
    if (currentId == null) return;
    list.current
      ?.querySelector(`[data-seg="${currentId}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [currentId]);

  const seek = (ms: number) => {
    const a = audio.current;
    if (!a) return;
    a.currentTime = Math.max(0, ms / 1000 - 0.3);
    void a.play();
  };

  /** Routes left (you) and right (them) so either side can be heard alone, in both ears. */
  const route = (c: Channel) => {
    setChannel(c);
    const a = audio.current;
    if (!a || !stereo) return;
    if (!graph.current) {
      const ctx = new AudioContext();
      const src = ctx.createMediaElementSource(a);
      const split = ctx.createChannelSplitter(2);
      const merge = ctx.createChannelMerger(2);
      src.connect(split);
      merge.connect(ctx.destination);
      graph.current = { ctx, split, merge };
    }
    const { ctx, split, merge } = graph.current;
    void ctx.resume();
    split.disconnect();
    const from = c === 'both' ? null : c === 'me' ? 0 : 1;
    if (from == null) {
      split.connect(merge, 0, 0);
      split.connect(merge, 1, 1);
    } else {
      split.connect(merge, from, 0);
      split.connect(merge, from, 1);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = audio.current;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (!a || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === ' ') {
        e.preventDefault();
        if (a.paused) void a.play();
        else a.pause();
      } else if (e.key === 'ArrowLeft') a.currentTime = Math.max(0, a.currentTime - 5);
      else if (e.key === 'ArrowRight') a.currentTime += 5;
      else if (e.key === ']' || e.key === '[') {
        const now = a.currentTime * 1000;
        const next =
          e.key === ']'
            ? questionTurns.find((q) => q.startMs > now + 500)
            : [...questionTurns].reverse().find((q) => q.startMs < now - 1500);
        if (next) seek(next.startMs);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [questionTurns]);

  const share = talkShare(turns);

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
      <div className="min-w-0 space-y-3">
        {audioFile ? (
          <div className="flex flex-wrap items-center gap-3">
            <audio
              ref={audio}
              src={`/api/interviews/${sessionId}/audio`}
              controls
              preload="metadata"
              className="min-w-72 flex-1"
              onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
            />
            {stereo && (
              <div
                className="flex rounded-md border border-border text-xs"
                role="group"
                aria-label="Who to hear"
              >
                {(['both', 'them', 'me'] as const).map((c) => (
                  <button
                    key={c}
                    onClick={() => route(c)}
                    className={cx(
                      'px-2.5 py-1',
                      channel === c ? 'bg-surface-2 font-medium' : 'text-ink-2',
                    )}
                  >
                    {c === 'both' ? 'Both' : c === 'them' ? 'Them' : 'You'}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-ink-3">No recording for this call (transcript only).</p>
        )}
        <p className="text-xs text-ink-3">
          You spoke {share.mePct}% of the time · {clock(share.meMs)} you, {clock(share.themMs)}{' '}
          them.
          {audioFile && ' Space plays or pauses, arrows skip 5 s, [ and ] jump between questions.'}
        </p>
        <div
          ref={list}
          className="max-h-[60vh] space-y-1 overflow-y-auto rounded-lg border border-border bg-surface p-3"
        >
          {!turns.length && <p className="text-sm text-ink-3">Nothing was transcribed.</p>}
          {turns.map((x) => {
            const h = hintBySegment.get(x.id);
            const here = x.id === currentId;
            return (
              <div key={x.id} data-seg={x.id}>
                <button
                  onClick={() => seek(x.startMs)}
                  disabled={!audioFile}
                  className={cx(
                    'flex w-full gap-3 rounded px-2 py-1 text-left text-sm',
                    here ? 'bg-accent/10' : 'hover:bg-surface-2',
                  )}
                >
                  <span className="w-12 shrink-0 tabular-nums text-ink-3">{clock(x.startMs)}</span>
                  <span
                    className={cx(
                      'w-10 shrink-0 font-medium',
                      x.speaker === 'me' ? 'text-accent' : 'text-ink-2',
                    )}
                  >
                    {x.speaker === 'me' ? 'You' : 'Them'}
                  </span>
                  <span className={x.speaker === 'me' ? 'text-ink' : 'text-ink-2'}>{x.text}</span>
                </button>
                {h?.probing && (
                  <p className="ml-24 border-l-2 border-accent/40 pl-2 text-xs text-ink-3">
                    Coach: {h.question ? `${h.question} · ` : ''}
                    {h.probing}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="rounded-lg border border-border bg-surface p-4 lg:sticky lg:top-4">
        <p className="mb-2 text-xs font-medium text-ink-3">Coach card at this point</p>
        <CoachCard card={cardNow} writing={false} compact />
      </div>
    </div>
  );
}
