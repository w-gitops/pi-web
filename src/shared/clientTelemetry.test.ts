import { describe, expect, it } from "vitest";
import { parseClientTelemetryBatch } from "./clientTelemetry.js";

const id = "1234567890abcdef1234567890abcdef";

describe("client telemetry schema", () => {
  it("accepts only closed, privacy-safe event shapes", () => {
    expect(parseClientTelemetryBatch({
      version: 1,
      events: [
        { type: "api", requestId: id, operation: "session.prompt", method: "POST", outcome: "network", durationMs: 12.5, online: true, visible: true },
        { type: "socket", kind: "session", attemptId: id, generation: 4, outcome: "close", closeCode: 1006, delayMs: 500, online: true, visible: false },
        { type: "browser", outcome: "visible", online: true, visible: true },
      ],
    })).toBeDefined();
  });

  it.each([
    ["free-form error text", { type: "api", requestId: id, operation: "session.prompt", method: "POST", outcome: "network", durationMs: 1, online: true, visible: true, message: "prompt Bearer secret /home/user?token=abc" }],
    ["dynamic operation", { type: "api", requestId: id, operation: "api/sessions/private-id", method: "GET", outcome: "success", durationMs: 1, online: true, visible: true }],
    ["socket URL", { type: "socket", kind: "session", attemptId: id, generation: 1, outcome: "error", online: true, visible: true, url: "wss://host/api/sessions/private" }],
    ["close reason", { type: "socket", kind: "realtime", attemptId: id, generation: 1, outcome: "close", closeCode: 1006, online: true, visible: true, reason: "cwd=/secret" }],
    ["noncanonical id", { type: "api", requestId: "session-123", operation: "api.unknown", method: "GET", outcome: "success", durationMs: 1, online: true, visible: true }],
  ])("rejects %s", (_label, event) => {
    expect(parseClientTelemetryBatch({ version: 1, events: [event] })).toBeUndefined();
  });

  it("rejects empty, oversized, and additional-property batches", () => {
    const event = { type: "browser", outcome: "online", online: true, visible: true };
    expect(parseClientTelemetryBatch({ version: 1, events: [] })).toBeUndefined();
    expect(parseClientTelemetryBatch({ version: 1, events: Array.from({ length: 21 }, () => event) })).toBeUndefined();
    expect(parseClientTelemetryBatch({ version: 1, events: [event], source: "/private" })).toBeUndefined();
  });
});
