"""Job Matrix audio engine.

Captures the microphone and the PC's speaker output (WASAPI loopback) as two separate tracks,
writes each to a WAV, and transcribes each live with faster-whisper on the GPU. One control
WebSocket from the Node server: ws://127.0.0.1:<port>/control. GET /health reports the model state.

Protocol (JSON text frames). Node -> engine:
  {"type":"devices"}
  {"type":"start","dir":"...","mic":"name|null","output":"name|null","record":true,
   "language":"en","prompt":"Acme, TPM, Jane Doe"}
  {"type":"stop"}
Engine -> Node:
  {"type":"devices","inputs":[...],"outputs":[...]}
  {"type":"started","mic":{"name","rate"}|null,"output":{"name","rate"}|null}
  {"type":"stopped","durationMs":int,"files":{"me":"me.wav","them":"them.wav"}|null}
  {"type":"event","event":{ track, type: speech|partial|final|level|error, ... }}
  {"type":"error","message":"..."}
Times in events are ms on the session clock (both tracks start together).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import threading
import time
import wave
from http import HTTPStatus
from typing import Optional

import numpy as np

SR = 16000


def setup_cuda_dlls() -> None:
    """cuBLAS 12 and cuDNN 9 come as pip wheels (nvidia-*-cu12); CTranslate2 needs them findable."""
    if sys.platform != "win32":
        return
    try:
        import nvidia  # type: ignore
    except ImportError:
        return
    for base in list(getattr(nvidia, "__path__", [])):
        for sub in os.listdir(base):
            bin_dir = os.path.join(base, sub, "bin")
            if os.path.isdir(bin_dir):
                os.add_dll_directory(bin_dir)
                os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")


def log(**kw) -> None:
    print(json.dumps(kw), flush=True)


class Asr:
    """The faster-whisper model plus the Silero VAD, each behind a lock (one GPU, shared by tracks)."""

    def __init__(self, model: str, device: str, compute: str) -> None:
        self.name, self.want_device, self.want_compute = model, device, compute
        self.phase, self.detail = "starting", ""
        self.device, self.compute = device, compute
        self.model = None
        self._lock = threading.Lock()
        self._vad_lock = threading.Lock()

    def load(self) -> None:
        try:
            setup_cuda_dlls()
            from faster_whisper import WhisperModel
            from faster_whisper.utils import download_model

            try:
                path = download_model(self.name, local_files_only=True)
            except Exception:
                self.phase = "downloading"
                log(event="phase", phase=self.phase)
                path = download_model(self.name)
            self.phase = "loading"
            log(event="phase", phase=self.phase)
            silence = np.zeros(SR, dtype=np.float32)
            try:
                self.model = WhisperModel(path, device=self.want_device, compute_type=self.want_compute)
                # Missing cuBLAS / cuDNN DLLs only show up on first use, so warm up here.
                list(self.model.transcribe(silence, beam_size=1, language="en")[0])
            except Exception as e:  # noqa: BLE001
                if self.want_device == "cpu":
                    raise
                log(event="cuda-failed", error=str(e))
                self.device, self.compute = "cpu", "int8"
                self.detail = f"GPU unavailable ({e}); running on the CPU, which is slow."
                self.model = WhisperModel(path, device="cpu", compute_type="int8")
                list(self.model.transcribe(silence, beam_size=1, language="en")[0])
            self.phase = "ready"
            log(event="phase", phase=self.phase, device=self.device)
        except Exception as e:  # noqa: BLE001
            self.phase, self.detail = "error", str(e)
            log(event="phase", phase="error", error=str(e))

    def transcribe(self, audio: np.ndarray, prompt: Optional[str], language: Optional[str]) -> str:
        with self._lock:
            segments, _ = self.model.transcribe(
                audio,
                beam_size=1,
                language=language,
                condition_on_previous_text=False,
                vad_filter=False,
                without_timestamps=True,
                initial_prompt=prompt or None,
                temperature=0.0,
            )
            return " ".join(s.text.strip() for s in segments).strip()

    def vad(self, audio: np.ndarray):
        from faster_whisper.vad import VadOptions, get_speech_timestamps

        opts = VadOptions(
            threshold=0.5,
            min_silence_duration_ms=600,
            speech_pad_ms=200,
            min_speech_duration_ms=250,
        )
        with self._vad_lock:
            return [(int(t["start"]), int(t["end"])) for t in get_speech_timestamps(audio, opts)]


class Track:
    """One source: raw device audio in, 16 kHz mono out to the WAV, the level meter and the segmenter."""

    def __init__(self, name: str, capture, asr: Asr, wav_path: Optional[str], prompt: str, language: Optional[str]):
        import soxr

        from segmenter import Segmenter

        self.name = name
        self.capture = capture
        self.queue: asyncio.Queue = asyncio.Queue()
        self.total = 0  # 16 kHz samples pushed so far: the track clock
        self._resampler = soxr.ResampleStream(capture.rate, SR, 1, dtype="float32")
        self._seg = Segmenter(asr.vad, lambda a: asr.transcribe(a, prompt, language))
        self._wav = None
        if wav_path:
            self._wav = wave.open(wav_path, "wb")
            self._wav.setnchannels(1)
            self._wav.setsampwidth(2)
            self._wav.setframerate(SR)
        self._level_acc: list[np.ndarray] = []
        self._level_samples = 0
        self.task: Optional[asyncio.Task] = None

    # ---- runs on a worker thread, one item at a time per track ----

    def _push(self, x: np.ndarray) -> list[dict]:
        if self._wav:
            self._wav.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())
        self.total += len(x)
        events = self._seg.feed(x)
        self._level_acc.append(x)
        self._level_samples += len(x)
        if self._level_samples >= SR // 10:
            joined = np.concatenate(self._level_acc)
            events.append({"type": "level", "rms": float(np.sqrt(np.mean(joined**2))), "ms": self.total * 1000 // SR})
            self._level_acc, self._level_samples = [], 0
        return events

    def process(self, item) -> list[dict]:
        kind = item[0]
        if kind == "tick":
            gap = int(item[1] * SR) - self.total
            return self._push(np.zeros(gap, dtype=np.float32)) if gap > SR // 2 else []
        _, arrived, data = item
        pcm = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
        ch = self.capture.channels
        mono = pcm.reshape(-1, ch).mean(axis=1) if ch > 1 else pcm
        x = self._resampler.resample_chunk(mono)
        # Loopback delivers nothing while the PC is silent, and the mic can stall; keep both tracks on
        # the same clock by filling the gap with silence.
        gap = int(arrived * SR) - len(x) - self.total
        events = self._push(np.zeros(gap, dtype=np.float32)) if gap > SR * 4 // 10 else []
        return events + self._push(x)

    def finish(self) -> list[dict]:
        events = self._seg.flush()
        if self._wav:
            self._wav.close()
        return events


class Session:
    def __init__(self, asr: Asr, params: dict, send) -> None:
        self.asr, self.params, self.send = asr, params, send
        self.tracks: dict[str, Track] = {}
        self.t0 = 0.0
        self._ticker: Optional[asyncio.Task] = None

    def clock(self) -> float:
        return time.perf_counter() - self.t0

    async def emit(self, track: str, ev: dict) -> None:
        await self.send({"type": "event", "event": {**ev, "track": track}})

    async def start(self) -> dict:
        import pyaudiowpatch as pyaudio

        import devices

        self.pa = pyaudio.PyAudio()
        loop = asyncio.get_running_loop()
        p = self.params
        directory = p["dir"]
        record = bool(p.get("record", True))
        if record:
            os.makedirs(directory, exist_ok=True)
        language = None if p.get("language") in (None, "", "auto") else p["language"]
        prompt = p.get("prompt") or ""
        started: dict = {"mic": None, "output": None}
        self.t0 = time.perf_counter()
        for name, kind, key in (("me", "mic", "mic"), ("them", "output", "output")):
            try:
                info = devices.resolve(self.pa, kind, p.get(key))
                track_box: dict = {}

                def on_chunk(t, data, _box=track_box):
                    loop.call_soon_threadsafe(_box["track"].queue.put_nowait, ("raw", t, data))

                cap = devices.DeviceCapture(self.pa, info, on_chunk, self.clock)
                wav = os.path.join(directory, f"{name}.wav") if record else None
                track = Track(name, cap, self.asr, wav, prompt, language)
                track_box["track"] = track
                self.tracks[name] = track
                started[key] = {"name": info["name"], "rate": cap.rate}
            except Exception as e:  # noqa: BLE001
                await self.emit(name, {"type": "error", "message": f"{'Microphone' if kind == 'mic' else 'Speaker capture'}: {e}"})
        if not self.tracks:
            self.pa.terminate()
            raise RuntimeError("Neither the microphone nor the speaker output could be opened.")
        for track in self.tracks.values():
            track.task = asyncio.create_task(self._worker(track))
        self._ticker = asyncio.create_task(self._tick())
        return started

    async def _worker(self, track: Track) -> None:
        while True:
            item = await track.queue.get()
            if item is None:
                return
            try:
                for ev in await asyncio.to_thread(track.process, item):
                    await self.emit(track.name, ev)
            except Exception as e:  # noqa: BLE001
                log(event="worker-error", track=track.name, error=str(e))
                await self.emit(track.name, {"type": "error", "message": str(e)})

    async def _tick(self) -> None:
        while True:
            await asyncio.sleep(0.25)
            now = self.clock()
            for t in self.tracks.values():
                t.queue.put_nowait(("tick", now))

    async def stop(self) -> dict:
        if self._ticker:
            self._ticker.cancel()
        for t in self.tracks.values():
            t.capture.stop()
        # Let in-flight chunks finish, then end each worker.
        for t in self.tracks.values():
            t.queue.put_nowait(None)
        await asyncio.gather(*(t.task for t in self.tracks.values() if t.task))
        duration = 0
        for t in self.tracks.values():
            for ev in await asyncio.to_thread(t.finish):
                await self.emit(t.name, ev)
            duration = max(duration, t.total * 1000 // SR)
        self.pa.terminate()
        record = bool(self.params.get("record", True))
        return {
            "durationMs": duration,
            "files": {n: f"{n}.wav" for n in self.tracks} if record else None,
        }


class Engine:
    def __init__(self, args) -> None:
        self.args = args
        self.asr = Asr(args.model, args.device, args.compute)
        self.session: Optional[Session] = None
        self._ws = None
        self._orphan: Optional[asyncio.Task] = None
        self.idle_since = time.time()

    def health(self) -> dict:
        return {
            "phase": self.asr.phase,
            "detail": self.asr.detail,
            "model": self.asr.name,
            "device": self.asr.device,
            "compute": self.asr.compute,
            "pid": os.getpid(),
            "recording": self.session is not None,
        }

    async def process_request(self, connection, request):
        if request.path == "/health":
            status = HTTPStatus.OK if self.asr.phase == "ready" else HTTPStatus.SERVICE_UNAVAILABLE
            response = connection.respond(status, json.dumps(self.health()))
            response.headers["Content-Type"] = "application/json"
            return response
        if request.path != "/control":
            return connection.respond(HTTPStatus.NOT_FOUND, "not found\n")
        return None

    async def send(self, obj: dict) -> None:
        ws = self._ws
        if ws is None:
            return
        try:
            await ws.send(json.dumps(obj))
        except Exception:  # noqa: BLE001
            pass

    async def handler(self, ws) -> None:
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:  # noqa: BLE001
                pass
        self._ws = ws
        if self._orphan:
            self._orphan.cancel()
            self._orphan = None
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                await self.dispatch(msg)
        finally:
            if self._ws is ws:
                self._ws = None
                self.idle_since = time.time()
                if self.session:
                    # Node went away mid-call: keep recording for a while in case it reconnects.
                    self._orphan = asyncio.create_task(self._stop_orphan())

    async def _stop_orphan(self) -> None:
        await asyncio.sleep(120)
        if self.session and self._ws is None:
            log(event="orphan-stop")
            try:
                await self.session.stop()
            finally:
                self.session = None

    async def dispatch(self, msg: dict) -> None:
        kind = msg.get("type")
        try:
            if kind == "devices":
                import pyaudiowpatch as pyaudio

                import devices

                pa = pyaudio.PyAudio()
                try:
                    await self.send({"type": "devices", **devices.list_devices(pa)})
                finally:
                    pa.terminate()
            elif kind == "start":
                if self.asr.phase != "ready":
                    raise RuntimeError(f"The speech model is not ready ({self.asr.phase}).")
                if self.session:
                    raise RuntimeError("A call is already being recorded.")
                self.session = Session(self.asr, msg, self.send)
                try:
                    started = await self.session.start()
                except Exception:
                    self.session = None
                    raise
                await self.send({"type": "started", **started})
            elif kind == "stop":
                if not self.session:
                    await self.send({"type": "stopped", "durationMs": 0, "files": None})
                    return
                session, self.session = self.session, None
                await self.send({"type": "stopped", **await session.stop()})
        except Exception as e:  # noqa: BLE001
            log(event="error", kind=kind, error=str(e))
            await self.send({"type": "error", "message": str(e), "for": kind})


async def watchdog(engine: "Engine", minutes: float) -> None:
    """If Node is gone and nothing is recording, exit rather than hold the GPU forever."""
    while True:
        await asyncio.sleep(30)
        if engine._ws is None and engine.session is None and time.time() - engine.idle_since > minutes * 60:
            log(event="idle-exit")
            os._exit(0)


async def main(args) -> None:
    from websockets.asyncio.server import serve

    engine = Engine(args)
    loop = asyncio.get_running_loop()
    loop.run_in_executor(None, engine.asr.load)
    asyncio.create_task(watchdog(engine, args.idle_exit_minutes))
    async with serve(
        engine.handler,
        "127.0.0.1",
        args.port,
        process_request=engine.process_request,
        max_size=2**20,
    ):
        log(event="listening", port=args.port)
        await asyncio.Future()


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5175)
    ap.add_argument("--model", default="large-v3-turbo")
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--compute", default="float16")
    ap.add_argument("--idle-exit-minutes", type=float, default=15)
    asyncio.run(main(ap.parse_args()))
