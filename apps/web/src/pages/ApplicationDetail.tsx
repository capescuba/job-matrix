import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  RELATIONSHIPS,
  REMOTE_TYPES,
  SOURCES,
  STATUSES,
  type ApplicationPatch,
  type JobPatch,
  type Status,
} from '@jm/shared';
import { api, type ApplicationDetail, type FitAssessment } from '../api.ts';
import { StatusBadge, postedOf } from '../components/badges.tsx';
import { ActivityLog } from '../components/ActivityLog.tsx';
import { ApplicationAnswers } from '../components/ApplicationAnswers.tsx';
import { CompanyAliases } from '../components/CompanyAliases.tsx';
import { CompanyInsights } from '../components/CompanyInsights.tsx';
import { useDecisionData } from '../components/Decision.tsx';
import { FitDetails, FitSummary, InterviewPrep } from '../components/FitPanel.tsx';
import { Button, Card, ErrorText, Field, Input, Select, Textarea, cx } from '../components/ui.tsx';

export default function ApplicationDetailPage() {
  const id = Number(useParams().id);
  const { data, isLoading, error } = useQuery({
    queryKey: ['application', id],
    queryFn: () => api.getApplication(id),
  });
  if (isLoading) return <p className="text-ink-2">Loading…</p>;
  if (error || !data) return <ErrorText error={error ?? 'Not found'} />;
  return <Detail data={data} />;
}

const TABS = [
  { key: 'fit', label: 'Fit details' },
  { key: 'prep', label: 'Interview prep' },
  { key: 'company', label: 'Company' },
  { key: 'job', label: 'Job description' },
] as const;
type Tab = (typeof TABS)[number]['key'];

function useInvalidate(id: number) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['application', id] });
    qc.invalidateQueries({ queryKey: ['applications'] });
  };
}

function Detail({ data }: { data: ApplicationDetail }) {
  const { application: app, job, company, fits } = data;
  const posted = postedOf(job);
  const invalidate = useInvalidate(app.id);
  const navigate = useNavigate();
  const { brief } = useDecisionData(app.id, company.id);
  // The open tab is in the URL, so a link or refresh keeps it. No description yet → start there.
  const [params, setParams] = useSearchParams();
  const tab: Tab =
    TABS.find((t) => t.key === params.get('tab'))?.key ?? (job.descriptionText ? 'fit' : 'job');
  const setTab = (t: Tab) => setParams(t === 'fit' ? {} : { tab: t }, { replace: true });

  const patchApp = useMutation({
    mutationFn: (p: ApplicationPatch) => api.updateApplication(app.id, p),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteApplication(app.id),
    onSuccess: () => {
      invalidate();
      navigate('/applications');
    },
  });

  return (
    <div className="space-y-4">
      <div>
        <Link to="/applications" className="text-sm text-ink-2 hover:text-ink">
          ← Applications
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{job.title}</h1>
          <StatusBadge status={app.status as Status} />
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 text-sm text-ink-2">
          <span className="font-medium text-ink">{company.name}</span>
          {job.location && <span>{job.location}</span>}
          {job.remoteType && <span>{job.remoteType}</span>}
          {(job.salaryMin || job.salaryMax) && (
            <span>
              ${job.salaryMin?.toLocaleString() ?? '?'} – ${job.salaryMax?.toLocaleString() ?? '?'}
            </span>
          )}
          {job.source && <span>via {job.source}</span>}
          {job.url && (
            <a
              href={job.url}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              Open posting ↗
            </a>
          )}
          {data.emailLink && (
            <a
              href={data.emailLink}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              Open recruiter email ↗
            </a>
          )}
          {posted && (
            <span
              className={cx(
                'cursor-help underline decoration-dotted underline-offset-2',
                posted.days > 60 && 'text-warn',
              )}
              title={posted.title}
            >
              {posted.label}
            </span>
          )}
          {job.postingStatus === 'closed' && (
            <span className="font-medium text-bad" title={job.postingNote ?? undefined}>
              Posting closed?
            </span>
          )}
        </div>
      </div>

      <FitSummary data={data} onShowDetails={() => setTab('fit')} />

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap gap-1 border-b border-border" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.key}
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={cx(
                  '-mb-px border-b-2 px-3 py-1.5 text-sm',
                  tab === t.key
                    ? 'border-accent font-medium text-ink'
                    : 'border-transparent text-ink-2 hover:text-ink',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          {tab === 'fit' && <FitDetails fit={fits[0] as FitAssessment | undefined} />}
          {tab === 'prep' && (
            <>
              <InterviewPrep fit={fits[0] as FitAssessment | undefined} brief={brief} />
              <ApplicationAnswers applicationId={app.id} />
            </>
          )}
          {tab === 'company' && (
            <>
              <CompanyInsights companyId={company.id} companyName={company.name} />
              <CompanyAliases companyId={company.id} companyName={company.name} />
            </>
          )}
          {tab === 'job' && <JobCard data={data} onSaved={invalidate} />}
        </div>
        <div className="space-y-4">
          <TrackingCard
            data={data}
            onSave={(p) => patchApp.mutate(p)}
            saving={patchApp.isPending}
            error={patchApp.error}
          />
          <ActivityLog data={data} onChanged={invalidate} />
          <ContactsCard data={data} onChanged={invalidate} />
          <div className="text-right">
            <Button
              variant="danger"
              onClick={() => confirm('Delete this application and its job?') && remove.mutate()}
            >
              Delete application
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TrackingCard({
  data,
  onSave,
  saving,
  error,
}: {
  data: ApplicationDetail;
  onSave: (p: ApplicationPatch) => void;
  saving: boolean;
  error: unknown;
}) {
  const app = data.application;
  const initial = {
    status: app.status,
    appliedAt: app.appliedAt ?? '',
    nextAction: app.nextAction ?? '',
    nextActionDate: app.nextActionDate ?? '',
    notes: app.notes ?? '',
  };
  const [f, setF] = useState(initial);
  useEffect(() => setF(initial), [app.updatedAt, app.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(f) !== JSON.stringify(initial);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));

  return (
    <Card
      title="Tracking"
      actions={
        <Button
          variant="primary"
          disabled={!dirty || saving}
          onClick={() =>
            onSave({
              status: f.status as Status,
              appliedAt: f.appliedAt || null,
              nextAction: f.nextAction || null,
              nextActionDate: f.nextActionDate || null,
              notes: f.notes || null,
            })
          }
        >
          Save
        </Button>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Status">
          <Select value={f.status} onChange={set('status')}>
            {STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        </Field>
        <Field label="Applied">
          <Input type="date" value={f.appliedAt} onChange={set('appliedAt')} />
        </Field>
        <Field label="Next action">
          <Input
            value={f.nextAction}
            onChange={set('nextAction')}
            placeholder="Follow up with recruiter"
          />
        </Field>
        <Field label="By">
          <Input type="date" value={f.nextActionDate} onChange={set('nextActionDate')} />
        </Field>
        <Field label="Notes" className="col-span-2">
          <Textarea rows={3} value={f.notes} onChange={set('notes')} />
        </Field>
      </div>
      <ErrorText error={error} />
    </Card>
  );
}

function JobCard({ data, onSaved }: { data: ApplicationDetail; onSaved: () => void }) {
  const { job } = data;
  const initial = {
    title: job.title,
    url: job.url ?? '',
    location: job.location ?? '',
    remoteType: job.remoteType ?? '',
    source: job.source ?? '',
    salaryMin: job.salaryMin?.toString() ?? '',
    salaryMax: job.salaryMax?.toString() ?? '',
    postedAt: job.postedAt ?? '',
    postingStatus: job.postingStatus ?? '',
    descriptionText: job.descriptionText ?? '',
  };
  const [editing, setEditing] = useState(!job.descriptionText);
  const [f, setF] = useState(initial);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  const num = (s: string) => (s.trim() ? Number(s.replace(/[^\d]/g, '')) : null);

  const save = useMutation({
    mutationFn: () =>
      api.updateJob(job.id, {
        title: f.title,
        url: f.url || null,
        location: f.location || null,
        remoteType: (f.remoteType || null) as JobPatch['remoteType'],
        source: (f.source || null) as JobPatch['source'],
        salaryMin: num(f.salaryMin),
        salaryMax: num(f.salaryMax),
        postedAt: f.postedAt || null,
        ...(f.postingStatus !== (job.postingStatus ?? '') && {
          postingStatus: (f.postingStatus || null) as JobPatch['postingStatus'],
          postingNote: f.postingStatus ? 'Set manually' : null,
        }),
        descriptionText: f.descriptionText || null,
      }),
    onSuccess: () => {
      setEditing(false);
      onSaved();
    },
  });

  // Fills the form from the posting's URL; keeps anything already typed except the description.
  const fetchFromUrl = useMutation({
    mutationFn: () => api.fetchJob(f.url),
    onSuccess: (r) =>
      setF((x) => ({
        ...x,
        descriptionText: r.descriptionText,
        location: x.location || r.location || '',
        remoteType: x.remoteType || r.remoteType || '',
        salaryMin: x.salaryMin || r.salaryMin?.toString() || '',
        salaryMax: x.salaryMax || r.salaryMax?.toString() || '',
      })),
  });

  if (!editing) {
    return (
      <Card
        title="Job description"
        actions={
          <Button
            variant="ghost"
            onClick={() => {
              setF(initial);
              setEditing(true);
            }}
          >
            Edit
          </Button>
        }
      >
        {(job.salaryMin || job.salaryMax) && (
          <p className="mb-2 text-sm text-ink-2">
            Salary: {job.salaryMin?.toLocaleString() ?? '?'} –{' '}
            {job.salaryMax?.toLocaleString() ?? '?'}
          </p>
        )}
        <div className="max-h-[32rem] overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed">
          {job.descriptionText}
        </div>
      </Card>
    );
  }

  return (
    <Card
      title="Job details"
      actions={
        <>
          <Button
            variant="ghost"
            disabled={!f.url.trim() || fetchFromUrl.isPending}
            onClick={() => fetchFromUrl.mutate()}
            title={f.url.trim() ? 'Fetch the description from the posting URL' : 'Add a URL first'}
          >
            {fetchFromUrl.isPending ? 'Importing…' : 'Import from URL'}
          </Button>
          {job.descriptionText && (
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          )}
          <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Title" className="col-span-2">
          <Input value={f.title} onChange={set('title')} />
        </Field>
        <Field label="URL" className="col-span-2">
          <Input value={f.url} onChange={set('url')} />
        </Field>
        <Field label="Location">
          <Input value={f.location} onChange={set('location')} />
        </Field>
        <Field label="Remote">
          <Select value={f.remoteType} onChange={set('remoteType')}>
            <option value="">—</option>
            {REMOTE_TYPES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </Select>
        </Field>
        <Field label="Salary min">
          <Input inputMode="numeric" value={f.salaryMin} onChange={set('salaryMin')} />
        </Field>
        <Field label="Salary max">
          <Input inputMode="numeric" value={f.salaryMax} onChange={set('salaryMax')} />
        </Field>
        <Field label="Source">
          <Select value={f.source} onChange={set('source')}>
            <option value="">—</option>
            {SOURCES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </Select>
        </Field>
        <Field label="Posted">
          <Input type="date" value={f.postedAt} onChange={set('postedAt')} />
          {job.postedAt && f.postedAt === job.postedAt && (
            <span className="mt-1 block text-xs text-ink-3" title={postedOf(job)?.title}>
              From: {job.postedSource ?? 'not recorded'}
              {job.postedApprox && ' (approx.)'}
            </span>
          )}
        </Field>
        <Field label="Posting status">
          <Select value={f.postingStatus} onChange={set('postingStatus')}>
            <option value="">Not checked</option>
            <option value="open">Open</option>
            <option value="closed">Closed / filled</option>
          </Select>
        </Field>
        <Field label="Job description" className="col-span-2 sm:col-span-4">
          <Textarea
            rows={14}
            value={f.descriptionText}
            onChange={set('descriptionText')}
            placeholder="Paste the full job description…"
          />
        </Field>
      </div>
      <ErrorText error={save.error ?? fetchFromUrl.error} />
    </Card>
  );
}

function ContactsCard({ data, onChanged }: { data: ApplicationDetail; onChanged: () => void }) {
  const blank = { name: '', role: '', relationship: '', linkedinUrl: '' };
  const [f, setF] = useState(blank);
  const [adding, setAdding] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  const add = useMutation({
    mutationFn: () =>
      api.createContact({
        companyId: data.company.id,
        name: f.name,
        role: f.role || null,
        linkedinUrl: f.linkedinUrl || null,
        relationship: (f.relationship || null) as (typeof RELATIONSHIPS)[number] | null,
      }),
    onSuccess: () => {
      setF(blank);
      setAdding(false);
      onChanged();
    },
  });
  const del = useMutation({ mutationFn: api.deleteContact, onSuccess: onChanged });

  return (
    <Card
      title={`Contacts at ${data.company.name}`}
      actions={
        !adding && (
          <Button variant="ghost" onClick={() => setAdding(true)}>
            + Add
          </Button>
        )
      }
    >
      {data.contacts.length === 0 && !adding && (
        <p className="text-sm text-ink-3">No contacts yet.</p>
      )}
      <ul className="divide-y divide-border text-sm">
        {data.contacts.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-2 py-1.5">
            <span>
              {c.linkedinUrl ? (
                <a
                  href={c.linkedinUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-accent hover:underline"
                >
                  {c.name}
                </a>
              ) : (
                <span className="font-medium">{c.name}</span>
              )}
              {c.role && <span className="text-ink-2"> · {c.role}</span>}
              {c.relationship && <span className="text-ink-3"> · {c.relationship}</span>}
            </span>
            <Button
              variant="danger"
              className="px-2 py-0.5"
              onClick={() => del.mutate(c.id)}
              aria-label={`Remove ${c.name}`}
            >
              ✕
            </Button>
          </li>
        ))}
      </ul>
      {adding && (
        <form
          className="mt-2 grid grid-cols-2 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <Input required placeholder="Name" value={f.name} onChange={set('name')} />
          <Input placeholder="Role" value={f.role} onChange={set('role')} />
          <Select value={f.relationship} onChange={set('relationship')}>
            <option value="">Relationship…</option>
            {RELATIONSHIPS.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </Select>
          <Input placeholder="LinkedIn URL" value={f.linkedinUrl} onChange={set('linkedinUrl')} />
          <div className="col-span-2 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={add.isPending}>
              Add contact
            </Button>
          </div>
          <ErrorText error={add.error} />
        </form>
      )}
    </Card>
  );
}
