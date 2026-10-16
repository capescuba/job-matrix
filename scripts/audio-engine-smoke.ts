/**
 * Manual check of the real audio engine on this PC: starts it, lists devices, captures for N
 * seconds into a temp folder, prints every transcript event, stops, and reports the WAV sizes.
 * Play something on the PC and talk into the mic while it runs.
 *
 *   npx tsx scripts/audio-engine-smoke.ts 20
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalAudioEngine } from '../packages/audio-engine/src/index.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const seconds = Number(process.argv[2] ?? 20);
const engine = new LocalAudioEngine({
  pythonExe: path.join(root, 'apps', 'audio-engine', '.venv', 'Scripts', 'python.exe'),
  enginePy: path.join(root, 'apps', 'audio-engine', 'engine.py'),
  port: Number(process.env.ENGINE_PORT ?? 5176),
  onLog: (line, stream) => stream === 'err' && console.error('  engine:', line.slice(0, 300)),
});
engine.onStatus((s) => console.log('status:', s.phase, s.device ?? '', s.detail ?? ''));

const t0 = Date.now();
await engine.ensureReady();
console.log(`ready after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
const devices = await engine.listDevices();
console.log('mics:', devices.inputs.map((d) => `${d.name}${d.isDefault ? ' *' : ''}`).join(' | '));
console.log(
  'outputs:',
  devices.outputs.map((d) => `${d.name}${d.isDefault ? ' *' : ''}`).join(' | '),
);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-smoke-'));
let levels = { me: 0, them: 0 };
const started = await engine.start({
  dir,
  mic: null,
  output: null,
  record: true,
  prompt: 'Job Matrix',
  onEvent: (e) => {
    if (e.type === 'level') levels[e.track] = Math.max(levels[e.track], e.rms);
    else if (e.type === 'final')
      console.log(`FINAL   ${e.track.padEnd(4)} [${e.startMs}-${e.endMs}] ${e.text}`);
    else if (e.type === 'partial') console.log(`partial ${e.track.padEnd(4)} ${e.text}`);
    else if (e.type === 'speech')
      console.log(`speech  ${e.track.padEnd(4)} ${e.active ? 'on' : 'off'} @${e.ms}`);
    else console.log('event', JSON.stringify(e));
  },
});
console.log('capturing', JSON.stringify(started), `for ${seconds} s into ${dir}`);
await new Promise((r) => setTimeout(r, seconds * 1000));
const stopped = await engine.stop();
console.log('stopped', JSON.stringify(stopped));
console.log('peak levels', JSON.stringify(levels));
for (const f of fs.readdirSync(dir))
  console.log(`  ${f}: ${(fs.statSync(path.join(dir, f)).size / 1024).toFixed(0)} KB`);
await engine.shutdown();
process.exit(0);
