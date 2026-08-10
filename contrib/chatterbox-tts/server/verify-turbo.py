#!/usr/bin/env python3
# pyright: reportMissingImports=false
"""Deployment smoke test for a warmed Chatterbox Turbo streaming service."""
import argparse
import base64
import io
import json
import time
import urllib.request
import wave


def get_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=15) as response:  # noqa: S310 - operator-supplied URL
        return json.load(response)


def verify_cuda_stft() -> None:
    import torch

    samples = torch.randn(1, 1000, device="cuda")
    window = torch.hann_window(16, device="cuda")
    torch.stft(samples, 16, 4, 16, window=window, return_complex=True)
    torch.cuda.synchronize()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def verify_stream(base_url: str, voice: str, text: str, sample_rate: int) -> tuple[float, float]:
    payload = json.dumps({
        "model": "chatterbox", "input": text, "voice": voice,
        "response_format": "wav", "speed": 1,
    }).encode()
    request = urllib.request.Request(
        f"{base_url}/v1/audio/speech/stream",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.monotonic()
    first_audio_s = None
    audio_duration_s = 0.0
    saw_done = False
    expected_index = 0
    with urllib.request.urlopen(request, timeout=90) as response:  # noqa: S310
        require(response.headers.get_content_type() == "application/x-ndjson", "wrong stream MIME type")
        require(response.headers.get("X-Chatterbox-Stream-Version") == "1", "wrong stream version")
        for raw_line in response:
            record = json.loads(raw_line)
            if record["type"] == "audio":
                require(record.get("index") == expected_index, "unexpected audio record index")
                expected_index += 1
                if first_audio_s is None:
                    first_audio_s = time.monotonic() - started
                audio = base64.b64decode(record["audio"], validate=True)
                with wave.open(io.BytesIO(audio)) as wav:
                    require(wav.getsampwidth() == 2, "stream is not PCM16")
                    require(wav.getframerate() == sample_rate, "WAV and health sample rates differ")
                    audio_duration_s += wav.getnframes() / wav.getframerate()
            elif record["type"] == "done":
                require(record.get("chunks") == expected_index, "terminal chunk count mismatch")
                saw_done = True
            elif record["type"] == "error":
                raise RuntimeError(record.get("error", "stream error"))
            else:
                raise RuntimeError(f"unexpected stream record type: {record.get('type')}")
    require(first_audio_s is not None, "stream returned no audio")
    require(audio_duration_s > 0, "stream returned empty audio")
    require(saw_done, "stream ended without a done record")
    return float(first_audio_s), float(audio_duration_s)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:9004")
    parser.add_argument("--voice", default="alloy")
    parser.add_argument("--skip-cuda-stft", action="store_true")
    args = parser.parse_args()
    base_url = args.base_url.rstrip("/")

    if not args.skip_cuda_stft:
        verify_cuda_stft()
    health = get_json(f"{base_url}/health")
    require(health.get("status") == "ok", "service is not healthy")
    require(health.get("model") == "chatterbox-turbo", "service is not running Turbo")
    require(health.get("cfm_steps") == 2, "Turbo is not reporting two CFM steps")
    first_audio_s, audio_duration_s = verify_stream(
        base_url,
        args.voice,
        "This verifies production voice conditioning and incremental Turbo audio streaming.",
        int(health["sample_rate"]),
    )
    print(json.dumps({
        "status": "ok", "first_audio_s": round(first_audio_s, 3),
        "audio_duration_s": round(audio_duration_s, 3), "health": health,
    }, sort_keys=True))


if __name__ == "__main__":
    main()
