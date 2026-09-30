import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, type CrawlStatus, type LeadRow, type SourceRow } from '../api.ts';
import { Button, Card, ErrorText, Field, Input, Select, Textarea, cx } from './ui.tsx';

const INTERVAL_LABEL: Record<number, string> = {
  [-1]: 'Manual only',
  0: 'When Job Matrix opens',
  60: 'On opening, then every hour',
  180: 'On opening, then every 3 hours',
  360: 'On opening, then every 6 hours',
};

const BOARD: Record<SourceRow['kind'], string> = {
  greenhouse: 'Greenhouse',
  ashby: 'Ashby',
  lever: 'Lever',
  workday: 'Workday',
};

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const money = (n: number) => `$${Math.round(n / 1000)}K`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The watchlist's settings and progress; polls while a check runs. */
export function useCrawlStatus() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['crawl-status'],
    queryFn: api.crawlStatus,
    refetchInterval: (q) => (q.state.data?.progress.running ? 1500 : 60_000),
  });
  // When a check finishes, show what it found.
  const running = Boolean(query.data?.progress.running);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running)
      for (const key of ['applications', 'stats', 'crawl-leads', 'crawl-sources'])
        qc.invalidateQueries({ queryKey: [key] });
    wasRunning.current = running;
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps
  return query.data;
}

function useCheckNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.crawlRun,
    onSuccess: (s) => qc.setQueryData(['crawl-status'], s),
  });
}

/** What the last check found, in words. */
function lastCheck(s: CrawlStatus) {
  if (!s.lastRunAt) return 'Not checked yet.';
  const { matched, added, filtered, boards } = s.last;
  return `Last checked ${when(s.lastRunAt)}: ${plural(matched, 'matching job')} on ${plural(boards, 'board')}, ${added} added to the inbox, ${filtered} filtered out.`;
}

/** Screening page: one line on the watchlist, with Check now. */
export function WatchlistStrip({ status }: { status: CrawlStatus | undefined }) {
  const check = useCheckNow();
  if (!status) return null;
  if (status.sources === 0)
    return (
      <p className="text-sm text-ink-3">
        Want jobs to arrive here on their own?{' '}
        <Link to="/profile#watchlist" className="text-accent hover:underline">
          Follow company job boards
        </Link>{' '}
        and new matching jobs are added to this inbox.
      </p>
    );
  const p = status.progress;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-surface px-3 py-2 text-sm">
      <span className="font-medium">Watchlist</span>
      {p.running ? (
        <span className="text-accent">
          Checking… {p.boardsDone}/{p.boards} boards, {plural(p.matched, 'matching job')}, {p.added}{' '}
          added
        </span>
      ) : (
        <span className="text-ink-2">{lastCheck(status)}</span>
      )}
      {status.lastError && !p.running && <span className="text-warn">{status.lastError}</span>}
      <span className="ml-auto flex items-center gap-2">
        {status.nextRunAt && !p.running && (
          <span className="text-xs text-ink-3">Next check {when(status.nextRunAt)}</span>
        )}
        <Link to="/profile#watchlist" className="text-xs text-accent hover:underline">
          {plural(status.sources, 'company', 'companies')}
        </Link>
        <Button onClick={() => check.mutate()} disabled={p.running}>
          {p.running ? 'Checking…' : 'Check now'}
        </Button>
      </span>
      <ErrorText error={check.error} />
    </div>
  );
}

const REASON_TONE: Record<string, string> = {
  duplicate: 'text-ink-3',
  error: 'text-bad',
};

/** Screening page, "Filtered out" tab: jobs the watchlist found but kept out, and why. */
export function FilteredList({ onAdded }: { onAdded: (applicationId: number) => void }) {
  const qc = useQueryClient();
  const {
    data: leads = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['crawl-leads'],
    queryFn: api.crawlLeads,
  });
  const add = useMutation({
    mutationFn: (id: number) => api.addCrawlLead(id),
    onSuccess: (r) => {
      for (const key of ['crawl-leads', 'crawl-status', 'applications', 'stats'])
        qc.invalidateQueries({ queryKey: [key] });
      onAdded(r.applicationId);
    },
  });
  if (isLoading) return <p className="text-ink-2">Loading…</p>;
  if (leads.length === 0)
    return (
      <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-ink-2">
        Nothing filtered out. Jobs on your watched boards that match a title but fail a rule (pay,
        place, contract, already tracked) are listed here with the reason.
      </div>
    );
  return (
    <div className="space-y-2">
      <p className="text-sm text-ink-2">
        Found on your watched boards with a title you look for, but kept out of the inbox. Rules are
        on{' '}
        <Link to="/profile#watchlist" className="text-accent hover:underline">
          Profile
        </Link>
        ; a job filtered by a rule is looked at again whenever the rules change.
      </p>
      <ErrorText error={error ?? add.error} />
      <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
        {leads.map((l) => (
          <LeadLine
            key={l.id}
            lead={l}
            busy={add.isPending && add.variables === l.id}
            onAdd={() => add.mutate(l.id)}
          />
        ))}
      </ul>
    </div>
  );
}

function LeadLine({ lead, busy, onAdd }: { lead: LeadRow; busy: boolean; onAdd: () => void }) {
  const pay =
    lead.salaryMin && lead.salaryMax
      ? `${money(lead.salaryMin)}–${money(lead.salaryMax)}`
      : lead.salaryMax
        ? money(lead.salaryMax)
        : null;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className="truncate">
          <span className="font-medium">{lead.company}</span>
          <span className="text-ink-3"> — </span>
          <a href={lead.url} target="_blank" rel="noreferrer" className="hover:underline">
            {lead.title}
          </a>
        </div>
        <div className="truncate text-xs text-ink-3">
          {[lead.location, pay, lead.postedAt && `posted ${lead.postedAt}`]
            .filter(Boolean)
            .join(' · ')}
        </div>
      </div>
      <span className={cx('max-w-md text-xs', REASON_TONE[lead.verdict] ?? 'text-warn')}>
        {lead.reason}
      </span>
      {lead.verdict === 'duplicate' && lead.applicationId && (
        <Link to={`/applications/${lead.applicationId}`} className="text-accent hover:underline">
          Open it
        </Link>
      )}
      {/* The very posting you track can't be added twice; a look-alike can. */}
      {lead.reason !== 'Already tracked' && (
        <Button onClick={onAdd} disabled={busy}>
          {busy ? 'Adding…' : 'Add anyway'}
        </Button>
      )}
    </li>
  );
}

// ---------- Profile: the boards and the rules ----------

type Lists = Pick<CrawlStatus, 'titleInclude' | 'titleExclude' | 'locations'>;
const toText = (s: Lists | undefined) => ({
  titleInclude: (s?.titleInclude ?? []).join('\n'),
  titleExclude: (s?.titleExclude ?? []).join('\n'),
  locations: (s?.locations ?? []).join('\n'),
});
const toLines = (t: string) =>
  t
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** Profile page: which company job boards to follow, and what to look for on them. */
export function WatchlistCard() {
  const qc = useQueryClient();
  const status = useCrawlStatus();
  const check = useCheckNow();
  const { data: sources = [] } = useQuery({
    queryKey: ['crawl-sources'],
    queryFn: api.crawlSources,
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['crawl-sources'] });
    qc.invalidateQueries({ queryKey: ['crawl-status'] });
  };

  const [url, setUrl] = useState('');
  const add = useMutation({
    mutationFn: () => api.addCrawlSource(url.trim()),
    onSuccess: () => {
      setUrl('');
      refresh();
    },
  });
  const update = useMutation({
    mutationFn: (v: { id: number; enabled?: boolean; companyName?: string }) =>
      api.updateCrawlSource(v.id, { enabled: v.enabled, companyName: v.companyName }),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: api.removeCrawlSource, onSuccess: refresh });
  const settings = useMutation({
    mutationFn: api.crawlSettings,
    onSuccess: (s) => qc.setQueryData(['crawl-status'], s),
  });

  const lists = status && {
    titleInclude: status.titleInclude,
    titleExclude: status.titleExclude,
    locations: status.locations,
  };
  const saved = JSON.stringify(toText(lists));
  const [f, setF] = useState(() => toText(lists));
  useEffect(() => setF(toText(lists)), [saved]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(f) !== saved;
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (url.trim()) add.mutate();
  };
  const running = Boolean(status?.progress.running);

  // Links from the Screening page land here (/profile#watchlist).
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (window.location.hash === '#watchlist') top.current?.scrollIntoView();
  }, []);

  return (
    <div id="watchlist" ref={top} className="scroll-mt-16">
      <Card
        title="Watchlist"
        actions={
          <Button
            variant="primary"
            onClick={() => check.mutate()}
            disabled={running || sources.length === 0}
          >
            {running ? 'Checking…' : 'Check now'}
          </Button>
        }
      >
        <p className="mb-3 text-sm text-ink-2">
          Company job boards to follow. New jobs with a title you look for are added to the
          Screening inbox, unless a rule below filters them out. Checking is free: it reads each
          company's public board (Greenhouse, Ashby, Lever or Workday) and uses no AI.
        </p>

        {sources.length > 0 && (
          <ul className="mb-3 divide-y divide-border rounded-md border border-border text-sm">
            {sources.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <input
                  type="checkbox"
                  checked={s.enabled}
                  aria-label={`Check ${s.companyName}`}
                  onChange={(e) => update.mutate({ id: s.id, enabled: e.target.checked })}
                />
                <button
                  className={cx('font-medium hover:underline', !s.enabled && 'text-ink-3')}
                  title="Rename"
                  onClick={() => {
                    const name = prompt('Company name', s.companyName)?.trim();
                    if (name && name !== s.companyName)
                      update.mutate({ id: s.id, companyName: name });
                  }}
                >
                  {s.companyName}
                </button>
                <a
                  href={s.boardUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-ink-3 hover:underline"
                >
                  {BOARD[s.kind]}
                </a>
                <span className="ml-auto text-xs text-ink-3">
                  {s.lastError ? (
                    <span className="text-bad">{s.lastError}</span>
                  ) : s.lastCount != null ? (
                    <>
                      {s.kind === 'workday'
                        ? plural(s.lastMatched ?? 0, 'matching job')
                        : `${s.lastMatched ?? 0} matching of ${plural(s.lastCount, 'open job')}`}{' '}
                      · {when(s.lastCheckedAt)}
                    </>
                  ) : (
                    'Not checked yet'
                  )}
                </span>
                <Button
                  variant="danger"
                  onClick={() =>
                    confirm(`Stop following ${s.companyName}? Jobs already in your inbox stay.`) &&
                    remove.mutate(s.id)
                  }
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
          <Input
            type="url"
            className="min-w-72 flex-1"
            placeholder="Follow a company — paste its careers page, job board or any job posting"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <Button type="submit" disabled={!url.trim() || add.isPending}>
            {add.isPending ? 'Reading the board…' : 'Follow'}
          </Button>
        </form>
        <ErrorText error={add.error ?? update.error ?? remove.error ?? check.error} />

        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <Field label="Titles to look for (one per line)">
            <Textarea rows={6} value={f.titleInclude} onChange={set('titleInclude')} />
            <span className="mt-1 block text-xs text-ink-3">
              A job is picked up when its title contains one of these. “TPM” and “Sr.” are read as
              “technical program manager” and “senior”.
            </span>
          </Field>
          <Field label="Titles to skip">
            <Textarea rows={6} value={f.titleExclude} onChange={set('titleExclude')} />
            <span className="mt-1 block text-xs text-ink-3">
              Filtered out when the title contains one of these.
            </span>
          </Field>
          <Field label="Places you can work from">
            <Textarea rows={6} value={f.locations} onChange={set('locations')} />
            <span className="mt-1 block text-xs text-ink-3">
              Remote jobs and postings that name no place always pass. Leave empty for anywhere.
            </span>
          </Field>
        </div>
        <p className="mt-2 text-xs text-ink-3">
          Also filtered out: contracts, internships and hourly pay; a posted range whose top is
          below your minimum base (set under Goals & criteria); and jobs you already track.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2">
            <span className="text-ink-2">Check</span>
            <Select
              className="w-auto"
              value={status?.intervalMinutes ?? 0}
              onChange={(e) => settings.mutate({ intervalMinutes: Number(e.target.value) })}
            >
              {(status?.intervals ?? [0]).map((m) => (
                <option key={m} value={m}>
                  {INTERVAL_LABEL[m] ?? `Every ${m} minutes`}
                </option>
              ))}
            </Select>
          </label>
          <span className="text-ink-3">{status ? lastCheck(status) : ''}</span>
          <Button
            className="ml-auto"
            variant="primary"
            disabled={!dirty || settings.isPending}
            onClick={() =>
              settings.mutate({
                titleInclude: toLines(f.titleInclude),
                titleExclude: toLines(f.titleExclude),
                locations: toLines(f.locations),
              })
            }
          >
            Save rules
          </Button>
        </div>
        <ErrorText error={settings.error} />
      </Card>
    </div>
  );
}
