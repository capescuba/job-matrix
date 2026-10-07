import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import {
  FIT_PARTS,
  ROLE_TRACKS,
  ROLE_TRACK_LABELS,
  trackFromTitle,
  type CompanyResearch,
  type FitPartKey,
  type FitResult,
  type Gate,
  type RoleTrack,
} from '@jm/shared';
import { api, type ApplicationDetail, type FitAssessment } from '../api.ts';
import { useAiRuns } from '../aiActivity.ts';
import { fitTone, formatScore } from './badges.tsx';
import { CallInspector } from './CallInspector.tsx';
import { DecisionBody, Verdict, barTone, useDecisionData } from './Decision.tsx';
import { LiveRun } from './LiveRun.tsx';
import { Button, Card, ErrorText, Select, cx } from './ui.tsx';

const severityTone = { Minor: 'text-ink-3', Moderate: 'text-warn', Major: 'text-bad' } as const;
const statusIcon = { ok: '✓', fails: '✕', unclear: '?' } as const;
const statusTone = { ok: 'text-good', fails: 'text-bad', unclear: 'text-warn' } as const;

/**
 * The job page's at-a-glance card: score, filter chip, the five tiles, short lists and fit bars,
 * with Score / Re-score and live progress. The long-form detail lives in the tabs below.
 */
export function FitSummary({
  data,
  onShowDetails,
}: {
  data: ApplicationDetail;
  onShowDetails: () => void;
}) {
  const { application: app, job, company } = data;
  const qc = useQueryClient();
  const { brief, stock, minBase, fit } = useDecisionData(app.id, company.id);
  const latest = data.fits[0] as FitAssessment | undefined;
  const hasDescription = Boolean(job.descriptionText?.trim());
  const [mountedAt] = useState(Date.now);
  // This job's fit run, if it's live or started since this page opened.
  const runs = useAiRuns().filter(
    (r) =>
      r.applicationId === app.id &&
      r.companyId == null &&
      (!r.finishedAt || r.startedAt >= mountedAt - 1000),
  );
  const score = useMutation({
    mutationFn: (force: boolean) => api.scoreFit(app.id, force),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['application', app.id] });
      qc.invalidateQueries({ queryKey: ['applications'] });
      qc.invalidateQueries({ queryKey: ['usage'] });
    },
  });
  const setTrack = useMutation({
    mutationFn: (track: RoleTrack | null) => api.updateJob(job.id, { track }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['application', app.id] }),
  });

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className="text-sm font-semibold">AI fit</h2>
        <Select
          className="w-auto py-1"
          value={job.track ?? ''}
          aria-label="Score this job as"
          title="Which kind of role this is scored as: picks the resume and how the AI judges it"
          onChange={(e) => setTrack.mutate((e.target.value || null) as RoleTrack | null)}
        >
          <option value="">{trackFromTitle(job.title)} role (from the title)</option>
          {ROLE_TRACKS.map((t) => (
            <option key={t} value={t}>
              {ROLE_TRACK_LABELS[t]}
            </option>
          ))}
        </Select>
        {!fit && (
          <span className="text-sm text-ink-2">
            {!hasDescription
              ? 'Add the job description to enable fit scoring.'
              : latest
                ? 'Scored with an older version — re-score to see the breakdown.'
                : 'Not scored yet.'}
          </span>
        )}
        <span className="flex-1" />
        {fit && latest && (
          <Verdict
            score={latest.overallScore}
            verdict={fit.verdict}
            gate={latest.gate as Gate}
            reasons={latest.gateReasons ?? []}
          />
        )}
        <Button
          variant={fit ? 'ghost' : 'primary'}
          disabled={!hasDescription || score.isPending}
          onClick={() => score.mutate(Boolean(latest))}
          title={hasDescription ? undefined : 'Add the job description first'}
        >
          {score.isPending ? <Elapsed label="Scoring" /> : latest ? 'Re-score' : 'Score fit'}
        </Button>
      </div>
      <ErrorText error={score.error ?? setTrack.error} />

      {fit && <p className="mt-2 text-sm text-ink-2">{fit.whyNotHigher}</p>}

      <DecisionBody
        title={job.title}
        fit={fit}
        reasons={latest?.gateReasons ?? []}
        detail={data}
        brief={brief}
        stock={stock}
        minBase={minBase}
        onMore={onShowDetails}
        moreLabel="in Fit details"
      />

      {runs.length > 0 && (
        <div className="mt-3 space-y-2">
          {runs.map((r) => (
            <LiveRun key={r.id} run={r} showLabel={runs.length > 1} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The full assessment, laid out wide: parts with reasons, strengths and gaps side by side. */
export function FitDetails({ fit }: { fit: FitAssessment | undefined }) {
  const [showCriteria, setShowCriteria] = useState(false);
  const [inspect, setInspect] = useState(false);
  const r = fit?.result as FitResult | undefined;
  if (!fit || !r?.parts)
    return (
      <Card>
        <p className="text-sm text-ink-2">No fit details yet — score the job first.</p>
      </Card>
    );

  return (
    <Card>
      <div className="space-y-1.5 text-sm leading-relaxed">
        <p>{r.summary}</p>
        <p className="text-ink-2">
          <span className="font-medium text-ink">Why not higher:</span> {r.whyNotHigher}
        </p>
      </div>

      <Section title="Score breakdown">
        <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
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
                <div className="mt-0.5 h-1 rounded-full bg-surface-2">
                  <div
                    className={cx('h-1 rounded-full', barTone(p.score))}
                    style={{ width: `${Math.max(0, Math.min(10, p.score)) * 10}%` }}
                  />
                </div>
                <p className="mt-0.5 text-xs text-ink-3">{p.why}</p>
              </div>
            );
          })}
        </div>
      </Section>

      <div className="grid gap-x-6 sm:grid-cols-2">
        <Section title={`Strengths (${r.strengths.length})`}>
          <ul className="space-y-2">
            {r.strengths.map((s, i) => (
              <li key={i}>
                <span className="font-medium">{s.label ?? s.point}</span>
                {s.label && <div className="text-xs text-ink-2">{s.point}</div>}
                <div className="text-xs text-ink-3">“{s.evidence}”</div>
              </li>
            ))}
          </ul>
        </Section>
        <Section title={`Gaps (${r.gaps.length})`}>
          <ul className="space-y-2">
            {r.gaps.map((g, i) => (
              <li key={i}>
                <span className={cx('mr-1.5 text-xs font-medium', severityTone[g.severity])}>
                  {g.severity}
                </span>
                <span className="font-medium">{g.label ?? g.gap}</span>
                {g.knownGap && (
                  <span className="ml-1.5 rounded bg-surface-2 px-1.5 text-[11px] text-ink-3">
                    known gap
                  </span>
                )}
                {g.label && <div className="text-xs text-ink-2">{g.gap}</div>}
                <div className="text-xs text-ink-3">→ {g.mitigation}</div>
              </li>
            ))}
          </ul>
        </Section>
      </div>

      <div className="mt-4">
        <button
          className="text-xs font-semibold uppercase tracking-wide text-ink-2 hover:text-ink"
          onClick={() => setShowCriteria((v) => !v)}
        >
          {showCriteria ? '▾' : '▸'} All criteria ({r.criteria.length})
        </button>
        {showCriteria && (
          <ul className="mt-2 grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
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

/** What to say and what to ask: talking points, likely focus, and the brief's interview notes. */
export function InterviewPrep({
  fit,
  brief,
}: {
  fit: FitAssessment | undefined;
  brief: CompanyResearch | undefined;
}) {
  const r = fit?.result as FitResult | undefined;
  const hasFit = Boolean(r?.parts);
  if (!hasFit && !brief)
    return (
      <Card>
        <p className="text-sm text-ink-2">
          Score the job (and research the company) to get talking points and interview notes.
        </p>
      </Card>
    );
  const iv = brief?.interview;
  return (
    <Card>
      <div className="grid gap-x-6 sm:grid-cols-2">
        {hasFit && r && (
          <div>
            {(r.flags.levelMismatch || r.flags.outreach.recommended) && (
              <Section title="Heads-up" first>
                <ul className="space-y-1.5">
                  {r.flags.levelMismatch && (
                    <li>
                      <span className="font-medium text-warn">Level:</span> {r.flags.levelMismatch}
                    </li>
                  )}
                  {r.flags.outreach.recommended && (
                    <li>
                      <span className="font-medium text-accent">Reach out:</span>{' '}
                      {r.flags.outreach.why}
                    </li>
                  )}
                </ul>
              </Section>
            )}
            <Section
              title="Lead with"
              first={!r.flags.levelMismatch && !r.flags.outreach.recommended}
            >
              <ol className="list-decimal space-y-1 pl-5">
                {r.talkingPoints.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ol>
            </Section>
            <Section title="They'll likely probe">
              <ul className="list-disc space-y-1 pl-5">
                {r.interviewFocus.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </Section>
          </div>
        )}
        {brief && (
          <div>
            {brief.questionsToAsk.length > 0 && (
              <Section title="Questions to ask" first>
                <ul className="list-disc space-y-1 pl-5">
                  {brief.questionsToAsk.map((q, i) => (
                    <li key={i}>{q}</li>
                  ))}
                </ul>
              </Section>
            )}
            {iv && (iv.process || iv.rounds.length > 0 || iv.tips.length > 0) && (
              <Section title="Their interview loop">
                {iv.process && <p className="mb-1.5">{iv.process}</p>}
                {iv.rounds.length > 0 && (
                  <ol className="mb-1.5 list-decimal space-y-0.5 pl-5">
                    {iv.rounds.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ol>
                )}
                {iv.tips.length > 0 && (
                  <ul className="list-disc space-y-0.5 pl-5 text-ink-2">
                    {iv.tips.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                )}
                <p className="mt-1 text-xs text-ink-3">
                  From the company brief (sources in Company).
                </p>
              </Section>
            )}
          </div>
        )}
      </div>
    </Card>
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

function Section({
  title,
  first,
  children,
}: {
  title: string;
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cx('text-sm', !first && 'mt-4')}>
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-2">{title}</h3>
      {children}
    </div>
  );
}
