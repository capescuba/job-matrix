import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { FIT_PARTS, type FitPartKey } from '@jm/shared';
import { api, type FitAssessment } from '../api.ts';
import { useAiRuns } from '../aiActivity.ts';
import { fitTone, formatScore } from './badges.tsx';
import { CallInspector } from './CallInspector.tsx';
import { LiveRun } from './LiveRun.tsx';
import { Button, Card, ErrorText, cx } from './ui.tsx';

const severityTone = { Minor: 'text-ink-3', Moderate: 'text-warn', Major: 'text-bad' } as const;
const statusIcon = { ok: '✓', fails: '✕', unclear: '?' } as const;
const statusTone = { ok: 'text-good', fails: 'text-bad', unclear: 'text-warn' } as const;

export function FitPanel({
  applicationId,
  fit,
  hasDescription,
}: {
  applicationId: number;
  fit: FitAssessment | undefined;
  hasDescription: boolean;
}) {
  const qc = useQueryClient();
  const [showCriteria, setShowCriteria] = useState(false);
  const [inspect, setInspect] = useState(false);
  const [mountedAt] = useState(Date.now);
  // This job's latest run, if it's live or started since this page opened.
  const run = useAiRuns().find(
    (r) => r.applicationId === applicationId && (!r.finishedAt || r.startedAt >= mountedAt - 1000),
  );
  const live = run && <LiveRun run={run} />;
  const score = useMutation({
    mutationFn: (force: boolean) => api.scoreFit(applicationId, force),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['application', applicationId] });
      qc.invalidateQueries({ queryKey: ['applications'] });
      qc.invalidateQueries({ queryKey: ['usage'] });
    },
  });

  const action = (
    <Button
      variant={fit ? 'ghost' : 'primary'}
      disabled={!hasDescription || score.isPending}
      onClick={() => score.mutate(Boolean(fit))}
      title={hasDescription ? undefined : 'Add the job description first'}
    >
      {score.isPending ? <Elapsed label="Scoring" /> : fit ? 'Re-score' : 'Score fit'}
    </Button>
  );

  // Assessments from the first scoring version have a different shape — ask for a re-score.
  if (!fit || !fit.result.parts) {
    return (
      <Card title="AI fit" actions={action}>
        <p className="text-sm text-ink-2">
          {!hasDescription
            ? 'Paste the job description to enable fit scoring.'
            : fit
              ? 'Scored with an older version — re-score to see the new breakdown.'
              : 'Not scored yet.'}
        </p>
        {live && <div className="mt-3">{live}</div>}
        <ErrorText error={score.error} />
      </Card>
    );
  }

  const r = fit.result;
  const reasons = fit.gateReasons ?? [];
  const fails = reasons.filter((x) => x.status === 'fails');
  const unclear = reasons.filter((x) => x.status === 'unclear');

  return (
    <Card title="AI fit" actions={action}>
      <ErrorText error={score.error} />
      {live && <div className="mb-3">{live}</div>}

      {fit.gate === 'fail' ? (
        <GateBox
          tone="bad"
          title={`Fails: ${fails.map((x) => x.label).join(', ')}`}
          items={fails}
        />
      ) : fit.gate === 'check' ? (
        <GateBox
          tone="warn"
          title={`Check: ${unclear.map((x) => x.label).join(', ')}`}
          items={unclear}
        />
      ) : (
        <p className="mb-3 text-sm font-medium text-good">
          ✓ Passes all must-haves and deal-breakers
        </p>
      )}

      <div className="flex items-start gap-4">
        <div className="text-center">
          <div
            className={cx(
              'text-4xl font-semibold tabular-nums',
              fit.gate === 'fail' ? 'text-ink-3' : fitTone(fit.overallScore),
            )}
          >
            {formatScore(fit.overallScore)}
          </div>
          <div className="text-xs text-ink-2">{r.verdict}</div>
        </div>
        <div className="space-y-1.5 text-sm leading-relaxed">
          <p>{r.summary}</p>
          <p className="text-ink-2">
            <span className="font-medium text-ink">Why not higher:</span> {r.whyNotHigher}
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-2.5">
        {(Object.keys(FIT_PARTS) as FitPartKey[]).map((k) => {
          const p = r.parts[k];
          return (
            <div key={k}>
              <div className="flex justify-between text-xs">
                <span className="text-ink-2">
                  {FIT_PARTS[k].label}{' '}
                  <span className="text-ink-3">· {Math.round(FIT_PARTS[k].weight * 100)}%</span>
                </span>
                <span className={cx('font-medium tabular-nums', fitTone(p.score))}>
                  {formatScore(p.score)}
                </span>
              </div>
              <div className="mt-0.5 h-1.5 rounded-full bg-surface-2">
                <div
                  className="h-1.5 rounded-full bg-accent"
                  style={{ width: `${Math.max(0, Math.min(10, p.score)) * 10}%` }}
                />
              </div>
              <p className="mt-0.5 text-xs text-ink-3">{p.why}</p>
            </div>
          );
        })}
      </div>

      {(r.flags.levelMismatch || r.flags.outreach.recommended) && (
        <Section title="Flags">
          <ul className="space-y-1.5">
            {r.flags.levelMismatch && (
              <li>
                <span className="font-medium text-warn">Level mismatch:</span>{' '}
                {r.flags.levelMismatch}
              </li>
            )}
            {r.flags.outreach.recommended && (
              <li>
                <span className="font-medium text-accent">Reach out:</span> {r.flags.outreach.why}
              </li>
            )}
          </ul>
        </Section>
      )}

      <Section title="Talking points">
        <ol className="list-decimal space-y-1 pl-5">
          {r.talkingPoints.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ol>
      </Section>
      <Section title="Strengths">
        <ul className="space-y-2">
          {r.strengths.map((s, i) => (
            <li key={i}>
              {s.point}
              <div className="text-xs text-ink-3">“{s.evidence}”</div>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Gaps">
        <ul className="space-y-2">
          {r.gaps.map((g, i) => (
            <li key={i}>
              <span className={cx('mr-1 text-xs font-medium', severityTone[g.severity])}>
                {g.severity}
              </span>
              {g.gap}
              <div className="mt-0.5 flex flex-wrap gap-1">
                <span className="rounded bg-surface-2 px-1.5 text-[11px] text-ink-2">
                  {g.theme}
                </span>
                {g.knownGap && (
                  <span className="rounded bg-surface-2 px-1.5 text-[11px] text-ink-3">
                    known gap
                  </span>
                )}
              </div>
              <div className="text-xs text-ink-3">→ {g.mitigation}</div>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Likely interview focus">
        <ul className="list-disc space-y-1 pl-5">
          {r.interviewFocus.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      </Section>

      <div className="mt-4">
        <button
          className="text-xs font-semibold uppercase tracking-wide text-ink-2 hover:text-ink"
          onClick={() => setShowCriteria((v) => !v)}
        >
          {showCriteria ? '▾' : '▸'} All criteria ({r.criteria.length})
        </button>
        {showCriteria && (
          <ul className="mt-2 space-y-1.5 text-sm">
            {r.criteria.map((c, i) => (
              <li key={i} className="flex gap-2">
                <span className={cx('w-3 shrink-0 font-semibold', statusTone[c.status])}>
                  {statusIcon[c.status]}
                </span>
                <span>
                  <span className="text-ink-3">{c.kind === 'must' ? 'Must' : 'Deal-breaker'}:</span>{' '}
                  {c.criterion}
                  <span className="block text-xs text-ink-3">{c.note}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="mt-4 text-xs text-ink-3">
        {fit.usageId != null && (
          <>
            <button className="text-accent hover:underline" onClick={() => setInspect(true)}>
              Inspect request
            </button>{' '}
            ·{' '}
          </>
        )}
        {fit.model} · {new Date(fit.createdAt).toLocaleString()}
        {r.facts.officeDaysPerWeek != null && ` · ${r.facts.officeDaysPerWeek} office days/wk`}
        {r.facts.yearsRequired != null && ` · ${r.facts.yearsRequired}+ yrs asked`}
        {r.facts.employmentType !== 'Unknown' && ` · ${r.facts.employmentType}`}
      </p>
      {inspect && fit.usageId != null && (
        <CallInspector usageId={fit.usageId} onClose={() => setInspect(false)} />
      )}
    </Card>
  );
}

function GateBox({
  tone,
  title,
  items,
}: {
  tone: 'bad' | 'warn';
  title: string;
  items: { label: string; note: string }[];
}) {
  return (
    <div
      className={cx(
        'mb-3 rounded-md border px-3 py-2 text-sm',
        tone === 'bad' ? 'border-bad/40 text-bad' : 'border-warn/40 text-warn',
      )}
    >
      <div className="font-semibold">{title}</div>
      <ul className="mt-0.5 text-xs text-ink-2">
        {items.map((x, i) => (
          <li key={i}>
            <span className="font-medium">{x.label}:</span> {x.note}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "Scoring… 12s": proof of life for calls that take a while. */
function Elapsed({ label }: { label: string }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <>
      {label}… {secs}s
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4 text-sm">
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-2">{title}</h3>
      {children}
    </div>
  );
}
