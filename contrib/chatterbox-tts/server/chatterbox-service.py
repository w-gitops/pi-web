#!/usr/bin/env python3
# pyright: reportMissingImports=false, reportMissingModuleSource=false
"""OpenAI-compatible Chatterbox TTS service with sentence/WAV streaming."""
import base64
import io
import json
import logging
import math
import os
import re
import tempfile
import threading
import time
import uuid

from _telemetry import get_tracer, setup_telemetry

setup_telemetry(service_name=os.getenv("OTEL_SERVICE_NAME", "voice-tts-chatterbox"))

import torch  # noqa: E402
import torchaudio as ta  # noqa: E402
from flask import Flask, Response, jsonify, request  # noqa: E402
from flask_cors import CORS  # noqa: E402

log = logging.getLogger("voice.tts")
tracer = get_tracer("voice.tts")

def _resolve_model_variant(value: str) -> tuple[str, str]:
    variant = value.strip().lower()
    if variant in {"default", "chatterbox"}:
        return "default", "chatterbox"
    if variant in {"turbo", "chatterbox-turbo"}:
        return "turbo", "chatterbox-turbo"
    raise ValueError("CHATTERBOX_MODEL must be default, chatterbox, turbo, or chatterbox-turbo")


MODEL_VARIANT, MODEL_NAME = _resolve_model_variant(os.getenv("CHATTERBOX_MODEL", "default"))
DEVICE = os.getenv("CHATTERBOX_DEVICE", "cuda" if torch.cuda.is_available() else "cpu")
PORT = int(os.getenv("PORT", "9004"))
VOICES_DIR = os.getenv("VOICES_DIR", "/opt/chatterbox-voices")
REQUIRE_SUCCESSFUL_WARMUP = os.getenv(
    "CHATTERBOX_REQUIRE_SUCCESSFUL_WARMUP",
    "true" if MODEL_VARIANT == "turbo" else "false",
).strip().lower() in {"1", "true", "yes", "on"}
WARMUP_VOICE = os.getenv("CHATTERBOX_WARMUP_VOICE", "alloy").strip()

STREAM_PROTOCOL_VERSION = "1"
FIRST_CHUNK_CHARS = int(os.getenv("CHATTERBOX_FIRST_CHUNK_CHARS", "160"))
SECOND_CHUNK_CHARS = int(os.getenv("CHATTERBOX_SECOND_CHUNK_CHARS", "160"))
LATER_CHUNK_CHARS = int(os.getenv("CHATTERBOX_LATER_CHUNK_CHARS", "160"))
if not all(
    32 <= size <= 1000
    for size in (FIRST_CHUNK_CHARS, SECOND_CHUNK_CHARS, LATER_CHUNK_CHARS)
):
    raise ValueError("CHATTERBOX chunk sizes must be between 32 and 1000 characters")
MAX_REQUEST_BYTES = 64 * 1024
MAX_INPUT_CHARS = 20_000
MAX_STREAM_CHUNKS = 128
MAX_VOICE_CHARS = 128
MAX_MODEL_CHARS = 128
def _resolve_cfm_steps(variant: str, value: str | None) -> int:
    steps = int(value if value is not None else ("2" if variant == "turbo" else "10"))
    if not 1 <= steps <= 50:
        raise ValueError("CHATTERBOX_CFM_STEPS must be between 1 and 50")
    if variant == "turbo" and steps != 2:
        raise ValueError("Chatterbox Turbo has a fixed two-step decoder; set CHATTERBOX_CFM_STEPS=2")
    return steps


CFM_STEPS = _resolve_cfm_steps(MODEL_VARIANT, os.getenv("CHATTERBOX_CFM_STEPS"))
STREAM_FIELDS = frozenset({"model", "input", "voice", "response_format", "speed"})
_SENTENCE_END = re.compile(r"[.!?\u3002\uff01\uff1f]+[\"'\u201d\u2019)]*(?=\s|$)")

os.makedirs(VOICES_DIR, exist_ok=True)

# perth's implicit watermarker is unavailable on this build.
import perth  # noqa: E402
if perth.PerthImplicitWatermarker is None:
    perth.PerthImplicitWatermarker = perth.DummyWatermarker
if MODEL_VARIANT == "turbo":
    from chatterbox.tts_turbo import ChatterboxTurboTTS as ChatterboxModel  # noqa: E402
else:
    from chatterbox.tts import ChatterboxTTS as ChatterboxModel  # noqa: E402

with tracer.start_as_current_span("voice.tts.model_load") as span:
    span.set_attribute("model", MODEL_NAME)
    span.set_attribute("device", DEVICE)
    log.info("voice.tts.model_loading", extra={"model": MODEL_NAME, "device": DEVICE})
    model = ChatterboxModel.from_pretrained(device=DEVICE)
    SAMPLE_RATE = model.sr
    span.set_attribute("sample_rate", SAMPLE_RATE)
    log.info("voice.tts.model_ready", extra={
        "model": MODEL_NAME, "sample_rate": SAMPLE_RATE, "device": DEVICE,
    })

# This deployment intentionally runs one service process per GPU. This lock
# serializes all access to mutable model conditionals within that process.
_synthesis_lock = threading.Lock()
_DEFAULT_CONDS = model.conds
_active_voice: dict[str, object] = {"key": None}
_phase_state = threading.local()


def _synchronize_device() -> None:
    """Make private model phase timings reflect completed CUDA work."""
    if DEVICE.startswith("cuda"):
        torch.cuda.synchronize()


def _instrument_model_phase(owner: object, method_name: str, phase_name: str) -> None:
    """Measure a private Chatterbox phase only while a request opts in."""
    original = getattr(owner, method_name)

    def measured(*args, **kwargs):
        timings = getattr(_phase_state, "timings", None)
        if timings is None:
            return original(*args, **kwargs)
        _synchronize_device()
        started = time.monotonic()
        try:
            return original(*args, **kwargs)
        finally:
            _synchronize_device()
            timings[phase_name] = time.monotonic() - started

    setattr(owner, method_name, measured)


# Chatterbox generate() does not expose its S3Gen diffusion-step setting.
# Preserve the upstream default of 10 while allowing measured deployment tuning.
_original_s3_inference = model.s3gen.inference


def _configured_s3_inference(*args, **kwargs):
    kwargs.setdefault("n_cfm_timesteps", CFM_STEPS)
    return _original_s3_inference(*args, **kwargs)


model.s3gen.inference = _configured_s3_inference

# Chatterbox also does not expose phase hooks. These narrow wrappers let us
# distinguish autoregressive generation, diffusion/flow, and vocoding while
# retaining the rest of the upstream generation implementation and output.
_instrument_model_phase(
    model.t3,
    "inference_turbo" if MODEL_VARIANT == "turbo" else "inference",
    "t3_s",
)
_instrument_model_phase(model.s3gen, "flow_inference", "s3_flow_s")
_instrument_model_phase(model.s3gen, "hift_inference", "hift_s")


def _normalize_input(value: str) -> str:
    """Collapse Unicode whitespace. Limits are Python Unicode code points."""
    return " ".join(value.split())


def _prefix_length(text: str, limit: int, first: bool) -> int:
    ends = [match.end() for match in _SENTENCE_END.finditer(text) if match.end() <= limit]
    if first and ends:
        # A very short opening sentence produces only a few seconds of audio,
        # not enough to cover synthesis of the next chunk. Prefer the first
        # sentence boundary that provides a useful startup playback buffer.
        buffered_end = next((end for end in ends if end >= 140), None)
        if buffered_end is not None:
            return buffered_end
    if len(text) <= limit:
        return len(text)
    if ends:
        sentence_end = ends[-1]
        # Do not emit a tiny heading/short sentence immediately before a long
        # sentence: it exhausts the playback buffer and causes a long silence.
        if not first and sentence_end >= min(80, limit // 2):
            return sentence_end
    whitespace = max((index for index, char in enumerate(text[:limit]) if char.isspace()), default=-1)
    return whitespace if whitespace > 0 else limit


def split_speech_text(value: str) -> list[str]:
    """Split normalized text in order, using sentences, whitespace, then hard cuts."""
    remaining = _normalize_input(value)
    chunks: list[str] = []
    while remaining:
        if not chunks:
            limit = FIRST_CHUNK_CHARS
        elif len(chunks) == 1:
            limit = SECOND_CHUNK_CHARS
        else:
            limit = LATER_CHUNK_CHARS
        end = _prefix_length(remaining, limit, not chunks)
        chunk = remaining[:end].strip()
        if chunk:
            chunks.append(chunk)
        remaining = remaining[end:].strip()
    return chunks


def _ndjson_line(record: dict) -> bytes:
    """Encode one compact UTF-8 NDJSON record, including its newline."""
    return (json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def _audio_record(index: int, audio_bytes: bytes) -> bytes:
    return _ndjson_line({
        "type": "audio", "index": index,
        "audio": base64.b64encode(audio_bytes).decode("ascii"),
        "mime_type": "audio/wav",
    })


def _validate_stream_payload(data: object) -> tuple[str, str, str, float, list[str]]:
    """Strictly validate all stream fields and work bounds before streaming."""
    if not isinstance(data, dict):
        raise ValueError("request body must be a JSON object")
    unknown = sorted(set(data) - STREAM_FIELDS)
    if unknown:
        raise ValueError(f"unsupported field: {unknown[0]}")

    raw_input = data.get("input")
    if not isinstance(raw_input, str):
        raise ValueError("input must be a string")
    text = _normalize_input(raw_input)
    if not text:
        raise ValueError("input is required")
    if len(text) > MAX_INPUT_CHARS:
        raise ValueError(f"input exceeds {MAX_INPUT_CHARS} characters")

    model_name = data.get("model", "chatterbox")
    if not isinstance(model_name, str) or not model_name or len(model_name) > MAX_MODEL_CHARS:
        raise ValueError("model must be a non-empty string of at most 128 characters")
    voice = data.get("voice", "alloy")
    if not isinstance(voice, str) or not voice.strip() or len(voice) > MAX_VOICE_CHARS:
        raise ValueError("voice must be a non-empty string of at most 128 characters")
    voice = voice.strip()
    response_format = data.get("response_format", "wav")
    if not isinstance(response_format, str) or response_format.lower() != "wav":
        raise ValueError("streaming supports response_format 'wav' only")
    speed = data.get("speed", 1.0)
    if isinstance(speed, bool) or not isinstance(speed, (int, float)):
        raise ValueError("speed must be a number from 0.25 to 4")
    speed = float(speed)
    if not math.isfinite(speed) or speed < 0.25 or speed > 4.0:
        raise ValueError("speed must be a number from 0.25 to 4")

    chunks = split_speech_text(text)
    if len(chunks) > MAX_STREAM_CHUNKS:
        raise ValueError(f"input exceeds the {MAX_STREAM_CHUNKS}-chunk stream limit")
    if not chunks or len(chunks[0]) > FIRST_CHUNK_CHARS or any(
        len(chunk) > LATER_CHUNK_CHARS for chunk in chunks[1:]
    ):
        raise ValueError("input could not be split within stream chunk limits")
    return text, model_name, voice, speed, chunks


def _ensure_conditionals(voice_path: str | None, exaggeration: float) -> None:
    """Select conditionals. Caller must hold _synthesis_lock."""
    if voice_path is None:
        key = (None, exaggeration)
        if _active_voice["key"] != key:
            model.conds = _DEFAULT_CONDS
            _active_voice["key"] = key
        return
    key = (voice_path, os.path.getmtime(voice_path), exaggeration)
    if _active_voice["key"] != key:
        with tracer.start_as_current_span("voice.tts.prepare_conditionals") as span:
            span.set_attribute("voice_path", voice_path)
            span.set_attribute("exaggeration", exaggeration)
            started = time.monotonic()
            model.prepare_conditionals(voice_path, exaggeration=exaggeration)
            _active_voice["key"] = key
            elapsed = round(time.monotonic() - started, 2)
            span.set_attribute("elapsed_s", elapsed)
            log.info("voice.tts.conditionals_prepared", extra={
                "voice_path": voice_path, "exaggeration": exaggeration, "elapsed_s": elapsed,
            })


app = Flask("chatterbox-service")
CORS(app, expose_headers=["X-Chatterbox-Stream-Version", "X-Chatterbox-Request-Id"])
START_TIME = time.time()
MIME_TYPES = {"wav": "audio/wav", "mp3": "audio/mpeg", "opus": "audio/ogg", "flac": "audio/flac"}


def _encode(wav: torch.Tensor, fmt: str) -> bytes:
    buf = io.BytesIO()
    if fmt == "wav":
        # PCM16 is universally decodable and halves transfer size versus the
        # float32 WAV default, which materially improves first audio on iOS.
        ta.save(buf, wav, SAMPLE_RATE, format="wav", encoding="PCM_S", bits_per_sample=16)
    elif fmt == "mp3":
        ta.save(buf, wav, SAMPLE_RATE, format="mp3")
    elif fmt == "flac":
        ta.save(buf, wav, SAMPLE_RATE, format="flac")
    else:
        ta.save(buf, wav, SAMPLE_RATE, format="ogg", encoding="opus")
    return buf.getvalue()


def _voice_path(voice: str | None) -> str | None:
    if not voice:
        return None
    if os.path.isabs(voice) and os.path.isfile(voice):
        return voice
    candidate = os.path.join(VOICES_DIR, f"{voice}.wav")
    return candidate if os.path.isfile(candidate) else None


def _generate_audio(
    text: str,
    voice_path: str | None,
    exaggeration: float,
    fmt: str,
    phase_timings: dict[str, float] | None = None,
) -> bytes:
    """Atomically select conditionals and synthesize one instrumented chunk."""
    total_started = time.monotonic()
    lock_started = total_started
    with _synthesis_lock:
        lock_acquired = time.monotonic()
        timings: dict[str, float] = {}
        _phase_state.timings = timings
        try:
            conditionals_started = time.monotonic()
            _ensure_conditionals(voice_path, exaggeration)
            timings["conditionals_s"] = time.monotonic() - conditionals_started

            generate_started = time.monotonic()
            wav = model.generate(text, exaggeration=exaggeration)
            timings["model_generate_s"] = time.monotonic() - generate_started

            encode_started = time.monotonic()
            audio_bytes = _encode(wav, fmt)
            timings["encode_s"] = time.monotonic() - encode_started
        finally:
            del _phase_state.timings

    timings["lock_wait_s"] = lock_acquired - lock_started
    timings["model_other_s"] = max(
        0.0,
        timings.get("model_generate_s", 0.0)
        - timings.get("t3_s", 0.0)
        - timings.get("s3_flow_s", 0.0)
        - timings.get("hift_s", 0.0),
    )
    timings["total_s"] = time.monotonic() - total_started
    if phase_timings is not None:
        phase_timings.update(timings)
    return audio_bytes


@app.get("/health")
def health():
    return jsonify({
        "status": "ok", "model": MODEL_NAME, "device": DEVICE,
        "sample_rate": SAMPLE_RATE, "cfm_steps": CFM_STEPS,
        "first_chunk_chars": FIRST_CHUNK_CHARS,
        "second_chunk_chars": SECOND_CHUNK_CHARS,
        "later_chunk_chars": LATER_CHUNK_CHARS,
        "uptime_s": round(time.time() - START_TIME, 1),
    })


@app.get("/v1/models")
def models():
    return jsonify({"object": "list", "data": [
        {"id": "chatterbox", "object": "model", "owned_by": "resemble-ai"},
    ]})


@app.post("/v1/audio/speech")
def speech():
    data = request.get_json(silent=True) or {}
    text = data.get("input", "")
    if not isinstance(text, str) or not text.strip():
        return jsonify({"error": "input is required"}), 400
    text = text.strip()
    voice = data.get("voice", "alloy")
    fmt = data.get("response_format", "wav")
    try:
        fmt = fmt.lower()
        speed = float(data.get("speed", 1.0))
    except (AttributeError, TypeError, ValueError):
        return jsonify({"error": "invalid response_format or speed"}), 400
    if fmt not in MIME_TYPES or not math.isfinite(speed):
        return jsonify({"error": "invalid response_format or speed"}), 400
    exaggeration = max(0.0, min(1.0, 0.5 * speed))
    voice_path = _voice_path(voice)
    started = time.monotonic()
    with tracer.start_as_current_span("voice.tts.synthesize") as span:
        span.set_attribute("voice", str(voice))
        span.set_attribute("voice_cloned", voice_path is not None)
        span.set_attribute("speed", speed)
        span.set_attribute("chars_in", len(text))
        try:
            audio_bytes = _generate_audio(text, voice_path, exaggeration, fmt)
        except Exception as exc:
            log.error("voice.tts.generate_error", extra={
                "error": str(exc), "voice": voice, "chars_in": len(text),
            })
            return jsonify({"error": str(exc)}), 500
        elapsed = round(time.monotonic() - started, 2)
        span.set_attribute("audio_bytes", len(audio_bytes))
        log.info("voice.tts.generated", extra={
            "chars_in": len(text), "voice": voice, "voice_cloned": voice_path is not None,
            "fmt": fmt, "elapsed_s": elapsed, "audio_bytes": len(audio_bytes),
        })
    return Response(audio_bytes, mimetype=MIME_TYPES[fmt])


@app.post("/v1/audio/speech/stream")
def speech_stream():
    declared = request.content_length
    if declared is not None and declared > MAX_REQUEST_BYTES:
        return jsonify({"error": f"request exceeds {MAX_REQUEST_BYTES} bytes"}), 413
    if not request.is_json:
        return jsonify({"error": "content type must be application/json"}), 415
    # Bound chunked requests while reading too; do not first buffer an unlimited body.
    raw = request.stream.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        return jsonify({"error": f"request exceeds {MAX_REQUEST_BYTES} bytes"}), 413
    try:
        data = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return jsonify({"error": "request body must be valid UTF-8 JSON"}), 400
    try:
        _text, _model_name, voice, speed, chunks = _validate_stream_payload(data)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    # Resolve every request-scoped value before constructing the generator.
    voice_path = _voice_path(voice)
    exaggeration = max(0.0, min(1.0, 0.5 * speed))
    supplied_request_id = request.headers.get("X-Chatterbox-Request-Id", "")
    request_id = supplied_request_id if re.fullmatch(r"[0-9a-f]{32}", supplied_request_id) else uuid.uuid4().hex
    accepted_at = time.monotonic()
    log.info("voice.tts.stream_accepted", extra={
        "request_id": request_id, "chars_in": len(_text), "chunk_count": len(chunks),
        "voice": voice, "speed": speed, "cfm_steps": CFM_STEPS,
    })

    def generate_stream():
        with tracer.start_as_current_span("voice.tts.stream") as stream_span:
            stream_span.set_attribute("client.request.id", request_id)
            stream_span.set_attribute("voice.tts.chunks", len(chunks))
            stream_span.set_attribute("voice.tts.chars", len(_text))
            try:
                for index, chunk in enumerate(chunks):
                    started = time.monotonic()
                    log.info("voice.tts.stream_chunk_start", extra={
                        "request_id": request_id, "index": index, "chars_in": len(chunk),
                        "queue_elapsed_s": round(started - accepted_at, 3),
                    })
                    with tracer.start_as_current_span("voice.tts.stream.chunk") as chunk_span:
                        chunk_span.set_attribute("client.request.id", request_id)
                        chunk_span.set_attribute("voice.tts.chunk.index", index)
                        chunk_span.set_attribute("voice.tts.chunk.chars", len(chunk))
                        phase_timings: dict[str, float] = {}
                        audio_bytes = _generate_audio(
                            chunk, voice_path, exaggeration, "wav", phase_timings,
                        )
                        elapsed = round(time.monotonic() - started, 3)
                        audio_duration = round(max(0, len(audio_bytes) - 44) / (SAMPLE_RATE * 2), 3)
                        realtime_factor = round(elapsed / audio_duration, 3) if audio_duration else 0
                        chunk_span.set_attribute("voice.tts.chunk.audio_bytes", len(audio_bytes))
                        chunk_span.set_attribute("voice.tts.chunk.duration_s", elapsed)
                        chunk_span.set_attribute("voice.tts.chunk.audio_duration_s", audio_duration)
                        chunk_span.set_attribute("voice.tts.chunk.realtime_factor", realtime_factor)
                        for phase_name, phase_elapsed in phase_timings.items():
                            chunk_span.set_attribute(
                                f"voice.tts.chunk.phase.{phase_name}", round(phase_elapsed, 4),
                            )
                    log.info("voice.tts.stream_chunk_ready", extra={
                        "request_id": request_id, "index": index, "chars_in": len(chunk),
                        "audio_bytes": len(audio_bytes), "elapsed_s": elapsed,
                        "audio_duration_s": audio_duration, "realtime_factor": realtime_factor,
                        "voice": voice,
                        "phase_timings_s": {
                            name: round(value, 4) for name, value in phase_timings.items()
                        },
                    })
                    yield _audio_record(index, audio_bytes)
                total_elapsed = round(time.monotonic() - accepted_at, 3)
                log.info("voice.tts.stream_complete", extra={
                    "request_id": request_id, "chunk_count": len(chunks), "elapsed_s": total_elapsed,
                })
                yield _ndjson_line({"type": "done", "chunks": len(chunks)})
            except GeneratorExit:
                log.info("voice.tts.stream_disconnected", extra={
                    "request_id": request_id, "elapsed_s": round(time.monotonic() - accepted_at, 3),
                })
                return
            except Exception as exc:
                stream_span.record_exception(exc)
                log.error("voice.tts.stream_error", extra={
                    "request_id": request_id, "error": str(exc), "voice": voice,
                })
                yield _ndjson_line({"type": "error", "error": "speech synthesis failed"})

    return Response(generate_stream(), content_type="application/x-ndjson; charset=utf-8", headers={
        "Cache-Control": "no-cache, no-store",
        "X-Accel-Buffering": "no",
        "X-Chatterbox-Stream-Version": STREAM_PROTOCOL_VERSION,
        "X-Chatterbox-Request-Id": request_id,
    })


@app.get("/v1/voices")
def list_voices():
    files = [f[:-4] for f in os.listdir(VOICES_DIR) if f.endswith(".wav")]
    return jsonify({"voices": sorted(files)})


@app.put("/v1/voices/<name>")
def upload_voice(name: str):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", name):
        return jsonify({"error": "invalid voice name"}), 400
    if "file" not in request.files:
        return jsonify({"error": "multipart field 'file' required"}), 400
    dest = os.path.join(VOICES_DIR, f"{name}.wav")
    descriptor, temporary = tempfile.mkstemp(prefix=f".{name}.", suffix=".wav", dir=VOICES_DIR)
    os.close(descriptor)
    try:
        request.files["file"].save(temporary)
        with _synthesis_lock:
            os.replace(temporary, dest)
            _active_voice["key"] = None
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
    log.info("voice.tts.voice_saved", extra={"voice": name, "path": dest})
    return jsonify({"name": name, "path": dest}), 201


if __name__ == "__main__":
    try:
        warm_path = _voice_path(WARMUP_VOICE)
        if REQUIRE_SUCCESSFUL_WARMUP and not warm_path:
            raise RuntimeError(f"required warmup voice not found: {WARMUP_VOICE}")
        started = time.monotonic()
        _generate_audio("Ready.", warm_path, 0.5, "wav")
        log.info("voice.tts.warmup_done", extra={
            "voice": WARMUP_VOICE if warm_path else "default",
            "elapsed_s": round(time.monotonic() - started, 2),
        })
    except Exception as exc:
        log.warning("voice.tts.warmup_failed", extra={"error": str(exc)})
        if REQUIRE_SUCCESSFUL_WARMUP:
            raise
    log.info("voice.tts.listening", extra={"port": PORT})
    app.run(host="0.0.0.0", port=PORT, debug=False)
