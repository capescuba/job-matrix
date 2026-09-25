import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { MODEL_PRICING } from '@jm/shared';
import { api, type Usage } from '../api.ts';
import { useState } from 'react';
import { CallInspector } from '../components/CallInspector.tsx';
import { Card, ErrorText } from '../components/ui.tsx';

export const usd = (n: number | null | undefined, digits = 2) =>
  n == null ? '—' : n > 0 && n < 0.01 && digits <= 2 ? '<$0.01' : `$${n.toFixed(digits)}`;
const tokens = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(1)}k`
      : String(n);
const FEATURE_LABELS: Record<string, string> = {
  fit: 'Fit scoring',
  research: 'Company research',
  answer: 'Application answers',
  email: 'Email updates',
};

export default function UsagePage() {
  const { data, error, isLoading } = useQuery({ queryKey: ['usage'], queryFn: api.usage });
  const [inspect, setInspect] = useState<number | null>(null);
  if (isLoading) return <p className="text-ink-2">Loading…</p>;
  if (error || !data) return <ErrorText error={error} />;
  const perScore = data.byFeature.find((f) => f.feature === 'fit');

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">AI usage</h1>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile
          label="This month"
          value={usd(data.thisMonth.costUsd)}
          sub={`${data.thisMonth.calls} calls`}
        />
        <Tile label="All time" value={usd(data.total.costUsd)} sub={`${data.total.calls} calls`} />
        <Tile
          label="Tokens (all time)"
          value={tokens(data.total.inputTokens + data.total.cacheTokens + data.total.outputTokens)}
          sub={`${tokens(data.total.inputTokens + data.total.cacheTokens)} in · ${tokens(data.total.outputTokens)} out`}
        />
        <Tile
          label="Per fit score"
          value={perScore ? usd(perScore.costUsd / perScore.calls, 3) : '—'}
          sub="average"
        />
      </div>

      <Forecast f={data.forecast} />

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Card title="Daily cost — last 30 days">
          {data.total.calls === 0 ? (
            <p className="text-sm text-ink-3">No AI calls yet.</p>
          ) : (
            <DailyChart data={data.last30Days} />
          )}
        </Card>
        <Card title="By model">
          {data.byModel.length === 0 ? (
            <p className="text-sm text-ink-3">No AI calls yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-ink-2">
                <tr>
                  <th className="pb-1 font-medium">Model</th>
                  <th className="pb-1 text-right font-medium">Calls</th>
                  <th className="pb-1 text-right font-medium">Cost</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.byModel.map((m) => (
                  <tr key={m.model} className="border-t border-border">
                    <td className="py-1.5">{m.label}</td>
                    <td className="py-1.5 text-right tabular-nums">{m.calls}</td>
                    <td className="py-1.5 text-right tabular-nums">{usd(m.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <Card title="Recent calls">
        {data.recent.length === 0 ? (
          <p className="text-sm text-ink-3">
            Nothing yet — scores you run will appear here. Re-scoring unchanged jobs uses the saved
            result and costs nothing.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-ink-2">
                <tr>
                  <th className="pb-1 font-medium">When</th>
                  <th className="pb-1 font-medium">What</th>
                  <th className="pb-1 font-medium">Model</th>
                  <th className="pb-1 text-right font-medium">In</th>
                  <th className="pb-1 text-right font-medium">Out</th>
                  <th className="pb-1 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="py-1.5 whitespace-nowrap text-ink-2">
                      {new Date(r.at).toLocaleString()}
                    </td>
                    <td className="py-1.5">
                      {FEATURE_LABELS[r.feature] ?? r.feature}
                      {r.company && (
                        <>
                          <span className="text-ink-3"> · </span>
                          <span className="font-medium">{r.company}</span>
                        </>
                      )}
                      {r.feature === 'fit' && r.jobTitle && (
                        <span className="text-ink-3"> · {r.jobTitle}</span>
                      )}
                      {r.applicationId && (
                        <Link
                          to={`/applications/${r.applicationId}`}
                          className="ml-2 text-accent hover:underline"
                        >
                          view
                        </Link>
                      )}
                    </td>
                    <td className="py-1.5 text-ink-2">
                      {MODEL_PRICING[r.model]?.label ?? r.model}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{tokens(r.inputTokens)}</td>
                    <td className="py-1.5 text-right tabular-nums">{tokens(r.outputTokens)}</td>
                    <td className="py-1.5 text-right tabular-nums">{usd(r.costUsd, 3)}</td>
                    <td className="py-1.5 pl-3 text-right">
                      <button
                        className="text-xs text-accent hover:underline"
                        onClick={() => setInspect(r.id)}
                      >
                        {r.error ? 'failed · inspect' : 'inspect'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {inspect != null && <CallInspector usageId={inspect} onClose={() => setInspect(null)} />}
      <p className="text-xs text-ink-3">
        Estimates use Anthropic list prices ({data.pricingAsOf}):{' '}
        {Object.values(MODEL_PRICING)
          .map((p) => `${p.label} $${p.input}/$${p.output}`)
          .join(' · ')}{' '}
        per million input/output tokens. Thinking counts as output. Your Anthropic invoice is the
        source of truth.
      </p>
    </div>
  );
}

function Forecast({ f }: { f: Usage['forecast'] }) {
  if (f.pending === 0) return null;
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3 text-sm">
      Scoring the <strong>{f.pending}</strong> unscored job{f.pending === 1 ? '' : 's'} with{' '}
      {f.modelLabel} would cost about <strong>{usd(f.totalUsd)}</strong>{' '}
      <span className="text-ink-3">
        ({usd(f.perCallUsd, 3)} each,{' '}
        {f.basis === 'history'
          ? 'based on your recent scores'
          : 'rough estimate until you have a few scores'}
        )
      </span>
      .
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="text-xs font-medium text-ink-2">{label}</div>
      <div className="mt-1 text-3xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-ink-3">{sub}</div>
    </div>
  );
}

function DailyChart({ data }: { data: Usage['last30Days'] }) {
  const fmt = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  return (
    <div className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 8, right: 8, bottom: 0, left: -12 }}
          barCategoryGap={2}
        >
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis
            dataKey="date"
            tickFormatter={fmt}
            interval={6}
            tick={{ fill: 'var(--ink-3)', fontSize: 11 }}
            axisLine={{ stroke: 'var(--border)' }}
            tickLine={false}
          />
          <YAxis
            tickFormatter={(v) => `$${v}`}
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
            labelFormatter={(d) => fmt(String(d))}
            formatter={(v, _n, item) => [
              `${usd(Number(v), 3)} · ${item.payload.calls} calls`,
              'Cost',
            ]}
          />
          <Bar dataKey="costUsd" fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={18} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
