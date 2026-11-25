# /// script
# requires-python = ">=3.10,<3.14"
# dependencies = ["piper-tts==1.8.0"]
# ///
"""
Jarvis German TTS worker (Piper via ONNX, runs on this Mac). Kokoro has no German, Piper does.

Started by Jarvis with `uv run --script piper-worker.py <voice-dir>`; stays alive between replies.
Same line protocol as kokoro-worker.py:
stdin, one JSON object per line:
  {"id": "...", "text": "...", "voice": "de_DE-thorsten-high", "speed": 1.0, "out": "/tmp/x.wav"}
  {"cancel": true}          drop everything still waiting (the user interrupted)
stdout, one JSON object per line:
  {"ready": true}
  {"id": "...", "ok": true} | {"id": "...", "error": "..."} | {"id": "...", "cancelled": true}
`--warmup <voice>` loads that voice, synthesizes one word and exits (used right after download so the
first real reply doesn't wait for dependency installs).
"""
import json
import os
import sys
import tempfile
import threading
import wave
from collections import deque

from piper import PiperVoice, SynthesisConfig

DEFAULT_VOICE = "de_DE-thorsten-high"


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    voice_dir = sys.argv[1]
    loaded = {}

    def voice_for(name):
        name = os.path.basename(name or DEFAULT_VOICE)  # ids only, never paths
        if name not in loaded:
            loaded[name] = PiperVoice.load(os.path.join(voice_dir, f"{name}.onnx"))
        return loaded[name]

    def synth(text, name, speed, out):
        # length_scale is duration: 1/speed makes 1.1x speed 10% faster.
        cfg = SynthesisConfig(length_scale=1.0 / max(0.5, min(2.0, speed)))
        voice = voice_for(name)  # load first: a missing voice should say so, not leave a broken WAV
        with wave.open(out, "wb") as wf:
            voice.synthesize_wav(text, wf, syn_config=cfg)

    if "--warmup" in sys.argv:
        i = sys.argv.index("--warmup")
        name = sys.argv[i + 1] if len(sys.argv) > i + 1 else DEFAULT_VOICE
        with tempfile.TemporaryDirectory() as tmp:
            synth("Bereit.", name, 1.0, os.path.join(tmp, "warmup.wav"))
        emit({"ready": True})
        return

    pending = deque()
    cond = threading.Condition()
    closed = False

    def reader():
        nonlocal closed
        for line in sys.stdin:
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            with cond:
                if msg.get("cancel"):
                    while pending:
                        emit({"id": pending.popleft()["id"], "cancelled": True})
                else:
                    pending.append(msg)
                cond.notify()
        with cond:
            closed = True
            cond.notify()

    threading.Thread(target=reader, daemon=True).start()
    emit({"ready": True})

    while True:
        with cond:
            while not pending and not closed:
                cond.wait()
            if not pending:
                return
            job = pending.popleft()
        try:
            synth(job["text"], job.get("voice"), float(job.get("speed") or 1.0), job["out"])
            emit({"id": job["id"], "ok": True})
        except Exception as e:  # noqa: BLE001 - report every failure to Jarvis, keep serving
            emit({"id": job["id"], "error": str(e)[:500]})


if __name__ == "__main__":
    main()
