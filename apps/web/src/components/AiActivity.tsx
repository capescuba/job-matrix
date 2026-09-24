import { useEffect, useState } from 'react';
import { useAiRuns } from '../aiActivity.ts';
import { LiveRun } from './LiveRun.tsx';
import { Button, cx } from './ui.tsx';

/** Header indicator ("AI · 3 running") that opens a drawer with every recent AI run, live. */
export function AiActivity() {
  const runs = useAiRuns();
  const [open, setOpen] = useState(false);
  const running = runs.filter((r) => !r.finishedAt).length;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={cx(
          'flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-sm',
          running ? 'text-accent' : 'text-ink-3 hover:text-ink',
        )}
        title="Live AI activity"
      >
        <span
          className={cx('size-2 rounded-full', running ? 'animate-pulse bg-accent' : 'bg-ink-3/50')}
        />
        AI{running > 0 && ` · ${running} running`}
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/30"
          onMouseDown={() => setOpen(false)}
        >
          <aside
            className="flex h-full w-full max-w-md flex-col border-l border-border bg-surface shadow-xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <header className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="font-semibold">AI activity</h2>
              <Button variant="ghost" onClick={() => setOpen(false)} aria-label="Close">
                ✕
              </Button>
            </header>
            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              {runs.length === 0 ? (
                <p className="text-sm text-ink-3">
                  No AI calls in the last few minutes. Score a job and you'll see each step here as
                  it happens.
                </p>
              ) : (
                runs.map((r) => <LiveRun key={r.id} run={r} showLabel />)
              )}
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
