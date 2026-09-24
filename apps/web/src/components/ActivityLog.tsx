import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { ACTIVITY_KINDS, STATUSES, type ActivityKind, type Status } from '@jm/shared';
import { api, type ApplicationDetail } from '../api.ts';
import { Button, Card, ErrorText, Input, Select, cx } from './ui.tsx';

const kindTone: Record<ActivityKind, string> = {
  Applied: 'text-accent',
  'Follow-up': 'text-ink-2',
  Response: 'text-good',
  Interview: 'text-good',
  Note: 'text-ink-3',
};

/** Suggested status when logging a kind of activity — the user can change it. */
const suggestedStatus: Partial<Record<ActivityKind, Status>> = { Applied: 'Applied' };

const todayStr = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local

type Entry =
  | { type: 'activity'; id: number; date: string; kind: ActivityKind; summary: string | null }
  | { type: 'status'; id: number; date: string; from: string | null; to: string };

/** Activities and status changes, merged into one dated timeline, with a form to log a new touchpoint. */
export function ActivityLog({
  data,
  onChanged,
}: {
  data: ApplicationDetail;
  onChanged: () => void;
}) {
  const blank = { at: todayStr(), kind: 'Follow-up' as ActivityKind, summary: '', setStatus: '' };
  const [f, setF] = useState(blank);
  const [adding, setAdding] = useState(false);

  const add = useMutation({
    mutationFn: () =>
      api.addActivity(data.application.id, {
        at: f.at,
        kind: f.kind,
        summary: f.summary || null,
        setStatus: (f.setStatus || null) as Status | null,
      }),
    onSuccess: () => {
      setF(blank);
      setAdding(false);
      onChanged();
    },
  });
  const del = useMutation({ mutationFn: api.deleteActivity, onSuccess: onChanged });

  const entries: Entry[] = [
    ...data.activities.map((a) => ({
      type: 'activity' as const,
      id: a.id,
      date: a.at,
      kind: a.kind as ActivityKind,
      summary: a.summary,
    })),
    ...data.events
      // "Created as Applied" is redundant next to an Applied activity on the same day.
      .filter(
        (e) =>
          e.fromStatus ||
          !data.activities.some((a) => a.kind === e.toStatus && a.at === e.at.slice(0, 10)),
      )
      .map((e) => ({
        type: 'status' as const,
        id: e.id,
        date: e.at.slice(0, 10),
        from: e.fromStatus,
        to: e.toStatus,
      })),
  ].sort((a, b) => b.date.localeCompare(a.date) || (a.type === 'status' ? 1 : -1));

  return (
    <Card
      title="Activity"
      actions={
        !adding && (
          <Button variant="ghost" onClick={() => setAdding(true)}>
            + Log
          </Button>
        )
      }
    >
      {adding && (
        <form
          className="mb-4 space-y-2 rounded-md border border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <div className="grid grid-cols-2 gap-2">
            <Input
              type="date"
              required
              value={f.at}
              onChange={(e) => setF({ ...f, at: e.target.value })}
            />
            <Select
              value={f.kind}
              onChange={(e) => {
                const kind = e.target.value as ActivityKind;
                setF({ ...f, kind, setStatus: suggestedStatus[kind] ?? f.setStatus });
              }}
            >
              {ACTIVITY_KINDS.map((k) => (
                <option key={k}>{k}</option>
              ))}
            </Select>
          </div>
          <Input
            placeholder="Summary (e.g. emailed recruiter, phone screen with Jane)"
            value={f.summary}
            onChange={(e) => setF({ ...f, summary: e.target.value })}
          />
          <Select value={f.setStatus} onChange={(e) => setF({ ...f, setStatus: e.target.value })}>
            <option value="">Keep status ({data.application.status})</option>
            {STATUSES.filter((s) => s !== data.application.status).map((s) => (
              <option key={s} value={s}>
                Move to {s}
              </option>
            ))}
          </Select>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={add.isPending}>
              Log
            </Button>
          </div>
          <ErrorText error={add.error} />
        </form>
      )}

      {entries.length === 0 ? (
        <p className="text-sm text-ink-3">Nothing logged yet.</p>
      ) : (
        <ol className="space-y-2 text-sm">
          {entries.map((e) => (
            <li key={`${e.type}-${e.id}`} className="group flex items-start justify-between gap-2">
              <span className="min-w-0">
                {e.type === 'activity' ? (
                  <>
                    <span className={cx('font-medium', kindTone[e.kind])}>{e.kind}</span>
                    {e.summary && <span className="text-ink-2"> · {e.summary}</span>}
                  </>
                ) : (
                  <span className="text-ink-3">
                    {e.from ? (
                      <>
                        Status {e.from} → <span className="text-ink-2">{e.to}</span>
                      </>
                    ) : (
                      <>Created as {e.to}</>
                    )}
                  </span>
                )}
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <span className="whitespace-nowrap tabular-nums text-ink-3">{e.date}</span>
                {e.type === 'activity' && (
                  <button
                    className="invisible px-1 text-ink-3 hover:text-bad group-hover:visible"
                    onClick={() => del.mutate(e.id)}
                    aria-label="Delete activity"
                  >
                    ✕
                  </button>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
