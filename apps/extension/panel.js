// The Job Matrix side panel: what Job Matrix knows about the page you're on, and actions for it.
import { api, openInApp } from './api.js';
import { captureBody, contextBody, readTab } from './capture.js';
import { fillField, startPicker } from './reader.js';
import { connectLive, isRunning, renderLive, toggleStream } from './live.js';

const root = document.getElementById('root');
const statusEl = document.getElementById('status');

/** Everything the panel shows; re-rendered as a whole (it's small). */
const state = {
  tab: null, // { id, url }
  page: null, // readPage() result
  template: null,
  ctx: null, // /api/ext/context
  error: null,
  notice: null,
  edits: { title: '', company: '' },
  busy: null, // 'add' | 'score' | 'save-template'
  useApp: null, // application chosen for the helper when the page only looks similar
  drafts: {}, // question id → { text, basedOn, loading, error }
  saved: {}, // question id → earlier answers to similar questions
  teach: null, // { selectors: {}, samples: {} } while teaching this site
};

// ---------- helpers ----------

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const money = (usd) =>
  usd == null ? '' : usd < 1 ? `${Math.round(usd * 100)}¢` : `$${usd.toFixed(2)}`;
const day = (iso) =>
  iso
    ? new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
      })
    : '';
const daysAgo = (iso) => {
  if (!iso) return '';
  const d = Math.floor((Date.now() - Date.parse(`${iso.slice(0, 10)}T12:00:00Z`)) / 86_400_000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
};
const status = (text) => (statusEl.textContent = text ?? '');

const STATUS_TONE = {
  Screening: 'accent',
  Saved: '',
  Applied: 'accent',
  'Recruiter Screen': 'good',
  'Hiring Manager': 'good',
  'Interview Loop': 'good',
  Offer: 'good',
  Rejected: 'bad',
  Withdrawn: '',
  Ghosted: 'warn',
  Passed: '',
};
/** "You passed on this" etc. for applications you've closed. */
const DECISION_TEXT = {
  Passed: 'You passed on this',
  Rejected: 'They turned you down',
  Withdrawn: 'You withdrew',
  Ghosted: 'No response — marked ghosted',
};
function decisionBanner(a, prefix = '') {
  const d = a.decision;
  if (!d) return '';
  const when = d.at ? ` · ${day(d.at)} <span class="faint">(${daysAgo(d.at)})</span>` : '';
  return `<div class="decision ${d.status === 'Rejected' ? 'bad' : ''}">
    <div><strong>${prefix}${esc(DECISION_TEXT[d.status] ?? d.status)}</strong>${when}</div>
    ${d.reason ? `<div class="muted">“${esc(d.reason)}”</div>` : ''}
  </div>`;
}
const statusChip = (s) => `<span class="chip ${STATUS_TONE[s] ?? ''}">${esc(s)}</span>`;
const gateChip = (a) =>
  a.fitGate === 'fail'
    ? `<span class="chip bad" title="${esc((a.fitGateReasons ?? []).map((r) => `${r.label}: ${r.note}`).join('\n'))}">Fails: ${esc(
        (a.fitGateReasons ?? [])
          .filter((r) => r.status === 'fails')
          .map((r) => r.label.toLowerCase())
          .join(', '),
      )}</span>`
    : a.fitGate === 'check'
      ? `<span class="chip warn" title="${esc((a.fitGateReasons ?? []).map((r) => `${r.label}: ${r.note}`).join('\n'))}">Check: ${esc(
          (a.fitGateReasons ?? []).map((r) => r.label.toLowerCase()).join(', '),
        )}</span>`
      : a.fitGate === 'pass'
        ? '<span class="chip good">Passes filters</span>'
        : '';
const spark = (points, up) => {
  if (!points || points.length < 2) return '';
  const min = Math.min(...points);
  const max = Math.max(...points);
  const d = points
    .map((p, i) => `${(i / (points.length - 1)) * 100},${13 - ((p - min) / (max - min || 1)) * 11}`)
    .join(' ');
  return `<svg class="spark" viewBox="0 0 100 14" preserveAspectRatio="none"><polyline fill="none" stroke-width="1.5" stroke="var(--${up ? 'good' : 'bad'})" points="${d}"/></svg>`;
};

// ---------- reading the tab ----------

let seq = 0;
async function refresh() {
  const mine = ++seq;
  connectLive();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (mine !== seq) return;
  // Same page as before (e.g. the panel just got focus back): keep drafts, teaching and notices.
  const samePage = !!tab && state.tab?.id === tab.id && state.tab?.url === tab.url;
  Object.assign(state, {
    tab: tab ? { id: tab.id, url: tab.url } : null,
    error: null,
    ...(!samePage && {
      notice: null,
      drafts: {},
      saved: {},
      teach: null,
      useApp: null,
      showAdd: false,
      passing: false,
    }),
  });
  if (!tab?.url || !/^https?:/.test(tab.url)) {
    Object.assign(state, { page: null, ctx: null });
    return render();
  }
  status('Reading the page…');
  try {
    const { page, template } = await readTab(tab.id, tab.url, status);
    if (mine !== seq) return;
    const ctx = await api('/api/ext/context', {
      method: 'POST',
      body: contextBody(page),
      onStatus: status,
    });
    if (mine !== seq) return;
    Object.assign(state, {
      page,
      template,
      ctx,
      // Keep what you typed if it's still the same page.
      edits: samePage
        ? state.edits
        : { title: ctx.detected.title ?? '', company: ctx.detected.company ?? '' },
    });
    loadSavedAnswers();
  } catch (e) {
    if (mine !== seq) return;
    Object.assign(state, { page: null, ctx: null, error: e.message || String(e) });
  }
  status('');
  render();
}

async function loadSavedAnswers() {
  for (const q of state.page?.questions ?? []) {
    api(`/api/ext/answers?q=${encodeURIComponent(q.label)}`)
      .then((rows) => {
        if (rows?.length) {
          state.saved[q.id] = rows;
          render();
        }
      })
      .catch(() => {});
  }
}

// ---------- rendering ----------

function render() {
  // Keep typing where it was when the panel redraws (e.g. saved answers arriving).
  const a = document.activeElement;
  const key = a?.dataset?.edit
    ? `[data-edit="${a.dataset.edit}"]`
    : a?.dataset?.draft
      ? `[data-draft="${a.dataset.draft}"]`
      : null;
  const caret = key ? [a.selectionStart, a.selectionEnd] : null;
  draw();
  renderLive(root);
  if (key) {
    const el = root.querySelector(key);
    el?.focus();
    el?.setSelectionRange?.(...caret);
  }
}

function draw() {
  if (!state.tab || !/^https?:/.test(state.tab.url ?? '')) {
    root.innerHTML =
      '<p class="muted pad">Open a job posting, a company’s careers page or an application form.</p>';
    return;
  }
  if (state.error) {
    root.innerHTML = `<section><p class="error">${esc(state.error)}</p><button data-action="refresh">Try again</button></section>`;
    return;
  }
  if (!state.ctx) {
    root.innerHTML = '<p class="muted pad">Reading the page…</p>';
    return;
  }
  root.innerHTML = [
    state.notice ? `<section class="${state.notice.tone}">${esc(state.notice.text)}</section>` : '',
    postingSection(),
    companySection(),
    helperSection(),
    teachSection(),
  ].join('');
}

function appLine(a) {
  return `<li>
    <span class="t" title="${esc(a.title)}">${esc(a.title)}</span>
    ${statusChip(a.status)}
    <span class="faint small" title="${esc(a.decision?.reason ?? '')}">${a.decision?.at ? day(a.decision.at) : a.appliedAt ? day(a.appliedAt) : ''}</span>
    ${a.fitScore != null ? `<span class="small">${a.fitScore.toFixed(1)}</span>` : ''}
    <button class="link small" data-action="open" data-path="/applications/${a.applicationId}">Open</button>
  </li>`;
}

/** A posting has job data, a template/LinkedIn description, your selection, or reads like a JD. */
function looksLikeJob(page) {
  return (
    page.jsonLd.some((b) => /JobPosting/.test(b)) ||
    !!page.fields?.descriptionText ||
    !!page.liFields?.descriptionText ||
    !!page.selectionText ||
    /responsibilit|qualifications|requirements|what you.ll do|about the role|about the job/i.test(
      page.pageText ?? '',
    )
  );
}

function postingSection() {
  const { ctx, page } = state;
  const t = ctx.tracked;
  if (t) {
    const f = t.fit;
    const scoring =
      state.scoring === t.applicationId || isRunning({ applicationId: t.applicationId });
    const open = t.decision == null;
    const list = (items, tone, mark) =>
      items
        .map((x) => `<li><span class="${tone}">${mark}</span><span>${esc(x)}</span></li>`)
        .join('');
    const PART = {
      skills: 'Skills',
      level: 'Level',
      logistics: 'Logistics',
      pay: 'Pay',
      upside: 'Upside',
    };
    const fitBlock = f
      ? `<div class="row">${esc(f.verdict)} ${gateChip(t)}</div>
         <div class="muted">${esc(f.whyNotHigher)}</div>
         <div class="cols">
           <div><div class="small good">Works for you</div><ul class="list">${list(f.strengths, 'good', '✓') || '<li class="faint">—</li>'}</ul></div>
           <div><div class="small bad">Watch out</div><ul class="list">${list(f.gaps, 'bad', '!') || '<li class="faint">Nothing major</li>'}</ul></div>
         </div>
         <div class="small faint">${Object.entries(f.parts)
           .map(([k, v]) => `${PART[k] ?? k} <strong class="ink">${Number(v).toFixed(1)}</strong>`)
           .join(' · ')}</div>`
      : scoring
        ? ''
        : open
          ? '<div class="faint">Not scored yet</div>'
          : '';
    const passForm = state.passing
      ? `<div class="row" style="margin-top:8px">
           <input data-edit="passReason" value="${esc(state.edits.passReason ?? '')}" placeholder="Reason (optional), e.g. 5 days onsite" style="flex:1;min-width:0" />
           <button class="danger" data-action="pass-confirm">Pass</button>
           <button class="link small" data-action="pass-cancel">Cancel</button>
         </div>`
      : '';
    return `<section>
      <h2>This posting ${statusChip(t.status)}</h2>
      ${decisionBanner(t)}
      <div class="row" style="align-items:flex-start">
        <div class="grow">
          <div class="title">${esc(t.title)}</div>
          <div class="muted">${esc(t.company)}</div>
        </div>
        ${t.fitScore != null ? `<span class="score ${t.fitGate === 'fail' ? 'fail' : ''}" title="${esc(t.fitVerdict ?? '')}">${t.fitScore.toFixed(1)}</span>` : ''}
      </div>
      <div class="stack small" style="margin-top:6px">
        ${t.appliedAt ? `<div>Applied <strong>${day(t.appliedAt)}</strong> <span class="faint">(${daysAgo(t.appliedAt)})</span></div>` : ''}
        ${fitBlock}
        <div data-live="app:${t.applicationId}" ${state.scoring === t.applicationId ? 'data-pending="Starting the fit score…"' : ''}></div>
        ${t.nextAction ? `<div>Next: ${esc(t.nextAction)}${t.nextActionDate ? ` <span class="faint">by ${day(t.nextActionDate)}</span>` : ''}</div>` : ''}
      </div>
      <div class="row" style="margin-top:8px">
        ${
          open && t.fitScore == null
            ? `<button class="primary" data-action="score-fit" data-id="${t.applicationId}" ${scoring ? 'disabled' : ''} title="Fit score only — company research stays separate">${scoring ? 'Scoring…' : `Score fit · ~${money(state.ctx.costs.fit)}`}</button>`
            : ''
        }
        ${open && t.status === 'Screening' && !state.passing ? '<button class="danger" data-action="pass">Pass</button>' : ''}
        <button class="${open && t.fitScore == null ? '' : 'primary'}" data-action="open" data-path="/applications/${t.applicationId}">Open in Job Matrix</button>
      </div>
      ${passForm}
    </section>`;
  }

  // A careers home page or company profile isn't a posting: keep the add buttons out of the way.
  if (!looksLikeJob(page) && !ctx.similar.length && !state.showAdd)
    return `<section><h2>This page</h2><p class="muted" style="margin:0 0 6px">This doesn’t look like a single job posting.</p>
      <button class="link small" data-action="show-add">Add it to Screening anyway</button></section>`;

  // Same role at another address: if you already decided on it, say so up front.
  const decided = ctx.similar.find((s) => s.decision);
  const similar = ctx.similar.length
    ? `<div class="saved" style="margin-bottom:8px">
        ${decided ? decisionBanner(decided, 'Same role elsewhere: ') : '<strong class="warn">Looks like one you’re already tracking</strong>'}
        <ul class="apps">${ctx.similar.map(appLine).join('')}</ul>
      </div>`
    : '';
  const src = page.selectionText
    ? `your selection (${page.selectionText.length.toLocaleString()} characters)`
    : page.fields?.descriptionText
      ? `the “${esc(state.template?.name)}” template`
      : page.liFields?.descriptionText
        ? 'LinkedIn’s job panel'
        : 'the page (Job Matrix reads the posting from its address first)';
  // Matches a job you already track (or passed on): no add buttons unless you say it's different.
  if (ctx.similar.length && !state.showAdd)
    return `<section>
      <h2>This posting</h2>
      ${similar}
      <div class="row">
        <button class="primary" data-action="open" data-path="/applications/${ctx.similar[0].applicationId}">Open in Job Matrix</button>
        <button class="link small" data-action="show-add">It’s a different role — add it anyway</button>
      </div>
    </section>`;

  return `<section>
    <h2>New posting</h2>
    ${similar}
    <div class="stack">
      <label class="field">Title<input data-edit="title" value="${esc(state.edits.title)}" placeholder="Job title" /></label>
      <label class="field">Company<input data-edit="company" value="${esc(state.edits.company)}" placeholder="Company" /></label>
      <div class="small faint">Description from ${src}. Highlight text on the page to use just that.</div>
      <div class="row">
        <button class="primary" data-action="add" ${state.busy ? 'disabled' : ''}>${state.busy === 'add' ? 'Adding…' : 'Add to Screening'}</button>
        <button data-action="add-score" ${state.busy ? 'disabled' : ''} title="Adds it to Screening and scores your fit here — company research stays separate">${state.busy === 'score' ? 'Adding…' : `Add &amp; score fit · ~${money(ctx.costs.fit)}`}</button>
      </div>
    </div>
  </section>`;
}

function companySection() {
  const c = state.ctx.company;
  if (!c) {
    const name = state.ctx.detected.company;
    return `<section><h2>Company</h2><p class="muted" style="margin:0">${name ? `${esc(name)} isn’t in Job Matrix yet.` : 'Company not recognised.'}</p></section>`;
  }
  const b = c.brief;
  const others = c.applications.length
    ? `<div style="margin-top:8px"><div class="small muted">Your applications here</div><ul class="apps">${c.applications.slice(0, 6).map(appLine).join('')}</ul></div>`
    : '';
  if (!b)
    return `<section><h2>${esc(c.name)}</h2><p class="muted" style="margin:0">No company brief yet.</p>
      <div class="row" style="margin-top:6px"><button data-action="research" data-id="${c.id}" ${state.researching ? 'disabled' : ''} title="Web research on the company: news, culture, stock or funding, red and green flags. Made once, then reused for all its jobs.">${state.researching || isRunning({ companyId: c.id }) ? 'Researching…' : `Research company · ~${money(state.ctx.costs.research)}`}</button></div>
      <div data-live="company:${c.id}" ${state.researching ? 'data-pending="Starting the research…"' : ''}></div>
      ${others}</section>`;
  const stock = c.stock
    ? `<div class="tile"><div class="k">${esc(c.stock.ticker)}</div><div class="v">${c.stock.price.toLocaleString(undefined, { style: 'currency', currency: c.stock.currency ?? 'USD' })}</div>${spark(c.stock.series, (c.stock.change1yPct ?? 0) >= 0)}<div class="small ${(c.stock.change1yPct ?? 0) >= 0 ? 'good' : 'bad'}">${c.stock.change1yPct == null ? '' : `${c.stock.change1yPct >= 0 ? '+' : ''}${c.stock.change1yPct.toFixed(0)}% 1 yr`}</div></div>`
    : `<div class="tile"><div class="k">${b.ownership === 'Subsidiary' ? 'Ownership' : esc(b.ownership)}</div><div class="v">${esc(b.fundingStage ?? (b.ownership === 'Subsidiary' ? 'Subsidiary' : '—'))}</div><div class="small faint">${esc(b.lastFunding ?? '')}</div></div>`;
  const trendTone = { Growing: 'good', Shrinking: 'bad', Mixed: 'warn' }[b.trend] ?? '';
  const flags = (items, tone, mark) =>
    items
      .slice(0, 3)
      .map((f) => `<li><span class="${tone}">${mark}</span><span>${esc(f)}</span></li>`)
      .join('');
  return `<section>
    <h2>${esc(c.name)} <span class="grow"></span><span class="small ${b.stale ? 'warn' : 'faint'}" style="text-transform:none;letter-spacing:0;font-weight:400">researched ${daysAgo(b.researchedAt)}</span></h2>
    <div class="tiles">
      <div class="tile"><div class="k">Momentum</div><div class="v ${trendTone}">${esc(b.trend)}</div></div>
      <div class="tile"><div class="k">Culture</div><div class="v">${b.rating ? `${b.rating.rating} <span class="small faint">${esc(b.rating.site.replace(/\s*\(.*\)/, ''))}</span>` : '—'}</div></div>
      <div class="tile"><div class="k">Office</div><div class="v">${b.officeDaysPerWeek == null ? 'Not stated' : b.officeDaysPerWeek === 0 ? 'Remote' : `${b.officeDaysPerWeek} days/wk`}</div></div>
      ${stock}
    </div>
    <div data-live="company:${c.id}"></div>
    <ul class="list">${flags(b.green, 'good', '✓')}${flags(b.red, 'bad', '!')}</ul>
    <div class="row" style="margin-top:6px"><button class="link small" data-action="open" data-path="${c.applications[0] || state.ctx.tracked ? `/applications/${(state.ctx.tracked ?? c.applications[0]).applicationId}?tab=company` : '/'}">Full brief in Job Matrix</button></div>
    ${others}
  </section>`;
}

/** The application the helper drafts for: this posting, or the one you picked from "looks like". */
function helperApp() {
  const { ctx } = state;
  return ctx.tracked ?? ctx.similar.find((s) => s.applicationId === state.useApp) ?? null;
}

function helperSection() {
  const qs = state.page?.questions ?? [];
  if (!qs.length) return '';
  const app = helperApp();
  const cost = money(state.ctx.costs.answer);
  let head;
  if (app) head = `<div class="small muted">For ${esc(app.title)} at ${esc(app.company)}</div>`;
  else if (state.ctx.similar.length)
    head = `<div class="small">Which application is this form for?
      ${state.ctx.similar.map((s) => `<button class="link" data-action="use-app" data-id="${s.applicationId}">${esc(s.title)}</button>`).join(' · ')}</div>`;
  else
    head =
      '<div class="small warn">Add this posting to Job Matrix first (above), so answers can use its description and your fit.</div>';

  const rows = qs
    .map((q) => {
      const d = state.drafts[q.id];
      const saved = (state.saved[q.id] ?? [])
        .map(
          (
            s,
          ) => `<div class="saved"><div class="faint small">Your answer for ${esc(s.company)} · ${day(s.createdAt)}</div>
            <div>${esc(s.answer)}</div>
            <div class="row" style="margin-top:4px"><button class="link small" data-action="use-saved" data-q="${q.id}" data-id="${s.id}">Use this</button></div></div>`,
        )
        .join('');
      return `<div class="q">
        <div><strong>${esc(q.label)}</strong>${q.maxLength ? ` <span class="faint small">(max ${q.maxLength} characters)</span>` : ''}${q.filled ? ' <span class="chip">filled</span>' : ''}</div>
        ${saved}
        ${
          d?.text != null
            ? `<textarea data-draft="${q.id}">${esc(d.text)}</textarea>
               ${d.basedOn ? `<div class="faint small">Draws on: ${esc(d.basedOn)}</div>` : ''}
               <div class="row" style="margin-top:4px">
                 <button class="primary" data-action="insert" data-q="${q.id}">Insert</button>
                 <button data-action="copy" data-q="${q.id}">Copy</button>
                 <button data-action="suggest" data-q="${q.id}" ${!app || d.loading ? 'disabled' : ''}>${d.loading ? 'Drafting…' : `Redo · ~${cost}`}</button>
                 <span class="faint small">${d.text.length}${q.maxLength ? `/${q.maxLength}` : ''}</span>
               </div>`
            : `<div class="row" style="margin-top:4px"><button data-action="suggest" data-q="${q.id}" ${!app || d?.loading ? 'disabled' : ''}>${d?.loading ? 'Drafting…' : `Suggest · ~${cost}`}</button></div>`
        }
        ${d?.error ? `<div class="error small">${esc(d.error)}</div>` : ''}
      </div>`;
    })
    .join('');
  return `<section><h2>Application helper</h2>${head}<div style="margin-top:8px">${rows}</div></section>`;
}

const FIELDS = [
  ['title', 'Title'],
  ['company', 'Company'],
  ['location', 'Location'],
  ['salary', 'Salary'],
  ['description', 'Description'],
];

function teachSection() {
  const host = new URL(state.tab.url).hostname;
  const t = state.teach;
  const current = state.template;
  if (!t)
    return `<section><details><summary><h2 style="margin:0">Teach this site ${current ? `<span class="chip good">${esc(current.name)}</span>` : ''}</h2></summary>
      <p class="small muted">If Job Matrix reads ${esc(host)} badly, point at where the title, company and description are. It uses your picks on every later capture from this site.</p>
      <div class="row"><button data-action="teach">${current ? 'Edit template' : 'Start'}</button>${current ? '<button class="link small" data-action="teach-delete">Remove template</button>' : ''}</div>
    </details></section>`;
  return `<section><h2>Teach ${esc(host)}</h2>
    <div class="stack">
      ${FIELDS.map(
        ([k, label]) => `<div class="row">
          <button data-action="pick" data-field="${k}" style="min-width:96px">${t.selectors[k] ? '✓ ' : ''}${label}</button>
          <span class="small faint" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(t.selectors[k] ?? '')}">${esc(t.samples[k] ?? (t.selectors[k] ? t.selectors[k] : 'Click, then click it on the page'))}</span>
        </div>`,
      ).join('')}
      <div class="row">
        <button class="primary" data-action="teach-save" ${Object.keys(t.selectors).length && state.busy !== 'save-template' ? '' : 'disabled'}>Save template</button>
        <button data-action="teach-cancel">Cancel</button>
      </div>
    </div>
  </section>`;
}

// ---------- actions ----------

async function add(score) {
  state.notice = null;
  state.busy = score ? 'score' : 'add';
  render();
  try {
    // Read again so a fresh selection counts.
    const { page, template } = await readTab(state.tab.id, state.tab.url, status);
    const r = await api('/api/screen/capture', {
      method: 'POST',
      body: captureBody(page, template, {
        title: state.edits.title.trim(),
        company: state.edits.company.trim(),
      }),
      onStatus: status,
    });
    // Add & score: stay here and show the fit in the panel. Add: go to Screening as before.
    if (r.existing) await openInApp(`/applications/${r.applicationId}`);
    else if (!score) await openInApp(`/screening?focus=${r.applicationId}`);
    state.busy = null;
    await refresh();
    if (score && !r.existing) await scoreFit(r.applicationId);
    if (r.existing) {
      state.notice = {
        tone: 'warn',
        text: `Already tracked: ${r.company} — ${r.title} (${r.status}).`,
      };
      render();
    }
  } catch (e) {
    state.busy = null;
    state.notice = { tone: 'error', text: e.message || String(e) };
    render();
  }
}

/** Fit score only (no company research); the panel shows it live and when it's done. */
async function scoreFit(applicationId) {
  state.scoring = applicationId;
  state.notice = null;
  render();
  try {
    await api(`/api/applications/${applicationId}/fit`, { method: 'POST' });
  } catch (e) {
    state.notice = { tone: 'error', text: `Scoring failed: ${e.message || e}` };
  }
  state.scoring = null;
  await refresh();
}

async function pass() {
  const t = state.ctx?.tracked;
  if (!t) return;
  const reason = (state.edits.passReason ?? '').trim();
  try {
    await api(`/api/applications/${t.applicationId}/activities`, {
      method: 'POST',
      body: {
        at: new Date().toLocaleDateString('en-CA'),
        kind: 'Note',
        summary: reason ? `Passed: ${reason}` : 'Passed at screening',
        setStatus: 'Passed',
      },
    });
    state.passing = false;
    state.edits.passReason = '';
  } catch (e) {
    state.notice = { tone: 'error', text: e.message || String(e) };
  }
  await refresh();
}

async function research(companyId) {
  state.researching = true;
  render();
  try {
    await api(`/api/companies/${companyId}/research?force=1`, { method: 'POST' });
  } catch (e) {
    state.notice = { tone: 'error', text: `Research failed: ${e.message || e}` };
  }
  state.researching = false;
  await refresh();
}

async function suggest(qid) {
  const q = state.page.questions.find((x) => x.id === qid);
  const app = helperApp();
  if (!q || !app) return;
  state.drafts[qid] = { ...(state.drafts[qid] ?? {}), loading: true, error: null };
  render();
  try {
    const r = await api('/api/ext/answer', {
      method: 'POST',
      body: { applicationId: app.applicationId, question: q.label, maxLength: q.maxLength },
    });
    state.drafts[qid] = { text: r.answer, basedOn: r.basedOn, loading: false };
  } catch (e) {
    state.drafts[qid] = {
      ...(state.drafts[qid] ?? {}),
      loading: false,
      error: e.message || String(e),
    };
  }
  render();
}

async function insert(qid) {
  const text = state.drafts[qid]?.text ?? '';
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: state.tab.id },
    func: fillField,
    args: [qid, text],
  });
  if (!result) {
    state.drafts[qid].error = 'That field is gone from the page — press ↻ and try again.';
    render();
  }
}

async function saveTemplate() {
  const host = new URL(state.tab.url).hostname;
  state.busy = 'save-template';
  render();
  try {
    await api(`/api/ext/templates/${encodeURIComponent(host)}`, {
      method: 'PUT',
      body: { name: host.replace(/^www\./, ''), selectors: state.teach.selectors },
    });
    state.busy = null;
    state.teach = null;
    await refresh();
    state.notice = {
      tone: 'good',
      text: 'Template saved — it’s used for every capture from this site.',
    };
    render();
  } catch (e) {
    state.busy = null;
    state.notice = { tone: 'error', text: e.message || String(e) };
    render();
  }
}

document.addEventListener('click', async (e) => {
  const stream = e.target.closest('[data-live-stream]');
  if (stream) {
    toggleStream(stream.dataset.run, stream.dataset.liveStream);
    renderLive(root);
    return;
  }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  if (a === 'refresh') refresh();
  else if (a === 'options') chrome.runtime.openOptionsPage();
  else if (a === 'open') openInApp(el.dataset.path);
  else if (a === 'show-add') {
    state.showAdd = true;
    render();
  } else if (a === 'add') add(false);
  else if (a === 'add-score') add(true);
  else if (a === 'score-fit') scoreFit(Number(el.dataset.id));
  else if (a === 'pass') {
    state.passing = true;
    render();
  } else if (a === 'pass-cancel') {
    state.passing = false;
    render();
  } else if (a === 'pass-confirm') pass();
  else if (a === 'research') research(Number(el.dataset.id));
  else if (a === 'use-app') {
    state.useApp = Number(el.dataset.id);
    render();
  } else if (a === 'suggest') suggest(el.dataset.q);
  else if (a === 'insert') insert(el.dataset.q);
  else if (a === 'copy')
    await navigator.clipboard.writeText(state.drafts[el.dataset.q]?.text ?? '');
  else if (a === 'use-saved') {
    const s = (state.saved[el.dataset.q] ?? []).find((x) => String(x.id) === el.dataset.id);
    if (s)
      state.drafts[el.dataset.q] = {
        text: s.answer,
        basedOn: `your ${s.company} answer`,
        loading: false,
      };
    render();
  } else if (a === 'teach') {
    state.teach = { selectors: { ...(state.template?.selectors ?? {}) }, samples: {} };
    render();
  } else if (a === 'teach-cancel') {
    state.teach = null;
    render();
  } else if (a === 'teach-delete') {
    await api(`/api/ext/templates/${encodeURIComponent(new URL(state.tab.url).hostname)}`, {
      method: 'DELETE',
    });
    state.teach = null;
    refresh();
  } else if (a === 'pick') {
    await chrome.scripting.executeScript({
      target: { tabId: state.tab.id },
      func: startPicker,
      args: [el.dataset.field],
    });
    status(`Click the ${el.dataset.field} on the page…`);
  } else if (a === 'teach-save') saveTemplate();
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.edit) state.edits[t.dataset.edit] = t.value;
  if (t.dataset.draft && state.drafts[t.dataset.draft])
    state.drafts[t.dataset.draft].text = t.value;
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'jm-picked' || !state.teach) return;
  status('');
  if (msg.selector) {
    state.teach.selectors[msg.field] = msg.selector;
    state.teach.samples[msg.field] = msg.sample || msg.selector;
  }
  render();
});

// Follow the tab you're looking at.
let timer;
const soon = () => {
  clearTimeout(timer);
  timer = setTimeout(refresh, 250);
};
chrome.tabs.onActivated.addListener(soon);
chrome.tabs.onUpdated.addListener((id, info) => {
  if (id === state.tab?.id && (info.status === 'complete' || info.url)) soon();
});
chrome.windows.onFocusChanged.addListener(soon);
// Coming back to the panel (e.g. after passing on the job in Job Matrix) reads it again.
document.addEventListener('visibilitychange', () => document.hidden || soon());
window.addEventListener('focus', soon);

connectLive({
  onChange: () => renderLive(root),
  onFinish: () => soon(),
});
refresh();
