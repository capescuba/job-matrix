"""Run with: apps/audio-engine/.venv/Scripts/python -m unittest discover -s apps/audio-engine -p "test_*.py"

No model and no sound card: a fake VAD that follows Silero's span rules and a fake transcriber.
"""

import unittest

import numpy as np

from segmenter import SR, Segmenter

PAD = int(0.2 * SR)
MIN_SILENCE = int(0.6 * SR)


def fake_vad(audio: np.ndarray):
    """Loud = speech. Spans close after 600 ms of silence and end 200 ms after the last loud sample;
    a span still open at the end of the buffer runs to the end (Silero's behaviour)."""
    loud = np.abs(audio) > 0.1
    min_speech = int(0.25 * SR)  # Silero drops anything shorter than this
    spans, start, last_loud = [], None, None

    def close(end):
        if last_loud - start >= min_speech:
            spans.append((max(0, start - PAD), end))

    for i in np.flatnonzero(loud):
        if start is None:
            start, last_loud = i, i
        elif i - last_loud > MIN_SILENCE:
            close(min(len(audio), last_loud + PAD))
            start, last_loud = i, i
        else:
            last_loud = i
    if start is not None:
        close(len(audio) if len(audio) - last_loud <= MIN_SILENCE else min(len(audio), last_loud + PAD))
    return spans


def tone(seconds: float) -> np.ndarray:
    return (0.5 * np.sin(np.linspace(0, 200 * np.pi, int(seconds * SR)))).astype(np.float32)


def quiet(seconds: float) -> np.ndarray:
    return np.zeros(int(seconds * SR), dtype=np.float32)


def run(parts, **kw):
    """Feed audio in 100 ms chunks; return all events."""
    calls: list[int] = []

    def transcribe(a):
        calls.append(len(a))
        return "hello there"

    seg = Segmenter(fake_vad, transcribe, **kw)
    events = []
    for audio in parts:
        for i in range(0, len(audio), SR // 10):
            events += seg.feed(audio[i : i + SR // 10])
    return seg, events, calls


class SegmenterTests(unittest.TestCase):
    def test_silence_makes_no_events_and_never_grows_the_buffer(self):
        seg, events, calls = run([quiet(30)])
        self.assertEqual(events, [])
        self.assertEqual(calls, [])
        self.assertLess(len(seg.buf), 5 * SR)

    def test_an_utterance_gets_speech_edges_and_one_final_on_the_session_clock(self):
        _, events, _ = run([quiet(2), tone(2.0), quiet(2)])
        kinds = [(e["type"], e.get("active")) for e in events if e["type"] != "partial"]
        self.assertEqual(kinds, [("speech", True), ("final", None), ("speech", False)])
        final = next(e for e in events if e["type"] == "final")
        self.assertEqual(final["text"], "hello there")
        # speech began at ~2.0 s (less padding) and ended at ~4.0 s (plus padding)
        self.assertTrue(1700 <= final["startMs"] <= 2100, final)
        self.assertTrue(3900 <= final["endMs"] <= 4400, final)

    def test_a_long_utterance_gets_partials_while_it_is_still_being_said(self):
        # The text grows as more is heard, as a real transcriber's would.
        seg = Segmenter(fake_vad, lambda a: f"heard {len(a) // 1000}")
        events = []
        audio = tone(6.0)
        for i in range(0, len(audio), SR // 10):
            events += seg.feed(audio[i : i + SR // 10])
        partials = [e for e in events if e["type"] == "partial"]
        self.assertGreaterEqual(len(partials), 2)
        self.assertEqual([e for e in events if e["type"] == "final"], [])

    def test_an_unchanged_partial_is_not_repeated(self):
        _, events, _ = run([tone(6.0)])
        self.assertLessEqual(len([e for e in events if e["type"] == "partial"]), 1)

    def test_two_utterances_become_two_finals_in_order(self):
        _, events, _ = run([tone(1.5), quiet(2), tone(1.5), quiet(2)])
        finals = [e["text"] for e in events if e["type"] == "final"]
        self.assertEqual(len(finals), 2)
        self.assertEqual(finals[0], "hello there")

    def test_a_very_long_run_is_split_at_its_longest_pause_and_keeps_speaking(self):
        # 6 s talk, 0.8 s pause, 6 s talk: over the 10 s cap, so it must be cut in the pause.
        seg, events, _ = run([tone(6.0), quiet(0.8), tone(6.0)])
        finals = [e for e in events if e["type"] == "final"]
        self.assertGreaterEqual(len(finals), 1)
        self.assertTrue(5800 <= finals[0]["endMs"] <= 7200, finals[0])
        self.assertTrue(seg.speaking)

    def test_a_blip_too_short_to_be_speech_is_ignored(self):
        _, events, calls = run([tone(0.1), quiet(3)])
        self.assertEqual([e for e in events if e["type"] == "final"], [])
        self.assertEqual(calls, [])

    def test_flush_finalizes_speech_that_was_still_going_when_the_call_ended(self):
        seg, events, _ = run([tone(2.0)])
        self.assertEqual([e for e in events if e["type"] == "final"], [])
        events = seg.flush()
        self.assertEqual([e["text"] for e in events if e["type"] == "final"], ["hello there"])
        self.assertIn(False, [e.get("active") for e in events if e["type"] == "speech"])

    def test_known_hallucinations_from_a_short_burst_are_dropped(self):
        calls = []
        seg = Segmenter(fake_vad, lambda a: (calls.append(1), "Thank you.")[1])
        events = []
        for audio in [tone(0.5), quiet(2)]:
            for i in range(0, len(audio), SR // 10):
                events += seg.feed(audio[i : i + SR // 10])
        self.assertEqual([e for e in events if e["type"] == "final"], [])


if __name__ == "__main__":
    unittest.main()
