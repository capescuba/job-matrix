import type { CoachHint } from '@jm/shared';
import { cx } from '../components/ui.tsx';

/**
 * The one thing to look at during a call. Big type, few words, fixed places: the question on top,
 * what they're really after under it, three points, then the story chip, a warning, a question back.
 */
export function CoachCard({
  card,
  writing,
  compact = false,
}: {
  card: Partial<CoachHint> | null;
  writing: boolean;
  compact?: boolean;
}) {
  return (
    <div className="relative">
      <div
        className={cx(
          'absolute inset-x-0 -top-px h-0.5 overflow-hidden rounded-full',
          writing ? 'bg-accent/20' : 'bg-transparent',
        )}
        aria-hidden
      >
        {writing && <div className="h-full w-1/3 animate-pulse bg-accent" />}
      </div>
      {!card ? (
        <p className={cx('text-ink-3', compact ? 'text-lg' : 'text-2xl')}>
          {writing ? 'Thinking…' : 'Listening. A card appears when they ask something.'}
        </p>
      ) : (
        <div className={cx(compact ? 'space-y-2' : 'space-y-4')}>
          {card.question && (
            <p className={cx('font-semibold leading-tight', compact ? 'text-xl' : 'text-3xl')}>
              {card.question}
            </p>
          )}
          {card.probing && (
            <p className={cx('text-ink-2', compact ? 'text-sm' : 'text-lg')}>
              <span className="text-ink-3">They want: </span>
              {card.probing}
            </p>
          )}
          {!!card.points?.length && (
            <ul className={cx('space-y-1', compact ? 'text-base' : 'text-xl')}>
              {card.points.map((p, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-accent">•</span>
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {card.story && (
              <span
                className={cx(
                  'rounded-full bg-surface-2 px-3 py-1 font-medium',
                  compact ? 'text-xs' : 'text-sm',
                )}
              >
                Story: {card.story}
              </span>
            )}
          </div>
          {card.watch && (
            <p className={cx('font-medium text-warn', compact ? 'text-sm' : 'text-base')}>
              ⚠ {card.watch}
            </p>
          )}
          {card.askBack && (
            <p className={cx('text-accent', compact ? 'text-sm' : 'text-base')}>
              Ask back: {card.askBack}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
