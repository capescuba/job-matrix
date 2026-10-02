// Whether the page in the tab is one job posting, for the side panel's "add" buttons.
//
// Saying "not a posting" about a real one blocks you; showing the add buttons on some other page
// costs nothing. So a page counts as a posting unless it plainly isn't one: a site's home page, a
// careers index, or a page of job links with nothing to apply to.

/** Wording job ads use for their sections ("What you'll work on here", "Ideal profile", …). */
const JOB_WORDS =
  /responsibilit|qualifications|requirements|what you.ll (do|work on|bring)|you will|about the (role|job|position)|the role|your role|who you are|about you|ideal (candidate|profile)|what we.re looking for|bring to the table|nice to have|experience (with|in)/i;

/** An address for one job: /careers/founding-fde, /jobs/12345, /job/…, /positions/…, /openings/…. */
const JOB_PATH =
  /\/(careers?|jobs?|positions?|openings?|roles?|vacanc(y|ies)|opportunit(y|ies))\/[^/?#]+/i;

/** The front of a careers site rather than one job: /, /careers, /jobs, /en/jobs/, /search. */
const INDEX_PATH =
  /^\/([a-z]{2}(-[a-z]{2})?\/)?(careers?|jobs?|openings|positions|search|job-search)?\/?$/i;

/**
 * `page` is what readPage() returned: url, jsonLd, pageText, fields, liFields, selectionText and
 * signals ({ apply: an "Apply" button or link, jobLinks: distinct links to job postings }).
 */
export function looksLikeJob(page) {
  const url = page.url ?? '';
  // What the page or you say outright.
  if (
    // A careers page embedding an Ashby/Greenhouse job (Job Matrix reads it from the board).
    /[?&](ashby_jid|gh_jid)=/.test(url) ||
    (page.jsonLd ?? []).some((b) => /JobPosting/.test(b)) ||
    page.fields?.descriptionText ||
    page.liFields?.descriptionText ||
    page.selectionText
  )
    return true;
  let path = '/';
  try {
    path = new URL(url).pathname;
  } catch {
    // not a web address: judged on the rest
  }
  const apply = Boolean(page.signals?.apply);
  // A list of jobs, or the front of a site.
  if (INDEX_PATH.test(path)) return false;
  if ((page.signals?.jobLinks ?? 0) >= 8 && !apply) return false;
  return apply || JOB_PATH.test(path) || JOB_WORDS.test(page.pageText ?? '');
}
