export type PiWebTelemetryServiceName = "pi-web-server" | "pi-web-sessiond";

export interface NodeTelemetryConfig {
  enabled: boolean;
  serviceName: PiWebTelemetryServiceName;
  exporterTimeoutMillis: number;
  shutdownTimeoutMillis: number;
  spanQueueSize: number;
  logQueueSize: number;
}

const DEFAULT_EXPORTER_TIMEOUT_MS = 3_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 4_000;

export function telemetryEnabled(env: NodeJS.ProcessEnv): boolean {
  return env["OTEL_ENABLED"] === "1" || env["OTEL_ENABLED"] === "true";
}

export function captureNodeTelemetryConfig(env: NodeJS.ProcessEnv, defaultServiceName: PiWebTelemetryServiceName): NodeTelemetryConfig {
  return Object.freeze({
    enabled: telemetryEnabled(env),
    serviceName: defaultServiceName,
    exporterTimeoutMillis: positiveInteger(env["OTEL_EXPORTER_OTLP_TIMEOUT"], DEFAULT_EXPORTER_TIMEOUT_MS),
    shutdownTimeoutMillis: positiveInteger(env["OTEL_SHUTDOWN_TIMEOUT"], DEFAULT_SHUTDOWN_TIMEOUT_MS),
    spanQueueSize: positiveInteger(env["OTEL_BSP_MAX_QUEUE_SIZE"], 512),
    logQueueSize: positiveInteger(env["OTEL_BLRP_MAX_QUEUE_SIZE"], 256),
  });
}

export function isClientTelemetryIntakePath(url: string | undefined): boolean {
  if (url === undefined) return false;
  let pathname: string;
  try {
    pathname = new URL(url, "http://pi-web.invalid").pathname;
  } catch {
    return false;
  }
  const normalized = `/${pathname.split("/").filter(Boolean).join("/")}`;
  return normalized === "/api/client-telemetry" || normalized.endsWith("/api/client-telemetry");
}

export function clientRequestIdAttributes(value: string | string[] | undefined): Record<string, string> {
  return typeof value === "string" && /^(?!0{32}$)[0-9a-f]{32}$/.test(value) ? { "client.request.id": value } : {};
}

interface NamedInstrumentation {
  readonly instrumentationName: string;
}

export function selectPrivacySafeInstrumentations<T extends NamedInstrumentation>(instrumentations: T[]): T[] {
  const allowed = new Set(["@opentelemetry/instrumentation-http", "@opentelemetry/instrumentation-undici"]);
  return instrumentations.filter((instrumentation) => allowed.has(instrumentation.instrumentationName));
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
