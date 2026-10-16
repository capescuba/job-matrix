import { describe, expect, it } from 'vitest';
import { closePartialJson } from './index.ts';

describe('closePartialJson', () => {
  it('returns null when there is no object yet', () => {
    expect(closePartialJson('')).toBeNull();
    expect(closePartialJson('thinking…')).toBeNull();
  });

  it('closes an unfinished string', () => {
    expect(closePartialJson('{"question":"Tell me about')).toEqual({ question: 'Tell me about' });
  });

  it('drops a key that has no value yet', () => {
    expect(closePartialJson('{"question":"Why us?","probing":')).toEqual({ question: 'Why us?' });
    expect(closePartialJson('{"question":"Why us?","pro')).toEqual({ question: 'Why us?' });
  });

  it('closes arrays and nested objects', () => {
    expect(closePartialJson('{"points":["one","tw')).toEqual({ points: ['one', 'tw'] });
    expect(closePartialJson('{"a":{"b":[1,2,')).toEqual({ a: { b: [1, 2] } });
  });

  it('handles escapes inside strings', () => {
    const bs = String.fromCharCode(92);
    const q = String.fromCharCode(34);
    const input = `{${q}q${q}:${q}say ${bs}${q}hi${bs}${q} and ${bs}`;
    expect(closePartialJson(input)).toEqual({ q: 'say "hi" and ' });
  });

  it('parses a complete object unchanged', () => {
    expect(closePartialJson('{"a":1,"b":[true,null]}')).toEqual({ a: 1, b: [true, null] });
  });
});
