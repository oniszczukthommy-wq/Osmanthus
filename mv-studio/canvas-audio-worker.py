"""Local-only Whisper worker for owned canvas jobs; no command/lyric prompt bias."""
import argparse
import array
import fcntl
import json
import math
import os
from pathlib import Path
import sys
import wave

os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_DATASETS_OFFLINE="1",
                  OMP_NUM_THREADS="2", OPENBLAS_NUM_THREADS="1", TOKENIZERS_PARALLELISM="false")
ENGINE = "faster-whisper-base-1.2.1-cpu-int8"
MAX_BYTES = 16_000_000
MAX_SECONDS = 60


def write_result(output, value):
    temporary = output.with_name(".transcription-" + str(os.getpid()) + ".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False)
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--language", choices=("auto", "zh", "en", "ja", "ko"), default="auto")
    parser.add_argument("--lock", required=True)
    args = parser.parse_args()
    audio, output, model = Path(args.audio), Path(args.output), Path(args.model)
    if not model.is_dir() or not all((model / name).is_file() for name in
                                    ("model.bin", "config.json", "tokenizer.json", "vocabulary.txt")):
        raise ValueError("The installed local Whisper base model is required; downloads are disabled")
    if audio.is_symlink() or not audio.is_file() or not 0 < audio.stat().st_size <= MAX_BYTES:
        raise ValueError("A local regular WAV of at most 16MB is required")
    with wave.open(str(audio), "rb") as handle:
        if (handle.getnchannels(), handle.getsampwidth(), handle.getframerate(), handle.getcomptype()) != (1, 2, 16000, "NONE"):
            raise ValueError("Expected mono 16kHz PCM16 WAV")
        duration = handle.getnframes() / handle.getframerate()
        if not 0.2 - 0.01 <= duration <= MAX_SECONDS + 0.01:
            raise ValueError("The audio selection must be between 0.2 and 60 seconds")
        samples = array.array("h", handle.readframes(handle.getnframes()))
    if sys.byteorder != "little":
        samples.byteswap()
    rms = math.sqrt(sum(value * value for value in samples) / max(1, len(samples))) / 32768
    if rms < 0.0002:
        write_result(output, {"status": "empty"})
        return
    from faster_whisper import WhisperModel
    lock_descriptor = os.open(args.lock, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(lock_descriptor, "a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        engine = WhisperModel(str(model), device="cpu", compute_type="int8", cpu_threads=2,
                              num_workers=1, local_files_only=True)
        segments, info = engine.transcribe(str(audio), language=None if args.language == "auto" else args.language,
                                          beam_size=5, vad_filter=True, condition_on_previous_text=False)
        cues = []
        for segment in segments:
            text = segment.text.strip()
            if not text:
                continue
            start, end = max(0.0, segment.start), min(duration, segment.end)
            if end > start:
                cues.append({"start": round(start, 6), "end": round(end, 6), "text": text})
            if len(cues) > 400 or sum(len(cue["text"]) for cue in cues) > 20000:
                raise ValueError("Transcription exceeds the caption limit; select a shorter interval")
    if not cues:
        write_result(output, {"status": "empty"})
        return
    separator = "" if info.language in ("zh", "ja") else " "
    write_result(output, {"status": "ready", "text": separator.join(cue["text"] for cue in cues),
                          "segments": cues, "language": info.language,
                          "language_probability": float(info.language_probability),
                          "duration": duration, "engine": ENGINE})


if __name__ == "__main__":
    main()
