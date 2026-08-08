import { describe, expect, it } from "vitest";
import { clientEventAttributes } from "./logs.js";

describe("explicit telemetry log attributes", () => {
  it("copies only the closed API allowlist", () => {
    const attributes = clientEventAttributes({
      type: "api",
      requestId: "1234567890abcdef1234567890abcdef",
      operation: "session.prompt",
      method: "POST",
      outcome: "network",
      durationMs: 42,
      online: true,
      visible: false,
    });
    const serialized = JSON.stringify(attributes);
    expect(serialized).toContain("session.prompt");
    expect(serialized).not.toContain("message");
    expect(serialized).not.toContain("url");
    expect(serialized).not.toContain("path");
    expect(serialized).not.toContain("stack");
  });
});
