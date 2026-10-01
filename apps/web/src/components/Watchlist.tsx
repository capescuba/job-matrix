import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  type CrawlStatus,
  type LeadRow,
  type SearchRow,
  type Settings,
  type SourceRow,
} from '../api.ts';
import { runSearchesInChrome } from '../extension.ts';
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
  amazon: 'amazon.jobs',
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

/** Check now: the boards (on the server) and the saved searches (in Chrome, by the extension). */
function useCheckNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const s = await api.crawlRun();
      const problem = s.searches > 0 ? await runSearchesInChrome() : null;
      if (s.searches > 0) qc.setQueryData(['searches-running'], Date.now());
      if (problem && s.sources === 0) throw new Error(problem);
      return s;
    },
    onSuccess: (s) => qc.setQueryData(['crawl-status'], s),
  });
}

/** What the last check found, in words. */
function lastCheck(s: CrawlStatus) {
  if (!s.lastRunAt) return 'Not checked yet';
  const { matched, added, filtered, boards } = s.last;
  return `Checked ${when(s.lastRunAt)} · ${plural(matched, 'matching job')} on ${plural(boards, 'board')} · ${added} added · ${filtered} filtered out`;
}

/** Screening page: one quiet line on the watchlist, once a company is followed. */
export function WatchlistStrip({ status }: { status: CrawlStatus | undefined }) {
  const check = useCheckNow();
  if (!status || status.sources + status.searches === 0) return null;
  const p = status.progress;
  const problem =
    !p.running &&
    [
      status.waitingCount > 0 && `${plural(status.waitingCount, 'job')} waiting for the pre-screen`,
      status.lastError,
    ]
      .filter(Boolean)
      .join(' · ');
  return (
    <div className="flex flex-wrap items-center gap-x-2 text-xs text-ink-3">
      <Link to="/watchlist" className="font-medium text-ink-2 hover:underline">
        Watchlist
      </Link>
      {p.running ? (
        <span className="text-accent">
          Checking… {p.boardsDone}/{p.boards} boards, {p.added} added
        </span>
      ) : (
        <span>{lastCheck(status)}</span>
      )}
      {problem && <span className="text-warn">{problem}</span>}
      {!p.running && (
        <button className="text-accent hover:underline" onClick={() => check.mutate()}>
          Check now
        </button>
      )}
      <ErrorText error={check.error} />
    </div>
  );
}

const REASON_TONE: Record<string, string> = {
  duplicate: 'text-ink-3',
  waiting: 'text-ink-3',
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
      <p className="text-xs text-ink-3">
        Matched a title on your{' '}
        <Link to="/watchlist" className="text-accent hover:underline">
          watchlist
        </Link>{' '}
        but kept out of the inbox.
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
      <span
        className={cx('max-w-md text-xs', REASON_TONE[lead.verdict] ?? 'text-warn')}
        title={lead.model ? `Judged by ${lead.model}` : undefined}
      >
        {lead.verdict === 'no-ai' && 'Pre-screen: '}
        {lead.verdict === 'waiting' && 'Waiting — '}
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

// ---------- Watchlist page: the boards and the rules ----------

/** Page header line: how the last check went, and Check now. */
export function WatchlistHeader({ status }: { status: CrawlStatus | undefined }) {
  const check = useCheckNow();
  const p = status?.progress;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <h1 className="text-xl font-semibold">Watchlist</h1>
      <span className="mr-auto text-sm text-ink-3">
        {!status
          ? ''
          : p?.running
            ? `Checking… ${p.boardsDone}/${p.boards} boards, ${p.added} added`
            : lastCheck(status)}
      </span>
      {status?.lastError && !p?.running && (
        <span className="text-sm text-warn">{status.lastError}</span>
      )}
      <Schedule status={status} />
      <Button
        variant="primary"
        onClick={() => check.mutate()}
        disabled={!status || p?.running || status.sources + status.searches === 0}
      >
        {p?.running ? 'Checking…' : 'Check now'}
      </Button>
      <ErrorText error={check.error} />
    </div>
  );
}

/** Whether checks happen by themselves: manual only, when the app opens, or every few hours. */
function Schedule({ status }: { status: CrawlStatus | undefined }) {
  const qc = useQueryClient();
  const settings = useMutation({
    mutationFn: api.crawlSettings,
    onSuccess: (s) => qc.setQueryData(['crawl-status'], s),
  });
  return (
    <label className="flex items-center gap-2 text-sm text-ink-3">
      Automatic
      <Select
        className="w-auto py-1"
        aria-label="When to check automatically"
        value={status?.intervalMinutes ?? -1}
        onChange={(e) => settings.mutate({ intervalMinutes: Number(e.target.value) })}
      >
        {(status?.intervals ?? [-1]).map((m) => (
          <option key={m} value={m}>
            {INTERVAL_LABEL[m] ?? `Every ${m} minutes`}
          </option>
        ))}
      </Select>
    </label>
  );
}

/** The company job boards you follow. */
export function WatchlistCompanies() {
  const qc = useQueryClient();
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
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (url.trim()) add.mutate();
  };

  return (
    <Card title={`Companies${sources.length ? ` (${sources.length})` : ''}`}>
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
        <Input
          type="url"
          className="min-w-72 flex-1"
          placeholder="Paste a company's careers page, job board or any job posting"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <Button type="submit" disabled={!url.trim() || add.isPending}>
          {add.isPending ? 'Reading the board…' : 'Follow'}
        </Button>
      </form>
      <ErrorText error={add.error ?? update.error ?? remove.error} />

      {sources.length === 0 ? (
        <p className="mt-3 text-sm text-ink-3">
          No companies yet. Greenhouse, Ashby, Lever and Workday boards and Amazon jobs searches can
          be followed. New jobs with a title you look for are added to the Screening inbox.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-border text-sm">
          {sources.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
              <input
                type="checkbox"
                checked={s.enabled}
                title={s.enabled ? 'Checked on each run' : 'Paused'}
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
                {BOARD[s.kind]} ↗
              </a>
              <span
                className="ml-auto text-xs text-ink-3"
                title={s.lastCheckedAt ? `Checked ${when(s.lastCheckedAt)}` : undefined}
              >
                {s.lastError ? (
                  <span className="text-bad">{s.lastError}</span>
                ) : s.lastCount == null ? (
                  'Not checked yet'
                ) : s.kind === 'workday' || s.kind === 'amazon' ? (
                  plural(s.lastMatched ?? 0, 'matching job')
                ) : (
                  `${s.lastMatched ?? 0} matching of ${s.lastCount}`
                )}
              </span>
              <button
                className="px-1 text-ink-3 hover:text-bad"
                title="Stop following"
                aria-label={`Stop following ${s.companyName}`}
                onClick={() =>
                  confirm(`Stop following ${s.companyName}? Jobs already in your inbox stay.`) &&
                  remove.mutate(s.id)
                }
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Sites whose results pages the extension can read; Indeed's reader hasn't been tried yet. */
const SITE_NOTE: Partial<Record<SearchRow['site'], string>> = {
  indeed: 'Not tried yet: Indeed showed a robot check during testing',
};

/**
 * Job sites: LinkedIn, Indeed, Glassdoor and ZipRecruiter, each searched for your keywords and
 * place. Job Matrix can't read those sites itself, so the Chrome extension opens each search in
 * your signed-in Chrome, reads the first page of results and sends them here. Searches you paste
 * yourself are listed underneath.
 */
export function JobSites() {
  const qc = useQueryClient();
  // For a few minutes after a run starts, follow the results as they come in.
  const { data: runStarted = 0 } = useQuery<number>({
    queryKey: ['searches-running'],
    queryFn: () => 0,
    staleTime: Infinity,
  });
  const following = Date.now() - runStarted < 4 * 60_000;
  const { data } = useQuery({
    queryKey: ['job-sites'],
    queryFn: api.jobSites,
    refetchInterval: following ? 3000 : false,
  });
  const { data: all = [] } = useQuery({
    queryKey: ['crawl-searches'],
    queryFn: api.crawlSearches,
    refetchInterval: following ? 3000 : false,
  });
  const own = all.filter((x) => !x.preset);
  const refresh = () => {
    for (const key of ['job-sites', 'crawl-searches', 'crawl-status'])
      qc.invalidateQueries({ queryKey: [key] });
  };

  const [keywords, setKeywords] = useState('');
  const [place, setPlace] = useState('');
  useEffect(() => {
    if (!data) return;
    setKeywords(data.keywords);
    setPlace(data.location);
  }, [data?.keywords, data?.location]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = !!data && (keywords.trim() !== data.keywords || place.trim() !== data.location);
  const save = useMutation({
    mutationFn: () => api.setJobSites(keywords.trim(), place.trim()),
    onSuccess: (d) => {
      qc.setQueryData(['job-sites'], d);
      refresh();
    },
  });
  const update = useMutation({
    mutationFn: (v: { id: number; enabled?: boolean; label?: string }) =>
      api.updateCrawlSearch(v.id, { enabled: v.enabled, label: v.label }),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: api.removeCrawlSearch, onSuccess: refresh });
  const [started, setStarted] = useState<{ ids: number[] | null; at: string } | null>(null);
  const run = useMutation({
    mutationFn: async (ids: number[] | null) => {
      const problem = await runSearchesInChrome(ids ?? undefined);
      if (problem) throw new Error(problem);
      setStarted({ ids, at: new Date().toISOString() });
      qc.setQueryData(['searches-running'], Date.now());
    },
  });
  const [url, setUrl] = useState('');
  const add = useMutation({
    mutationFn: () => api.addCrawlSearch(url.trim()),
    onSuccess: () => {
      setUrl('');
      refresh();
    },
  });

  /** Still being searched: part of the run just started, and no result back since. */
  const inRun = (x: SearchRow) =>
    following &&
    !!started &&
    (started.ids ? started.ids.includes(x.id) : x.enabled) &&
    (!x.lastRunAt || x.lastRunAt < started.at);
  const result = (x: SearchRow) =>
    inRun(x) ? (
      <span className="text-accent">Searching in Chrome…</span>
    ) : x.lastError ? (
      <span className="text-warn">{x.lastError}</span>
    ) : x.lastRunAt ? (
      <span title={`Searched ${when(x.lastRunAt)}`}>
        {x.lastMatched ?? 0} matching of {x.lastCount ?? 0} · {x.lastAdded ?? 0} added ·{' '}
        {when(x.lastRunAt)}
      </span>
    ) : (
      <span>{SITE_NOTE[x.site] ?? 'Not searched yet'}</span>
    );
  const row = (x: SearchRow, name: ReactNode, extra?: ReactNode) => (
    <li key={x.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
      <input
        type="checkbox"
        checked={x.enabled}
        title={x.enabled ? 'Included in Search all' : 'Left out of Search all'}
        aria-label={`Include ${x.label} in Search all`}
        onChange={(e) => update.mutate({ id: x.id, enabled: e.target.checked })}
      />
      <span className={cx('min-w-28 font-medium', !x.enabled && 'text-ink-3')}>{name}</span>
      <a
        href={x.url}
        target="_blank"
        rel="noreferrer"
        className="text-xs text-ink-3 hover:underline"
        title="Open this search in a new tab"
      >
        open ↗
      </a>
      <span className="ml-auto text-xs text-ink-3">{result(x)}</span>
      <Button onClick={() => run.mutate([x.id])} disabled={run.isPending || inRun(x)}>
        Search now
      </Button>
      {extra}
    </li>
  );

  return (
    <Card
      title="Job sites"
      actions={
        <Button
          variant="primary"
          onClick={() => run.mutate(null)}
          disabled={run.isPending || !all.some((x) => x.enabled)}
        >
          Search all now
        </Button>
      }
    >
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty && keywords.trim() && place.trim()) save.mutate();
        }}
      >
        <Field label="Search for" className="min-w-64 flex-1">
          <Input value={keywords} onChange={(e) => setKeywords(e.target.value)} />
        </Field>
        <Field label="In" className="min-w-56 flex-1">
          <Input value={place} onChange={(e) => setPlace(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" disabled={!dirty || save.isPending}>
          Save
        </Button>
      </form>
      <p className="mt-2 text-xs text-ink-3">
        Each search opens in a tab of your Chrome, is read (first page, newest first) and closed.
        New matching jobs go through your rules to the Screening inbox.
      </p>
      <ErrorText error={save.error ?? update.error ?? remove.error ?? run.error} />

      <ul className="mt-2 divide-y divide-border text-sm">
        {data?.sites.map((x) => row(x, x.label))}
      </ul>

      <details className="mt-3 text-sm" open={own.length > 0}>
        <summary className="cursor-pointer text-ink-2">
          Your own searches{own.length ? ` (${own.length})` : ''}
        </summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) add.mutate();
          }}
          className="mt-2 flex flex-wrap items-center gap-2"
        >
          <Input
            type="url"
            className="min-w-72 flex-1"
            placeholder="Paste a results page from LinkedIn, Indeed, Glassdoor, ZipRecruiter or Dice"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <Button type="submit" disabled={!url.trim() || add.isPending}>
            Save search
          </Button>
        </form>
        <ErrorText error={add.error} />
        {own.length > 0 && (
          <ul className="mt-2 divide-y divide-border">
            {own.map((x) =>
              row(
                x,
                <button
                  className="text-left hover:underline"
                  title="Rename"
                  onClick={() => {
                    const label = prompt('Name', x.label)?.trim();
                    if (label && label !== x.label) update.mutate({ id: x.id, label });
                  }}
                >
                  {x.label}
                </button>,
                <button
                  className="px-1 text-ink-3 hover:text-bad"
                  title="Forget this search"
                  aria-label={`Forget ${x.label}`}
                  onClick={() =>
                    confirm(`Forget “${x.label}”? Jobs it found stay.`) && remove.mutate(x.id)
                  }
                >
                  ✕
                </button>,
              ),
            )}
          </ul>
        )}
      </details>
    </Card>
  );
}

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

/** What to look for on the boards, what to leave out, and how often to check. */
export function WatchlistRules({ status }: { status: CrawlStatus | undefined }) {
  const qc = useQueryClient();
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

  return (
    <Card
      title="Rules"
      actions={
        <>
          <Button
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
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Titles to look for">
          <Textarea rows={5} value={f.titleInclude} onChange={set('titleInclude')} />
        </Field>
        <Field label="Titles to skip">
          <Textarea rows={5} value={f.titleExclude} onChange={set('titleExclude')} />
        </Field>
        <Field label="Places you can work from">
          <Textarea rows={5} value={f.locations} onChange={set('locations')} />
        </Field>
      </div>
      <p className="mt-2 text-xs text-ink-3">
        One per line. Remote jobs and postings that name no place always pass.{' '}
        <span
          className="cursor-help underline decoration-dotted"
          title={
            '“TPM” and “Sr.” are read as “technical program manager” and “senior”.\n' +
            'Also filtered out: contracts, internships and hourly pay; a posted pay range whose top is below your minimum base (Profile → Criteria); and jobs you already track.\n' +
            'Leave the places empty to allow anywhere.'
          }
        >
          What else is filtered?
        </span>
      </p>
      <ErrorText error={settings.error} />
    </Card>
  );
}

// ---------- the pre-screen model ----------

type Provider = Settings['prescreen']['provider'];

const PROVIDER_OPTION: Record<Provider, string> = {
  off: 'Off — rules only',
  groq: 'Groq — GPT-OSS 120B, free (recommended)',
  gemini: 'Google Gemini — Flash-Lite, free, fastest',
  openrouter: 'OpenRouter — a free model',
  ollama: 'Ollama — a model running on this PC',
  custom: 'Another OpenAI-compatible service',
  anthropic: 'Claude Haiku 4.5 — paid, about 0.2¢ a job',
};

const PROVIDER_NOTE: Record<Provider, string> = {
  off: 'Every job the rules let through goes to the inbox.',
  groq: 'Free, with per-minute and per-day limits, so a first check of a big board can take a few minutes. Groq does not train on what it is sent. Other free Groq models: openai/gpt-oss-20b, qwen/qwen3.8-27b.',
  gemini:
    'Free: about 1,000 jobs a day, 15 a minute. On the free tier Google may use what it is sent to improve its models.',
  openrouter:
    'Free models are limited to 50 requests a day (1,000 once the account has ever bought $10 of credit), and their quality varies.',
  ollama:
    'Nothing leaves this PC. Needs Ollama running with the model pulled; a small model judges less well.',
  custom: 'Any service with an OpenAI-style /chat/completions address.',
  anthropic:
    'Uses your Anthropic key. Unlike the rest of Job Matrix, this spends money without being asked each time: every new job that passes the rules costs about 0.2¢ on each check.',
};

/**
 * Which model, if any, looks at jobs the rules let through and answers yes / maybe / no.
 * "No" keeps a job out of the inbox (listed under Filtered out with the reason).
 */
export function PrescreenSettings() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const pre = data?.prescreen;
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  useEffect(() => {
    setModel(pre?.model ?? '');
    setBaseUrl(pre?.baseUrl ?? '');
  }, [pre?.model, pre?.baseUrl]);
  const save = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: (next) => {
      qc.setQueryData(['settings'], next);
      qc.invalidateQueries({ queryKey: ['crawl-status'] });
      setKey('');
    },
  });
  if (!pre) return null;
  const preset = pre.presets[pre.provider];
  const wantsKey = preset.needsKey || pre.provider === 'custom';
  const wantsUrl = pre.provider === 'custom' || pre.provider === 'ollama';
  const dirty = model.trim() !== pre.model || (wantsUrl && baseUrl.trim() !== pre.baseUrl);

  return (
    <Card
      title={
        <span>
          Pre-screen{' '}
          <span
            className={cx(
              'ml-1 font-normal',
              pre.provider === 'off' ? 'text-ink-3' : pre.ready ? 'text-good' : 'text-warn',
            )}
          >
            · {pre.provider === 'off' ? 'off' : pre.ready ? `on, ${pre.model}` : 'not set up yet'}
          </span>
        </span>
      }
    >
      <p className="mb-3 text-sm text-ink-2">
        A small model answers yes, maybe or no on each job the rules let through. Only a clear “no”
        keeps a job out.{' '}
        <span
          className="cursor-help underline decoration-dotted"
          title="It is sent the posting and your goals, pay floor, must-haves and deal-breakers. It is never sent your resume or career profile."
        >
          What is it sent?
        </span>
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Model" className="min-w-72">
          <Select
            value={pre.provider}
            onChange={(e) =>
              // A different service: its own address, model and key.
              save.mutate({
                prescreenProvider: e.target.value as Provider,
                prescreenBaseUrl: null,
                prescreenModel: null,
                prescreenApiKey: null,
              })
            }
          >
            {(Object.keys(PROVIDER_OPTION) as Provider[]).map((id) => (
              <option key={id} value={id}>
                {PROVIDER_OPTION[id]}
              </option>
            ))}
          </Select>
        </Field>
        {pre.provider !== 'off' && pre.provider !== 'anthropic' && (
          <Field label="Model name" className="min-w-56">
            <Input value={model} onChange={(e) => setModel(e.target.value)} />
          </Field>
        )}
        {wantsUrl && (
          <Field label="Address" className="min-w-72 flex-1">
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://…/v1"
            />
          </Field>
        )}
        {dirty && (
          <Button
            variant="primary"
            disabled={save.isPending}
            onClick={() =>
              save.mutate({
                prescreenModel: model.trim() || null,
                ...(wantsUrl && { prescreenBaseUrl: baseUrl.trim() || null }),
              })
            }
          >
            Save
          </Button>
        )}
      </div>
      {wantsKey && (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim()) save.mutate({ prescreenApiKey: key.trim() });
          }}
        >
          <Field
            label={pre.apiKeyHint ? `API key (saved: ${pre.apiKeyHint})` : 'API key'}
            className="min-w-64 flex-1"
          >
            <Input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={pre.apiKeyHint ? 'Paste a new key to replace it' : 'Paste the key'}
            />
          </Field>
          <Button type="submit" variant="primary" disabled={!key.trim() || save.isPending}>
            Save key
          </Button>
          {preset.keyUrl && (
            <a
              href={preset.keyUrl}
              target="_blank"
              rel="noreferrer"
              className="pb-2 text-sm text-accent hover:underline"
            >
              Get a free key
            </a>
          )}
        </form>
      )}
      <p className="mt-2 text-xs text-ink-3">{PROVIDER_NOTE[pre.provider]}</p>
      {pre.provider !== 'off' && !pre.ready && (
        <p className="mt-1 text-xs text-warn">
          {pre.provider === 'anthropic'
            ? 'Add your Anthropic API key under Profile → Settings to use this.'
            : 'It needs a key, a model name and an address. Until then jobs that pass the rules go straight to the inbox.'}
        </p>
      )}
      <ErrorText error={save.error} />
    </Card>
  );
}
