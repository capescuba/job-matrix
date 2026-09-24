import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { STATUSES } from '@jm/shared';
import { api, type Stats } from '../api.ts';
import { useState } from 'react';
import { Card, ErrorText, cx } from '../components/ui.tsx';

const pct = (x: number | null) => (x == null ? '—' : `${Math.round(x * 100)}%`);

export default function DashboardPage() {
  const { data, error, isLoading } = useQuery({ queryKey: ['stats'], queryFn: api.stats });
  if (isLoading) return <p className="text-ink-2">Loading…</p>;
  if (error || !data) return <ErrorText error={error} />;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Dashboard</h1>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Applied" value={data.applied} sub={`${data.total} tracked`} />
        <Tile label="Active pipeline" value={data.active} sub="applied, not closed" />
        <Tile
          label="Response rate"
          value={pct(data.responseRate)}
          sub="any reply incl. rejections"
        />
        <Tile
          label="Days to first response"
          value={data.avgDaysToFirstResponse == null ? '—' : data.avgDaysToFirstResponse.toFixed(1)}
          sub="average"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Card title="Applications per week">
          <WeeklyChart data={data.perWeek} />
        </Card>
        <Card title="Pipeline">
          <HBars
            rows={STATUSES.map((s) => ({ label: s, value: data.byStatus[s] }))}
            format={(v) => String(v)}
          />
        </Card>
      </div>

      <RecurringGaps themes={data.gapThemes} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Average fit by outcome">
          {data.fitByOutcome.length === 0 ? (
            <p className="text-sm text-ink-3">No scored jobs yet.</p>
          ) : (
            <HBars
              rows={data.fitByOutcome.map((f) => ({
                label: `${f.outcome} (${f.n})`,
                value: f.avgFit,
              }))}
              max={10}
              format={(v) => v.toFixed(1)}
            />
          )}
        </Card>
        <Card title="By source">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-ink-2">
              <tr>
                <th className="pb-1 font-medium">Source</th>
                <th className="pb-1 text-right font-medium">Applied</th>
                <th className="pb-1 text-right font-medium">Response</th>
              </tr>
            </thead>
            <tbody>
              {data.bySource.map((s) => (
                <tr key={s.source} className="border-t border-border">
                  <td className="py-1.5">{s.source}</td>
                  <td className="py-1.5 text-right tabular-nums">{s.applied}</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {pct(s.applied ? s.responded / s.applied : null)}
                  </td>
                </tr>
              ))}
              {data.bySource.length === 0 && (
                <tr>
                  <td colSpan={3} className="py-2 text-ink-3">
                    Nothing applied yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
        <Card title="Next actions (7 days)">
          {data.upcoming.length === 0 ? (
            <p className="text-sm text-ink-3">Nothing due.</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {data.upcoming.map((u) => (
                <li key={u.id} className="py-1.5">
                  <Link to={`/applications/${u.id}`} className="font-medium hover:underline">
                    {u.company}
                  </Link>
                  <span className="text-ink-2"> · {u.nextAction ?? u.title}</span>
                  <span className="float-right tabular-nums text-ink-3">{u.nextActionDate}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string | number; sub: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="text-xs font-medium text-ink-2">{label}</div>
      <div className="mt-1 text-3xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-ink-3">{sub}</div>
    </div>
  );
}

function WeeklyChart({ data }: { data: Stats['perWeek'] }) {
  const fmt = (w: string) =>
    new Date(`${w}T00:00:00Z`).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  return (
    <div className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 8, right: 8, bottom: 0, left: -20 }}
          barCategoryGap={4}
        >
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis
            dataKey="week"
            tickFormatter={fmt}
            tick={{ fill: 'var(--ink-3)', fontSize: 11 }}
            axisLine={{ stroke: 'var(--border)' }}
            tickLine={false}
          />
          <YAxis
            allowDecimals={false}
            tick={{ fill: 'var(--ink-3)', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            cursor={{ fill: 'var(--surface-2)' }}
            contentStyle={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              color: 'var(--ink)',
              fontSize: 12,
            }}
            labelFormatter={(w) => `Week of ${fmt(String(w))}`}
            formatter={(v) => [v, 'Applications']}
          />
          <Bar dataKey="count" fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={36} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Lightweight horizontal bars: label, value, track. Values are always printed, so no hover needed. */
function HBars({
  rows,
  max,
  format,
}: {
  rows: { label: string; value: number }[];
  max?: number;
  format: (v: number) => string;
}) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.label}>
          <div className="flex justify-between text-xs">
            <span className="text-ink-2">{r.label}</span>
            <span className="tabular-nums">{format(r.value)}</span>
          </div>
          <div className="mt-0.5 h-1.5 rounded-full bg-surface-2">
            <div
              className="h-1.5 rounded-full"
              style={{ width: `${(r.value / top) * 100}%`, background: 'var(--series-1)' }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Gap themes across your latest scores — what to prepare for, or build, next. */
function RecurringGaps({ themes }: { themes: Stats['gapThemes'] }) {
  const [open, setOpen] = useState<string | null>(null);
  const top = themes.filter((t) => t.count > 1).slice(0, 10);
  const shown = top.length ? top : themes.slice(0, 5);
  return (
    <Card title="Recurring gaps">
      {themes.length === 0 ? (
        <p className="text-sm text-ink-3">
          Gaps from each fit score are grouped here, so you can see what keeps coming up.
        </p>
      ) : (
        <>
          <p className="mb-3 text-sm text-ink-2">
            Themes across your latest scores. The ones that keep coming up are what to prepare for,
            or build a story around, next.
          </p>
          <ul className="divide-y divide-border text-sm">
            {shown.map((t) => (
              <li key={t.theme} className="py-1.5">
                <button
                  className="flex w-full items-center gap-2 text-left"
                  onClick={() => setOpen(open === t.theme ? null : t.theme)}
                >
                  <span className="w-3 text-ink-3">{open === t.theme ? '▾' : '▸'}</span>
                  <span className="flex-1 font-medium">{t.theme}</span>
                  {t.knownGap && <span className="text-xs text-ink-3">known gap</span>}
                  {t.major > 0 && <span className="text-xs text-bad">{t.major} major</span>}
                  <span
                    className={cx(
                      'w-16 text-right tabular-nums',
                      t.count >= 3 ? 'font-semibold text-warn' : 'text-ink-2',
                    )}
                  >
                    {t.count} job{t.count === 1 ? '' : 's'}
                  </span>
                </button>
                {open === t.theme && (
                  <ul className="mt-1 space-y-1 pl-5 text-xs text-ink-2">
                    {t.jobs.map((j, i) => (
                      <li key={i}>
                        <Link
                          to={`/applications/${j.applicationId}`}
                          className="font-medium hover:underline"
                        >
                          {j.company} — {j.title}
                        </Link>
                        : {j.detail}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
