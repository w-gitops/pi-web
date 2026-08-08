import { describe, expect, it, vi } from "vitest";
import { boundedTelemetryShutdown } from "./shutdown.js";
import { startNodeTelemetry } from "./nodeTelemetry.js";

describe("bounded telemetry shutdown", () => {
  it("does not load an SDK, contact a collector, or create timers without exact opt-in", async () => {
    vi.useFakeTimers();
    await expect(startNodeTelemetry("pi-web-server", { OTEL_ENABLED: "TRUE", OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.invalid:4318" })).resolves.toMatchObject({
      enabled: false,
      serviceName: "pi-web-server",
    });
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("does not wait forever for a stuck SDK", async () => {
    vi.useFakeTimers();
    const shutdown = vi.fn(() => new Promise<void>(() => undefined));
    const result = boundedTelemetryShutdown(shutdown, 250);
    await vi.advanceTimersByTimeAsync(250);
    await expect(result).resolves.toBeUndefined();
    expect(shutdown).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("settles immediately when shutdown rejects", async () => {
    await expect(boundedTelemetryShutdown(() => Promise.reject(new Error("private exporter detail")), 1_000)).resolves.toBeUndefined();
  });
});
