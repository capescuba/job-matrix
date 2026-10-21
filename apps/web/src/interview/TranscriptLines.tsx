import { cx } from '../components/ui.tsx';
import type { LiveState } from './live.ts';

/**
 * The last few lines of the call, with what is being said right now (dimmed) at the bottom.
 * Used beside the coach card and, smaller, in the pop-out window.
 */
export function TranscriptLines({
  live,
  limit,
  compact = false,
}: {
  live: Pick<LiveState, 'turns' | 'pending'>;
  limit: number;
  compact?: boolean;
}) {
  const recent = live.turns.slice(-limit);
  const label = (s: 'me' | 'them') => (s === 'me' ? 'You' : 'Them');
  const empty = !recent.length && !live.pending.me && !live.pending.them;
  return (
    <div className={cx('space-y-1', compact ? 'text-xs' : 'text-sm')}>
      {recent.map((t) => (
        <p key={t.id} className={t.speaker === 'me' ? 'text-accent' : 'text-ink-2'}>
          <span className="mr-1 text-xs text-ink-3">{label(t.speaker)}</span>
          {t.text}
        </p>
      ))}
      {(['them', 'me'] as const).map(
        (s) =>
          live.pending[s] && (
            <p key={s} className="italic text-ink-3">
              <span className="mr-1 text-xs">{label(s)}</span>
              {live.pending[s]}
            </p>
          ),
      )}
      {empty && <p className="text-ink-3">Transcript appears here.</p>}
    </div>
  );
}
