// Live AI runs in the side panel — the same feed and view as the app's live scoring panel
// (apps/web/src/aiActivity.ts + components/LiveRun.tsx), in plain JS.
import { settings } from './api.js';

/** runId → { id, label, applicationId, companyId, startedAt, steps, thinking, output, finishedAt, result } */
const runs = new Map();
/** Which stream (thinking/output) is open per run. */
const openStream = new Map();
const openedAt = Date.now();
let source = null;
let sourceUrl = null;
let onChange = () => {};
let onFinish = () => {};

function apply(e) {
  if (e.type === 'start') {
    // Replays start with 'start', so resetting makes reconnects idempotent.
    runs.set(e.runId, {
      id: e.runId,
      label: e.label,
      applicationId: e.applicationId,
      companyId: e.companyId,
      startedAt: e.at,
      steps: [],
      thinking: '',
      output: '',
      finishedAt: null,
      result: null,
    });
    return;
  }
  const run = runs.get(e.runId);
  if (!run) return;
  if (e.type === 'step') run.steps.push({ at: e.at, text: e.text, detail: e.detail });
  else if (e.type === 'thinking') run.thinking += e.text;
  else if (e.type === 'output') run.output += e.text;
  else if (e.type === 'done' || e.type === 'error') {
    const wasRunning = !run.finishedAt;
    run.finishedAt = e.at;
    run.result = { text: e.text, ok: e.type === 'done', usageId: e.usageId };
    if (wasRunning && e.at >= openedAt) onFinish(run);
  }
}

let scheduled = false;
function changed() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    onChange();
  }, 150);
}

// Keep elapsed times moving while a run is quiet (e.g. thinking before any text arrives).
setInterval(() => {
  if ([...runs.values()].some((r) => !r.finishedAt)) onChange();
}, 1000);

/** Opens (or re-opens after a server change) the server's live AI feed. */
export async function connectLive(handlers) {
  if (handlers) ({ onChange, onFinish } = handlers);
  const { server } = await settings();
  const url = `${server}/api/ai/events`;
  if (source && sourceUrl === url) return;
  source?.close();
  sourceUrl = url;
  source = new EventSource(url);
  source.onmessage = (m) => {
    try {
      apply(JSON.parse(m.data));
      changed();
    } catch {
      // ignore malformed events
    }
  };
}

/** Runs for this job (fit) or this company (research) that are live or started since the panel opened. */
export function runsFor({ applicationId, companyId }) {
  return [...runs.values()]
    .filter((r) =>
      companyId != null
        ? r.companyId === companyId
        : r.applicationId === applicationId && r.companyId == null,
    )
    .filter((r) => !r.finishedAt || r.startedAt >= openedAt - 1000)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 1);
}

export function isRunning(filter) {
  return runsFor(filter).some((r) => !r.finishedAt);
}

// ---------- progress (same rules as the app) ----------

const OUTPUT_KEYS = [
  'verdict',
  'summary',
  'whyNotHigher',
  'parts',
  'criteria',
  'strengths',
  'gaps',
  'flags',
  'facts',
  'interviewFocus',
  'talkingPoints',
];
const RESEARCH_KEYS = [
  'flags',
  'snapshot',
  'momentum',
  'news',
  'culture',
  'interview',
  'comp',
  'financials',
  'questionsToAsk',
  'sources',
];

function progress(run) {
  if (run.result) return { value: 1, label: run.result.ok ? 'Done' : 'Failed' };
  if (run.companyId != null) {
    const searches = run.steps.filter((s) => s.text.startsWith('Searching')).length;
    if (run.output.includes('{')) {
      const json = run.output.slice(run.output.indexOf('{') + 1);
      const written = RESEARCH_KEYS.filter((k) => json.includes(`"${k}"`)).length;
      return {
        value: 0.5 + 0.45 * (written / RESEARCH_KEYS.length),
        label: `Writing: ${RESEARCH_KEYS[Math.max(0, written - 1)]}`,
      };
    }
    return {
      value: 0.05 + 0.4 * Math.min(1, searches / 8),
      label: searches ? `Searching (${searches} so far)` : 'Starting',
    };
  }
  if (run.output) {
    const written = OUTPUT_KEYS.filter((k) => run.output.includes(`"${k}"`)).length;
    return {
      value: 0.35 + 0.6 * (written / OUTPUT_KEYS.length),
      label: `Writing: ${OUTPUT_KEYS[Math.max(0, written - 1)]}`,
    };
  }
  if (run.thinking) return { value: 0.2, label: 'Thinking' };
  return { value: 0.08, label: run.steps.at(-1)?.text ?? 'Starting' };
}

/** Part scores as soon as each appears in the streamed answer. */
function partialParts(output) {
  const out = {};
  for (const m of output.matchAll(
    /"(skills|level|logistics|pay|upside)"\s*:\s*\{\s*"score"\s*:\s*([\d.]+)/g,
  ))
    out[m[1]] = Number(m[2]);
  return out;
}

// ---------- view ----------

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const tone = (s) => (s >= 8 ? 'good' : s >= 7 ? 'accent' : s >= 6 ? 'warn' : 'bad');
const PART = {
  skills: 'Skills',
  level: 'Level',
  logistics: 'Logistics',
  pay: 'Pay',
  upside: 'Upside',
};

function card(run) {
  const now = Date.now();
  const p = progress(run);
  const parts = partialParts(run.output);
  const open = openStream.get(run.id) ?? null;
  const done = !!run.finishedAt;
  // A finished run folds down to one line (plus its streams, if you open them).
  const steps = done
    ? ''
    : `<ol class="steps">${run.steps
        .map(
          (s) =>
            `<li><span class="t">+${secs(s.at - run.startedAt)}</span><span>${esc(s.text)}${s.detail ? `<span class="faint d">${esc(s.detail)}</span>` : ''}</span></li>`,
        )
        .join('')}</ol>`;
  return `<div class="liverun">
    <div class="row"><strong class="grow">${done ? (run.result.ok ? '✓ ' : '✕ ') : ''}${esc(done ? run.result.text : run.label)}</strong><span class="faint small">${secs((run.finishedAt ?? now) - run.startedAt)}</span></div>
    ${done ? '' : `<div class="bar"><div class="${run.result && !run.result.ok ? 'bad' : ''}" style="width:${Math.round(p.value * 100)}%"></div></div><div class="small muted">${esc(p.label)}</div>`}
    ${
      !done && Object.keys(parts).length
        ? `<div class="row small" style="margin-top:4px">${Object.entries(parts)
            .map(
              ([k, v]) =>
                `<span class="chip">${PART[k]} <span class="${tone(v)}">${v}</span></span>`,
            )
            .join('')}</div>`
        : ''
    }
    ${steps}
    <div class="row small" style="margin-top:4px">
      <button class="link small" data-live-stream="thinking" data-run="${run.id}" ${run.thinking ? '' : 'disabled'}>${open === 'thinking' ? '▾' : '▸'} Thinking${run.thinking ? ` (${run.thinking.length.toLocaleString()} chars)` : ''}</button>
      <button class="link small" data-live-stream="output" data-run="${run.id}" ${run.output ? '' : 'disabled'}>${open === 'output' ? '▾' : '▸'} Output${run.output ? ` (${run.output.length.toLocaleString()} chars)` : ''}</button>
    </div>
    ${open ? `<pre class="stream ${open === 'output' ? 'mono' : ''}" data-stream-for="${run.id}">${esc(open === 'thinking' ? run.thinking : run.output)}</pre>` : ''}
  </div>`;
}

/** Fills every <div data-live="app:ID"> / <div data-live="company:ID"> in the panel. */
export function renderLive(root) {
  for (const el of root.querySelectorAll('[data-live]')) {
    const [kind, id] = el.dataset.live.split(':');
    const list = runsFor(
      kind === 'company' ? { companyId: Number(id) } : { applicationId: Number(id) },
    );
    // Keep a scrolled-up stream where it is; otherwise follow the newest text.
    const pre = el.querySelector('pre.stream');
    const stick = !pre || pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
    const top = pre?.scrollTop;
    el.innerHTML = list.length
      ? list.map(card).join('')
      : el.dataset.pending
        ? `<div class="liverun small muted">${esc(el.dataset.pending)}</div>`
        : '';
    const next = el.querySelector('pre.stream');
    if (next) next.scrollTop = stick ? next.scrollHeight : top;
  }
}

/** Thinking/Output toggle clicks. */
export function toggleStream(runId, which) {
  openStream.set(runId, openStream.get(runId) === which ? null : which);
}
