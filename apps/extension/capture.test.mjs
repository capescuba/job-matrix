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

describe('what the panel sends for a Tesla job opened from search', () => {
  // The tab title is still the page you came from.
  const page = {
    url: 'https://www.tesla.com/careers/search/job/sr-technical-program-manager-charging-software-firmware-284122',
    pageTitle: 'Technical Program Manager, Optimus Academy',
    jsonLd: [],
    pageText: 'Tesla homepage\nCareers\nSkip to main content…',
    siteFields: {
      site: 'Tesla',
      url: null,
      title: 'Sr. Technical Program Manager, Charging Software & Firmware',
      company: 'Tesla',
      location: 'Palo Alto, California',
      salaryText: '$144,800 - $217,200/annual salary + cash and stock awards + benefits',
      descriptionText: 'What to Expect\nTesla’s Energy Engineering Program Management team…',
    },
  };

  it('names the job from its header, keeps the tab’s address, and says which reader', () => {
    const body = captureBody(page, null);
    expect(body.url).toBe(page.url);
    expect(body.fields).toMatchObject({
      title: 'Sr. Technical Program Manager, Charging Software & Firmware',
      company: 'Tesla',
      location: 'Palo Alto, California',
    });
    expect(body.templateName).toBe('Built-in Tesla');
  });
});
