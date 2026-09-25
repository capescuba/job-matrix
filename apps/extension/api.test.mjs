import { describe, expect, it } from 'vitest';
import { DEFAULT_SERVER, normalizeServer } from './api.js';

describe('server address on the Options page', () => {
  it.each([
    ['', DEFAULT_SERVER],
    ['http://127.0.0.1:5185', 'http://127.0.0.1:5185'],
    ['http://127.0.0.1:5185/', 'http://127.0.0.1:5185'],
    ['127.0.0.1:5174', 'http://127.0.0.1:5174'],
    ['localhost:5174', 'http://localhost:5174'],
  ])('accepts %j', (input, expected) => expect(normalizeServer(input)).toBe(expected));

  it.each([
    'http://http://127.0.0.1:5174/',
    'ftp://127.0.0.1',
    'http://127.0.0.1:5174/api',
    'not a url at all',
  ])('rejects %j', (input) => expect(normalizeServer(input)).toBeNull());
});
