import { SpanKind, type Attributes, type SpanContext } from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { API_TELEMETRY_OPERATIONS } from "../../shared/clientTelemetry.js";

const API_OPERATIONS = new Set<string>(API_TELEMETRY_OPERATIONS);
const API_METHODS = new Set(["DELETE", "GET", "PATCH", "POST", "PUT", "OTHER"]);
const API_OUTCOMES = new Set(["abort", "http.4xx", "http.5xx", "http.other", "network", "parse", "success", "timeout"]);
const SOCKET_KINDS = new Set(["realtime", "session"]);
const SOCKET_OUTCOMES = new Set(["close", "error", "open", "replaced", "scheduled"]);
const BROWSER_OUTCOMES = new Set(["focus", "offline", "online", "visible"]);
const OPAQUE_ID = /^(?!0{32}$)[0-9a-f]{32}$/;

export class PrivacySpanExporter implements SpanExporter {
  constructor(private readonly delegate: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter["export"]>[1]): void {
    this.delegate.export(spans.map(sanitizeReadableSpan), resultCallback);
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush?.() ?? Promise.resolve();
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }
}

function sanitizeReadableSpan(span: ReadableSpan): ReadableSpan {
  const parentSpanContext = stripTraceState(span.parentSpanContext);
  return {
    ...span,
    name: privacySafeSpanName(span.kind, span.instrumentationScope.name, span.name),
    spanContext: () => stripTraceState(span.spanContext()),
    ...(parentSpanContext === undefined ? {} : { parentSpanContext }),
    status: { code: span.status.code },
    attributes: privacySafeSpanAttributes(span.attributes),
    events: [],
    links: [],
  };
}

function stripTraceState(spanContext: SpanContext): SpanContext;
function stripTraceState(spanContext: undefined): undefined;
function stripTraceState(spanContext: SpanContext | undefined): SpanContext | undefined;
function stripTraceState(spanContext: SpanContext | undefined): SpanContext | undefined {
  if (spanContext === undefined) return undefined;
  return {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    traceFlags: spanContext.traceFlags,
    ...(spanContext.isRemote === undefined ? {} : { isRemote: spanContext.isRemote }),
  };
}

export function privacySafeSpanName(kind: SpanKind, instrumentationScope: string, originalName: string): string {
  if (instrumentationScope === "pi-web.client-telemetry" && (originalName === "client.api" || originalName === "client.browser" || originalName === "client.socket")) return originalName;
  if (kind === SpanKind.SERVER) return "http.server";
  if (kind === SpanKind.CLIENT) return "http.client";
  return "operation";
}

export function privacySafeSpanAttributes(attributes: Attributes): Attributes {
  const safe: Attributes = {};
  copyEnum(attributes, safe, "http.request.method", API_METHODS);
  copyInteger(attributes, safe, "http.response.status_code", 100, 599);

  copyBoolean(attributes, safe, "browser.online");
  copyBoolean(attributes, safe, "browser.visible");
  copyEnum(attributes, safe, "browser.outcome", BROWSER_OUTCOMES);
  copyOpaqueId(attributes, safe, "client.request.id");
  copyEnum(attributes, safe, "client.api.operation", API_OPERATIONS);
  copyEnum(attributes, safe, "client.api.method", API_METHODS);
  copyEnum(attributes, safe, "client.api.outcome", API_OUTCOMES);
  copyNumber(attributes, safe, "client.api.duration_ms", 0, 3_600_000);
  copyEnum(attributes, safe, "client.socket.kind", SOCKET_KINDS);
  copyOpaqueId(attributes, safe, "client.socket.attempt_id");
  copyInteger(attributes, safe, "client.socket.generation", 0, 1_000_000_000);
  copyEnum(attributes, safe, "client.socket.outcome", SOCKET_OUTCOMES);
  copyInteger(attributes, safe, "client.socket.close_code", 0, 4999);
  copyNumber(attributes, safe, "client.socket.delay_ms", 0, 300_000);
  return safe;
}

function copyEnum(source: Attributes, target: Attributes, key: string, values: ReadonlySet<string>): void {
  const value = source[key];
  if (typeof value === "string" && values.has(value)) target[key] = value;
}

function copyBoolean(source: Attributes, target: Attributes, key: string): void {
  const value = source[key];
  if (typeof value === "boolean") target[key] = value;
}

function copyOpaqueId(source: Attributes, target: Attributes, key: string): void {
  const value = source[key];
  if (typeof value === "string" && OPAQUE_ID.test(value)) target[key] = value;
}

function copyNumber(source: Attributes, target: Attributes, key: string, minimum: number, maximum: number): void {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum) target[key] = value;
}

function copyInteger(source: Attributes, target: Attributes, key: string, minimum: number, maximum: number): void {
  const value = source[key];
  if (typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum) target[key] = value;
}
