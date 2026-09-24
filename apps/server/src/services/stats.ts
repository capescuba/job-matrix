import {
  CLOSED_STATUSES,
  RESPONSE_ACTIVITY_KINDS,
  RESPONSE_STATUSES,
  STATUSES,
  type ActivityKind,
  type Status,
} from '@jm/shared';
import type { Db } from '../db/client.ts';
import { listApplications, today } from './applications.ts';
import { gapThemes } from './fit.ts';

const DAY = 86_400_000;

/** Monday (UTC) of the week containing the given YYYY-MM-DD date. */
export function weekStart(date: string): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - offset * DAY).toISOString().slice(0, 10);
}

export function getStats(db: Db, now = new Date()) {
  const apps = listApplications(db);
  const events = db.$client
    .prepare('SELECT application_id AS applicationId, to_status AS toStatus, at FROM status_events')
    .all() as { applicationId: number; toStatus: Status; at: string }[];

  const acts = db.$client
    .prepare('SELECT application_id AS applicationId, kind, at FROM activities')
    .all() as { applicationId: number; kind: ActivityKind; at: string }[];

  // Earliest sign the employer responded: a response-status change or a Response/Interview activity.
  const firstResponse = new Map<number, string>();
  const noteResponse = (appId: number, at: string) => {
    const prev = firstResponse.get(appId);
    if (!prev || at < prev) firstResponse.set(appId, at);
  };
  for (const e of events)
    if (RESPONSE_STATUSES.includes(e.toStatus)) noteResponse(e.applicationId, e.at);
  for (const a of acts)
    if (RESPONSE_ACTIVITY_KINDS.includes(a.kind)) noteResponse(a.applicationId, a.at);
  // Imported rows may already sit in a response status without a dated event.
  for (const a of apps) {
    if (RESPONSE_STATUSES.includes(a.status) && !firstResponse.has(a.id))
      firstResponse.set(a.id, '');
  }

  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  for (const a of apps) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;

  const applied = apps.filter((a) => a.appliedAt);
  const responded = applied.filter((a) => firstResponse.has(a.id));
  const responseDays = responded
    .map((a) => firstResponse.get(a.id)!)
    .map((at, i) => (at ? (Date.parse(at) - Date.parse(responded[i].appliedAt!)) / DAY : NaN))
    .filter((d) => Number.isFinite(d) && d >= 0);

  // Applications per week, last 12 weeks (zero-filled).
  const weeks: { week: string; count: number }[] = [];
  const thisWeek = weekStart(today(now));
  for (let i = 11; i >= 0; i--) {
    weeks.push({
      week: new Date(Date.parse(thisWeek) - i * 7 * DAY).toISOString().slice(0, 10),
      count: 0,
    });
  }
  for (const a of applied) {
    const w = weeks.find((x) => x.week === weekStart(a.appliedAt!));
    if (w) w.count++;
  }

  // Average fit score by outcome bucket — do high-fit jobs convert?
  const bucket = (s: Status) =>
    s === 'Saved'
      ? 'Not applied'
      : s === 'Applied' || s === 'Ghosted'
        ? 'No response'
        : s === 'Rejected' || s === 'Withdrawn'
          ? 'Rejected / withdrawn'
          : 'Interviewing / offer';
  const fitGroups = new Map<string, number[]>();
  for (const a of apps) {
    if (a.fitScore == null) continue;
    const k = bucket(a.status);
    fitGroups.set(k, [...(fitGroups.get(k) ?? []), a.fitScore]);
  }
  const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

  const sources = new Map<string, { applied: number; responded: number }>();
  for (const a of applied) {
    const k = a.source ?? 'Unknown';
    const s = sources.get(k) ?? { applied: 0, responded: 0 };
    s.applied++;
    if (firstResponse.has(a.id)) s.responded++;
    sources.set(k, s);
  }

  const soon = today(new Date(now.getTime() + 7 * DAY));
  return {
    total: apps.length,
    active: apps.filter((a) => a.status !== 'Saved' && !CLOSED_STATUSES.includes(a.status)).length,
    applied: applied.length,
    byStatus,
    responseRate: applied.length ? responded.length / applied.length : null,
    avgDaysToFirstResponse: avg(responseDays),
    perWeek: weeks,
    fitByOutcome: [...fitGroups].map(([outcome, xs]) => ({
      outcome,
      avgFit: avg(xs)!,
      n: xs.length,
    })),
    gapThemes: gapThemes(db),
    bySource: [...sources]
      .map(([source, s]) => ({ source, ...s }))
      .sort((a, b) => b.applied - a.applied),
    upcoming: apps
      .filter(
        (a) => a.nextActionDate && a.nextActionDate <= soon && !CLOSED_STATUSES.includes(a.status),
      )
      .sort((a, b) => a.nextActionDate!.localeCompare(b.nextActionDate!))
      .map((a) => ({
        id: a.id,
        company: a.company,
        title: a.title,
        nextAction: a.nextAction,
        nextActionDate: a.nextActionDate,
      })),
  };
}
