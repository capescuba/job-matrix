import type { Gate, GateReason } from '@jm/shared';
import { parseSalaryRange } from './jobfetch.ts';

const money = (n: number) => `$${n.toLocaleString('en-US')}`;

export interface PayRange {
  min: number | null;
  max: number | null;
  from: 'posting' | 'description';
}

/**
 * The job's pay range: the stored fields, else parsed from the description. A stored 0 is a
 * feed's placeholder for "not provided", not a salary.
 */
export function payRangeOf(job: {
  salaryMin: number | null;
  salaryMax: number | null;
  descriptionText: string | null;
}): PayRange | null {
  if ((job.salaryMin ?? 0) > 0 || (job.salaryMax ?? 0) > 0)
    return { min: job.salaryMin, max: job.salaryMax, from: 'posting' };
  const parsed = parseSalaryRange(job.descriptionText ?? '');
  return parsed ? { ...parsed, from: 'description' } : null;
}

/** Pay floor, checked in code against the posted range (more reliable than the model). */
export function payCheck(
  minBase: number | null,
  salaryMin: number | null,
  salaryMax: number | null,
): GateReason | null {
  if (!minBase) return null;
  const floor = money(minBase);
  if (salaryMin == null && salaryMax == null)
    return {
      kind: 'pay',
      label: 'Base',
      status: 'unclear',
      note: `No pay range posted (floor ${floor})`,
    };
  const top = salaryMax ?? salaryMin!;
  if (top < minBase)
    return {
      kind: 'pay',
      label: 'Base',
      status: 'fails',
      note: `Top of range ${money(top)} is below ${floor}`,
    };
  return null;
}

/** Any failure fails; anything unclear needs a check. Failures are listed first. */
export function gateOf(reasons: GateReason[]): { gate: Gate; reasons: GateReason[] } {
  const gate: Gate = reasons.some((r) => r.status === 'fails')
    ? 'fail'
    : reasons.length
      ? 'check'
      : 'pass';
  const sorted = [...reasons].sort((a, b) =>
    a.status === b.status ? 0 : a.status === 'fails' ? -1 : 1,
  );
  return { gate, reasons: sorted };
}

/**
 * A saved gate with the pay floor checked again against today's range and floor. Pay is a code
 * check, so a corrected salary or a new floor on Profile shows without paying to re-score; the
 * AI-judged must-haves and deal-breakers stay as scored.
 */
export function withCurrentPay(
  saved: GateReason[] | null,
  minBase: number | null,
  range: PayRange | null,
): { gate: Gate; reasons: GateReason[] } {
  const pay = payCheck(minBase, range?.min ?? null, range?.max ?? null);
  return gateOf([...(pay ? [pay] : []), ...(saved ?? []).filter((r) => r.kind !== 'pay')]);
}
