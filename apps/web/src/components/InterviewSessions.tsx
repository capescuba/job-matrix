import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api.ts';
import { clock } from '../interview/live.ts';
import { Card } from './ui.tsx';

const mb = (bytes: number) => (bytes > 0 ? `${Math.max(1, Math.round(bytes / 1e6))} MB` : '');

/** Calls recorded for this application, and the way into the live coach. */
export function InterviewSessions({ applicationId }: { applicationId: number }) {
  const { data = [] } = useQuery({
    queryKey: ['interviews', applicationId],
    queryFn: () => api.listInterviews(applicationId),
  });
  return (
    <Card
      title="Interview calls"
      actions={
        <Link
          to={`/interview/${applicationId}`}
          className="rounded-md bg-accent px-3 py-1 text-sm font-medium text-accent-ink hover:opacity-90"
        >
          Interview coach
        </Link>
      }
    >
      {!data.length ? (
        <p className="text-sm text-ink-3">
          Record a screen or interview, get live hints, then play it back with a debrief.
        </p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {data.map((s) => (
            <li key={s.id}>
              <Link
                to={`/interview/${applicationId}/${s.id}`}
                className="flex items-center gap-2 py-1.5 hover:text-accent"
              >
                <span className="font-medium">{s.round}</span>
                <span className="text-ink-3">{(s.startedAt ?? s.createdAt).slice(0, 10)}</span>
                <span className="ml-auto text-xs text-ink-3">
                  {!s.startedAt
                    ? 'not started'
                    : !s.endedAt
                      ? 'live'
                      : [
                          s.audioMs ? clock(s.audioMs) : null,
                          mb(s.audioBytes),
                          s.hasSummary ? 'debriefed' : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
