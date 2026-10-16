import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { mergeRecording, wavDurationMs } from './recording.ts';

/** A WAV-sized file: 44-byte header plus `seconds` of 16 kHz mono 16-bit audio. */
function fakeWav(file: string, seconds: number) {
  fs.writeFileSync(file, Buffer.alloc(44 + seconds * 32_000));
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-rec-'));
});

describe('mergeRecording', () => {
  it('measures a WAV by its size', () => {
    fakeWav(path.join(dir, 'a.wav'), 90);
    expect(wavDurationMs(path.join(dir, 'a.wav'))).toBe(90_000);
    expect(wavDurationMs(path.join(dir, 'missing.wav'))).toBe(0);
  });

  it('puts you on the left and them on the right, then removes the WAVs', async () => {
    fakeWav(path.join(dir, 'me.wav'), 60);
    fakeWav(path.join(dir, 'them.wav'), 61);
    let args: string[] = [];
    const res = await mergeRecording(dir, {
      run: async (_exe, a) => {
        args = a;
        fs.writeFileSync(path.join(dir, 'call.ogg'), 'ogg');
        return true;
      },
    });
    expect(res).toEqual({ file: 'call.ogg', durationMs: 61_000, stereo: true });
    expect(args.join(' ')).toContain('amerge=inputs=2');
    expect(args.slice(args.indexOf('-i'), args.indexOf('-i') + 4)).toEqual([
      '-i',
      path.join(dir, 'me.wav'),
      '-i',
      path.join(dir, 'them.wav'),
    ]);
    expect(fs.readdirSync(dir)).toEqual(['call.ogg']);
  });

  it('keeps the WAVs when ffmpeg is missing, so nothing is lost', async () => {
    fakeWav(path.join(dir, 'me.wav'), 10);
    fakeWav(path.join(dir, 'them.wav'), 10);
    const res = await mergeRecording(dir, { run: async () => false });
    expect(res).toEqual({ file: 'them.wav', durationMs: 10_000, stereo: false });
    expect(fs.readdirSync(dir).sort()).toEqual(['me.wav', 'them.wav']);
  });

  it('handles a call where only one side could be captured', async () => {
    fakeWav(path.join(dir, 'me.wav'), 5);
    let args: string[] = [];
    await mergeRecording(dir, {
      run: async (_e, a) => {
        args = a;
        fs.writeFileSync(path.join(dir, 'call.ogg'), 'ogg');
        return true;
      },
    });
    expect(args.join(' ')).toContain('c0=c0|c1=0*c0');
  });

  it('returns null when nothing was recorded', async () => {
    expect(await mergeRecording(dir, { run: async () => true })).toBeNull();
    fakeWav(path.join(dir, 'me.wav'), 0);
    expect(await mergeRecording(dir, { run: async () => true })).toBeNull();
  });
});
