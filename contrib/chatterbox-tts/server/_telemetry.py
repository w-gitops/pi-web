"""Shared OpenTelemetry bootstrap for the voice-services Flask apps.

One call to ``setup_telemetry(service_name=...)`` at the top of each
service script wires up:

  * A ``TracerProvider`` exporting OTLP-gRPC to ``OTEL_EXPORTER_OTLP_ENDPOINT``
    (default ``http://localhost:4317``). Flask routes and outbound ``requests`` calls are
    auto-instrumented; the homebot-api side already auto-instruments
    httpx so spans link parent → child without manual context plumbing.
  * A ``LoggerProvider`` shipping the root Python ``logging`` stream as
    OTLP logs. Records that fire inside an active span carry that span's
    ``trace_id`` / ``span_id`` automatically, so SigNoz can pivot from a
    slow span to its log lines.
  * A JSON formatter on the stderr handler so journald entries are also
    machine-readable (mirrors ``prd/40.18-logging-standards.md`` shape:
    timestamp, level, event/message, kwargs).

Idempotent: a second call is a no-op so ``flask run`` reloads don't
double-register providers.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone

_INITIALIZED = False


def _json_record(record: logging.LogRecord) -> str:
    """Render a LogRecord as a single-line JSON object."""
    payload = {
        "timestamp": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
        "level": record.levelname,
        "logger": record.name,
        "event": record.getMessage(),
    }
    # Pull through any structured kwargs the caller attached via ``extra=...``.
    # Standard LogRecord attributes are filtered out so only user fields land.
    standard = set(logging.LogRecord("", 0, "", 0, "", (), None).__dict__) | {"message"}
    for key, value in record.__dict__.items():
        if key in standard or key.startswith("_"):
            continue
        try:
            json.dumps(value)
        except TypeError:
            value = repr(value)
        payload[key] = value
    if record.exc_info:
        payload["exception"] = logging.Formatter().formatException(record.exc_info)
    return json.dumps(payload, default=str)


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:  # noqa: D401
        return _json_record(record)


def setup_telemetry(service_name: str) -> None:
    """Initialise OTel traces + logs and a JSON stderr handler.

    Safe to call multiple times — re-invocations are no-ops.
    """
    global _INITIALIZED
    if _INITIALIZED:
        return

    # Imports are lazy so the file is harmless to import even if the
    # OTel SDK isn't installed (e.g. during a unit-test run).
    from opentelemetry import trace
    from opentelemetry._logs import set_logger_provider
    from opentelemetry.exporter.otlp.proto.grpc._log_exporter import OTLPLogExporter
    from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
    from opentelemetry.instrumentation.flask import FlaskInstrumentor
    # RequestsInstrumentor eagerly imports the `requests` package at module
    # load time. Some venvs (e.g. piper-env) don't ship requests because
    # the service doesn't make outbound HTTP calls — guard the import so
    # those services aren't forced to add a dead dep.
    try:
        from opentelemetry.instrumentation.requests import RequestsInstrumentor
    except ImportError:
        RequestsInstrumentor = None
    from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
    from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")
    # Honour the standard env var if the operator wants to point this
    # service at a different collector without changing code.
    environment = os.getenv("DEPLOYMENT_ENVIRONMENT", "dev")
    host_name = os.getenv("HOSTNAME") or os.uname().nodename

    resource = Resource.create({
        "service.name": service_name,
        "service.namespace": "voice-services",
        "deployment.environment": environment,
        "host.name": host_name,
    })

    # --- Traces ---
    tracer_provider = TracerProvider(resource=resource)
    tracer_provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint, insecure=True)))
    trace.set_tracer_provider(tracer_provider)

    # --- Logs ---
    logger_provider = LoggerProvider(resource=resource)
    logger_provider.add_log_record_processor(
        BatchLogRecordProcessor(OTLPLogExporter(endpoint=endpoint, insecure=True))
    )
    set_logger_provider(logger_provider)

    root = logging.getLogger()
    root.setLevel(os.getenv("LOG_LEVEL", "INFO").upper())
    # Strip any pre-existing handlers (e.g. Flask's default) so we don't
    # ship duplicate records — keep exactly one stderr-JSON path and one
    # OTLP path.
    root.handlers.clear()

    stderr = logging.StreamHandler(sys.stderr)
    stderr.setFormatter(_JsonFormatter())
    root.addHandler(stderr)
    root.addHandler(LoggingHandler(level=logging.NOTSET, logger_provider=logger_provider))

    # --- Auto-instrumentation ---
    # Flask must be instrumented before any app is created; we rely on
    # callers invoking setup_telemetry() before `app = Flask(...)`.
    FlaskInstrumentor().instrument()
    if RequestsInstrumentor is not None:
        RequestsInstrumentor().instrument()

    _INITIALIZED = True
    logging.getLogger(service_name).info(
        "voice.telemetry.ready",
        extra={"service.name": service_name, "otlp_endpoint": endpoint, "environment": environment},
    )


def get_tracer(name: str):
    """Thin wrapper so call sites don't import ``opentelemetry`` directly."""
    from opentelemetry import trace
    return trace.get_tracer(name)
