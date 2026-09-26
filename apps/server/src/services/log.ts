/**
 * Named app events for the log file (and the Log page): "mail.sync.done", "ai.call", ….
 * The server wires in Fastify's logger at start-up; until then (and in tests) events go nowhere.
 */
type Level = 'info' | 'warn' | 'error';
type Sink = Record<Level, (obj: object, msg: string) => void>;

let sink: Sink | null = null;

export function setLogSink(s: Sink | null) {
  sink = s;
}

export function logEvent(event: string, msg: string, details: object = {}, level: Level = 'info') {
  sink?.[level]({ event, ...details }, msg);
}
