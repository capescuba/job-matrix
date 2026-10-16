import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** A 16 kHz mono 16-bit WAV: 32 bytes per ms after the 44-byte header. */
export function wavDurationMs(file: string): number {
  try {
    return Math.max(0, Math.floor((fs.statSync(file).size - 44) / 32));
  } catch {
    return 0;
  }
}

export interface MergeResult {
  /** File name inside the session folder. */
  file: string;
  durationMs: number;
  /** False when ffmpeg was missing or failed and a raw WAV is being kept instead. */
  stereo: boolean;
}

/**
 * Merges me.wav and them.wav into call.ogg: Opus, stereo, you on the left and them on the right,
 * about 25 MB an hour. The WAVs are deleted once that works. Without ffmpeg they stay (and the
 * call plays back from one of them, mono), so a missing tool never loses a recording.
 */
export async function mergeRecording(
  dir: string,
  opts: { ffmpeg?: string; run?: typeof runFfmpeg } = {},
): Promise<MergeResult | null> {
  const me = path.join(dir, 'me.wav');
  const them = path.join(dir, 'them.wav');
  const have = [me, them].filter((f) => fs.existsSync(f) && fs.statSync(f).size > 44);
  if (!have.length) return null;
  const durationMs = Math.max(...have.map(wavDurationMs));
  const out = path.join(dir, 'call.ogg');
  const hasMe = have.includes(me);
  const hasThem = have.includes(them);

  const args = ['-y', '-v', 'error', ...have.flatMap((f) => ['-i', f])];
  if (hasMe && hasThem) args.push('-filter_complex', '[0:a][1:a]amerge=inputs=2,pan=stereo|c0=c0|c1=c1[m]', '-map', '[m]');
  else if (hasMe) args.push('-filter_complex', '[0:a]pan=stereo|c0=c0|c1=0*c0[m]', '-map', '[m]');
  else args.push('-filter_complex', '[0:a]pan=stereo|c0=0*c0|c1=c0[m]', '-map', '[m]');
  args.push('-c:a', 'libopus', '-b:a', '48k', out);

  const ok = await (opts.run ?? runFfmpeg)(opts.ffmpeg ?? process.env.FFMPEG_PATH ?? 'ffmpeg', args);
  if (ok && fs.existsSync(out) && fs.statSync(out).size > 0) {
    for (const f of have) fs.rmSync(f, { force: true });
    return { file: 'call.ogg', durationMs, stereo: true };
  }
  fs.rmSync(out, { force: true });
  return { file: path.basename(hasThem ? them : me), durationMs, stereo: false };
}

export function runFfmpeg(exe: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}
