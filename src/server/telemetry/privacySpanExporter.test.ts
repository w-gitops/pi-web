import { SpanKind } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { privacySafeSpanAttributes, privacySafeSpanName } from "./privacySpanExporter.js";

describe("trace export privacy boundary", () => {
  it("removes dynamic URLs, paths, ids, errors, events, and arbitrary attributes before export", () => {
    const attributes = privacySafeSpanAttributes({
      "http.request.method": "POST",
      "http.response.status_code": 503,
      "http.route": "/api/sessions/:sessionId/prompt",
      "url.full": "https://pi.example/api/sessions/private-id?cwd=/home/user&token=secret",
      "url.path": "/api/sessions/private-id",
      "error.message": "prompt body Bearer secret",
      "exception.stacktrace": "/home/user/src/private.ts:10",
      "session.id": "private-id",
    });

    expect(attributes).toEqual({
      "http.request.method": "POST",
      "http.response.status_code": 503,
    });
    expect(JSON.stringify(attributes)).not.toContain("private");
    expect(JSON.stringify(attributes)).not.toContain("secret");
  });

  it("replaces auto-instrumented dynamic span names with closed operation keys", () => {
    expect(privacySafeSpanName(SpanKind.SERVER, "@opentelemetry/instrumentation-http", "POST /api/sessions/private-id/prompt")).toBe("http.server");
    expect(privacySafeSpanName(SpanKind.CLIENT, "@opentelemetry/instrumentation-undici", "GET https://private.example/id")).toBe("http.client");
    expect(privacySafeSpanName(SpanKind.INTERNAL, "unknown", "/home/user/private")).toBe("operation");
  });
});
