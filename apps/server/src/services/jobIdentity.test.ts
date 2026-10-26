import { describe, expect, it } from 'vitest';
import {
  cleanCompany,
  cleanTitle,
  companyFromHost,
  companyKey,
  resolveIdentity,
  type FindCompany,
  type IdentitySources,
} from './jobIdentity.ts';

/** A finder over a few tracked companies, matched the way the real one matches. */
const tracking = (...names: string[]): FindCompany => {
  const list = names.map((name, i) => ({ id: i + 1, name }));
  return (n) => list.find((c) => companyKey(c.name) === companyKey(n));
};
const TRACKED = tracking('NVIDIA', 'Visa', 'Cisco', 'Valon', 'Apple', 'Lam Research', 'Alku');

const pick = (src: IdentitySources, find = TRACKED) => {
  const r = resolveIdentity(src, find);
  return { title: r.title, company: r.company };
};

// Each case is a job that was saved with the wrong title or company, as the sources gave it.
describe('jobs saved with the wrong title or company', () => {
  it.each<[string, IdentitySources, { title: string | null; company: string | null }]>([
    [
      'NVIDIA on Workday: legal entity "2100 NVIDIA USA"',
      {
        url: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-Technical-Program-Manager--Forward-Deployed-Engineering_JR2028220',
        fetched: {
          title: 'Senior Technical Program Manager, Forward Deployed Engineering',
          company: '2100 NVIDIA USA',
        },
        ld: {
          title: 'Senior Technical Program Manager, Forward Deployed Engineering',
          hiringOrganization: { name: '2100 NVIDIA USA' },
        },
        pageTitle: 'Senior Technical Program Manager, Forward Deployed Engineering',
      },
      {
        title: 'Senior Technical Program Manager, Forward Deployed Engineering',
        company: 'NVIDIA',
      },
    ],
    [
      'Visa on Workday: "110 Visa U.S.A. Inc."',
      {
        url: 'https://visa.wd5.myworkdayjobs.com/Visa/job/US---San-Francisco-CA/Manager--AI-Project-Management---Global-Marketing-Services_REF089341W',
        fetched: {
          title: 'Manager, AI Project Management - Global Marketing Services',
          company: '110 Visa U.S.A. Inc.',
        },
        ld: { hiringOrganization: { name: '110 Visa U.S.A. Inc.' } },
      },
      { title: 'Manager, AI Project Management - Global Marketing Services', company: 'Visa' },
    ],
    [
      'Cisco on Workday: "020 Cisco Systems, Inc." and an escaped "&amp;"',
      {
        url: 'https://cisco.wd5.myworkdayjobs.com/en-US/Cisco_Careers/job/Technical-Product-Manager--Cisco-IQ-Platform_2018299-1',
        fetched: {
          title:
            'Technical Product Manager, Cisco IQ Platform (Enterprise IT Integrations &amp; BE workflows)',
          company: '020 Cisco Systems, Inc.',
        },
      },
      {
        title:
          'Technical Product Manager, Cisco IQ Platform (Enterprise IT Integrations & BE workflows)',
        company: 'Cisco',
      },
    ],
    [
      'Apple: "… - Jobs - Careers at Apple" tab title (Claris)',
      {
        url: 'https://jobs.apple.com/en-us/details/200648818-3401/manager-engineering-program-management-claris',
        pageTitle: 'Manager, Engineering Program Management - Claris - Jobs - Careers at Apple',
      },
      { title: 'Manager, Engineering Program Management - Claris', company: 'Apple' },
    ],
    [
      'Apple: "… - Jobs - Careers at Apple" tab title (AiDP)',
      {
        url: 'https://jobs.apple.com/en-us/details/200688511-3956/manager-engineering-program-management-ai-data-platforms-aidp',
        pageTitle:
          'Manager, Engineering Program Management - Ai &amp; Data Platforms (AiDP) - Jobs - Careers at Apple',
      },
      {
        title: 'Manager, Engineering Program Management - Ai & Data Platforms (AiDP)',
        company: 'Apple',
      },
    ],
    [
      'Valon on Ashby: "Deployment Strategist @ Valon Tech"',
      {
        url: 'https://jobs.ashbyhq.com/Valon/de0903c4-f947-47d5-8888-175f5a4fa541',
        fetched: { title: 'Deployment Strategist @ Valon Tech', company: null },
      },
      { title: 'Deployment Strategist', company: 'Valon' },
    ],
    [
      'Valon on Ashby: "Deployment Strategy Lead (People Manager) @ Valon Tech"',
      {
        url: 'https://jobs.ashbyhq.com/Valon/75e5d519-9784-475a-bb48-0406ee21a597',
        fetched: { title: 'Deployment Strategy Lead (People Manager) @ Valon Tech', company: null },
      },
      { title: 'Deployment Strategy Lead (People Manager)', company: 'Valon' },
    ],
    [
      'Lam Research: a template pick of the "Careers" heading',
      {
        url: 'https://careers.lamresearch.com/careers?pid=1099555391279&domain=lamresearch.com',
        template: { title: 'Careers' },
        fetched: { title: 'Technical Program Manager - AI/ML, GOPs AI', company: 'Lam Research' },
        pageTitle: 'Careers',
      },
      { title: 'Technical Program Manager - AI/ML, GOPs AI', company: 'Lam Research' },
    ],
    [
      'IREN on HiBob: the tab says only "Careers", the platform is not the employer',
      {
        url: 'https://iren.careers.hibob.com/jobs/2c9a5b71-4252-4b0d-9abf-d87f04dbd76c',
        pageTitle: 'Careers',
      },
      { title: null, company: 'Iren' },
    ],
    [
      'X (x.company): a one-letter company from its address',
      {
        url: 'https://x.company/careers/8843386002/?gh_jid=b1ef07022',
        pageTitle: 'Senior Forward Deployed Engineer, Early Stage Supply Chain Project',
      },
      { title: 'Senior Forward Deployed Engineer, Early Stage Supply Chain Project', company: 'X' },
    ],
    [
      'Stanford: the tab title is the site name; the page data has the role',
      {
        url: 'https://careersearch.stanford.edu/hcmUI/CandidateExperience/en/sites/Stanford/job/201270',
        fetched: {
          title: null,
          company: null,
          pageTitle: 'Senior Program Manager, Health AI Programs (Hybrid Opportunity)',
        },
        pageTitle: 'Stanford',
      },
      {
        title: 'Senior Program Manager, Health AI Programs (Hybrid Opportunity)',
        company: 'Stanford',
      },
    ],
    [
      'FlowGen Labs on LinkedIn: the template picked the pay instead of the title',
      {
        url: 'https://www.linkedin.com/jobs/view/4480860960/',
        template: { title: '$200K/yr - $375K/yr', company: 'FlowGen Labs' },
        fetched: { title: 'AI Strategist', company: 'FlowGen Labs' },
      },
      { title: 'AI Strategist', company: 'FlowGen Labs' },
    ],
    [
      'JPMC on Oracle Recruiting: the site is "JPMC Candidate Experience page"',
      {
        url: 'https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210777991',
        fetched: {
          title: 'Technical Project Manager III - Applied AI',
          company: 'JPMC Candidate Experience page',
          pageTitle: 'Technical Project Manager III - Applied AI',
        },
        pageTitle: 'JPMC Candidate Experience page',
      },
      { title: 'Technical Project Manager III - Applied AI', company: 'JPMC' },
    ],
    [
      'JPMC on Oracle Recruiting, opened from search results',
      {
        url: 'https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/jobs/preview/210795797/',
        ld: {
          title: 'Lead Technical Program Manager',
          hiringOrganization: { name: 'JPMC Candidate Experience page' },
        },
        pageTitle: 'JPMC Candidate Experience page',
      },
      { title: 'Lead Technical Program Manager', company: 'JPMC' },
    ],
  ])('%s', (_, src, want) => expect(pick(src)).toEqual(want));

  it('names the company sensibly before you track it, too', () => {
    const none: FindCompany = () => undefined;
    const workday = (tenant: string, entity: string) =>
      pick(
        {
          url: `https://${tenant}.wd5.myworkdayjobs.com/x/job/y`,
          fetched: { title: 'TPM', company: entity },
        },
        none,
      );
    expect(workday('nvidia', '2100 NVIDIA USA').company).toBe('NVIDIA');
    expect(workday('visa', '110 Visa U.S.A. Inc.').company).toBe('Visa');
    expect(workday('cisco', '020 Cisco Systems, Inc.').company).toBe('Cisco Systems');
  });
});

describe('a job board that names itself, not the employer (ZipRecruiter)', () => {
  const zip = {
    url: 'https://www.ziprecruiter.com/jobs/v2/eyJsaXN0aW5nX2tleSI6Ik42bTlzcmxIRVY0S1I3UDF4SVJVOVEifQ==',
    pageTitle:
      'Product Owner, Expert job in Oakland, California, United States at ZipRecruiter | Ziprecruiter',
  };

  it('reads the role from the tab title, and never calls ZipRecruiter the employer', () => {
    expect(pick(zip)).toEqual({ title: 'Product Owner, Expert', company: null });
  });

  it('takes the employer from the posting’s header', () => {
    const heading = { title: 'Product Owner, Expert', company: 'PG&E Corporation' };
    expect(pick({ ...zip, heading }, () => undefined)).toEqual({
      title: 'Product Owner, Expert',
      company: 'PG&E Corporation',
    });
    // …and files it under the PG&E you already track.
    expect(pick({ ...zip, heading }, tracking('PG&E')).company).toBe('PG&E');
  });

  it('but a page or search card naming the board means it: LinkedIn hires on LinkedIn', () => {
    expect(
      pick({
        url: 'https://www.linkedin.com/jobs/view/1/',
        template: { title: 'Staff TPM', company: 'LinkedIn' },
      }),
    ).toEqual({ title: 'Staff TPM', company: 'LinkedIn' });
    expect(
      pick({ ...zip, heading: { title: 'Product Owner', company: 'ZipRecruiter' } }).company,
    ).toBe('ZipRecruiter');
  });
});

describe('what the checks leave alone', () => {
  it('keeps company names that start with a number or end in a country', () => {
    expect(cleanCompany('3M')).toBe('3M');
    expect(cleanCompany('84 Lumber')).toBe('84 Lumber');
    expect(cleanCompany('Bank of America')).toBe('Bank of America');
    expect(cleanCompany('123 Bank of America Corporation')).toBe('Bank of America');
    expect(cleanCompany('About Us')).toBeNull();
    expect(cleanCompany('$185K/yr')).toBeNull();
  });

  it('keeps a team named after the company in the title', () => {
    expect(cleanTitle('Senior TPM - Visa Direct', 'Visa')).toBe('Senior TPM - Visa Direct');
    expect(cleanTitle('Senior TPM - Visa', 'Visa')).toBe('Senior TPM');
    expect(cleanTitle('Staff TPM, Careers Platform')).toBe('Staff TPM, Careers Platform');
  });

  it('a company the page names beats a tracked one the address only suggests', () => {
    // A staffing firm's site posting for its client.
    expect(
      pick({
        url: 'https://jobs.alku.com/j/1',
        template: { title: 'TPM', company: 'Acme Robotics' },
      }),
    ).toEqual({ title: 'TPM', company: 'Acme Robotics' });
  });

  it('a tracked company is matched by an alias and keeps its own spelling', () => {
    const find: FindCompany = (n) =>
      companyKey(n) === 'spacexai' || companyKey(n) === 'cursor'
        ? { id: 9, name: 'Cursor' }
        : undefined;
    expect(
      resolveIdentity(
        { url: 'https://example.com/j', ld: { title: 'TPM', hiringOrganization: 'SpaceXAI' } },
        find,
      ),
    ).toMatchObject({ company: 'Cursor', known: { id: 9 }, stated: true });
  });

  it('reads a tenant from HiBob and a one-letter company from its own domain', () => {
    expect(companyFromHost('https://iren.careers.hibob.com/jobs/1')).toBe('Iren');
    expect(companyFromHost('https://x.company/careers/1')).toBe('X');
  });
});
