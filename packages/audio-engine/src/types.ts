export type EnginePhase = 'stopped' | 'starting' | 'downloading' | 'loading' | 'ready' | 'error';

export interface EngineStatus {
  phase: EnginePhase;
  detail?: string;
  /** cuda or cpu, once the model is loaded. */
  device?: string;
}

export interface AudioDevice {
  index: number;
  name: string;
  isDefault: boolean;
}

export type Track = 'me' | 'them';

/** What the engine reports while a call is being captured. Times are ms on the session clock. */
export type EngineEvent =
  | { type: 'speech'; track: Track; active: boolean; ms: number }
  | { type: 'partial'; track: Track; text: string; startMs: number }
  | { type: 'final'; track: Track; text: string; startMs: number; endMs: number }
  | { type: 'level'; track: Track; rms: number; ms: number }
  | { type: 'error'; track?: Track; message: string };

export interface StartOptions {
  /** Folder for me.wav and them.wav. */
  dir: string;
  /** Device names; null = the system default. */
  mic: string | null;
  output: string | null;
  record: boolean;
  language?: string;
  /** Names and terms to spell right (company, role, interviewers). */
  prompt?: string;
  onEvent: (e: EngineEvent) => void;
}

export interface StartResult {
  mic: { name: string; rate: number } | null;
  output: { name: string; rate: number } | null;
}

export interface StopResult {
  durationMs: number;
  /** Null when nothing was recorded. */
  files: { me?: string; them?: string } | null;
}

/** Captures the microphone and the PC's speaker output, records both, and transcribes live. */
export interface AudioEngine {
  readonly name: string;
  status(): EngineStatus;
  onStatus(listener: (s: EngineStatus) => void): () => void;
  /** Starts the engine if needed and resolves once the speech model is loaded. */
  ensureReady(): Promise<void>;
  listDevices(): Promise<{ inputs: AudioDevice[]; outputs: AudioDevice[] }>;
  start(opts: StartOptions): Promise<StartResult>;
  stop(): Promise<StopResult>;
  /** Server exit only: stops the engine process. */
  shutdown(): Promise<void>;
}

export class EngineError extends Error {}
