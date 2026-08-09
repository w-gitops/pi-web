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
OTEL_SERVICE_NAME=voice-tts-chatterbox \
python server/chatterbox-service.py
```

`server/chatterbox.service.example` shows a systemd unit. Chatterbox voice conditionals are mutable, so a process-local lock serializes warmup, legacy requests, and streamed chunks. Multiple workers sharing one model are unsupported.

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

The plugin posts one immutable cleaned message to `/v1/audio/speech/stream`. The server normalizes and splits it into 160-character sentence/whitespace chunks, synthesizes them serially, and yields base64 PCM16 WAV records over bounded NDJSON. The browser:

- validates MIME type, protocol version, record ordering, WAV shape, and byte/count limits;
- starts after the first record and decodes at most one successor ahead;
- conservatively trims generated leading/trailing silence;
- schedules the successor on the same Web Audio timeline with a 40 ms boundary overlap;
- resumes suspended mobile Web Audio contexts before scheduling;
- cancels the fetch, reader, and every scheduled source when stopped.

The first-record deadline is 75 seconds and each later stream read has a separate 90-second idle deadline. HTTP 404 or 405 before any stream record falls back to the legacy `/v1/audio/speech` endpoint. Other transport, protocol, or synthesis errors do not silently retry.

## Observability

Every browser request carries an opaque `X-Chatterbox-Request-Id`. The service includes it in structured logs and OpenTelemetry spans for stream acceptance, each chunk's start/readiness, completion, disconnect, and failure. Chunk telemetry includes synthesis time, audio duration, byte count, and real-time factor. Configure `OTEL_EXPORTER_OTLP_ENDPOINT` to send traces and logs to an OTLP-gRPC collector such as SigNoz; it defaults to `http://localhost:4317`.

PI WEB's privacy-bounded client telemetry records overall browser success, timeout, abort, network, and parse outcomes using the same opaque request ID when client telemetry is enabled.

## Verification

Run the deterministic plugin and pure server suites:

```sh
(cd contrib/chatterbox-tts/plugin && npm test)
python -m unittest -v contrib/chatterbox-tts/server/test_stream_helpers.py
```

After deployment, verify health, legacy speech, CORS, audio-before-done streaming, proxy non-buffering, mobile playback continuity, cancellation, and SigNoz correlation. The helper suites do not load the ML model or replace browser/proxy acceptance testing.
