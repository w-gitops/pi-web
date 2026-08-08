import { SpanStatusCode, trace, type Attributes } from "@opentelemetry/api";
import type { ApiTelemetryMethod, ClientTelemetryEvent } from "../../shared/clientTelemetry.js";
import type { PiWebTelemetryServiceName } from "./config.js";

export interface ServiceTelemetryLog {
  event: "service.started" | "service.stopping" | "service.stopped";
  component: PiWebTelemetryServiceName;
}

export interface HttpErrorTelemetryLog {
  event: "http.server.error";
  method: ApiTelemetryMethod;
  route: string;
  status: number;
  durationMs: number;
}

export type TelemetryLog = ServiceTelemetryLog | HttpErrorTelemetryLog;

export interface ExplicitTelemetryLogRecord {
  eventName: string;
  severityNumber: 9 | 17;
  severityText: "ERROR" | "INFO";
  attributes: Attributes;
}

let explicitLogEmitter: ((record: ExplicitTelemetryLogRecord) => void) | undefined;

export function configureExplicitTelemetryLogEmitter(emitter: ((record: ExplicitTelemetryLogRecord) => void) | undefined): void {
  explicitLogEmitter = emitter;
}

export function emitTelemetryLog(record: TelemetryLog): void {
  const attributes = telemetryLogAttributes(record);
  explicitLogEmitter?.({
    eventName: record.event,
    severityNumber: record.event === "http.server.error" ? 17 : 9,
    severityText: record.event === "http.server.error" ? "ERROR" : "INFO",
    attributes,
  });
}

export function recordClientTelemetryEvent(event: ClientTelemetryEvent): void {
  const attributes = clientEventAttributes(event);
  const tracer = trace.getTracer("pi-web.client-telemetry");
  const span = tracer.startSpan(`client.${event.type}`, { attributes });
  if ((event.type === "api" && event.outcome !== "success") || (event.type === "socket" && event.outcome !== "open")) {
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
  span.end();
  explicitLogEmitter?.({
    eventName: `client.${event.type}`,
    severityNumber: 9,
    severityText: "INFO",
    attributes,
  });
}

function telemetryLogAttributes(record: TelemetryLog): Attributes {
  if (record.event !== "http.server.error") return { "service.component": record.component };
  return {
    "http.request.method": record.method,
    "http.route": record.route,
    "http.response.status_code": record.status,
    "http.server.duration_ms": record.durationMs,
  };
}

export function clientEventAttributes(event: ClientTelemetryEvent): Attributes {
  const browser = { "browser.online": event.online, "browser.visible": event.visible };
  if (event.type === "browser") return { ...browser, "browser.outcome": event.outcome };
  if (event.type === "api") {
    return {
      ...browser,
      "client.request.id": event.requestId,
      "client.api.operation": event.operation,
      "client.api.method": event.method,
      "client.api.outcome": event.outcome,
      "client.api.duration_ms": event.durationMs,
      ...(event.status === undefined ? {} : { "http.response.status_code": event.status }),
    };
  }
  return {
    ...browser,
    "client.socket.kind": event.kind,
    "client.socket.attempt_id": event.attemptId,
    "client.socket.generation": event.generation,
    "client.socket.outcome": event.outcome,
    ...(event.closeCode === undefined ? {} : { "client.socket.close_code": event.closeCode }),
    ...(event.delayMs === undefined ? {} : { "client.socket.delay_ms": event.delayMs }),
  };
}
