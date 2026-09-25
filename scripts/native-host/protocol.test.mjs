import { describe, expect, it } from 'vitest';
import { decode, encode } from './protocol.mjs';

describe('native messaging framing', () => {
  it('round-trips messages, including split and back-to-back ones', () => {
    const a = encode({ type: 'start' });
    const b = encode({ ok: true, token: 'é'.repeat(3) });
    expect(a.readUInt32LE(0)).toBe(Buffer.byteLength('{"type":"start"}'));
    const both = Buffer.concat([a, b]);
    const first = decode(both.subarray(0, a.length + 5));
    expect(first.messages).toEqual([{ type: 'start' }]);
    const second = decode(Buffer.concat([first.rest, both.subarray(a.length + 5)]));
    expect(second.messages).toEqual([{ ok: true, token: 'ééé' }]);
    expect(second.rest.length).toBe(0);
  });
});
