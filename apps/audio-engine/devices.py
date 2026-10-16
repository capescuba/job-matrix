"""Audio devices and capture, via WASAPI (PyAudioWPatch).

The microphone is an ordinary input. "Them" is the loopback of an output device: whatever the PC
plays through it, which is the other side of a Zoom, Teams or Meet call whichever app it is in.
"""

from __future__ import annotations

from typing import Callable, Optional

import pyaudiowpatch as pyaudio


def wasapi_index(pa: pyaudio.PyAudio) -> int:
    return pa.get_host_api_info_by_type(pyaudio.paWASAPI)["index"]


def list_devices(pa: pyaudio.PyAudio) -> dict:
    host = wasapi_index(pa)
    default_in = pa.get_host_api_info_by_type(pyaudio.paWASAPI).get("defaultInputDevice")
    try:
        default_out = pa.get_default_wasapi_loopback()["index"]
    except Exception:
        default_out = None
    inputs, outputs = [], []
    for d in pa.get_device_info_generator():
        if d["hostApi"] != host:
            continue
        item = {"index": d["index"], "name": d["name"]}
        if d.get("isLoopbackDevice"):
            outputs.append({**item, "isDefault": d["index"] == default_out})
        elif d["maxInputChannels"] > 0:
            inputs.append({**item, "isDefault": d["index"] == default_in})
    return {"inputs": inputs, "outputs": outputs}


def resolve(pa: pyaudio.PyAudio, kind: str, name: Optional[str]) -> dict:
    """The device info for a remembered name, else the system default. Raises if there is none."""
    listing = list_devices(pa)["inputs" if kind == "mic" else "outputs"]
    pick = next((d for d in listing if name and d["name"] == name), None) or next(
        (d for d in listing if d["isDefault"]), None
    )
    if pick is None:
        raise RuntimeError(
            "No microphone found." if kind == "mic" else "No speaker output found to capture."
        )
    return pa.get_device_info_by_index(pick["index"])


class DeviceCapture:
    """One open input stream. `on_chunk(arrival_perf_counter, bytes)` is called on PortAudio's thread."""

    def __init__(
        self,
        pa: pyaudio.PyAudio,
        info: dict,
        on_chunk: Callable[[float, bytes], None],
        clock: Callable[[], float],
    ) -> None:
        self.info = info
        self.rate = int(info["defaultSampleRate"])
        self.channels = max(1, int(info["maxInputChannels"]))
        self._on_chunk = on_chunk
        self._clock = clock
        self._stream = pa.open(
            format=pyaudio.paInt16,
            channels=self.channels,
            rate=self.rate,
            input=True,
            input_device_index=info["index"],
            frames_per_buffer=self.rate // 10,
            stream_callback=self._callback,
        )

    def _callback(self, in_data, frame_count, time_info, status):
        self._on_chunk(self._clock(), in_data)
        return (None, pyaudio.paContinue)

    def stop(self) -> None:
        try:
            self._stream.stop_stream()
            self._stream.close()
        except Exception:
            pass
