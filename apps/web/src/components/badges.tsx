import {
  CLOSED_STATUSES,
  describePosted,
  type Gate,
  type GateReason,
  type Status,
} from '@jm/shared';
import type { ApplicationRow } from '../api.ts';
import { cx } from './ui.tsx';

const statusTone: Record<Status, string> = {
  Saved: 'text-ink-2 border-border',
  Applied: 'text-accent border-accent/40',
  'Recruiter Screen': 'text-accent border-accent/40',
  'Hiring Manager': 'text-accent border-accent/40',
  'Interview Loop': 'text-accent border-accent/40',
  Offer: 'text-good border-good/40',
  Rejected: 'text-bad border-bad/40',
  Withdrawn: 'text-ink-3 border-border',
  Ghosted: 'text-ink-3 border-border',
};

export function StatusBadge({ status }: { status: Status }) {
  return (
    <span
      className={cx(
        'inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium',
        statusTone[status],
      )}
    >
      {status}
    </span>
  );
}

/** Tone for a 0–10 fit score. */
export function fitTone(score: number) {
  return score >= 8
    ? 'text-good'
    : score >= 7
      ? 'text-accent'
      : score >= 6
        ? 'text-warn'
        : 'text-bad';
}

export const formatScore = (s: number) => s.toFixed(1);

const joinLabels = (reasons: GateReason[], status: GateReason['status']) =>
  reasons
    .filter((r) => r.status === status)
    .map((r) => r.label)
    .join(', ');

/**
 * Fit score with the must-have / deal-breaker filter applied: a failing job reads "Fails: base"
 * with the score underneath, so a high score can't hide a disqualifier.
 */
export function FitBadge({
  score,
  verdict,
  gate,
  reasons,
  compact,
}: {
  score: number | null;
  verdict?: string | null;
  gate?: Gate | null;
  reasons?: GateReason[] | null;
  compact?: boolean;
}) {
  if (score == null) return <span className="text-xs text-ink-3">—</span>;
  const tip = reasons
    ?.map((r) => `${r.status === 'fails' ? '✕' : '?'} ${r.label}: ${r.note}`)
    .join('\n');
  if (gate === 'fail') {
    return (
      <span className="inline-flex flex-col leading-tight" title={tip}>
        <span className="whitespace-nowrap text-xs font-semibold text-bad">
          Fails: {joinLabels(reasons ?? [], 'fails')}
        </span>
        <span className="text-xs tabular-nums text-ink-3">
          {formatScore(score)}
          {!compact && verdict && ` · ${verdict}`}
        </span>
      </span>
    );
  }
  return (
    <span className="inline-flex flex-col leading-tight" title={tip ?? verdict ?? undefined}>
      <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
        <span className={cx('font-semibold tabular-nums', fitTone(score))}>
          {formatScore(score)}
        </span>
        {!compact && verdict && <span className="text-xs text-ink-3">{verdict}</span>}
      </span>
      {gate === 'check' && (
        <span className="whitespace-nowrap text-xs text-warn">
          Check: {joinLabels(reasons ?? [], 'unclear')}
        </span>
      )}
    </span>
  );
}

/** Posted-date label + citation for a job/row, or null if no date is known. */
export function postedOf(j: {
  postedAt: string | null;
  postedSource: string | null;
  postedApprox: boolean;
  postedRaw: string | null;
}) {
  return j.postedAt
    ? describePosted({
        date: j.postedAt,
        source: j.postedSource,
        approx: j.postedApprox,
        raw: j.postedRaw,
      })
    : null;
}

const DAY = 86_400_000;
export const daysSince = (date: string) =>
  Math.floor((Date.now() - Date.parse(`${date.slice(0, 10)}T12:00:00Z`)) / DAY);

export interface Flag {
  key: string;
  label: string;
  tone: 'bad' | 'warn' | 'accent' | 'good';
  title: string;
}

/** Things worth knowing about a job beyond its score: stale/closed posting, level, outreach. */
export function jobFlags(r: ApplicationRow): Flag[] {
  const open = !CLOSED_STATUSES.includes(r.status);
  const flags: Flag[] = [];
  if (open && r.postingStatus === 'closed')
    flags.push({
      key: 'closed',
      label: 'Posting closed?',
      tone: 'bad',
      title: r.postingNote ?? '',
    });
  const posted = postedOf(r);
  if (open && posted && posted.days > 60)
    flags.push({
      key: 'stale',
      label: posted.label,
      tone: 'warn',
      title: `${posted.title}\nOver 60 days old: often stale or a standing hiring pool.`,
    });
  if (r.levelMismatch)
    flags.push({ key: 'level', label: 'Level mismatch', tone: 'warn', title: r.levelMismatch });
  if (r.contactCount > 0)
    flags.push({
      key: 'contact',
      label: `Know ${r.contactCount}`,
      tone: 'good',
      title: 'You have contacts at this company',
    });
  if (open && r.outreachRecommended)
    flags.push({ key: 'outreach', label: 'Reach out', tone: 'accent', title: r.outreachWhy ?? '' });
  return flags;
}

const flagTone = {
  bad: 'border-bad/40 text-bad',
  warn: 'border-warn/40 text-warn',
  accent: 'border-accent/40 text-accent',
  good: 'border-good/40 text-good',
};

export function FlagChips({ flags }: { flags: Flag[] }) {
  if (!flags.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {flags.map((f) => (
        <span
          key={f.key}
          title={f.title}
          className={cx(
            'whitespace-nowrap rounded border px-1.5 py-px text-[11px] font-medium',
            flagTone[f.tone],
          )}
        >
          {f.label}
        </span>
      ))}
    </span>
  );
}
