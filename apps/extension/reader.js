// Functions injected into the job page with chrome.scripting.executeScript({ func, args }).
// Each must be self-contained: Chrome copies only the function's own source into the page.

/**
 * Reads the page: address, title, schema.org data, your selection, readable text, fields from a
 * saved site template, LinkedIn details, and application-form questions.
 * @param {Record<string,string>|null} selectors  the site template, if this site has one
 */
export function readPage(selectors) {
  const text = (el) =>
    el ? (el.innerText || el.textContent || '').replace(/\s+\n/g, '\n').trim() : '';
  const pick = (sel) => {
    if (!sel) return null;
    try {
      return text(document.querySelector(sel)) || null;
    } catch {
      return null;
    }
  };

  // Short fields: the first line of what the template points at, so picking a big block (e.g.
  // a whole section for "Company") still gives one line rather than the section.
  const short = (sel, max = 200) => {
    const line = (pick(sel) ?? '')
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .find(Boolean);
    return line ? line.slice(0, max) : null;
  };
  // Site template fields.
  const fields = selectors
    ? {
        title: short(selectors.title),
        company: short(selectors.company),
        location: short(selectors.location),
        salaryText: pick(selectors.salary)?.slice(0, 2000) ?? null,
        descriptionText: pick(selectors.description),
      }
    : null;

  // LinkedIn (signed in): the job panel's own fields — the page text is mostly other jobs.
  let linkedin = null;
  let liFields = null;
  if (/(^|\.)linkedin\.com$/.test(location.hostname)) {
    const first = (...sels) => {
      for (const s of sels) {
        const t = pick(s);
        if (t) return t;
      }
      return null;
    };
    liFields = {
      title: first(
        '.job-details-jobs-unified-top-card__job-title h1',
        '.job-details-jobs-unified-top-card__job-title',
        '.jobs-unified-top-card__job-title',
        '.top-card-layout__title',
      ),
      company: first(
        '.job-details-jobs-unified-top-card__company-name a',
        '.job-details-jobs-unified-top-card__company-name',
        '.jobs-unified-top-card__company-name',
        '.topcard__org-name-link',
      ),
      location: null,
      descriptionText: first('#job-details', '.jobs-description__content', '.description__text'),
    };
    const top = first(
      '.job-details-jobs-unified-top-card__primary-description-container',
      '.job-details-jobs-unified-top-card__tertiary-description-container',
      '.jobs-unified-top-card__primary-description',
    );
    if (top) {
      const parts = top.split(/\s*·\s*/).map((s) => s.trim());
      liFields.location = parts[0] || null;
      linkedin = {
        applicantsText: parts.find((p) => /applicant/i.test(p)) || null,
        insights: [
          ...document.querySelectorAll(
            '.job-details-jobs-unified-top-card__job-insight, .job-details-fit-level-preferences button',
          ),
        ]
          .map((e) => text(e))
          .filter(Boolean)
          .slice(0, 10),
        hiringTeam: [...document.querySelectorAll('.hirer-card__hirer-information')]
          .map((e) => ({
            name: text(e.querySelector('strong, .jobs-poster__name')) || '',
            title:
              text(
                e.querySelector('.hirer-card__hirer-job-title, .linked-area .text-body-small'),
              ) || null,
            profileUrl: e.querySelector('a[href*="/in/"]')?.href || null,
          }))
          .filter((p) => p.name)
          .slice(0, 5),
      };
    }
  }

  // Application-form questions: text areas, and long text inputs that ask something.
  const SKIP =
    /\b(name|e-?mail|phone|mobile|address|city|state|zip|postal|country|linkedin|github|website|portfolio|url|salary|compensation|pronoun|gender|race|ethnic|veteran|disability|date|school|degree|gpa|hispanic|latino|ethnicity|sponsorship|authori[sz]ed)\b/i;
  const ASK =
    /\?|why|describe|tell us|explain|what (excites|interests|draws)|cover letter|additional information|anything else/i;
  const labelOf = (el) => {
    const byFor = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    const labelled = el.getAttribute('aria-labelledby');
    const candidates = [
      byFor && text(byFor),
      labelled &&
        labelled
          .split(/\s+/)
          .map((id) => text(document.getElementById(id)))
          .join(' '),
      el.getAttribute('aria-label'),
      text(el.closest('label')),
      text(el.closest('fieldset')?.querySelector('legend')),
      text(
        el
          .closest(
            '.field, .application-question, .form-group, [class*="question"], [class*="Question"]',
          )
          ?.querySelector('label, legend, [class*="label"], [class*="Label"]'),
      ),
      el.placeholder,
    ];
    return (candidates.find((c) => c && c.trim()) || '')
      .replace(/\s+/g, ' ')
      .replace(/\*$/, '')
      .trim();
  };
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const questions = [];
  let n = 0;
  for (const el of document.querySelectorAll(
    'textarea, input[type="text"], input:not([type]), [contenteditable="true"][role="textbox"]',
  )) {
    if (!visible(el) || el.disabled || el.readOnly) continue;
    // Dropdowns built from text inputs (yes/no, visa, EEO questions) aren't written answers.
    if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete')) continue;
    // A site's chat assistant or search box ("Chat message input") isn't an application question.
    if (el.closest('[role="dialog"][aria-label*="chat" i], [class*="chat" i], [id*="chat" i]'))
      continue;
    const label = labelOf(el);
    if (!label || label.length < 8 || SKIP.test(label) || /\b(chat|search)\b/i.test(label))
      continue;
    const isArea = el.tagName === 'TEXTAREA' || el.isContentEditable;
    const max = Number(el.getAttribute('maxlength')) || null;
    if (!isArea && !(ASK.test(label) && (!max || max >= 150))) continue;
    const id = String(++n);
    el.setAttribute('data-jm-q', id);
    questions.push({
      id,
      label: label.slice(0, 500),
      maxLength: max,
      filled: !!(el.value || el.textContent || '').trim(),
    });
    if (questions.length >= 15) break;
  }

  const ld = [...document.querySelectorAll('script[type="application/ld+json"]')]
    .map((s) => s.textContent || '')
    .filter(Boolean)
    .slice(0, 20);
  // The page's main content, skipping widgets that call themselves "main": Amazon's hiring
  // assistant chat is an empty role="main" box, which read as a page with no job on it.
  const main =
    [...document.querySelectorAll('main, [role="main"], article')].find(
      (e) =>
        text(e).length >= 200 &&
        !e.closest('[id*="chat" i], [class*="chat" i], [role="dialog"], [aria-modal="true"]'),
    ) || document.body;
  return {
    url: location.href,
    pageTitle: document.title,
    jsonLd: ld,
    selectionText: String(getSelection() || '').trim(),
    pageText: text(main).slice(0, 150_000),
    fields,
    liFields,
    linkedin,
    questions,
  };
}

/** Puts `value` into the question field the reader tagged, so the site's own code notices. */
export function fillField(id, value) {
  const el = document.querySelector(`[data-jm-q="${id}"]`);
  if (!el) return false;
  el.focus();
  if (el.isContentEditable) {
    el.textContent = value;
  } else {
    const proto =
      el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); // works with React-managed inputs
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  return true;
}

/**
 * "Teach this site": highlight elements under the pointer; a click picks one and reports a CSS
 * selector for it (plus a sample of its text) back to the side panel. Esc cancels.
 */
export function startPicker(field) {
  window.__jmPicker?.stop();
  const box = document.createElement('div');
  box.style.cssText =
    'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #2a78d6;background:rgba(42,120,214,.12);border-radius:3px;transition:all .05s';
  const tip = document.createElement('div');
  tip.textContent = `Job Matrix: click the ${field} · Esc to cancel`;
  tip.style.cssText =
    'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#2a78d6;color:#fff;font:600 13px system-ui;padding:6px 12px;border-radius:6px;pointer-events:none';
  document.documentElement.append(box, tip);
  let current = null;

  const stable = (c) =>
    c && !/\d{3,}|^css-|^sc-|__[a-z0-9]{5,}$|^[a-z]{1,3}-[a-z0-9]{5,}$/i.test(c);
  const selectorFor = (el) => {
    if (
      el.id &&
      !/\d{3,}/.test(el.id) &&
      document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1
    )
      return `#${CSS.escape(el.id)}`;
    const parts = [];
    for (let e = el; e && e !== document.body && parts.length < 6; e = e.parentElement) {
      let part = e.tagName.toLowerCase();
      if (e.id && !/\d{3,}/.test(e.id)) {
        parts.unshift(`#${CSS.escape(e.id)}`);
        break;
      }
      const classes = [...e.classList].filter(stable).slice(0, 2);
      if (classes.length) part += classes.map((c) => `.${CSS.escape(c)}`).join('');
      const sibs = e.parentElement
        ? [...e.parentElement.children].filter((s) => s.tagName === e.tagName)
        : [];
      if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(e) + 1})`;
      parts.unshift(part);
      const sel = parts.join(' > ');
      try {
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch {
        // keep going
      }
    }
    return parts.join(' > ');
  };

  const move = (e) => {
    current = e.target;
    const r = current.getBoundingClientRect();
    Object.assign(box.style, {
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
  };
  const click = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const el = current || e.target;
    stop();
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      chrome.runtime.sendMessage({ type: 'jm-picked', field, selector: null, frame: true });
      return;
    }
    chrome.runtime.sendMessage({
      type: 'jm-picked',
      field,
      selector: selectorFor(el),
      sample: (el.innerText || el.textContent || '').trim().slice(0, 200),
      // How big the pick is: a one-line field that's long or multi-line is probably too big.
      chars: (el.innerText || el.textContent || '').trim().length,
      lines: (el.innerText || '')
        .trim()
        .split('\n')
        .filter((l) => l.trim()).length,
    });
  };
  const key = (e) => {
    if (e.key === 'Escape') {
      stop();
      chrome.runtime.sendMessage({ type: 'jm-picked', field, selector: null });
    }
  };
  function stop() {
    document.removeEventListener('mousemove', move, true);
    document.removeEventListener('click', click, true);
    document.removeEventListener('keydown', key, true);
    box.remove();
    tip.remove();
    window.__jmPicker = null;
  }
  document.addEventListener('mousemove', move, true);
  document.addEventListener('click', click, true);
  document.addEventListener('keydown', key, true);
  window.__jmPicker = { stop };
}
