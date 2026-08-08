import { describe, expect, it } from "vitest";
import { safeRouteTemplate } from "./fastifyTelemetry.js";

describe("Fastify telemetry route labels", () => {
  it.each(["/api/sessions/:sessionId/prompt", "/api/machines/:machineId/*", "/health"])("keeps literal route template %s", (route) => {
    expect(safeRouteTemplate(route)).toBe(route);
  });

  it.each(["/api/sessions/private-id?cwd=/secret", "/api/token%2Fsecret", "https://private.example/path", undefined])("drops unsafe route %s", (route) => {
    expect(safeRouteTemplate(route)).toBe("unknown");
  });
});
