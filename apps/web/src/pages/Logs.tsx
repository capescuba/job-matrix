import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type LogEntry } from '../api.ts';
import { Input, Select, cx } from '../components/ui.tsx';

const LEVEL_TONE: Record<string, string> = {
  error: 'text-bad bg-bad/10',
  fatal: 'text-bad bg-bad/15',
  warn: 'text-warn bg-warn/10',
  info: 'text-ink-3 bg-surface-2',
  debug: 'text-ink-3 bg-surface-2',
  trace: 'text-ink-3 bg-surface-2',
};
const RANK: Record<string, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };

const kb = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${Math.round(n / 1024)} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`;

function time(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : d.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
}

/** The app's own log files: what it did, email checks, AI calls, errors. */
export default function LogsPage() {
  const [params, setParams] = useSearchParams();
  const { data: list } = useQuery({
    queryKey: ['logs'],
    queryFn: api.logs,
    refetchInterval: 15_000,
  });
  const files = list?.files ?? [];
  const file = params.get('file') ?? files[0]?.name ?? 'server.log';
  const [follow, setFollow] = useState(true);
  const [minLevel, setMinLevel] = useState('info');
  const [hideRoutine, setHideRoutine] = useState(true);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<number | null>(null);

  const { data, error } = useQuery({
    queryKey: ['log', file],
    queryFn: () => api.log(file),
    refetchInterval: follow ? 3000 : false,
  });

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.entries ?? []).filter(
      (e) =>
        (RANK[e.level] ?? 2) >= RANK[minLevel]! &&
        !(hideRoutine && e.routine) &&
        (!needle ||
          e.msg.toLowerCase().includes(needle) ||
          (e.event ?? '').toLowerCase().includes(needle) ||
          (e.details && JSON.stringify(e.details).toLowerCase().includes(needle))),
    );
  }, [data, minLevel, hideRoutine, q]);

  // Following: stay at the newest line.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [rows.length, follow, file]);

  const groups: [string, string][] = [
    ['server', 'App'],
    ['errors', 'Errors'],
    ['build', 'Build'],
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold">Log</h1>
        {list && <span className="text-xs text-ink-3">Files in {list.dir}</span>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {groups.map(([g, label]) => {
          const inGroup = files.filter((f) => f.group === g);
          if (!inGroup.length) return null;
          return (
            <div key={g} className="flex items-center gap-1 rounded-md border border-border p-0.5">
              <span className="px-1.5 text-xs text-ink-3">{label}</span>
              {inGroup.map((f) => (
                <button
                  key={f.name}
                  title={`${f.name} · ${kb(f.size)} · updated ${new Date(f.modified).toLocaleString()}`}
                  onClick={() => {
                    setParams({ file: f.name });
                    setOpen(null);
                  }}
                  className={cx(
                    'rounded px-2.5 py-1 text-sm',
                    file === f.name ? 'bg-surface-2 font-medium' : 'text-ink-2 hover:text-ink',
                    f.size === 0 && 'opacity-50',
                  )}
                >
                  {f.label.replace(/^Errors \((.*)\)$/, '$1').replace(/^Build errors$/, 'Errors')}
                </button>
              ))}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Select className="w-auto" value={minLevel} onChange={(e) => setMinLevel(e.target.value)}>
          <option value="trace">Everything</option>
          <option value="info">Info and up</option>
          <option value="warn">Warnings and errors</option>
          <option value="error">Errors only</option>
        </Select>
        <label className="flex items-center gap-1.5 text-ink-2">
          <input
            type="checkbox"
            checked={hideRoutine}
            onChange={(e) => setHideRoutine(e.target.checked)}
          />
          Hide routine requests
        </label>
        <Input
          className="w-64"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search (e.g. mail, ai.call, 500)"
        />
        <label className="flex items-center gap-1.5 text-ink-2">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Follow (refresh every 3s)
        </label>
        <span className="ml-auto text-xs text-ink-3">
          {rows.length} of {data?.entries.length ?? 0} lines
          {data?.truncated && ' · showing the end of the file'}
          {data && ` · ${kb(data.size)}`}
        </span>
      </div>

      {error ? (
        <p className="text-sm text-bad">{(error as Error).message}</p>
      ) : (
        <div
          ref={box}
          className="max-h-[70vh] overflow-y-auto rounded-lg border border-border bg-surface font-mono text-xs"
        >
          {rows.length === 0 ? (
            <p className="p-4 font-sans text-sm text-ink-3">
              {data?.entries.length ? 'No lines match the filters.' : 'This file is empty.'}
            </p>
          ) : (
            rows.map((e) => (
              <Row
                key={e.n}
                e={e}
                open={open === e.n}
                onToggle={() => setOpen(open === e.n ? null : e.n)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function Row({ e, open, onToggle }: { e: LogEntry; open: boolean; onToggle: () => void }) {
  return (
    <div className={cx('border-b border-border/60 px-3 py-1', open && 'bg-surface-2/60')}>
      <button
        onClick={onToggle}
        className="flex w-full items-baseline gap-2 text-left"
        disabled={!e.details}
      >
        <span className="w-32 shrink-0 text-ink-3">{time(e.time)}</span>
        <span
          className={cx(
            'w-12 shrink-0 rounded px-1 text-center font-sans text-[11px] font-semibold uppercase',
            LEVEL_TONE[e.level] ?? LEVEL_TONE.info,
          )}
        >
          {e.level}
        </span>
        {e.event && e.event !== 'http' && (
          <span className="shrink-0 rounded bg-accent/10 px-1.5 font-sans text-[11px] text-accent">
            {e.event}
          </span>
        )}
        <span
          className={cx(
            'min-w-0 flex-1 break-words whitespace-pre-wrap',
            e.level === 'error' || e.level === 'fatal' ? 'text-bad' : 'text-ink',
          )}
        >
          {e.msg}
        </span>
        {e.details && <span className="shrink-0 text-ink-3">{open ? '▾' : '▸'}</span>}
      </button>
      {open && e.details && (
        <pre className="mt-1 mb-1 ml-34 overflow-x-auto rounded bg-surface p-2 text-[11px] text-ink-2">
          {JSON.stringify(e.details, null, 2)}
        </pre>
      )}
    </div>
  );
}
