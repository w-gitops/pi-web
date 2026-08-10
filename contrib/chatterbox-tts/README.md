# Chatterbox TTS integration

This contributed integration adds cancellable speech controls to PI WEB assistant messages and serves Chatterbox audio as incrementally delivered PCM16 WAV chunks.

It contains:

- `plugin/`: a dependency-free local PI WEB plugin;
- `server/`: the Flask/CUDA Chatterbox service, OpenTelemetry bootstrap, and pure helper tests.

This is a deployment-oriented integration rather than a PI WEB core feature. The message control uses PI WEB's private chat DOM because the stable plugin API does not currently expose message-action contributions. Review it after PI WEB chat markup changes.

## Install the plugin

Link the plugin into PI WEB's local plugin directory:

```sh
mkdir -p ~/.pi-web/plugins
ln -s "$PWD/contrib/chatterbox-tts/plugin" ~/.pi-web/plugins/chatterbox-tts
```

Enable `chatterbox-tts` in **Settings → PI WEB plugins**. The action palette provides configuration, stop, and reload actions.

On HTTPS pages, the default endpoint is the same-origin `/chatterbox-tts` route. On HTTP pages, the deployment default is `http://192.168.200.42:9004`; use **Configure Chatterbox TTS** to change it. Assistant text is sent to the configured endpoint, so only use a server you trust.

The plugin checks PI WEB's plugin manifest every 30 seconds while visible and idle. When the module's mtime-versioned URL changes, it performs one ordinary reload; mobile users do not need a hard refresh for subsequent upgrades.

## Run the service

Use a CUDA-compatible PyTorch/torchaudio installation suitable for the host GPU, then install Chatterbox, Flask, CORS, and OpenTelemetry dependencies. The deployed service expects these importable modules:

```text
chatterbox-tts
flask
flask-cors
opentelemetry-api
opentelemetry-sdk
opentelemetry-exporter-otlp-proto-grpc
opentelemetry-instrumentation-flask
opentelemetry-instrumentation-requests
```

Copy `server/chatterbox-service.py` and `server/_telemetry.py` into one working directory and run exactly one service process per GPU:

```sh
PORT=9004 \
CHATTERBOX_DEVICE=cuda \
VOICES_DIR=/opt/chatterbox-voices \
CHATTERBOX_CFM_STEPS=7 \
CHATTERBOX_FIRST_CHUNK_CHARS=160 \
CHATTERBOX_SECOND_CHUNK_CHARS=80 \
CHATTERBOX_LATER_CHUNK_CHARS=120 \
OTEL_SERVICE_NAME=voice-tts-chatterbox \
python server/chatterbox-service.py
```

`server/chatterbox.service.example` shows a standard-model systemd unit. Chatterbox voice conditionals are mutable, so a process-local lock serializes warmup, legacy requests, and streamed chunks. Multiple workers sharing one model are unsupported. Cancelling a request stops future chunks but cannot interrupt a `model.generate()` call already executing; a replacement request may briefly wait for that active GPU chunk.

The service defaults to Chatterbox's 10 CFM steps and uniform 160-character chunks. The example above is a measured Quadro P2200 standard-model profile: seven CFM steps, a 160-character playback-buffer chunk, an 80-character successor, then 120-character steady-state chunks. Treat these as deployment tuning rather than universal defaults, and verify voice quality and successor readiness on the target model and GPU.

### Chatterbox Turbo

Set `CHATTERBOX_MODEL=turbo` to load `ChatterboxTurboTTS`. Install `server/requirements-turbo.txt`, which pins the tested upstream revision because Turbo support postdates the 0.1.7 PyPI release. Turbo's distilled decoder is fixed at two CFM steps, so the service requires `CHATTERBOX_CFM_STEPS=2`. `server/chatterbox-turbo.service.example` contains the measured deployment profile and requires a successful production-voice warmup before Flask begins listening:

```sh
CHATTERBOX_MODEL=turbo \
CHATTERBOX_CFM_STEPS=2 \
CHATTERBOX_FIRST_CHUNK_CHARS=120 \
CHATTERBOX_SECOND_CHUNK_CHARS=80 \
CHATTERBOX_LATER_CHUNK_CHARS=120 \
python server/chatterbox-service.py
```

On a 5 GB Quadro P2200, the resident Turbo model peaked below 3 GB of CUDA allocations and generated 6.44 seconds of custom-voice audio from 120 characters in 2.75 seconds (RTF 0.426). Keep T3 and S3Gen resident: CPU offloading added roughly one second per chunk and was unnecessary after the NVIDIA runtime was configured correctly.

For an NVIDIA GPU passed into an LXC, exposing `/dev/nvidia*` and `libcuda` may not be sufficient. CUDA FFT kernels on the tested Pascal GPU failed with `CUFFT_INTERNAL_ERROR` until the container could resolve the host-driver-matched `libnvidia-ptxjitcompiler.so.1` and `libnvidia-nvvm.so.4`. The tested Proxmox host stores versioned libraries under `/usr/lib/x86_64-linux-gnu/nvidia/current/`; mount that directory read-only, create only the standard soname links to files from the same driver version, and run `ldconfig`. Compare `nvidia-smi` driver versions and library checksums after host driver upgrades rather than linking arbitrary container packages.

Set `CHATTERBOX_WARMUP_VOICE` to the same named voice used by clients (`alloy` in the example). Required warmup fails startup if that file is missing or generation fails. Before proxy cutover, run `python server/verify-turbo.py --base-url http://127.0.0.1:9004 --voice alloy` inside the LXC. It executes CUDA `torch.stft`, verifies warmed Turbo health, and validates production-voice NDJSON/PCM16 streaming. Standard and Turbo cannot remain resident together on the tested 5 GB GPU. Stop the active service before starting the other and preserve the previous upstream as the immediate rollback. This creates a short planned outage while the replacement loads and warms; if startup or smoke verification fails, stop Turbo and restart standard without changing the proxy.

## HTTPS reverse proxy

HTTPS PI WEB cannot call an HTTP TTS endpoint directly. Configure a same-origin route such as `/chatterbox-tts/` and strip that prefix when forwarding to the Flask service. Streaming requires response and request buffering to be disabled. A representative nginx location is:

```nginx
location /chatterbox-tts/ {
    proxy_pass http://127.0.0.1:9004/;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_request_buffering off;
    gzip off;
    proxy_read_timeout 180s;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

Keep the route behind the same authentication boundary as PI WEB.

## Streaming behavior

The plugin posts one immutable cleaned message to `/v1/audio/speech/stream`. The server normalizes and splits it at configurable sentence/whitespace boundaries, synthesizes chunks serially, and yields base64 PCM16 WAV records over bounded NDJSON. The browser:

- validates MIME type, protocol version, record ordering, WAV shape, and byte/count limits;
- starts after the first record and decodes at most one successor ahead;
- conservatively trims generated leading/trailing silence;
- schedules the successor on the same Web Audio timeline with a 40 ms boundary overlap;
- resumes suspended mobile Web Audio contexts before scheduling;
- cancels the fetch, reader, and every scheduled source when stopped.

The first-record deadline is 75 seconds and each later stream read has a separate 90-second idle deadline. HTTP 404 or 405 before any stream record falls back to the legacy `/v1/audio/speech` endpoint. Other transport, protocol, or synthesis errors do not silently retry.

## Observability

Every browser request carries an opaque `X-Chatterbox-Request-Id`. The service includes it in structured logs and OpenTelemetry spans for stream acceptance, each chunk's start/readiness, completion, disconnect, and failure. Chunk telemetry includes lock wait, conditional selection, T3 autoregressive generation, S3 flow, HiFT vocoding, encoding, synthesis time, audio duration, byte count, and real-time factor. Configure `OTEL_EXPORTER_OTLP_ENDPOINT` to send traces and logs to an OTLP-gRPC collector such as SigNoz; it defaults to `http://localhost:4317`.

PI WEB's privacy-bounded client telemetry records overall browser success, timeout, abort, network, and parse outcomes using the same opaque request ID when client telemetry is enabled.

## Verification

Run the deterministic plugin and pure server suites:

```sh
(cd contrib/chatterbox-tts/plugin && npm test)
python -m unittest -v contrib/chatterbox-tts/server/test_stream_helpers.py
```

After deployment, verify health, legacy speech, CORS, audio-before-done streaming, proxy non-buffering, mobile playback continuity, cancellation, and SigNoz correlation. The helper suites do not load the ML model or replace browser/proxy acceptance testing.
