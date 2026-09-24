import { useEffect, useRef, useState } from 'react';
import { FIT_PARTS, type FitPartKey } from '@jm/shared';
import { partialParts, runProgress, type AiRun } from '../aiActivity.ts';
import { fitTone } from './badges.tsx';
import { CallInspector } from './CallInspector.tsx';
import { Button, cx } from './ui.tsx';

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** Live view of one AI run: steps with timings, real progress, thinking and output as they stream. */
export function LiveRun({ run, showLabel }: { run: AiRun; showLabel?: boolean }) {
  const [now, setNow] = useState(Date.now());
  const [open, setOpen] = useState<'thinking' | 'output' | null>(null);
  const [inspect, setInspect] = useState(false);
  useEffect(() => {
    if (run.finishedAt) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [run.finishedAt]);

  const elapsed = (run.finishedAt ?? now) - run.startedAt;
  const progress = runProgress(run);
  const parts = partialParts(run.output);

  return (
    <div className="rounded-md border border-border bg-surface-2/40 p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-medium">
          {showLabel ? run.label : run.finishedAt ? 'Last scoring run' : 'Scoring…'}
        </span>
        <span className="shrink-0 tabular-nums text-ink-3">{secs(elapsed)}</span>
      </div>

      <div
        className="mt-2 h-1.5 rounded-full bg-surface-2"
        role="progressbar"
        aria-valuenow={Math.round(progress.value * 100)}
      >
        <div
          className={cx(
            'h-1.5 rounded-full transition-[width] duration-300',
            run.result && !run.result.ok ? 'bg-bad' : 'bg-accent',
          )}
          style={{ width: `${progress.value * 100}%` }}
        />
      </div>
      <div className="mt-1 text-xs text-ink-2">{progress.label}</div>

      {Object.keys(parts).length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {(Object.keys(FIT_PARTS) as FitPartKey[]).map((k) =>
            parts[k] != null ? (
              <span key={k} className="rounded bg-surface px-1.5 py-0.5 text-xs">
                <span className="text-ink-3">{FIT_PARTS[k].label}</span>{' '}
                <span className={cx('font-semibold tabular-nums', fitTone(parts[k]))}>
                  {parts[k]}
                </span>
              </span>
            ) : null,
          )}
        </div>
      )}

      <ol className="mt-2 space-y-1 text-xs">
        {run.steps.map((s, i) => (
          <li key={i} className="flex gap-2">
            <span className="w-10 shrink-0 text-right tabular-nums text-ink-3">
              +{secs(s.at - run.startedAt)}
            </span>
            <span>
              {s.text}
              {s.detail && <span className="block text-ink-3">{s.detail}</span>}
            </span>
          </li>
        ))}
        {run.result && (
          <li className="flex gap-2">
            <span className="w-10 shrink-0 text-right tabular-nums text-ink-3">
              +{secs((run.finishedAt ?? now) - run.startedAt)}
            </span>
            <span className={cx('font-medium', run.result.ok ? 'text-good' : 'text-bad')}>
              {run.result.text}
            </span>
          </li>
        )}
      </ol>

      <div className="mt-2 flex flex-wrap gap-1">
        <Button
          variant="ghost"
          className="px-2 py-0.5 text-xs"
          disabled={!run.thinking}
          onClick={() => setOpen(open === 'thinking' ? null : 'thinking')}
        >
          {open === 'thinking' ? '▾' : '▸'} Thinking{' '}
          {run.thinking
            ? `(${run.thinking.length.toLocaleString()} chars)`
            : run.output && '(skipped — went straight to writing)'}
        </Button>
        <Button
          variant="ghost"
          className="px-2 py-0.5 text-xs"
          disabled={!run.output}
          onClick={() => setOpen(open === 'output' ? null : 'output')}
        >
          {open === 'output' ? '▾' : '▸'} Output{' '}
          {run.output && `(${run.output.length.toLocaleString()} chars)`}
        </Button>
        {run.result?.usageId != null && (
          <Button variant="ghost" className="px-2 py-0.5 text-xs" onClick={() => setInspect(true)}>
            Inspect request
          </Button>
        )}
      </div>
      {open && (
        <Stream text={open === 'thinking' ? run.thinking : run.output} mono={open === 'output'} />
      )}
      {inspect && run.result?.usageId != null && (
        <CallInspector usageId={run.result.usageId} onClose={() => setInspect(false)} />
      )}
    </div>
  );
}

/** Auto-scrolling box that follows streamed text unless you scroll up. */
function Stream({ text, mono }: { text: string; mono?: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <pre
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className={cx(
        'mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded bg-surface p-2 text-xs leading-relaxed text-ink-2',
        mono ? 'font-mono' : 'font-sans',
      )}
    >
      {text}
    </pre>
  );
}
