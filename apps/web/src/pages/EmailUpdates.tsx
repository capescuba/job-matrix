import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { STATUSES, type Status } from '@jm/shared';
import { api, type EmailKind, type EmailUpdateRow, type MailStatus } from '../api.ts';
import { StatusBadge } from '../components/badges.tsx';
import { Button, Card, ErrorText, Input, Select, cx } from '../components/ui.tsx';

const KIND: Record<EmailKind, { label: string; tone: string }> = {
  confirmation: { label: 'Application received', tone: 'text-accent bg-accent/10' },
  rejection: { label: 'Rejection', tone: 'text-bad bg-bad/10' },
  interview: { label: 'Interview request', tone: 'text-good bg-good/10' },
  action: { label: 'Action needed', tone: 'text-warn bg-warn/10' },
  offer: { label: 'Offer', tone: 'text-good bg-good/15' },
  viewed: { label: 'Viewed', tone: 'text-ink-2 bg-surface-2' },
  unclear: { label: 'Unclear', tone: 'text-ink-3 bg-surface-2' },
};

const INTERVAL_LABEL: Record<number, string> = {
  [-1]: 'Manual only',
  0: 'When Job Matrix opens',
  15: 'Every 15 minutes',
  30: 'Every 30 minutes',
  60: 'Every hour',
};

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const cents = (usd: number | null) =>
  usd == null ? '' : usd < 0.01 ? `~${(usd * 100).toFixed(1)}¢` : `~${Math.round(usd * 100)}¢`;

/** Refresh everything an email change can touch. */
function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    for (const key of [
      'email-updates',
      'mail-status',
      'applications',
      'stats',
      'application',
      'usage',
    ])
      qc.invalidateQueries({ queryKey: [key] });
  };
}

export default function EmailUpdatesPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'done' ? 'done' : 'pending';
  const { data: status } = useQuery({
    queryKey: ['mail-status'],
    queryFn: api.mailStatus,
    refetchInterval: (q) =>
      q.state.data?.progress.running || q.state.data?.signingIn ? 2000 : 60_000,
  });
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['email-updates', tab],
    queryFn: () => api.emailUpdates(tab),
  });

  // When a check finishes, show what it found.
  const invalidate = useInvalidate();
  const wasRunning = useRef(false);
  useEffect(() => {
    const running = Boolean(status?.progress.running);
    if (wasRunning.current && !running) invalidate();
    wasRunning.current = running;
  }, [status?.progress.running]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = {
    possible: rows.filter((r) => r.kind !== 'unclear' && r.matchedBy === 'title-only'),
    suggested: rows.filter(
      (r) => r.kind !== 'unclear' && r.applicationId && r.matchedBy !== 'title-only',
    ),
    pick: rows.filter((r) => r.kind !== 'unclear' && !r.applicationId && r.companyId),
    untracked: rows.filter((r) => r.kind !== 'unclear' && !r.companyId),
    unclear: rows.filter((r) => r.kind === 'unclear'),
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold">Email</h1>
        <div className="flex rounded-md border border-border p-0.5">
          {(
            [
              ['pending', `To review${status?.pending ? ` (${status.pending})` : ''}`],
              ['done', 'Done'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setParams(key === 'done' ? { tab: 'done' } : {})}
              className={cx(
                'rounded px-3 py-1 text-sm',
                tab === key ? 'bg-surface-2 font-medium' : 'text-ink-2',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <ConnectionCard status={status} />

      {isLoading ? (
        <p className="text-sm text-ink-3">Loading…</p>
      ) : tab === 'done' ? (
        <DoneList rows={rows} />
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-ink-3">
          Nothing to review.{' '}
          {status?.signedIn && 'Press Check now to look for new application emails.'}
        </p>
      ) : (
        <>
          <Group
            title="Possible matches"
            hint="The email names a company you don't track, but the job title matches one of your jobs (e.g. after an acquisition or rename). Check it's right."
            rows={groups.possible}
            askAiUsd={status?.askAiUsd ?? null}
          />
          <Group
            title="Suggested updates"
            hint="What each email means for the job it's about. Nothing changes until you apply it."
            rows={groups.suggested}
            askAiUsd={status?.askAiUsd ?? null}
          />
          <Group
            title="Pick the job"
            hint="The company matched, but you track more than one job there."
            rows={groups.pick}
            askAiUsd={status?.askAiUsd ?? null}
          />
          <Group
            title="Not tracked"
            hint="About a job that isn't in Job Matrix yet."
            rows={groups.untracked}
            askAiUsd={status?.askAiUsd ?? null}
          />
          <Group
            title="Unclear"
            hint="Job-related, but the rules can't tell what it means. Ask AI, or say what it is."
            rows={groups.unclear}
            askAiUsd={status?.askAiUsd ?? null}
          />
        </>
      )}
    </div>
  );
}

// ---------- connection & checking ----------

function ConnectionCard({ status }: { status: MailStatus | undefined }) {
  const invalidate = useInvalidate();
  const qc = useQueryClient();
  const setStatus = (s: MailStatus) => qc.setQueryData(['mail-status'], s);
  const connect = useMutation({ mutationFn: api.mailConnect, onSuccess: invalidate });
  const sync = useMutation({ mutationFn: api.mailSync, onSuccess: setStatus });
  const rescan = useMutation({ mutationFn: api.mailRescan, onSuccess: setStatus });
  const settings = useMutation({ mutationFn: api.mailSettings, onSuccess: setStatus });
  if (!status) return null;
  const running = status.progress.running;

  if (!status.configured)
    return (
      <Card title="Outlook">
        <p className="text-sm text-ink-2">
          No Azure app ID yet. Save <code>{'{"clientId": "…"}'}</code> to{' '}
          <code>%USERPROFILE%\.email-mcp\config.json</code> (the same file email-mcp uses).
        </p>
      </Card>
    );

  if (!status.signedIn || status.signingIn)
    return (
      <Card title="Outlook">
        {status.signingIn ? (
          <div className="space-y-2 text-sm">
            <p>
              Open{' '}
              <a
                href={status.signingIn.verificationUri}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-accent hover:underline"
              >
                {status.signingIn.verificationUri}
              </a>{' '}
              and enter this code:
            </p>
            <div className="flex items-center gap-2">
              <code className="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-lg font-semibold tracking-widest">
                {status.signingIn.userCode}
              </code>
              <Button onClick={() => navigator.clipboard.writeText(status.signingIn!.userCode)}>
                Copy
              </Button>
            </div>
            <p className="text-ink-3">
              Sign in with your Hotmail account. This page updates when you're done (the code works
              until{' '}
              {new Date(status.signingIn.expiresAt).toLocaleTimeString([], { timeStyle: 'short' })}
              ).
            </p>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-ink-2">
              Connect your Hotmail/Outlook.com mailbox (read-only) so Job Matrix can find
              application updates. The sign-in is shared with Claude's email tools.
            </p>
            <Button variant="primary" onClick={() => connect.mutate()} disabled={connect.isPending}>
              Connect Outlook
            </Button>
          </div>
        )}
        {status.lastError && <p className="mt-2 text-sm text-bad">{status.lastError}</p>}
        <ErrorText error={connect.error} />
      </Card>
    );

  return (
    <Card
      title={
        <span>
          Outlook <span className="font-normal text-ink-3">· {status.account ?? 'connected'}</span>
        </span>
      }
      actions={
        <>
          <Button variant="primary" onClick={() => sync.mutate()} disabled={running}>
            {running ? 'Checking…' : 'Check now'}
          </Button>
          <Button
            onClick={() =>
              confirm(
                'Read your mail again from two weeks before your first application? Emails you already have (or dismissed) are skipped.',
              ) && rescan.mutate()
            }
            disabled={running}
          >
            Re-scan history
          </Button>
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        {running ? (
          <span className="text-accent">
            Checking… {status.progress.scanned} emails looked at, {status.progress.found} job
            updates found
          </span>
        ) : (
          <span className="text-ink-2">
            Last checked: {when(status.lastSyncAt)}
            {status.lastSyncAt && (
              <span className="text-ink-3">
                {' '}
                ({status.scanned} emails looked at, {status.found} job updates)
              </span>
            )}
          </span>
        )}
        <label className="flex items-center gap-2 text-ink-2">
          Check
          <Select
            className="w-auto max-w-xs"
            value={status.intervalMinutes}
            onChange={(e) => settings.mutate({ intervalMinutes: Number(e.target.value) })}
          >
            {status.intervals.map((m) => (
              <option key={m} value={m}>
                {INTERVAL_LABEL[m] ?? `Every ${m} minutes`}
              </option>
            ))}
          </Select>
        </label>
        {status.intervalMinutes >= 0 && (
          <label className="flex items-center gap-1.5 text-ink-2">
            <input
              type="checkbox"
              checked={!status.enabled}
              onChange={(e) => settings.mutate({ enabled: !e.target.checked })}
            />
            Pause
          </label>
        )}
        {status.nextSyncAt && (
          <span className="text-ink-3">Next check: {when(status.nextSyncAt)}</span>
        )}
      </div>
      <p className="mt-2 text-xs text-ink-3">
        Looks in every folder (Inbox, Junk, Deleted Items, your own folders), not Sent or Drafts.
        Only job-related emails are kept; checks run while Job Matrix is open.
      </p>
      {status.lastError && !running && (
        <p className="mt-2 text-sm text-bad">Last check failed: {status.lastError}</p>
      )}
      <ErrorText error={sync.error ?? rescan.error ?? settings.error} />
    </Card>
  );
}

// ---------- the queue ----------

function Group({
  title,
  hint,
  rows,
  askAiUsd,
}: {
  title: string;
  hint: string;
  rows: EmailUpdateRow[];
  askAiUsd: number | null;
}) {
  if (!rows.length) return null;
  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-sm font-semibold">
          {title} <span className="font-normal text-ink-3">({rows.length})</span>
        </h2>
        <p className="text-xs text-ink-3">{hint}</p>
      </div>
      {rows.map((r) => (
        <UpdateCard key={r.id} row={r} askAiUsd={askAiUsd} />
      ))}
    </section>
  );
}

function KindChip({ kind }: { kind: string }) {
  const k = KIND[kind as EmailKind] ?? KIND.unclear;
  return (
    <span className={cx('rounded-full px-2 py-0.5 text-xs font-semibold', k.tone)}>{k.label}</span>
  );
}

function EmailHeader({ row, children }: { row: EmailUpdateRow; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <KindChip kind={row.kind} />
        {row.classifiedBy === 'ai' && <span className="text-xs text-ink-3">read by AI</span>}
        <span className="font-medium">{row.subject}</span>
        <span className="ml-auto text-xs text-ink-3">
          {row.fromName ?? row.fromAddr} · {day(row.receivedAt)}
        </span>
      </div>
      {row.evidence && row.evidence !== row.subject && (
        <p className="border-l-2 border-border pl-2 text-sm text-ink-2">“{row.evidence}”</p>
      )}
      <div className="flex flex-wrap gap-3 text-xs">
        {row.excerpt && (
          <button className="text-ink-3 hover:text-ink" onClick={() => setOpen(!open)}>
            {open ? 'Hide email text' : 'Show email text'}
          </button>
        )}
        {row.webLink && (
          <a
            href={row.webLink}
            target="_blank"
            rel="noreferrer"
            className="text-ink-3 hover:text-accent"
          >
            Open in Outlook ↗
          </a>
        )}
        {children}
      </div>
      {open && (
        <p className="rounded-md bg-surface-2 p-2 text-xs whitespace-pre-wrap text-ink-2">
          {row.excerpt}…
        </p>
      )}
    </div>
  );
}

function UpdateCard({ row, askAiUsd }: { row: EmailUpdateRow; askAiUsd: number | null }) {
  const invalidate = useInvalidate();
  const [status, setStatus] = useState<string>('suggested');
  const [company, setCompany] = useState(row.companyName ?? '');
  const [title, setTitle] = useState(row.jobTitle ?? '');
  // Title-only matches: remember the email's company name as another name for the job's company.
  const titleOnly = row.matchedBy === 'title-only';
  const [remember, setRemember] = useState(true);
  const { data: companies = [] } = useQuery({
    queryKey: ['companies'],
    queryFn: api.companies,
    enabled: !row.companyId && row.kind !== 'unclear',
  });
  const opts = { onSuccess: invalidate };
  const apply = useMutation({
    mutationFn: () =>
      api.applyEmailUpdate(row.id, {
        ...(status === 'suggested' ? {} : { status: status === 'log' ? null : (status as Status) }),
        ...(titleOnly && remember && row.companyName ? { rememberAlias: row.companyName } : {}),
      }),
    ...opts,
  });
  const dismiss = useMutation({ mutationFn: () => api.dismissEmailUpdate(row.id), ...opts });
  const relabel = useMutation({
    mutationFn: (b: {
      kind?: EmailKind;
      applicationId?: number | null;
      companyId?: number;
      rememberAlias?: boolean;
    }) => api.relabelEmailUpdate(row.id, b),
    ...opts,
  });
  const track = useMutation({
    mutationFn: () => api.trackEmailUpdate(row.id, { company, title }),
    ...opts,
  });
  const ask = useMutation({ mutationFn: () => api.classifyEmailUpdate(row.id), ...opts });
  const busy =
    apply.isPending || dismiss.isPending || relabel.isPending || track.isPending || ask.isPending;
  const app = row.application;
  const unclear = row.kind === 'unclear';

  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface p-3">
      <EmailHeader row={row} />

      {app && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Link to={`/applications/${app.id}`} className="font-medium hover:text-accent">
            {app.company} · {app.title}
          </Link>
          <StatusBadge status={app.status} />
          {!unclear && (
            <>
              <span className="text-ink-3">→</span>
              {row.suggestedStatus ? (
                <StatusBadge status={row.suggestedStatus as Status} />
              ) : (
                <span className="text-ink-3">just log the email</span>
              )}
            </>
          )}
          {titleOnly && (
            <span className="w-full text-xs text-warn">
              Matched by job title only: the email says “{row.companyName ?? 'another company'}”,
              and you track this job at {app.company}.
            </span>
          )}
          {row.matchedBy === 'only-open' && (
            <span className="text-xs text-ink-3">
              (your only open job there — check it's the right one)
            </span>
          )}
          {row.suggestedNextAction && (
            <span className="text-ink-2">· Next: {row.suggestedNextAction}</span>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {/* Which job, when the company has several (or to correct the match). */}
        {!app && row.companyApplications.length > 0 && (
          <Select
            className="w-auto max-w-md"
            value=""
            onChange={(e) =>
              e.target.value && relabel.mutate({ applicationId: Number(e.target.value) })
            }
          >
            <option value="">Which {row.companyName} job is this about?</option>
            {row.companyApplications.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title} ({a.status})
              </option>
            ))}
          </Select>
        )}

        {!row.companyId && !unclear && companies.length > 0 && (
          <Select
            className="w-auto max-w-xs"
            value=""
            onChange={(e) =>
              e.target.value &&
              relabel.mutate({ companyId: Number(e.target.value), rememberAlias: remember })
            }
          >
            <option value="">It's from a company I track…</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
        {!row.companyId && !unclear && (
          <>
            <span className="text-xs text-ink-3">or</span>
            <Input
              className="w-40"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="Company"
            />
            <Input
              className="w-72"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Job title"
            />
            <Button
              variant="primary"
              disabled={busy || !company.trim() || !title.trim()}
              onClick={() => track.mutate()}
            >
              Add to tracker
            </Button>
          </>
        )}

        {unclear && (
          <>
            <Button variant="primary" disabled={busy} onClick={() => ask.mutate()}>
              {ask.isPending ? 'Asking…' : `Ask AI ${cents(askAiUsd)}`}
            </Button>
            <Select
              className="w-auto max-w-xs"
              value=""
              onChange={(e) =>
                e.target.value && relabel.mutate({ kind: e.target.value as EmailKind })
              }
            >
              <option value="">It's a…</option>
              {(Object.keys(KIND) as EmailKind[])
                .filter((k) => k !== 'unclear')
                .map((k) => (
                  <option key={k} value={k}>
                    {KIND[k].label}
                  </option>
                ))}
            </Select>
          </>
        )}

        {app && !unclear && (
          <>
            <Select
              className="w-auto max-w-xs"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="suggested">
                {row.suggestedStatus ? `Move to ${row.suggestedStatus}` : 'Just log the email'}
              </option>
              {row.suggestedStatus && <option value="log">Just log the email</option>}
              {STATUSES.filter((s) => s !== row.suggestedStatus && s !== app.status).map((s) => (
                <option key={s} value={s}>
                  Move to {s}
                </option>
              ))}
            </Select>
            <Button variant="primary" disabled={busy} onClick={() => apply.mutate()}>
              Apply
            </Button>
          </>
        )}
        {(titleOnly || (!row.companyId && !unclear)) && row.companyName && (
          <label className="flex items-center gap-1.5 text-xs text-ink-2">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            Remember “{row.companyName}” as another name for{' '}
            {titleOnly ? app?.company : 'that company'}
          </label>
        )}
        <Button variant="ghost" disabled={busy} onClick={() => dismiss.mutate()}>
          Dismiss
        </Button>
      </div>
      <ErrorText
        error={apply.error ?? dismiss.error ?? relabel.error ?? track.error ?? ask.error}
      />
    </div>
  );
}

const STATE_LABEL: Record<string, string> = {
  applied: 'Applied',
  dismissed: 'Dismissed',
  noop: 'Nothing to change',
};

function DoneList({ rows }: { rows: EmailUpdateRow[] }) {
  const invalidate = useInvalidate();
  const restore = useMutation({ mutationFn: api.restoreEmailUpdate, onSuccess: invalidate });
  if (!rows.length) return <p className="text-sm text-ink-3">Nothing here yet.</p>;
  return (
    <div className="space-y-2">
      <p className="text-xs text-ink-3">
        “Nothing to change” are receipts for jobs already marked Applied with their date. Applied
        emails are in each job's activity log.
      </p>
      {rows.map((r) => (
        <div key={r.id} className="space-y-1 rounded-lg border border-border bg-surface p-3">
          <EmailHeader row={r}>
            <span className={cx('font-medium', r.state === 'applied' ? 'text-good' : 'text-ink-3')}>
              {STATE_LABEL[r.state] ?? r.state}
            </span>
            {r.application && (
              <Link
                to={`/applications/${r.application.id}`}
                className="text-ink-2 hover:text-accent"
              >
                {r.application.company} · {r.application.title}
              </Link>
            )}
            {r.state !== 'applied' && (
              <button className="text-accent hover:underline" onClick={() => restore.mutate(r.id)}>
                Put back to review
              </button>
            )}
          </EmailHeader>
        </div>
      ))}
    </div>
  );
}
