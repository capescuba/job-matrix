import { describe, expect, it } from 'vitest';
import { captureBody, contextBody } from './capture.js';

describe('what the panel sends for a Glassdoor list page', () => {
  const page = {
    url: 'https://www.glassdoor.com/job-listing/index.htm?jl=1010212172303',
    pageTitle: 'Recommended Jobs For You | Glassdoor Job Search',
    jsonLd: [],
    pageText: 'Jobs based on your activity…',
    siteFields: {
      site: 'Glassdoor',
      url: 'https://www.glassdoor.com/job-listing/index.htm?jl=1010212172303',
      title: 'Senior Technical Program Manager, ERP',
      company: 'GFiber',
      location: 'Sunnyvale, CA',
      salaryText: '$192K - $233K (Employer provided)',
      descriptionText: 'At gFiber, we believe that great internet has the power…',
    },
  };

  it('names the job from the pane, not the tab title', () => {
    expect(contextBody(page).fields).toEqual({
      title: 'Senior Technical Program Manager, ERP',
      company: 'GFiber',
    });
  });

  it('captures the pane’s fields, labelled as the Glassdoor reader', () => {
    const body = captureBody(page, null);
    expect(body.fields).toEqual({
      title: 'Senior Technical Program Manager, ERP',
      company: 'GFiber',
      location: 'Sunnyvale, CA',
      salaryText: '$192K - $233K (Employer provided)',
      descriptionText: 'At gFiber, we believe that great internet has the power…',
    });
    expect(body.templateName).toBe('Built-in Glassdoor');
  });

  it('a template you taught the site still wins', () => {
    const body = captureBody({ ...page, fields: { title: 'TPM, ERP' } }, { name: 'My Glassdoor' });
    expect(body.fields.title).toBe('TPM, ERP');
    expect(body.templateName).toBe('My Glassdoor');
  });
});
