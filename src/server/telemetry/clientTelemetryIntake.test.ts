import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { ClientTelemetryAdmission, registerClientTelemetryIntake } from "./clientTelemetryIntake.js";

const apiEvent = {
  type: "api",
  requestId: "1234567890abcdef1234567890abcdef",
  operation: "session.prompt",
  method: "POST",
  outcome: "network",
  durationMs: 12,
  online: true,
  visible: true,
} as const;

describe("client telemetry intake", () => {
  it("is discoverable and does no processing when disabled", async () => {
    const record = vi.fn();
    const app = Fastify();
    registerClientTelemetryIntake(app, { enabled: false, record });

    expect((await app.inject({ method: "GET", url: "/api/client-telemetry" })).json()).toEqual({ enabled: false });
    const response = await app.inject({ method: "POST", url: "/api/client-telemetry", payload: "not-json", headers: { "content-type": "text/plain" } });
    expect(response.statusCode).toBe(204);
    expect(record).not.toHaveBeenCalled();
    await app.close();
  });

  it("accepts exact same-origin batches and records only parsed events", async () => {
    const record = vi.fn();
    const app = Fastify();
    registerClientTelemetryIntake(app, { enabled: true, record });

    const response = await app.inject({
      method: "POST",
      url: "/api/client-telemetry",
      payload: { version: 1, events: [apiEvent] },
      headers: { origin: "https://pi.example.test", host: "pi.example.test", "sec-fetch-site": "same-origin" },
    });

    expect(response.statusCode).toBe(204);
    expect(record).toHaveBeenCalledWith(apiEvent);
    await app.close();
  });

  it.each([
    [{ origin: "https://evil.example", host: "pi.example.test", "content-type": "application/json" }, 403],
    [{ origin: "https://pi.example.test", host: "pi.example.test", "sec-fetch-site": "cross-site", "content-type": "application/json" }, 403],
    [{ host: "pi.example.test", "content-type": "text/plain" }, 415],
  ])("rejects invalid request boundary %#", async (headers, expectedStatus) => {
    const app = Fastify();
    registerClientTelemetryIntake(app, { enabled: true, record: vi.fn() });
    const response = await app.inject({ method: "POST", url: "/api/client-telemetry", payload: JSON.stringify({ version: 1, events: [apiEvent] }), headers });
    expect(response.statusCode).toBe(expectedStatus);
    await app.close();
  });

  it("rejects extra fields containing adversarial secret text", async () => {
    const record = vi.fn();
    const app = Fastify();
    registerClientTelemetryIntake(app, { enabled: true, record });
    const response = await app.inject({
      method: "POST",
      url: "/api/client-telemetry",
      payload: { version: 1, events: [{ ...apiEvent, message: "prompt /home/user?token=Bearer-secret" }] },
    });
    expect(response.statusCode).toBe(400);
    expect(record).not.toHaveBeenCalled();
    await app.close();
  });

  it("applies injectable per-source, global, and process-budget admission", () => {
    let now = 0;
    const admission = new ClientTelemetryAdmission({
      now: () => now,
      globalCapacity: 3,
      globalRefillPerSecond: 1,
      sourceCapacity: 2,
      sourceRefillPerSecond: 1,
      acceptedEventBudget: 4,
    });
    expect(admission.admit("source-a", 2)).toBe(true);
    expect(admission.admit("source-a", 1)).toBe(false);
    expect(admission.admit("source-b", 1)).toBe(true);
    now = 1_000;
    expect(admission.admit("source-a", 1)).toBe(true);
    now = 2_000;
    expect(admission.admit("source-b", 1)).toBe(false);
  });

  it("enforces a tiny route-local body limit", async () => {
    const app = Fastify({ bodyLimit: 1_000_000 });
    registerClientTelemetryIntake(app, { enabled: true, record: vi.fn() });
    const response = await app.inject({ method: "POST", url: "/api/client-telemetry", payload: { version: 1, events: [apiEvent], padding: "x".repeat(20_000) } });
    expect(response.statusCode).toBe(413);
    await app.close();
  });
});
