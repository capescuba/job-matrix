"""Turns a stream of 16 kHz mono audio into speech events: partial and final transcripts.

Pure logic with the VAD and the transcriber injected, so it is tested without a GPU or a sound
card. One Segmenter per track (the microphone and the system audio are kept apart on purpose:
that is what tells "me" from "them").
"""

from __future__ import annotations

from typing import Callable, Optional

import numpy as np

SR = 16000

# Lines Whisper makes up on noise or breathing; dropped when they come from a short burst of "speech".
HALLUCINATIONS = {
    "",
    ".",
    "you",
    "thank you.",
    "thank you",
    "thanks for watching!",
    "thanks for watching.",
    "bye.",
    "okay.",
}

Spans = list[tuple[int, int]]
Vad = Callable[[np.ndarray], Spans]
Transcribe = Callable[[np.ndarray], str]


def ms(sample: int) -> int:
    return int(sample * 1000 / SR)


class Segmenter:
    """Feed audio in; get a list of event dicts back.

    Events (all times are ms on this track's clock, which starts at sample 0 of the session):
      {"type": "speech", "active": bool, "ms": int}
      {"type": "partial", "text": str, "startMs": int}
      {"type": "final", "text": str, "startMs": int, "endMs": int}

    VAD semantics this relies on (Silero, as used by faster-whisper): a span that is still open at
    the end of the buffer runs to the end of the buffer; a span closes once min_silence has passed,
    and ends at the last speech plus a little padding. So "the last span ends clearly before the
    buffer does" means the speaker has stopped.
    """

    def __init__(
        self,
        vad: Vad,
        transcribe: Transcribe,
        *,
        check_every_ms: int = 300,
        partial_every_ms: int = 1500,
        closed_gap_ms: int = 300,
        max_utterance_s: float = 10.0,
        min_speech_ms: int = 300,
        idle_keep_s: float = 1.0,
        idle_trim_s: float = 3.0,
    ) -> None:
        self.vad = vad
        self.transcribe = transcribe
        self.check_every = check_every_ms * SR // 1000
        self.partial_every = partial_every_ms * SR // 1000
        self.closed_gap = closed_gap_ms * SR // 1000
        self.max_utterance = int(max_utterance_s * SR)
        self.min_speech = min_speech_ms * SR // 1000
        self.idle_keep = int(idle_keep_s * SR)
        self.idle_trim = int(idle_trim_s * SR)

        self.buf = np.zeros(0, dtype=np.float32)
        self.buf_start = 0  # absolute sample index of buf[0]
        self.speaking = False
        self._since_check = 0
        self._last_partial_at: Optional[int] = None
        self._last_partial_text = ""

    # ---- public ----

    def feed(self, samples: np.ndarray) -> list[dict]:
        self.buf = np.concatenate([self.buf, samples.astype(np.float32, copy=False)])
        self._since_check += len(samples)
        if self._since_check < self.check_every:
            return []
        self._since_check = 0
        return self._check()

    def flush(self) -> list[dict]:
        """The call is over: turn whatever speech is still buffered into a final."""
        events: list[dict] = []
        spans = self.vad(self.buf) if len(self.buf) else []
        if spans:
            events += self._finalize(spans, spans[0][0], spans[-1][1])
        elif self.speaking:
            self.speaking = False
            events.append({"type": "speech", "active": False, "ms": ms(self.buf_start + len(self.buf))})
        self.buf = np.zeros(0, dtype=np.float32)
        return events

    @property
    def position_ms(self) -> int:
        return ms(self.buf_start + len(self.buf))

    # ---- internals ----

    def _drop(self, upto: int) -> None:
        self.buf = self.buf[upto:]
        self.buf_start += upto

    def _check(self) -> list[dict]:
        n = len(self.buf)
        spans = self.vad(self.buf)
        events: list[dict] = []
        if not spans:
            if self.speaking:
                self.speaking = False
                events.append({"type": "speech", "active": False, "ms": ms(self.buf_start + n)})
            self._last_partial_at = None
            if n > self.idle_trim:
                self._drop(n - self.idle_keep)
            return events

        first, last = spans[0][0], spans[-1][1]
        if not self.speaking:
            self.speaking = True
            events.append({"type": "speech", "active": True, "ms": ms(self.buf_start + first)})

        if n - last >= self.closed_gap:
            return events + self._finalize(spans, first, last)
        if n - first > self.max_utterance:
            return events + self._finalize(spans, first, self._cut_point(spans), still_speaking=True)

        at = self.buf_start + n
        if self._last_partial_at is None or at - self._last_partial_at >= self.partial_every:
            self._last_partial_at = at
            text = self.transcribe(self.buf[first:]).strip()
            if text and text != self._last_partial_text:
                self._last_partial_text = text
                events.append({"type": "partial", "text": text, "startMs": ms(self.buf_start + first)})
        return events

    @staticmethod
    def _cut_point(spans: Spans) -> int:
        """Where to split a very long utterance: the middle of its longest pause, else the end."""
        best, best_gap = spans[-1][1], 0
        for (_, a_end), (b_start, _) in zip(spans, spans[1:]):
            if b_start - a_end > best_gap:
                best_gap, best = b_start - a_end, (a_end + b_start) // 2
        return best

    def _finalize(self, spans: Spans, first: int, cut: int, still_speaking: bool = False) -> list[dict]:
        events: list[dict] = []
        spoken = sum(min(e, cut) - max(s, first) for s, e in spans if e > first and s < cut)
        text = ""
        if spoken >= self.min_speech:
            text = self.transcribe(self.buf[first:cut]).strip()
            if spoken < SR * 1.2 and text.lower() in HALLUCINATIONS:
                text = ""
        if text:
            events.append(
                {
                    "type": "final",
                    "text": text,
                    "startMs": ms(self.buf_start + first),
                    "endMs": ms(self.buf_start + cut),
                }
            )
        end_ms = ms(self.buf_start + cut)
        self._drop(cut)
        self._last_partial_at = None
        self._last_partial_text = ""
        if not still_speaking and self.speaking:
            self.speaking = False
            events.append({"type": "speech", "active": False, "ms": end_ms})
        return events
