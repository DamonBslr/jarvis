# /// script
# requires-python = ">=3.10,<3.14"
# dependencies = ["kokoro-onnx==0.4.9", "soundfile==0.13.1"]
# ///
"""
Jarvis neural TTS worker (Kokoro-82M via ONNX, runs on this Mac).

Started by Jarvis with `uv run --script kokoro-worker.py <model-dir>`; stays alive between replies.
stdin, one JSON object per line:
  {"id": "...", "text": "...", "voice": "bm_george", "speed": 1.0, "out": "/tmp/x.wav"}
  {"cancel": true}          drop everything still waiting (the user interrupted)
stdout, one JSON object per line:
  {"ready": true}
  {"id": "...", "ok": true} | {"id": "...", "error": "..."} | {"id": "...", "cancelled": true}
`--warmup` loads the model, synthesizes one word and exits (used right after download so the
first real reply doesn't wait for dependency installs).
"""
import json
import sys
import threading
from collections import deque

import soundfile as sf
from kokoro_onnx import Kokoro

# Kokoro voice prefix -> espeak language.
LANGS = {"a": "en-us", "b": "en-gb", "e": "es", "f": "fr-fr", "h": "hi", "i": "it", "j": "ja", "p": "pt-br", "z": "cmn"}


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    model_dir = sys.argv[1]
    kokoro = Kokoro(f"{model_dir}/kokoro-v1.0.onnx", f"{model_dir}/voices-v1.0.bin")

    if "--warmup" in sys.argv:
        kokoro.create("Ready.", voice="bm_george", speed=1.0, lang="en-gb")
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
            voice = job.get("voice") or "bm_george"
            samples, rate = kokoro.create(
                job["text"], voice=voice, speed=float(job.get("speed") or 1.0), lang=LANGS.get(voice[0], "en-us")
            )
            sf.write(job["out"], samples, rate)
            emit({"id": job["id"], "ok": True})
        except Exception as e:  # noqa: BLE001 - report every failure to Jarvis, keep serving
            emit({"id": job["id"], "error": str(e)[:500]})


if __name__ == "__main__":
    main()
