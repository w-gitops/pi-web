import { describe, expect, it } from "vitest";
import { captureNodeTelemetryConfig, clientRequestIdAttributes, isClientTelemetryIntakePath, telemetryEnabled } from "./config.js";

describe("node telemetry configuration", () => {
  it.each(["1", "true"])("enables only the exact opt-in value %s", (value) => {
    expect(telemetryEnabled({ OTEL_ENABLED: value })).toBe(true);
  });

  it.each([undefined, "", "0", "TRUE", "True", "yes", " true", "true "])("rejects non-opt-in value %s", (value) => {
    expect(telemetryEnabled(value === undefined ? {} : { OTEL_ENABLED: value })).toBe(false);
  });

  it("captures bounded defaults and honors valid standard queue/timeout settings", () => {
    expect(captureNodeTelemetryConfig({
      OTEL_ENABLED: "true",
      OTEL_EXPORTER_OTLP_TIMEOUT: "1200",
      OTEL_BSP_MAX_QUEUE_SIZE: "64",
      OTEL_BLRP_MAX_QUEUE_SIZE: "32",
      OTEL_SHUTDOWN_TIMEOUT: "1800",
    }, "pi-web-sessiond")).toEqual({
      enabled: true,
      serviceName: "pi-web-sessiond",
      exporterTimeoutMillis: 1200,
      shutdownTimeoutMillis: 1800,
      spanQueueSize: 64,
      logQueueSize: 32,
    });
  });

  it.each([
    "/api/client-telemetry",
    "/api/client-telemetry?cache=bust",
    "/nested/base/api/client-telemetry",
    "https://pi.example.test/nested/api/client-telemetry?private=value",
  ])("excludes normalized intake URL %s", (url) => {
    expect(isClientTelemetryIntakePath(url)).toBe(true);
  });

  it.each(["/api/client-telemetry/extra", "/api/client-telemetry-other", "/api/sessions/private"])("does not exclude %s", (url) => {
    expect(isClientTelemetryIntakePath(url)).toBe(false);
  });

  it("accepts only canonical opaque browser request IDs as span attributes", () => {
    const requestId = "1234567890abcdef1234567890abcdef";
    expect(clientRequestIdAttributes(requestId)).toEqual({ "client.request.id": requestId });
    expect(clientRequestIdAttributes(requestId.toUpperCase())).toEqual({});
    expect(clientRequestIdAttributes("0".repeat(32))).toEqual({});
    expect(clientRequestIdAttributes([requestId])).toEqual({});
    expect(clientRequestIdAttributes("/private/session?id=secret")).toEqual({});
  });
});
