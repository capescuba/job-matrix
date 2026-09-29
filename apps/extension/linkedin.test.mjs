import { describe, expect, it } from 'vitest';
import { DETAIL_PAGES, profileBase } from './linkedin.js';

describe('LinkedIn profile import', () => {
  it.each([
    ['https://www.linkedin.com/in/dave-b/', 'https://www.linkedin.com/in/dave-b/'],
    ['linkedin.com/in/dave-b', 'https://www.linkedin.com/in/dave-b/'],
    ['https://uk.linkedin.com/in/dave-b/details/experience/?x=1', 'https://www.linkedin.com/in/dave-b/'],
  ])('reads %s as your profile', (input, expected) => expect(profileBase(input)).toBe(expected));

  it.each(['https://www.linkedin.com/jobs/view/1', 'https://example.com/in/dave', 'not a url'])(
    'refuses %s',
    (input) => expect(profileBase(input)).toBeNull(),
  );

  it('reads every details page LinkedIn has for a profile', () => {
    expect(DETAIL_PAGES.map(([k]) => k)).toEqual([
      'experience',
      'projects',
      'skills',
      'certifications',
      'education',
      'honors',
      'recommendations',
    ]);
  });
});
